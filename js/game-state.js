import * as Grid from "./puzzle/grid.js";
import * as Ladder from "./puzzle/ladder.js";
import * as Rater from "./puzzle/rater.js";
import { PuzzleState } from "./puzzle-state.js";
import { UndoStack } from "./commands/undo-stack.js";
import { SetMarkCommand } from "./commands/set-mark-command.js";
import { CrossRunCommand } from "./commands/cross-run-command.js";
import { ClearBoardCommand } from "./commands/clear-board-command.js";
import { buildLevel, levelFromMessage } from "./builder.js";
import { MAX_LIVES, POINTS_PER_CAT, POINTS_PER_LEVEL } from "./scoring.js";
import { Emitter } from "./util/emitter.js";

/**
 * The running game.
 *
 * Everything the UI needs to know lives here, and everything it needs to say
 * comes back as an event. No view reaches into another view's DOM -- the board,
 * the toolbar and the top bar each listen for the events they care about and know
 * nothing about each other.
 *
 * The player is on a level, the level decides the board, and finishing one moves
 * them up. Ladder owns that mapping; SaveManager owns the number.
 *
 * Lives and the score belong to the run, not the level. They carry across levels
 * and only reset when the last life goes, so SaveManager holds them and this
 * class reads them back whenever a level starts.
 *
 * Generation runs in a Web Worker. Carving regions that admit exactly one
 * solution is a rejection loop, so the main thread stays free to draw the
 * "finding a level" overlay.
 */

export { MAX_LIVES } from "./scoring.js";

/**
 * Hints available per level. One: enough to unstick somebody who has genuinely
 * run out of ideas, not enough to solve the board with.
 */
export const HINTS_PER_LEVEL = 1;

/** How often the clock is sampled. Whole seconds are all the UI ever shows. */
const TICK_MS = 200;

/**
 * One long-lived worker and a request/reply protocol over it.
 *
 * Falls back to building on the main thread when workers are unavailable -- the
 * page stalls for a moment on the big boards, which is better than not running.
 */
class LevelWorker {
	constructor() {
		this._worker = null;
		this._pending = new Map();
		this._nextId = 1;
		try {
			this._worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
			this._worker.addEventListener("message", (event) => {
				const { id, level } = event.data;
				const resolve = this._pending.get(id);
				if (resolve === undefined) return;
				this._pending.delete(id);
				resolve(levelFromMessage(level));
			});
			this._worker.addEventListener("error", () => this._failAll());
		} catch {
			this._worker = null;
		}
	}

	build(level, seen) {
		if (this._worker === null) return buildLevel(level, seen);
		const id = this._nextId;
		this._nextId += 1;
		return new Promise((resolve) => {
			this._pending.set(id, resolve);
			this._worker.postMessage({ id, level, seen });
		});
	}

	_failAll() {
		for (const resolve of this._pending.values()) resolve(null);
		this._pending.clear();
	}
}

export class GameState extends Emitter {
	constructor(saveManager) {
		super();
		this.save = saveManager;
		this.board = new PuzzleState();
		this.history = new UndoStack();

		this.levelNumber = Ladder.FIRST_LEVEL;
		this.tier = Grid.Tier.EASY;
		this.seed = 0;
		this.selected = -1;
		this.livesLeft = saveManager.runLives();
		this.score = saveManager.runScore();
		/** Lives spent on the level in play, which the clean-level bonus turns on. */
		this.mistakesMade = 0;
		this.hintsUsed = 0;
		this.elapsed = 0;
		this.playing = false;
		this.finished = false;

		this._generating = false;
		this._lastWholeSecond = -1;
		this._tickHandle = null;
		this._tickStamp = 0;

		/**
		 * The next level, built while the player works on the current one.
		 *
		 * Carving a unique 10x10 Expert board takes seconds, and the shipped bank
		 * holds only so many -- past level 111 or so it runs dry and every level is
		 * generated live. Rather than make the player watch a spinner, the next
		 * board is built in the background the moment the current one loads. By the
		 * time they finish, it is already waiting.
		 */
		this._prefetched = null;
		this._prefetchedFor = 0;
		this._prefetchRunning = false;
		/** Which level the prefetch *should* be building, if it drifted. */
		this._prefetchWanted = 0;

		this._run = null;
		/** Where a drag started, and which axis it has committed to. */
		this._runOrigin = -1;
		this._runAxis = null;

		this._worker = new LevelWorker();
		this._prefetchWorker = new LevelWorker();

		this.board.on("cellsChanged", (indices) => this._onBoardCellsChanged(indices));
		this.history.on("changed", (canUndo, canRedo) => {
			this.emit("historyChanged", canUndo, canRedo);
		});
		this.save.on("saveRequested", () => this._onSaveRequested());
		this._startClock();
	}

