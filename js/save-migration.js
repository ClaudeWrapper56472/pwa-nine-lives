import * as Grid from "./puzzle/grid.js";
import * as Ladder from "./puzzle/ladder.js";
import { MAX_LIVES } from "./scoring.js";
import { CatLevel } from "./puzzle/level.js";

/**
 * Save-format versioning.
 *
 * Pure functions, no storage access, so migration can be checked without
 * touching localStorage -- which matters, because a migration bug corrupts real
 * players' progress and is the one thing you cannot hotfix after the fact.
 *
 * The rule: every save carries a version, migration only ever moves forward one
 * step at a time, and an unrecognised or newer version is discarded rather than
 * guessed at.
 *
 * Each step is exported so it can be checked on its own. The chain is only as
 * trustworthy as its weakest link, and testing only the whole chain hides which
 * link broke.
 *
 * Version history
 *   1  Flat document. Marks as an array of small integers, difficulty as a
 *      display name, stats keyed by difficulty name, no undo history.
 *   2  Session and stats separated. Marks as one character per cell, difficulty
 *      as a tier value, plus undo history, hint counts and the streak.
 *   3  A wrong cat ends the level, and placing one no longer crosses out cells.
 *      Commands are single-cell.
 *   4  One climbing progression instead of a difficulty menu. Stats gain a
 *      progress block; the session records its level.
 *   5  One board size, and a scored run. Stats gain a run block and a high
 *      score; the session counts its mistakes instead of its lives, which are
 *      now the run's.
 */

export const CURRENT_VERSION = 5;

const V1_TIER_NAMES = {
	easy: Grid.Tier.EASY,
	medium: Grid.Tier.MEDIUM,
	hard: Grid.Tier.HARD,
	expert: Grid.Tier.EXPERT,
};
const V1_MARKS = [".", "x", "c"];

/** Lives a v4 level started with, which its sessions counted down from. */
const V4_LIVES = 3;

export function migrate(data) {
	let version = Number(data?.version ?? 0);
	if (version <= 0 || version > CURRENT_VERSION) {
		// Either not one of ours, or written by a build newer than this one. A
		// newer save may use fields we would silently drop, so start clean rather
		// than corrupt it.
		return emptyDocument();
	}

	let document = structuredClone(data);
	while (version < CURRENT_VERSION) {
		if (version === 1) document = migrateV1ToV2(document);
		else if (version === 2) document = migrateV2ToV3(document);
		else if (version === 3) document = migrateV3ToV4(document);
		else if (version === 4) document = migrateV4ToV5(document);
		else return emptyDocument();
		version = Number(document.version ?? CURRENT_VERSION);
	}
	return normalize(document);
}

export function emptyDocument() {
	return { version: CURRENT_VERSION, session: {}, stats: emptyStats() };
}

export function emptyStats() {
	const tiers = {};
	for (const tier of Grid.TIER_VALUES) tiers[String(tier)] = emptyTierStats();
	return {
		tiers,
		streak: emptyStreak(),
		hints_used: 0,
		progress: emptyProgress(),
		seen: emptySeen(),
		run: emptyRun(),
		high_score: 0,
	};
}

/**
 * The run in progress: the score so far and the lives left to spend on it. Both
 * outlive the level being played, and both are reset together when the last life
 * goes.
 */
export function emptyRun() {
	return { score: 0, lives: MAX_LIVES };
}

/** Levels cleared in a row without running out of lives. */
export function emptyStreak() {
	return { current: 0, best: 0 };
}

/**
 * Fingerprints of boards already served, and the size they belong to.
 *
 * Only one size is ever tracked. The ladder's sizes never decrease, so the moment
 * the board grows every smaller board becomes unreachable and its fingerprints
 * are dead weight.
 */
export function emptySeen() {
	return { size: 0, prints: [] };
}

/**
 * `level` is the furthest the player has reached and only ever climbs. `playing`
 * is the level they are on now.
 */
export function emptyProgress() {
	return { level: Ladder.FIRST_LEVEL, playing: Ladder.FIRST_LEVEL, completed: 0 };
}

export function emptyTierStats() {
	return { started: 0, won: 0, best_time: 0, total_time: 0, mistakes: 0 };
}

/**
 * Fills in anything a partially written or hand-edited save is missing, so the
 * rest of the game can read fields without guarding every one.
 */
