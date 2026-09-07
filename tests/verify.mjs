/**
 * Self-check for the puzzle layer.
 *
 *     node tests/verify.mjs
 *
 * Nothing here touches the DOM, so the whole layer runs under plain Node. Plain
 * assertions rather than a framework, so it runs with nothing installed.
 *
 * The fixture is the four-by-four tutorial board: teal, orange, green and rose
 * regions, with the green region a single cell.
 *
 *     A B C B     A teal     solution: row 0 -> col 2
 *     A B B B     B orange             row 1 -> col 0
 *     A A D B     C green               row 2 -> col 3
 *     A D D B     D rose                row 3 -> col 1
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import * as Grid from "../js/puzzle/grid.js";
import * as Solver from "../js/puzzle/solver.js";
import * as Rater from "../js/puzzle/rater.js";
import * as Generator from "../js/puzzle/generator.js";
import * as Ladder from "../js/puzzle/ladder.js";
import * as Bank from "../js/puzzle/bank.js";
import * as Migration from "../js/save-migration.js";
import { MAX_LIVES, POINTS_PER_CAT, POINTS_PER_LEVEL } from "../js/scoring.js";
import { CatLevel } from "../js/puzzle/level.js";
import { PuzzleState } from "../js/puzzle-state.js";
import { UndoStack } from "../js/commands/undo-stack.js";
import { SetMarkCommand } from "../js/commands/set-mark-command.js";
import { CrossRunCommand } from "../js/commands/cross-run-command.js";
import { ClearBoardCommand } from "../js/commands/clear-board-command.js";
import { Rng } from "../js/util/rng.js";
import { GameState } from "../js/game-state.js";
import { Emitter } from "../js/util/emitter.js";

const TUTORIAL_REGIONS = "ABCBABBBAADBADDB";
const TUTORIAL_COLUMNS = [2, 0, 3, 1];
const SIZE = 4;

let passed = 0;
const failures = [];
let suite = "";

function group(name) {
	suite = name;
	process.stdout.write(`\n${name}\n`);
}

function check(message, condition) {
	if (condition) {
		passed += 1;
		return;
	}
	failures.push(`${suite}: ${message}`);
	process.stdout.write(`  FAIL  ${message}\n`);
}

function eq(message, actual, expected) {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) process.stdout.write(`         got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}\n`);
	check(message, ok);
}

const tutorialRegions = () => Grid.regionsFromString(TUTORIAL_REGIONS);

/** Cells in the smallest colour of a stored region string. */
function smallestRegion(regions) {
	const counts = new Map();
	for (const ch of regions) counts.set(ch, (counts.get(ch) ?? 0) + 1);
	return Math.min(...counts.values());
}

// --- The rules --------------------------------------------------------------

group("Rules and geometry");
{
	const regions = tutorialRegions();
	eq("sixteen cells", regions.length, SIZE * SIZE);
	eq("region string round trips", Grid.regionsToString(regions), TUTORIAL_REGIONS);
	check("every region is one connected blob", Grid.regionsAreConnected(SIZE, regions));
	check("the intended placement is legal",
		Grid.isValidSolution(SIZE, regions, TUTORIAL_COLUMNS));
	eq("columns round trip", [...Grid.columnsFromString("2031")], TUTORIAL_COLUMNS);
}

// --- Solving ----------------------------------------------------------------