	size() {
		return this.board.size();
	}

	mistakes() {
		return this.mistakesMade;
	}

	hintsLeft() {
		return Math.max(HINTS_PER_LEVEL - this.hintsUsed, 0);
	}

	// --- Starting, retrying and resuming ------------------------------------

	isGenerating() {
		return this._generating;
	}

	/** Generates the level the player is currently on. */
	async startLevel(requestedLevel = 0) {
		if (this._generating) return;
		this.levelNumber = requestedLevel > 0 ? requestedLevel : this.save.playingLevel();

		// Built already, while the last level was being played.
		if (this._prefetched !== null && this._prefetchedFor === this.levelNumber) {
			const ready = this._prefetched;
			this._prefetched = null;
			this._prefetchedFor = 0;
			this.emit("generationStarted", this.levelNumber);
			this._accept(ready);
			return;
		}

		this.playing = false;
		this._generating = true;
		this.emit("generationStarted", this.levelNumber);
		// Snapshotted here, on the main thread, so the worker never reaches into
		// SaveManager while the game is running.
		const seen = [...this.save.seenFingerprints(Ladder.SIZE)];
		const level = await this._worker.build(this.levelNumber, seen);
		this._generating = false;
		if (level === null) {
			this.emit("generationFinished", false);
			return;
		}
		this._accept(level);
	}

	/**
	 * Puts the same board back the way it started. Losing means starting this
	 * level over, not being handed a different one -- the point is to solve *this*
	 * puzzle, and swapping it out would let a player reroll their way past
	 * anything awkward.
	 */
	restartLevel() {
		if (this.board.level === null || this._generating) return;
		// A run that ended takes its penalties with it. One still going keeps
		// them, so restarting cannot buy back a spent hint or a lost life.
		const carryOn = this.livesLeft > 0;
		this._adoptRun();
		this._resetFor(this.board.level, carryOn);
	}

	/** Takes the score and the lives from the save, which owns them. */
	_adoptRun() {
		this.livesLeft = this.save.runLives();
		this.score = this.save.runScore();
	}

	_accept(level) {
		this._adoptRun();
		this._resetFor(level);
		this.save.recordSeen(level.size, level.fingerprint());
		this.save.recordStarted(this.levelNumber, level.tier);
		this.emit("generationFinished", true);
		this._startPrefetch(this.levelNumber + 1);
	}

	/**
	 * Starts building the level the player would get if they pressed Play right
	 * now, so sitting on the menu is not a dead moment. There is nothing to build
	 * when a suspended level is waiting to be resumed.
	 */
	prefetchUpcoming() {
		if (this.save.hasSession()) return;
		this._startPrefetch(this.save.playingLevel());
	}

	/**
	 * Begins building the level after this one. Does nothing while a build is
	 * already running -- that one re-checks what is wanted when it lands.
	 */
	async _startPrefetch(nextLevel) {
		this._prefetchWanted = nextLevel;
		if (this._prefetchRunning) return;
		if (this._prefetched !== null && this._prefetchedFor === nextLevel) return;
		this._prefetched = null;
		this._prefetchedFor = 0;

		this._prefetchRunning = true;
		const seen = [...this.save.seenFingerprints(Ladder.SIZE)];
		const level = await this._prefetchWorker.build(nextLevel, seen);
		this._prefetchRunning = false;

		// The player may have gone somewhere else while this was building. Throw it
		// away and start on what is actually wanted now.
		if (nextLevel !== this._prefetchWanted) {
			this._prefetched = null;
			this._prefetchedFor = 0;
			this._startPrefetch(this._prefetchWanted);
			return;
		}
		this._prefetched = level;
		this._prefetchedFor = nextLevel;
	}

