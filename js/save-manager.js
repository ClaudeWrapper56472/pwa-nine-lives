import * as Ladder from "./puzzle/ladder.js";
import * as Migration from "./save-migration.js";
import { MAX_LIVES } from "./scoring.js";
import { Emitter } from "./util/emitter.js";

/**
 * Reads and writes the save document in localStorage.
 *
 * Two jobs, kept together because they share a document: the in-progress game,
 * and lifetime statistics.
 *
 * Saving is driven by an event rather than a direct call. SaveManager announces
 * "I am about to write", whoever owns live state hands it over, and the write
 * happens. That keeps this file free of any knowledge of GameState, and it means
 * a second system with state to persist only has to listen.
 *
 * Where the Godot build wrote a temp file and renamed it, localStorage.setItem is
 * already all-or-nothing, so there is no torn write to defend against. What does
 * carry over is *when* we write: a browser tab can be discarded without warning,
 * so every hook that might be the last one flushes.
 *
 * Emits: saveRequested(), statsChanged(), sessionAvailable(available)
 */
export class SaveManager extends Emitter {
	static STORAGE_KEY = "meowdoku.save";

	/**
	 * How many past boards to remember at the current size. Only the largest board
	 * ever accumulates enough to reach this.
	 */
	static SEEN_LIMIT = 400;

	constructor(settings) {
		super();
		this._settings = settings;
		this._document = Migration.emptyDocument();
		this._loaded = false;
	}

	/**
	 * Browsers give no warning before a background tab is discarded, so every
	 * hook that might be the last one we get writes the document.
	 *
	 *   visibilitychange -> hidden   backgrounded, or the screen locked
	 *   pagehide                     navigating away or being unloaded
	 *   freeze                       the browser is suspending the tab entirely
	 */
	installSuspendHooks() {
		const flush = () => this.flush();
		document.addEventListener("visibilitychange", () => {
			if (document.visibilityState === "hidden") flush();
		});
		window.addEventListener("pagehide", flush);
		window.addEventListener("freeze", flush);
	}

	/** Collects live state from whoever is listening, then writes. */
	flush() {
		if (!this._loaded) return;
		this.emit("saveRequested");
		this._settings?.save();
		this._write();
	}

	/** Called from a saveRequested handler. */
	submitSession(session) {
		this._document.session = session;
	}

	clearSession() {
		this._document.session = {};
		this._write();
		this.emit("sessionAvailable", false);
	}

	hasSession() {
		const session = this._document.session;
		return isObject(session) && Object.keys(session).length > 0;
	}

	session() {
		return this._document.session ?? {};
	}

	stats() {
		return this._document.stats ?? Migration.emptyStats();
	}

	tierStats(tier) {
		return this.stats().tiers?.[String(tier)] ?? Migration.emptyTierStats();
	}

	/**
	 * Fingerprints of boards already served at `size`, as a Set for quick lookup.
	 *
	 * Only the current board size is ever tracked. The ladder never sends a player
	 * back to a smaller board, so the moment the size goes up every fingerprint
	 * below it is unreachable and gets dropped -- which is why the cap rarely comes
	 * into play until a player settles on the largest board for good.
	 *
	 * Rebuilt from the stored array on each read, and coerced with Number: JSON
	 * round trips are forgiving about numeric types, and a set of strings compared
	 * against a numeric fingerprint would silently never match, leaving the whole
	 * mechanism quietly doing nothing while looking correct.
	 */
	seenFingerprints(size) {
		const known = new Set();
		const seen = this.stats().seen ?? Migration.emptySeen();
		if (Number(seen.size ?? 0) !== size) return known;
		for (const value of seen.prints ?? []) known.add(Number(value));
		return known;
	}

	hasSeen(size, fingerprint) {
		return this.seenFingerprints(size).has(fingerprint);
	}

	/**
	 * Records a board as served. Moving up a size throws the previous size's list
	 * away wholesale, since none of it can come round again.
	 */
	recordSeen(size, fingerprint) {
		const seen = this.stats().seen ?? Migration.emptySeen();
		let prints = [];
		if (Number(seen.size ?? 0) === size) {
			prints = (seen.prints ?? []).map(Number);
			if (prints.includes(fingerprint)) return;
		}
		prints.push(fingerprint);
		if (prints.length > SaveManager.SEEN_LIMIT) {
			prints = prints.slice(prints.length - SaveManager.SEEN_LIMIT);
		}

		const stats = this.stats();
		stats.seen = { size, prints };
		this._document.stats = stats;
		this._write();
	}

	progress() {
		return this.stats().progress ?? Migration.emptyProgress();
	}

	/** The level the player is on now, which the menu can send backwards. */
	playingLevel() {
		return Math.max(Number(this.progress().playing ?? Ladder.FIRST_LEVEL), Ladder.FIRST_LEVEL);
	}

	/**
	 * The furthest level they have reached, which only ever climbs. Never behind
	 * the level being played, whatever a hand-edited save says.
	 */
	furthestLevel() {
		return Math.max(Number(this.progress().level ?? Ladder.FIRST_LEVEL),
			Ladder.FIRST_LEVEL, this.playingLevel());
	}

	levelsCompleted() {
		return Number(this.progress().completed ?? 0);
	}

	// --- The run ------------------------------------------------------------

	run() {
		return this.stats().run ?? Migration.emptyRun();
	}