group("Solver");
{
	const regions = tutorialRegions();
	eq("solver reproduces the tutorial answer",
		[...Solver.solve(SIZE, regions, Solver.openConstraints(SIZE))], TUTORIAL_COLUMNS);
	eq("exactly one placement satisfies every rule",
		Solver.countSolutions(SIZE, regions, Solver.openConstraints(SIZE), 3), 1);

	// [2, 3, 0, 1] satisfies one-per-row, one-per-column and one-per-colour. It is
	// only excluded because the cats in rows 0 and 1 would touch diagonally. Drop
	// the adjacency rule and this board would have two answers, which is how we
	// know the rule is really there.
	const rival = [2, 3, 0, 1];
	const seenCols = new Set();
	const seenRegions = new Set();
	for (let row = 0; row < SIZE; row += 1) {
		seenCols.add(rival[row]);
		seenRegions.add(regions[Grid.indexOf(SIZE, row, rival[row])]);
	}
	eq("the rival uses every column once", seenCols.size, SIZE);
	eq("the rival uses every colour once", seenRegions.size, SIZE);
	check("but its first two cats touch", Grid.touching(0, rival[0], 1, rival[1]));
	check("so it is not a legal placement", !Grid.isValidSolution(SIZE, regions, rival));

	// An unconstrained board with every cell its own colour has many placements.
	const open = new Uint8Array(SIZE * SIZE);
	for (let row = 0; row < SIZE; row += 1) {
		for (let col = 0; col < SIZE; col += 1) open[Grid.indexOf(SIZE, row, col)] = row;
	}
	eq("counting short-circuits at the limit",
		Solver.countSolutions(SIZE, open, Solver.openConstraints(SIZE), 2), 2);

	const allowed = Solver.openConstraints(SIZE);
	allowed[0] = 1 << 2; // pin row 0 to the green cell, where it has to go anyway
	eq("a correct constraint leaves the answer alone",
		Solver.countSolutions(SIZE, regions, allowed, 3), 1);
	allowed[0] = Grid.fullMask(SIZE) & ~(1 << 2); // now forbid it
	eq("and forbidding it leaves no answer",
		Solver.countSolutions(SIZE, regions, allowed, 3), 0);

	check("a board with one answer has no rival",
		Solver.findRival(SIZE, regions, TUTORIAL_COLUMNS).length === 0);
}

// --- The ladder -------------------------------------------------------------

group("Ladder");
{
	eq("level 1 is Easy", Ladder.tierFor(Ladder.FIRST_LEVEL), Grid.Tier.EASY);
	eq("the board is a 10x10", Ladder.SIZE, 10);
	check("and one the grid can build",
		Ladder.SIZE >= Grid.MIN_SIZE && Ladder.SIZE <= Grid.MAX_SIZE);

	for (const [level, tier] of Object.entries({
		1: Grid.Tier.EASY,
		8: Grid.Tier.MEDIUM,
		15: Grid.Tier.HARD,
		22: Grid.Tier.EXPERT,
	})) {
		eq(`level ${level} is ${Grid.tierName(tier)}`, Ladder.tierFor(Number(level)), tier);
	}

	let ramps = true;
	let lastTier = -1;
	for (let level = Ladder.FIRST_LEVEL; level < 400; level += 1) {
		const tier = Ladder.tierFor(level);
		if (tier < lastTier || tier > Grid.Tier.EXPERT) ramps = false;
		lastTier = tier;
	}
	check("the tier climbs without dipping and stops at Expert", ramps);

	eq("the ramp reaches Expert on its last level",
		Ladder.tierFor(Ladder.RAMP_LEVELS), Grid.Tier.EXPERT);
	eq("and stays there however far the levels run",
		Ladder.tierFor(5100), Grid.Tier.EXPERT);
	eq("single-square colours stop at the advertised level",
		Ladder.minRegionCells(Ladder.NO_SINGLE_CELL_REGIONS_FROM), 2);
	eq("and are allowed before it",
		Ladder.minRegionCells(Ladder.NO_SINGLE_CELL_REGIONS_FROM - 1), 1);

	check("every board the ladder asks for is the one size",
		Ladder.combinations().every((spec) => spec.size === Ladder.SIZE));
}

// --- Rating -----------------------------------------------------------------

