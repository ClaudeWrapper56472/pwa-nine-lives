import * as Ladder from "./puzzle/ladder.js";
import * as Generator from "./puzzle/generator.js";
import { CatLevel } from "./puzzle/level.js";

/**
 * Builds the board for a level number. Every level is carved fresh, so no two
 * players and no two runs get the same one.
 *
 * Reads nothing but its arguments, which is what lets the worker run it. `seen`
 * arrives as a plain array because a Set does not survive postMessage in every
 * browser.
 */
export async function buildLevel(targetLevel, seenList) {
	const minRegion = Ladder.minRegionCells(targetLevel);
	const seen = new Set(seenList.map(Number));
	// Seed 0 means draw a fresh one.
	return Generator.generate(Ladder.TIER, 0, Generator.DEFAULT_MAX_ATTEMPTS, Ladder.SIZE,
		seen, minRegion);
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