	/**
	 * Puts a board up ready to play. `carryOn` keeps what this level has already
	 * cost, so a restart is a fresh board rather than a fresh record: the hint
	 * stays spent and the lives already lost still rule out the clean bonus.
	 */
	_resetFor(level, carryOn = false) {
		this._clearRun();
		this.board.setup(level);
		this.history.clear();
		this.tier = level.tier;
		this.seed = level.seed;
		this.selected = -1;
		if (!carryOn) {
			this.mistakesMade = 0;
			this.hintsUsed = 0;
		}
		this.elapsed = 0;
		this._lastWholeSecond = -1;
		this.finished = false;
		this.playing = true;
		this._announce();
	}

	resumeSavedGame() {
		const session = this.save.session();
		if (Object.keys(session).length === 0) return false;
		const restored = new PuzzleState();
		if (!restored.fromJSON(session.board ?? {})) return false;

		this._clearRun();
		this.board.setup(restored.level);
		this.board.marks = restored.marks;
		this.history.clear();
		this.history.fromJSON(session.history ?? {});

		this.levelNumber = Math.max(Number(session.level ?? Ladder.FIRST_LEVEL), Ladder.FIRST_LEVEL);
		this.tier = Number(session.tier ?? Grid.Tier.EASY);
		this.seed = Number(session.seed ?? 0);
		this._adoptRun();
		this.mistakesMade = Number(session.mistakes ?? 0);
		this.hintsUsed = Number(session.hints ?? 0);
		this.elapsed = Number(session.elapsed ?? 0);
		this.selected = Number(session.selected ?? -1);
		this._lastWholeSecond = -1;
		this.finished = false;
		this.playing = true;
		this._announce();
		this._startPrefetch(this.levelNumber + 1);
		return true;
	}

	_announce() {
		this.emit("levelLoaded");
		this.emit("selectionChanged", this.selected);
		this.emit("livesChanged", this.livesLeft, MAX_LIVES);
		this.emit("scoreChanged", this.score);
		this.emit("hintsChanged", this.hintsLeft());
		this.emit("catsChanged", this.board.catsPlaced(), this.size());
		this.emit("timeChanged", Math.floor(this.elapsed));
		this.emit("historyChanged", this.history.canUndo(), this.history.canRedo());
	}

	/** Leaves the level running in the save so the menu can offer Continue. */
	suspend() {
		this.playing = false;
		this.save.flush();
	}

	abandon() {
		this.playing = false;
		this.finished = true;
		this.save.clearSession();
	}

	// --- Player input -------------------------------------------------------

	select(index) {
		if (index === this.selected) return;
		this.selected = index;
		this.emit("selectionChanged", this.selected);
	}

	moveSelection(deltaRow, deltaColumn) {
		const n = this.size();
		if (n === 0) return;
		if (this.selected < 0) {
			this.select(0);
			return;
		}
		const row = Math.min(Math.max(Grid.rowOf(n, this.selected) + deltaRow, 0), n - 1);
		const col = Math.min(Math.max(Grid.colOf(n, this.selected) + deltaColumn, 0), n - 1);
		this.select(Grid.indexOf(n, row, col));
	}

	/**
	 * A plain tap cycles empty and crossed. Crossing out is the bulk of play, so it
	 * gets the cheap gesture. It is purely a note to yourself -- crossing the wrong
	 * cell costs nothing and is never checked.
	 */
	toggleCross(index) {
		if (!this._canEdit() || index < 0 || this.board.isLocked(index)) return;
		const next = this.board.marks[index] !== Grid.Mark.EMPTY
			? Grid.Mark.EMPTY : Grid.Mark.EXCLUDED;
		this._push(SetMarkCommand.create(this.board, index, next));
	}

	/**
	 * Placing a cat is the committing move, and the only one that can cost a life.
	 *
	 * A wrong cat is refused rather than placed: the cell turns red, a life goes,
	 * and the board stays clean. Leaving a cat there would block completion and
	 * mean the player had to tidy up after their own mistake, which is busywork on
	 * top of a penalty.
	 */
	toggleCat(index) {
		if (!this._canEdit() || index < 0 || this.board.isLocked(index)) return;
		if (!this.board.level.isSolutionCell(index)) {
			this._refuseCat(index);
			return;
		}
		// Placed directly rather than through the undo stack. A correct cat is a
		// fact, not an opinion -- it cannot turn out to be wrong later, so there is
		// nothing to take back. The undo stack is left holding only crosses, which
		// are exactly the marks a player might change their mind about.
		this.board.put(index, Grid.Mark.CAT);
		this.board.notify([index]);
		this._award(POINTS_PER_CAT);
		this._checkCompletion();
	}