group("Rater");
{
	const level = new CatLevel();
	level.size = SIZE;
	level.regions = tutorialRegions();
	level.columns = Uint8Array.from(TUTORIAL_COLUMNS);
	const rating = Rater.rate(level);
	check("the tutorial board solves logically", rating.solved);
	eq("with nothing harder than last-one-standing",
		rating.hardest, Rater.Technique.FORCED_SINGLE);
	eq("so it rates Easy", rating.tier, Grid.Tier.EASY);

	const hint = Rater.findHint(level, new Uint8Array(SIZE * SIZE));
	check("a hint is offered on an untouched board", hint.ok);
	check("and it names a cell in the solution", level.isSolutionCell(hint.index));

	const solvedMarks = new Uint8Array(SIZE * SIZE);
	for (let row = 0; row < SIZE; row += 1) solvedMarks[level.solutionIndex(row)] = Grid.Mark.CAT;
	const done = Rater.findHint(level, solvedMarks);
	check("a finished board offers no hint", !done.ok);
}

// --- Generation -------------------------------------------------------------

group("Generator");
{
	let legal = true;
	let unique = true;
	let connected = true;
	let onTier = true;
	for (const tier of Grid.TIER_VALUES) {
		for (const size of [5, 6, 7]) {
			const level = Generator.generate(tier, 0, Generator.DEFAULT_MAX_ATTEMPTS, size);
			if (level === null) {
				onTier = false;
				continue;
			}
			if (!Grid.isValidSolution(level.size, level.regions, level.columns)) legal = false;
			if (!Grid.regionsAreConnected(level.size, level.regions)) connected = false;
			if (!Solver.hasUniqueSolution(level.size, level.regions,
				Solver.openConstraints(level.size))) unique = false;
			if (level.tier !== tier || level.size !== size) onTier = false;
		}
	}
	check("every generated placement is legal", legal);
	check("every generated board has exactly one solution", unique);
	check("every region is one connected blob", connected);
	check("every board lands on the tier and size asked for", onTier);

	const seed = 987654321;
	const first = Generator.generate(Grid.Tier.MEDIUM, seed, Generator.DEFAULT_MAX_ATTEMPTS, 6);
	const second = Generator.generate(Grid.Tier.MEDIUM, seed, Generator.DEFAULT_MAX_ATTEMPTS, 6);
	check("the same seed produces the identical board",
		first !== null && second !== null
		&& Grid.regionsToString(first.regions) === Grid.regionsToString(second.regions)
		&& Grid.columnsToString(first.columns) === Grid.columnsToString(second.columns)
		&& first.attempts === second.attempts);

	const deep = Generator.generate(Grid.Tier.EXPERT, 0, Generator.DEFAULT_MAX_ATTEMPTS, 8,
		new Set(), 2);
	check("no colour is a single square when the ladder forbids it",
		deep !== null && deep.smallestRegion() >= 2);

	const rng = new Rng(12345);
	const placement = Generator.randomPlacement(9, rng);
	let placementLegal = placement.length === 9;
	for (let row = 1; row < placement.length; row += 1) {
		if (Grid.touching(row, placement[row], row - 1, placement[row - 1])) placementLegal = false;
	}
	check("a random placement never puts two cats together", placementLegal);
}

// --- Rating in both directions ----------------------------------------------

group("Tier claims");
{
	// A level rated tier N must solve with N's cap and *not* with N-1's. That
	// second half is what makes the tier claim mean anything.
	let honest = true;
	let checked = 0;
	for (const tier of Grid.TIER_VALUES) {
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const level = Generator.generate(tier, 0, Generator.DEFAULT_MAX_ATTEMPTS, 7);
			// A pinned size the tier does not normally draw from can come back
			// off-tier; there is nothing to claim about one of those.
			if (level === null || level.tier !== tier) continue;
			checked += 1;
			if (!Rater.rate(level, Rater.capForTier(tier)).solved) honest = false;
			if (tier > Grid.Tier.EASY
				&& Rater.rate(level, Rater.capForTier(tier - 1)).solved) honest = false;
		}
	}
	check(`a level solves at its own tier and no lower (${checked} levels)`, honest && checked > 0);
}

// --- The shipped bank -------------------------------------------------------