export function normalize(document) {
	document.version = CURRENT_VERSION;
	if (!isObject(document.session)) document.session = {};
	if (!isObject(document.stats)) document.stats = emptyStats();

	const stats = document.stats;
	if (!isObject(stats.tiers)) stats.tiers = {};
	for (const tier of Grid.TIER_VALUES) {
		const key = String(tier);
		if (!isObject(stats.tiers[key])) {
			stats.tiers[key] = emptyTierStats();
		} else {
			const defaults = emptyTierStats();
			for (const field of Object.keys(defaults)) {
				if (!(field in stats.tiers[key])) stats.tiers[key][field] = defaults[field];
			}
		}
	}
	if (!isObject(stats.streak)) {
		stats.streak = emptyStreak();
	} else {
		const streak = stats.streak;
		// last_win_day marks a save from when the streak counted consecutive days
		// rather than consecutive levels. The number means something different
		// now, so start it over rather than show a figure that reads as levels but
		// was earned in days.
		if ("last_win_day" in streak) {
			delete streak.last_win_day;
			streak.current = 0;
			streak.best = 0;
		}
		for (const field of ["current", "best"]) {
			if (!(field in streak)) streak[field] = 0;
		}
	}
	if (!("hints_used" in stats)) stats.hints_used = 0;
	if (!isObject(stats.run)) {
		stats.run = emptyRun();
	} else {
		const defaults = emptyRun();
		for (const field of Object.keys(defaults)) {
			if (!(field in stats.run)) stats.run[field] = defaults[field];
		}
	}
	// A hand-edited save could hold more lives than the rules allow, or a negative
	// score. Clamping here means nothing downstream has to re-check.
	stats.run.lives = Math.min(Math.max(Number(stats.run.lives), 0), MAX_LIVES);
	stats.run.score = Math.max(Number(stats.run.score) || 0, 0);
	stats.high_score = Math.max(Number(stats.high_score) || 0, stats.run.score);
	// `seen` is purely a de-duplication convenience, so it needs no version bump:
	// normalize() exists for exactly this, and the worst case of throwing an
	// unrecognised shape away is that one board could repeat.
	if (!isObject(stats.seen)) {
		stats.seen = emptySeen();
	} else {
		if (!Array.isArray(stats.seen.prints)) stats.seen.prints = [];
		if (!("size" in stats.seen)) stats.seen.size = 0;
	}
	if (!isObject(stats.progress)) {
		stats.progress = emptyProgress();
	} else {
		// A save from before the two levels were separate has only the furthest
		// one, which is also where its player left off.
		if (!("playing" in stats.progress) && "level" in stats.progress) {
			stats.progress.playing = stats.progress.level;
		}
		const defaults = emptyProgress();
		for (const field of Object.keys(defaults)) {
			if (!(field in stats.progress)) stats.progress[field] = defaults[field];
		}
	}
	stats.progress.level = Math.max(Number(stats.progress.level), Ladder.FIRST_LEVEL);
	stats.progress.playing = Math.max(Number(stats.progress.playing), Ladder.FIRST_LEVEL);
	// Starting a level is what puts it in reach, so the furthest reached can never
	// be behind the one being played.
	stats.progress.level = Math.max(stats.progress.level, stats.progress.playing);
	return document;
}

export function migrateV1ToV2(data) {
	let session = {};
	const size = Number(data.size ?? 0);
	const regions = String(data.regions ?? "");
	if (size > 0 && regions.length === size * size) {
		const tier = tierFromName(String(data.difficulty ?? "Easy"));
		session = {
			tier,
			seed: Number(data.seed ?? 0),
			board: {
				level: {
					size,
					regions,
					columns: String(data.solution ?? ""),
					tier,
					seed: Number(data.seed ?? 0),
				},
				marks: marksToString(data.marks, size * size),
			},
			elapsed: Number(data.elapsed ?? 0),
			mistakes: Number(data.mistakes ?? 0),
			// v1 tracked neither hints nor undo history. Zero and empty are the
			// honest values -- a resumed v1 game simply starts with nothing to undo.
			hints: 0,
			selected: -1,
			history: { undo: [], redo: [] },
		};
	}

	const stats = emptyStats();
	const oldStats = isObject(data.stats) ? data.stats : {};
	for (const name of Object.keys(oldStats)) {
		const tier = V1_TIER_NAMES[name.toLowerCase()] ?? -1;
		if (tier < 0 || !isObject(oldStats[name])) continue;
		const entry = oldStats[name];
		const won = Number(entry.won ?? 0);
		const best = Number(entry.best ?? 0);
		stats.tiers[String(tier)] = {
			started: Number(entry.played ?? 0),
			won,
			best_time: best,
			// v1 never recorded cumulative time, so best_time per win is the only
			// estimate available. Noted here so the average is not mistaken for
			// exact history.
			total_time: best * won,
			mistakes: 0,
		};
	}

	return { version: 2, session, stats };
}