	/**
	 * Adds to the run's score and writes it. Raising the best score is the save's
	 * job, and the menu is the only screen that shows it.
	 */
	_award(points) {
		this.score += points;
		this.save.recordRun(this.score, this.livesLeft);
		this.emit("scoreChanged", this.score);
	}

	/**
	 * A drag across a run of cells. The target mark is decided from the cell the
	 * drag starts on -- from an empty cell it crosses out, from a crossed cell it
	 * erases -- and every cell the drag reaches is set to that same mark. Fixing
	 * the target up front is what stops a drag flickering cells on and off as it
	 * wanders back over its own path.
	 *
	 * A drag stays on one axis. The first cell it reaches decides which: leave the
	 * starting cell sideways and it is a row, leave it vertically and it is a
	 * column, and from then on nothing off that line is touched.
	 *
	 * Committing to an axis is what makes the gesture safe to aim carelessly. A
	 * finger crossing a 10x10 board wanders by a cell or two without meaning to,
	 * and a free-form drag that can wipe a diagonal through your working is one
	 * you would have to aim precisely -- which defeats the point of it being the
	 * quick gesture.
	 *
	 * Settled cells are skipped entirely: a drag cannot disturb a cat or a red
	 * cross.
	 */
	beginCrossRun(index) {
		if (!this._canEdit() || this._run !== null || index < 0 || this.board.isLocked(index)) return;
		const mark = this.board.marks[index];
		if (mark === Grid.Mark.CAT) return;
		this.select(index);
		this._runOrigin = index;
		this._runAxis = null;
		this._run = CrossRunCommand.create(
			mark === Grid.Mark.EXCLUDED ? Grid.Mark.EMPTY : Grid.Mark.EXCLUDED);
		this.extendCrossRun(index);
	}

	extendCrossRun(index) {
		if (this._run === null || index < 0) return;
		if (!this._onRunAxis(index)) return;
		if (this._run.extend(this.board, index)) this.board.notify([index]);
	}

	/**
	 * Whether a cell is on the drag's line, deciding the axis if it is still open.
	 *
	 * A pointer moving fast can jump straight to a cell that shares neither the
	 * row nor the column of the start. That cell is skipped and the axis is left
	 * open, so the next one along can still settle it -- better than committing to
	 * a line the player never actually traced.
	 */
	_onRunAxis(index) {
		const n = this.size();
		const sameRow = Grid.rowOf(n, index) === Grid.rowOf(n, this._runOrigin);
		const sameColumn = Grid.colOf(n, index) === Grid.colOf(n, this._runOrigin);
		if (this._runAxis === null) {
			if (index === this._runOrigin) return true;
			if (sameRow) this._runAxis = "row";
			else if (sameColumn) this._runAxis = "column";
			else return false;
		}
		return this._runAxis === "row" ? sameRow : sameColumn;
	}

	/**
	 * Ends the gesture and records it as one undo step. The cells are already on
	 * the board, so the command is filed rather than re-applied.
	 */
	endCrossRun() {
		if (this._run === null) return;
		const run = this._run;
		this._clearRun();
		if (run.isEmpty()) return;
		this.history.pushApplied(run, this.board);
	}

	_clearRun() {
		this._run = null;
		this._runOrigin = -1;
		this._runAxis = null;
	}

	clearCell(index) {
		if (!this._canEdit() || index < 0 || this.board.isLocked(index)) return;
		if (this.board.marks[index] === Grid.Mark.EMPTY) return;
		this._push(SetMarkCommand.create(this.board, index, Grid.Mark.EMPTY));
	}

	/**
	 * Wipes the player's own marks in one step. Lives, the clock and the red cells
	 * are untouched: this is for starting your reasoning over, not the level.
	 */
	clearBoard() {
		if (!this._canEdit()) return;
		const command = ClearBoardCommand.create(this.board);
		if (command.isEmpty()) return;
		this._push(command);
	}

	undo() {
		if (this.finished) return;
		this.history.undo(this.board);
		this._checkCompletion();
	}

	redo() {
		if (this.finished) return;
		this.history.redo(this.board);
		this._checkCompletion();
	}