group("Level bank");
{
	const path = fileURLToPath(new URL("../content/level_bank.json", import.meta.url));
	const document = JSON.parse(readFileSync(path, "utf8"));
	Bank.seed(document);

	let total = 0;
	let legal = true;
	let unique = true;
	let rated = true;
	let connected = true;
	for (const tier of Grid.TIER_VALUES) {
		for (const entry of Bank.entriesFor(tier)) {
			total += 1;
			const level = CatLevel.fromJSON(entry);
			if (level === null || !Grid.isValidSolution(level.size, level.regions, level.columns)) {
				legal = false;
				continue;
			}
			if (!Grid.regionsAreConnected(level.size, level.regions)) connected = false;
			if (!Solver.hasUniqueSolution(level.size, level.regions,
				Solver.openConstraints(level.size))) unique = false;
			const rating = Rater.rate(level);
			if (!rating.solved || rating.tier !== tier) rated = false;
		}
	}
	check(`the bank holds levels (${total})`, total > 0);
	check("every shipped level is a legal placement", legal);
	check("every shipped level has exactly one solution", unique);
	check("every shipped region is one connected blob", connected);
	check("every shipped level rates to the tier it is filed under", rated);

	// Every board the ladder can ask for must be in the bank, or a player hits a
	// stutter while the game generates one live. The minimum colour size counts:
	// past NO_SINGLE_CELL_REGIONS_FROM the bank is filtered down to the entries
	// that have no one-square colour, and those have to exist.
	let covered = true;
	for (const spec of Ladder.combinations()) {
		const found = Bank.entriesFor(spec.tier).some((entry) =>
			Number(entry.size) === spec.size
			&& smallestRegion(String(entry.regions ?? "")) >= spec.minRegion);
		if (!found) covered = false;
	}
	check("the bank covers every board the ladder asks for", covered);

	const rng = new Rng(4242);
	const drawn = Bank.take(Grid.Tier.HARD, rng, Ladder.SIZE);
	check("a level can be drawn from the bank",
		drawn !== null && drawn.size === Ladder.SIZE);
	const fingerprint = drawn.fingerprint();
	const again = Bank.take(Grid.Tier.HARD, rng, Ladder.SIZE, new Set([fingerprint]));
	check("and a board already seen is skipped",
		again !== null && again.fingerprint() !== fingerprint);
}

// --- Commands and undo ------------------------------------------------------

