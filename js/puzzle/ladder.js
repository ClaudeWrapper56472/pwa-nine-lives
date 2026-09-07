import * as Grid from "./grid.js";

/**
 * Turns a level number into a board to generate.
 *
 * Every board is the same size. What climbs is the reasoning: the techniques a
 * level demands ramp from Easy to Expert over the first RAMP_LEVELS levels and
 * stay at Expert after that, so the player meets each new idea once they have
 * had some practice with the last one.
 */

export const FIRST_LEVEL = 1;

/**
 * The only board the game plays.
 *
 * Ten is where a board stops being worth growing. Carving a unique board costs
 * roughly five times more per extra row -- 34 ms at 10x10, 1.7 s at 12x12, where
 * almost nothing succeeds. Cells shrink below a comfortable touch target: 37 pt
 * at 10x10, 30 pt at 12x12, against Apple's 44 pt guidance. And every region
 * needs its own colour. Past a dozen flat colours nobody can tell them apart at
 * cell size, which is a limit of eyes rather than code.
 */
export const SIZE = 10;

/**
 * How many levels the ramp takes to climb from Easy to Expert. Seven levels at
 * each of the four tiers.
 */
export const RAMP_LEVELS = 28;

/**
 * From this level on, no colour may be a single square.
 *
 * A one-square colour is a free placement -- the cat can only go there -- so it
 * is the easiest foothold on any board. Removing it means the player has to open
 * the puzzle with real reasoning rather than a gift. By this point they have
 * played a hundred and fifty boards and have earned it.
 */
export const NO_SINGLE_CELL_REGIONS_FROM = 150;

export function tierFor(level) {
	const climbed = Math.max(level, FIRST_LEVEL) - FIRST_LEVEL;
	return Math.min(Math.floor(Grid.TIER_VALUES.length * climbed / RAMP_LEVELS),
		Grid.Tier.EXPERT);
}

export function minRegionCells(level) {
	return level >= NO_SINGLE_CELL_REGIONS_FROM ? 2 : 1;
}

/** Short caption for the top bar: "Level 7  ·  Medium 10x10". */
export function describe(level) {
	return `Level ${level}  ·  ${Grid.tierName(tierFor(level))} ${SIZE}×${SIZE}`;
}

/**
 * Every board the ladder can ask for, as {tier, size, minimum colour size}. The
 * shipped bank covers exactly what players will actually be served.
 */
export function combinations() {
	const out = [];
	const seen = new Set();
	const last = Math.max(RAMP_LEVELS, NO_SINGLE_CELL_REGIONS_FROM);
	for (let level = FIRST_LEVEL; level <= last; level += 1) {
		const spec = { tier: tierFor(level), size: SIZE, minRegion: minRegionCells(level) };
		const key = `${spec.tier}:${spec.minRegion}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(spec);
	}
	return out;
}
