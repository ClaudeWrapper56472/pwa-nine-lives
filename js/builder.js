import * as Ladder from "./puzzle/ladder.js";
import * as Bank from "./puzzle/bank.js";
import * as Generator from "./puzzle/generator.js";
import { CatLevel } from "./puzzle/level.js";
import { Rng } from "./util/rng.js";

/**
 * Takes a precomputed level when the bank has one, and falls back to generating.
 *
 * Reads nothing but its arguments, which is what lets the worker run it. `seen`
 * arrives as a plain array because a Set does not survive postMessage in every
 * browser.
 */
export async function buildLevel(targetLevel, seenList) {
	await Bank.load();
	const tier = Ladder.tierFor(targetLevel);
	const size = Ladder.SIZE;
	const minRegion = Ladder.minRegionCells(targetLevel);
	const seen = new Set(seenList.map(Number));
	const rng = new Rng(Rng.randomSeed());

	let level = Bank.take(tier, rng, size, seen, minRegion);
	if (level === null) {
		level = Generator.generate(tier, 0, Generator.DEFAULT_MAX_ATTEMPTS, size, seen, minRegion);
	}
	return level;
}

/**
 * The level as a plain object, for crossing a worker boundary. The rating is
 * dropped: nothing outside generation reads it, and it would not survive
 * structured cloning as a class anyway.
 */
export function levelToMessage(level) {
	return level === null ? null : level.toJSON();
}

export function levelFromMessage(data) {
	return data === null ? null : CatLevel.fromJSON(data);
}