group("Commands");
{
	const level = new CatLevel();
	level.size = SIZE;
	level.regions = tutorialRegions();
	level.columns = Uint8Array.from(TUTORIAL_COLUMNS);

	const state = new PuzzleState();
	state.setup(level);
	const history = new UndoStack();

	history.push(SetMarkCommand.create(state, 1, Grid.Mark.EXCLUDED), state);
	eq("a cross lands on the board", state.marks[1], Grid.Mark.EXCLUDED);
	check("and can be undone", history.canUndo());
	history.undo(state);
	eq("undo puts the cell back", state.marks[1], Grid.Mark.EMPTY);
	history.redo(state);
	eq("redo puts it back again", state.marks[1], Grid.Mark.EXCLUDED);

	// A drag is one undo step, not one per cell.
	const run = CrossRunCommand.create(Grid.Mark.EXCLUDED);
	for (const index of [4, 5, 6, 7]) run.extend(state, index);
	history.pushApplied(run, state);
	eq("a drag crossed its whole run", [4, 5, 6, 7].map((i) => state.marks[i]),
		[1, 1, 1, 1]);
	const depth = history.depth();
	history.undo(state);
	eq("and takes back in one press", [4, 5, 6, 7].map((i) => state.marks[i]), [0, 0, 0, 0]);
	eq("as a single step", history.depth(), depth - 1);

	// A drag never disturbs a cat.
	state.put(9, Grid.Mark.CAT);
	const overCat = CrossRunCommand.create(Grid.Mark.EXCLUDED);
	check("a drag skips a cell holding a cat", !overCat.extend(state, 9));
	eq("leaving the cat where it was", state.marks[9], Grid.Mark.CAT);

	// Clearing leaves the game's own red cells alone.
	state.put(3, Grid.Mark.WRONG);
	state.put(2, Grid.Mark.EXCLUDED);
	const clear = ClearBoardCommand.create(state);
	clear.apply(state);
	eq("clearing wipes the player's cross", state.marks[2], Grid.Mark.EMPTY);
	eq("but not a cell the game proved wrong", state.marks[3], Grid.Mark.WRONG);
	eq("nor a cat", state.marks[9], Grid.Mark.CAT);
	clear.revert(state);
	eq("and it comes back in one press", state.marks[2], Grid.Mark.EXCLUDED);

	// A drag commits to one axis, decided by the first cell it reaches, and then
	// ignores everything off that line.
	const axis = new PuzzleState();
	axis.setup(level);
	const down = CrossRunCommand.create(Grid.Mark.EXCLUDED);
	// Walking a column: cells 1, 5, 9, 13 on a 4x4 all share column 1.
	for (const index of [1, 5, 9, 13]) down.extend(axis, index);
	eq("a column run crosses its whole column",
		[1, 5, 9, 13].map((i) => axis.marks[i]), [1, 1, 1, 1]);
	eq("and leaves the rest of the board alone", axis.marks[2], Grid.Mark.EMPTY);

	// A command recorded before a cell was settled must not repaint over it. Cross
	// a cell, clear the board, then lose a life on that same cell: the clear
	// command still holds the old cross, and reverting it blindly would wipe the
	// red the game paid a life to establish.
	const stale = new PuzzleState();
	stale.setup(level);
	stale.put(5, Grid.Mark.EXCLUDED);
	const staleClear = ClearBoardCommand.create(stale);
	staleClear.apply(stale);
	stale.put(5, Grid.Mark.WRONG); // the game locks it after the command was made
	staleClear.revert(stale);
	eq("undo cannot repaint over a cell the game locked", stale.marks[5], Grid.Mark.WRONG);

	const staleMark = SetMarkCommand.create(stale, 6, Grid.Mark.EXCLUDED);
	staleMark.apply(stale);
	stale.put(6, Grid.Mark.CAT);
	staleMark.revert(stale);
	eq("nor over a cat placed since", stale.marks[6], Grid.Mark.CAT);

	// History survives a round trip through storage.
	const restored = new UndoStack();
	restored.fromJSON(JSON.parse(JSON.stringify(history.toJSON())));
	eq("history survives serialization", restored.depth(), history.depth());
	check("a truncated command is dropped rather than trusted",
		CrossRunCommand.fromJSON({ m: 1, i: [1, 2, 3], o: [0] }) === null);

	// Depth is capped so the save cannot grow without limit.
	const capped = new UndoStack();
	const scratch = new PuzzleState();
	scratch.setup(level);
	for (let i = 0; i < UndoStack.MAX_DEPTH + 25; i += 1) {
		capped.push(SetMarkCommand.create(scratch, i % (SIZE * SIZE), Grid.Mark.EXCLUDED), scratch);
	}
	eq("the undo stack stops growing at its cap", capped.depth(), UndoStack.MAX_DEPTH);
}

// --- Board model ------------------------------------------------------------

group("Board model");
{
	const level = new CatLevel();
	level.size = SIZE;
	level.regions = tutorialRegions();
	level.columns = Uint8Array.from(TUTORIAL_COLUMNS);
	const state = new PuzzleState();
	state.setup(level);

	check("an empty board is not complete", !state.isComplete());
	for (let row = 0; row < SIZE; row += 1) state.put(level.solutionIndex(row), Grid.Mark.CAT);
	check("the solution completes it", state.isComplete());
	eq("and every cat is counted", state.catsPlaced(), SIZE);

	const wrong = new PuzzleState();
	wrong.setup(level);
	wrong.put(0, Grid.Mark.CAT); // row 0 col 0, not the answer
	check("a cat off the solution is wrong", wrong.isWrongCat(0));
	check("locked cells cannot be edited", wrong.isLocked(0));

	const marks = state.marksToString();
	const round = new PuzzleState();
	round.setup(level);
	round.marksFromString(marks);
	eq("marks round trip through a string", round.marksToString(), marks);
	check("a board round trips through JSON",
		new PuzzleState().fromJSON(JSON.parse(JSON.stringify(state.toJSON()))));
}