	/**
	 * Places the cat the logical solver says is next, once per level. Works from
	 * the board as it stands, so it also catches a board the player has already
	 * made unsolvable with their crosses.
	 */
	useHint() {
		if (this.finished || !this.playing) return;
		if (this.hintsLeft() <= 0) {
			this.emit("hintOffered", -1, "No hints left on this level.", false);
			return;
		}
		const hint = Rater.findHint(this.board.level, this.board.marks);
		if (!hint.ok) {
			this.emit("hintOffered", -1, hint.message, false);
			return;
		}
		this.hintsUsed += 1;
		this.emit("hintsChanged", this.hintsLeft());
		this.select(hint.index);
		this.board.put(hint.index, Grid.Mark.CAT);
		this.board.notify([hint.index]);
		this.emit("hintOffered", hint.index, hint.message, true);
		this._checkCompletion();
	}

	_push(command) {
		this.history.push(command, this.board);
	}

	_canEdit() {
		return this.playing && !this.finished && this.board.level !== null;
	}

	/**
	 * Every wrong cell is one the rules already ruled out, so there is no such
	 * thing as a placement that is only wrong in hindsight. That is what makes
	 * spending a life fair rather than arbitrary.
	 */
	_refuseCat(index) {
		this.mistakesMade += 1;
		this.livesLeft = Math.max(this.livesLeft - 1, 0);
		// Marked directly rather than pushed as a command. The cross is not a move
		// the player made, and undoing their way out of it would make the lost life
		// meaningless -- the same reason a spent life never comes back.
		const message = this.board.explainWrong(index);
		this.board.put(index, Grid.Mark.WRONG);
		this.board.notify([index]);
		this.emit("wrongCat", index, message);
		this.emit("livesChanged", this.livesLeft, MAX_LIVES);
		if (this.livesLeft > 0) {
			this.save.recordRun(this.score, this.livesLeft);
			return;
		}
		this.finished = true;
		this.playing = false;
		this.save.recordLoss();
		// The run ends in the save now, so a tab discarded on the result panel
		// comes back to a fresh one. The score stays on screen until the next
		// level starts: it is the last thing worth telling the player.
		this.save.endRun();
		this.save.clearSession();
		this.emit("levelFailed", this.score);
	}

	_checkCompletion() {
		if (this.finished || !this.board.isComplete()) return;
		this.finished = true;
		this.playing = false;
		const seconds = Math.floor(this.elapsed);
		// A clean level is one that cost nothing: no life spent on it and no hint
		// taken. It pays twice over, and hands a life back if there is room for it.
		const clean = this.mistakesMade === 0 && this.hintsUsed === 0;
		const regained = clean && this.livesLeft < MAX_LIVES;
		if (regained) {
			this.livesLeft += 1;
			this.emit("livesChanged", this.livesLeft, MAX_LIVES);
		}
		this._award(clean ? POINTS_PER_LEVEL * 2 : POINTS_PER_LEVEL);
		this.save.recordWin(this.levelNumber, this.tier, seconds, this.mistakesMade, this.hintsUsed);
		// `regained` is what the result card animates: it needs to draw the bar as
		// it was and then fill the heart in, which it cannot work out from a count
		// that has already been raised.
		this.emit("levelCompleted", this.levelNumber, seconds, this.hintsUsed, regained);
	}

	// --- Plumbing -----------------------------------------------------------

	_startClock() {
		this._tickStamp = performance.now();
		this._tickHandle = setInterval(() => this._tick(), TICK_MS);
	}

	_tick() {
		const now = performance.now();
		const delta = (now - this._tickStamp) / 1000;
		this._tickStamp = now;
		if (!this.playing || this.finished) return;
		this.elapsed += delta;
		const whole = Math.floor(this.elapsed);
		if (whole !== this._lastWholeSecond) {
			this._lastWholeSecond = whole;
			this.emit("timeChanged", whole);
		}
	}

	_onBoardCellsChanged(indices) {
		this.emit("cellsChanged", indices);
		this.emit("catsChanged", this.board.catsPlaced(), this.size());
	}

	/**
	 * Deliberately not gated on `playing`. suspend() stops the clock before asking
	 * for a save, and a paused level is exactly the one worth writing.
	 */
	_onSaveRequested() {
		if (this.finished || this.board.level === null) return;
		this.save.submitSession(this.toJSON());
	}

	toJSON() {
		return {
			level: this.levelNumber,
			tier: this.tier,
			seed: this.seed,
			board: this.board.toJSON(),
			elapsed: this.elapsed,
			mistakes: this.mistakesMade,
			hints: this.hintsUsed,
			selected: this.selected,
			history: this.history.toJSON(),
		};
	}
}