	runScore() {
		return Number(this.run().score ?? 0);
	}

	runLives() {
		return Number(this.run().lives ?? MAX_LIVES);
	}

	highScore() {
		return Number(this.stats().high_score ?? 0);
	}

	/**
	 * Writes where the run stands. The high score is raised here rather than by
	 * the caller: it is the one number that must never be able to go down, so the
	 * only code that can move it is the code that sees every score.
	 */
	recordRun(score, lives) {
		const stats = this.stats();
		stats.run = {
			score: Math.max(score, 0),
			lives: Math.min(Math.max(lives, 0), MAX_LIVES),
		};
		stats.high_score = Math.max(Number(stats.high_score ?? 0), stats.run.score);
		this._document.stats = stats;
		this._write();
		this.emit("statsChanged");
	}

	/** The last life is gone. The score goes back to zero; the best of them stays. */
	endRun() {
		const stats = this.stats();
		stats.run = Migration.emptyRun();
		this._document.stats = stats;
		this._write();
		this.emit("statsChanged");
	}

	load() {
		this._loaded = true;
		let text = null;
		try {
			text = localStorage.getItem(SaveManager.STORAGE_KEY);
		} catch {
			// Private mode, or storage disabled. The game still plays; it just
			// cannot remember anything between visits.
			this._document = Migration.emptyDocument();
			return;
		}
		if (text === null) {
			this._document = Migration.emptyDocument();
			return;
		}

		let parsed = null;
		try {
			parsed = JSON.parse(text);
		} catch {
			parsed = null;
		}
		if (!isObject(parsed)) {
			console.warn("Save document is not valid JSON; starting fresh.");
			this._document = Migration.emptyDocument();
			return;
		}
		this._document = Migration.migrate(parsed);
		this.emit("sessionAvailable", this.hasSession());
		this.emit("statsChanged");
	}

	/**
	 * Records a level being started. Starting one is what moves the player to it,
	 * so both progress numbers are written here: the level being played, and the
	 * furthest reached when this is a new best.
	 */
	recordStarted(level, tier) {
		const progress = this.progress();
		progress.playing = level;
		progress.level = Math.max(Number(progress.level ?? level), level);
		const statsBlock = this.stats();
		statsBlock.progress = progress;
		this._document.stats = statsBlock;

		const entry = this._tierEntry(tier);
		entry.started = Number(entry.started ?? 0) + 1;
		this._write();
		this.emit("statsChanged");
	}

	/**
	 * Records a finished level and moves the player up one.
	 *
	 * The level number advances here rather than in GameState so that it cannot
	 * get out of step with the document: the same write that records the win is
	 * the one that says which level comes next. A win on a level below the
	 * furthest reached carries on from where it was played and leaves the furthest
	 * alone.
	 */
	recordWin(level, tier, seconds, mistakes, hints) {
		const progress = this.progress();
		progress.level = Math.max(Number(progress.level ?? level), level + 1);
		progress.playing = level + 1;
		progress.completed = Number(progress.completed ?? 0) + 1;
		const statsBlock = this.stats();
		statsBlock.progress = progress;
		this._document.stats = statsBlock;

		const entry = this._tierEntry(tier);
		entry.won = Number(entry.won ?? 0) + 1;
		entry.total_time = Number(entry.total_time ?? 0) + seconds;
		entry.mistakes = Number(entry.mistakes ?? 0) + mistakes;
		const best = Number(entry.best_time ?? 0);
		if (best === 0 || seconds < best) entry.best_time = seconds;

		const stats = this.stats();
		stats.hints_used = Number(stats.hints_used ?? 0) + hints;
		extendStreak(stats);

		this._document.session = {};
		this._write();
		this.emit("statsChanged");
		this.emit("sessionAvailable", false);
	}

	/**
	 * Called when the last life goes. The best run is kept -- that is the point of
	 * recording it.
	 */
	recordLoss() {
		const stats = this.stats();
		const streak = stats.streak ?? Migration.emptyStreak();
		streak.current = 0;
		stats.streak = streak;
		this._document.stats = stats;
		this._write();
		this.emit("statsChanged");
	}

	_tierEntry(tier) {
		const stats = this.stats();
		const tiers = stats.tiers ?? {};
		const key = String(tier);
		if (!isObject(tiers[key])) tiers[key] = Migration.emptyTierStats();
		stats.tiers = tiers;
		this._document.stats = stats;
		return tiers[key];
	}

	_write() {
		this._document.version = Migration.CURRENT_VERSION;
		try {
			localStorage.setItem(SaveManager.STORAGE_KEY, JSON.stringify(this._document));
		} catch (error) {
			// Out of quota, or storage blocked. Losing the write is bad; taking the
			// running game down with it would be worse.
			console.warn("Could not write the save document.", error);
		}
	}
}

/**
 * A run of levels cleared without running out of lives.
 *
 * It counts levels rather than days, which is a thing the player can feel while
 * playing, and it needs no date handling at all -- no timezone edge cases, no
 * clock to trust.
 */
function extendStreak(stats) {
	const streak = stats.streak ?? Migration.emptyStreak();
	streak.current = Number(streak.current ?? 0) + 1;
	streak.best = Math.max(Number(streak.best ?? 0), streak.current);
	stats.streak = streak;
}

function isObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