// --- Save migration ---------------------------------------------------------

group("Save migration");
{
	const marks = new Array(SIZE * SIZE).fill(0);
	marks[0] = 1; // a cross
	marks[2] = 2; // a cat
	const v1 = {
		version: 1,
		size: SIZE,
		regions: TUTORIAL_REGIONS,
		solution: "2031",
		seed: 4242,
		marks,
		elapsed: 128.5,
		mistakes: 1,
		difficulty: "Hard",
		stats: {
			easy: { played: 5, won: 4, best: 90 },
			hard: { played: 3, won: 1, best: 420 },
		},
	};

	const migrated = Migration.migrate(structuredClone(v1));
	eq("version was bumped", migrated.version, Migration.CURRENT_VERSION);
	check("the document has stats", "stats" in migrated);
	check("and a progression to resume from", "progress" in migrated.stats);
	eq("wins carried into the progression", migrated.stats.progress.completed, 5);

	eq("an old save carries on from the level it left off on",
		Migration.normalize({ stats: { progress: { level: 42, completed: 41 } } })
			.stats.progress.playing, 42);
	eq("a save that names both keeps them apart",
		Migration.normalize({ stats: { progress: { level: 120, playing: 4 } } })
			.stats.progress.playing, 4);
	eq("and the furthest reached is never behind the level being played",
		Migration.normalize({ stats: { progress: { level: 3, playing: 70 } } })
			.stats.progress.level, 70);

	const session = Migration.migrateV1ToV2(structuredClone(v1)).session;
	eq("one character per cell", session.board.marks.length, SIZE * SIZE);
	eq("a cross became x", session.board.marks[0], "x");
	eq("a cat became c", session.board.marks[2], "c");
	eq("an empty cell became a dot", session.board.marks[1], ".");
	eq("difficulty name became a tier value", session.tier, Grid.Tier.HARD);
	eq("elapsed time carried over", session.elapsed, 128.5);
	eq("hint count defaults to zero", session.hints, 0);
	eq("v1 had no history, so it starts empty", session.history.undo, []);

	const board = new PuzzleState();
	check("a migrated board loads", board.fromJSON(session.board));
	eq("the player's cat survived", board.marks[2], Grid.Mark.CAT);
	check("and the level it references is legal", board.level.isValid());

	// A wrong cat could exist under v2's rules but not under v3's.
	const v2 = {
		version: 2,
		session: {
			tier: 0,
			seed: 1,
			board: {
				level: { size: SIZE, regions: TUTORIAL_REGIONS, columns: "2031", tier: 0, seed: 1 },
				marks: "cx..............",
			},
			history: { undo: [{ t: "mark", i: 0, m: 2, o: 0 }], redo: [] },
		},
		stats: Migration.emptyStats(),
	};
	const v3 = Migration.migrateV2ToV3(v2);
	eq("a wrong cat is lifted", v3.session.board.marks[0], ".");
	eq("but the player's crosses are kept", v3.session.board.marks[1], "x");
	eq("and history recorded under the old rules is dropped", v3.session.history.undo, []);

	const v4 = Migration.migrateV3ToV4({ version: 3, session: { anything: 1 }, stats: {
		tiers: { 0: { won: 7 }, 1: { won: 5 } },
	} });
	eq("a v3 session is dropped rather than mislabelled", Object.keys(v4.session).length, 0);
	eq("and the level to resume on comes from total wins", v4.stats.progress.level, 13);

	const v5 = Migration.migrateV4ToV5({
		version: 4,
		session: { level: 12, lives: 2, hints: 1 },
		stats: Migration.emptyStats(),
	});
	eq("a v5 run starts on a full bar", v5.stats.run.lives, MAX_LIVES);
	eq("with nothing scored yet", v5.stats.run.score, 0);
	eq("and no high score to beat", v5.stats.high_score, 0);
	eq("a suspended level keeps the mistakes its lives were counting",
		v5.session.mistakes, 1);
	check("and stops carrying lives of its own", !("lives" in v5.session));

	check("a document with no version is discarded",
		Object.keys(Migration.migrate({ stats: { anything: 1 } }).session).length === 0);
	check("so is one from a newer build",
		Migration.migrate({ version: 99, stats: { hints_used: 5 } }).stats.hints_used === 0);

	const normalized = Migration.normalize({ version: 5, session: {}, stats: {} });
	check("normalize fills in every block a partial document is missing",
		"tiers" in normalized.stats && "streak" in normalized.stats
		&& "progress" in normalized.stats && "seen" in normalized.stats
		&& "run" in normalized.stats && "high_score" in normalized.stats);
	eq("a run cannot hold more lives than the rules allow",
		Migration.normalize({ stats: { run: { score: 10, lives: 99 } } }).stats.run.lives,
		MAX_LIVES);
	eq("and the high score is never behind the score being played",
		Migration.normalize({ stats: { run: { score: 250, lives: 4 }, high_score: 10 } })
			.stats.high_score, 250);
	eq("a day-counting streak is reset rather than reinterpreted",
		Migration.normalize({ version: 4, session: {}, stats: {
			streak: { current: 9, best: 12, last_win_day: 1234 },
		} }).stats.streak, { current: 0, best: 0 });
}