/**
 * v2 was played under different rules: a cat could sit on a wrong cell without
 * ending the level, and placing one crossed out its row, column and colour.
 *
 * The crosses are kept -- they are still the player's own reasoning. Wrong cats
 * are lifted, because under the current rules that board could not exist. And
 * the undo history is dropped rather than migrated: those commands were recorded
 * against the old rules and reverting one could reconstruct a board the new rules
 * would never produce. A shorter history is a much smaller cost than a save that
 * can undo into an impossible state.
 */
export function migrateV2ToV3(data) {
	const document = structuredClone(data);
	document.version = 3;
	const session = document.session;
	if (!isObject(session) || Object.keys(session).length === 0) return document;

	const board = session.board;
	if (isObject(board)) {
		const level = CatLevel.fromJSON(board.level ?? {});
		const marks = String(board.marks ?? "");
		if (level !== null && marks.length === level.size * level.size) {
			let cleaned = "";
			for (let index = 0; index < marks.length; index += 1) {
				let mark = marks[index];
				if (mark === "c" && !level.isSolutionCell(index)) mark = ".";
				cleaned += mark;
			}
			board.marks = cleaned;
		}
	}
	session.history = { undo: [], redo: [] };
	return document;
}

/**
 * v3 let the player pick a difficulty; v4 has one climbing progression instead.
 *
 * There is no record of which level anyone was on, because the concept did not
 * exist. Total wins is the closest honest estimate: someone who finished twelve
 * puzzles has done roughly twelve levels of work, so that is where they resume.
 * It can only ever be generous, never punishing, which is the right direction to
 * be wrong in.
 */
export function migrateV3ToV4(data) {
	const document = structuredClone(data);
	document.version = 4;

	const stats = document.stats;
	if (!isObject(stats)) return document;
	let won = 0;
	if (isObject(stats.tiers)) {
		for (const key of Object.keys(stats.tiers)) {
			if (isObject(stats.tiers[key])) won += Number(stats.tiers[key].won ?? 0);
		}
	}
	stats.progress = { level: Ladder.FIRST_LEVEL + won, completed: won };

	// A v3 session was a one-off puzzle at a chosen difficulty. It has no level
	// number and cannot be given one honestly, so it is dropped -- losing one
	// unfinished puzzle is a smaller cost than resuming into a level that lies
	// about where the player is.
	document.session = {};
	return document;
}

/**
 * v4 gave every level its own three lives; v5 gives the run nine and scores it.
 *
 * The run starts full rather than inheriting anything. There is no score to
 * carry over, and starting a scored run on a partly spent bar would penalise a
 * player for mistakes made under rules that did not charge for them.
 *
 * A suspended level kept its lives left; what v5 wants from it is the mistakes
 * already made on that board, which is what the old three were counting down.
 */
export function migrateV4ToV5(data) {
	const document = structuredClone(data);
	document.version = 5;

	const stats = document.stats;
	if (isObject(stats)) {
		stats.run = emptyRun();
		stats.high_score = 0;
	}

	const session = document.session;
	if (isObject(session) && "lives" in session) {
		session.mistakes = Math.max(V4_LIVES - Number(session.lives ?? V4_LIVES), 0);
		delete session.lives;
	}
	return document;
}

function tierFromName(name) {
	return V1_TIER_NAMES[name.toLowerCase()] ?? Grid.Tier.EASY;
}

/** v1 stored one small integer per cell; v2 stores one character per cell. */
function marksToString(raw, cells) {
	let out = "";
	const values = Array.isArray(raw) ? raw : [];
	for (let i = 0; i < cells; i += 1) {
		const mark = i < values.length ? Number(values[i]) : 0;
		out += V1_MARKS[Math.min(Math.max(mark, 0), V1_MARKS.length - 1)];
	}
	return out;
}

function isObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