// --- Seeded randomness ------------------------------------------------------

group("Seeded randomness");
{
	const a = new Rng(42);
	const b = new Rng(42);
	const first = [a.nextUint32(), a.nextUint32(), a.nextUint32()];
	const second = [b.nextUint32(), b.nextUint32(), b.nextUint32()];
	eq("the same seed gives the same stream", first, second);
	check("and the values are 32-bit unsigned",
		first.every((value) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff));

	const different = new Rng(43);
	check("a different seed gives a different stream",
		different.nextUint32() !== first[0]);

	const spread = new Rng(7);
	const counts = new Int32Array(5);
	for (let i = 0; i < 5000; i += 1) counts[spread.randiRange(0, 4)] += 1;
	check("randiRange covers its whole inclusive span",
		[...counts].every((count) => count > 800));
}


// --- Scoring and lives ------------------------------------------------------

/**
 * Enough of a SaveManager for GameState to run against: it holds the run and
 * counts what it was told, and touches no storage. The real one is checked by
 * the migration group above.
 */
class FakeSave extends Emitter {
	constructor(lives = MAX_LIVES, score = 0) {
		super();
		this.stored = { score, lives };
		this.high = score;
		this.wins = [];
		this.losses = 0;
		this.runsEnded = 0;
	}

	runLives() { return this.stored.lives; }
	runScore() { return this.stored.score; }
	highScore() { return this.high; }

	recordRun(score, lives) {
		this.stored = { score, lives };
		this.high = Math.max(this.high, score);
	}

	endRun() {
		this.runsEnded += 1;
		this.stored = { score: 0, lives: MAX_LIVES };
	}

	recordWin(level, tier, seconds, mistakes, hints) {
		this.wins.push({ level, mistakes, hints });
	}

	recordLoss() { this.losses += 1; }

	playingLevel() { return 1; }
	hasSession() { return false; }
	session() { return {}; }
	seenFingerprints() { return new Set(); }
	clearSession() {}
	recordSeen() {}
	recordStarted() {}
	submitSession() {}
	flush() {}
}

function tutorialLevel() {
	const level = new CatLevel();
	level.size = SIZE;
	level.regions = tutorialRegions();
	level.columns = Uint8Array.from(TUTORIAL_COLUMNS);
	level.tier = Grid.Tier.EASY;
	return level;
}

/** A game sitting on the tutorial board, with its clock stopped. */
function startedGame(lives = MAX_LIVES, score = 0) {
	const save = new FakeSave(lives, score);
	const game = new GameState(save);
	clearInterval(game._tickHandle);
	game._accept(tutorialLevel());
	return { game, save };
}

/** Every cell that is not part of the answer, in order. */
function wrongCells(level) {
	const out = [];
	for (let index = 0; index < SIZE * SIZE; index += 1) {
		if (!level.isSolutionCell(index)) out.push(index);
	}
	return out;
}

function solve(game) {
	for (let row = 0; row < SIZE; row += 1) game.toggleCat(game.board.level.solutionIndex(row));
}

group("Scoring and lives");
{
	const { game } = startedGame();
	eq("a run starts on a full bar", game.livesLeft, MAX_LIVES);
	eq("with nothing scored", game.score, 0);

	const first = game.board.level.solutionIndex(0);
	game.toggleCat(first);
	eq("a cat is worth its points", game.score, POINTS_PER_CAT);
	game.toggleCat(first);
	eq("and tapping it again pays nothing", game.score, POINTS_PER_CAT);

	// Three cats left on a four-row board, then the level bonus.
	const { game: clean, save: cleanSave } = startedGame();
	solve(clean);
	check("a solved board is finished", clean.finished);
	eq("a clean level pays double",
		clean.score, POINTS_PER_CAT * SIZE + POINTS_PER_LEVEL * 2);
	eq("and cannot push the bar past full", clean.livesLeft, MAX_LIVES);
	eq("the win was recorded with no mistakes", cleanSave.wins[0].mistakes, 0);

	const { game: hurt } = startedGame(MAX_LIVES - 2);
	eq("a run resumes on the lives it had left", hurt.livesLeft, MAX_LIVES - 2);
	solve(hurt);
	eq("a clean level hands one life back", hurt.livesLeft, MAX_LIVES - 1);
	eq("and still pays double", hurt.score, POINTS_PER_CAT * SIZE + POINTS_PER_LEVEL * 2);

	const { game: slipped } = startedGame(MAX_LIVES - 2);
	slipped.toggleCat(wrongCells(slipped.board.level)[0]);
	eq("a wrong cat costs a life", slipped.livesLeft, MAX_LIVES - 3);
	eq("and scores nothing", slipped.score, 0);
	solve(slipped);
	eq("a level with a mistake pays once",
		slipped.score, POINTS_PER_CAT * SIZE + POINTS_PER_LEVEL);
	eq("and hands no life back", slipped.livesLeft, MAX_LIVES - 3);

	// A hint places a cat itself, so the board finishes a cat short of the full
	// placement points as well as short of the bonus.
	const { game: hinted } = startedGame(MAX_LIVES - 1);
	hinted.useHint();
	solve(hinted);
	check("a hinted board still completes", hinted.finished);
	eq("but it is not clean, so no life comes back", hinted.livesLeft, MAX_LIVES - 1);

	const { game: doomed, save: doomedSave } = startedGame(2, 500);
	const wrong = wrongCells(doomed.board.level);
	doomed.toggleCat(wrong[0]);
	doomed.toggleCat(wrong[1]);
	eq("the last life goes", doomed.livesLeft, 0);
	check("which ends the level", doomed.finished);
	eq("the run was ended in the save", doomedSave.runsEnded, 1);
	eq("the score went back to zero", doomedSave.stored.score, 0);
	eq("on a full bar again", doomedSave.stored.lives, MAX_LIVES);
	eq("and the best score survived it", doomedSave.highScore(), 500);

	// Restarting is a fresh board, not a fresh record.
	const { game: retried } = startedGame(MAX_LIVES);
	retried.toggleCat(wrongCells(retried.board.level)[0]);
	retried.restartLevel();
	eq("a restart keeps the lives already spent", retried.livesLeft, MAX_LIVES - 1);
	solve(retried);
	eq("and the level it restarted cannot count as clean",
		retried.livesLeft, MAX_LIVES - 1);
}

// --- Result -----------------------------------------------------------------

process.stdout.write(`\n${passed} checks passed`);
if (failures.length > 0) {
	process.stdout.write(`, ${failures.length} FAILED\n`);
	for (const failure of failures) process.stdout.write(`  ${failure}\n`);
	process.exit(1);
}
process.stdout.write(".\n");
