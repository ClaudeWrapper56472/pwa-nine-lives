import * as Grid from "./grid.js";

/**
 * Turns a level number into a board to generate.
 *
 * Every level is the same board and the same tier: a 10x10 that takes the whole
 * technique set to crack. Lives and score belong to the run, so a board that
 * falls to forced singles costs the player nothing and decides nothing. What
 * climbs with the level number is only how much a mistake has already cost.
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
 * The tier every level is generated at: the rater has to reach for locked
 * groups, its hardest technique, before the board gives way.
 */
export const TIER = Grid.Tier.EXPERT;

/**
 * From this level on, no colour may be a single square.
 *
 * A one-square colour is a free placement -- the cat can only go there -- so it
 * is the easiest foothold on any board. Removing it means the player has to open
 * the puzzle with real reasoning rather than a gift. By this point they have
 * played a hundred and fifty boards and have earned it.
 */
export const NO_SINGLE_CELL_REGIONS_FROM = 150;

export function minRegionCells(level) {
	return level >= NO_SINGLE_CELL_REGIONS_FROM ? 2 : 1;
}

/** Short caption for the top bar: "Level 7  ·  Expert 10x10". */
export function describe(level) {
	return `Level ${level}  ·  ${Grid.tierName(TIER)} ${SIZE}×${SIZE}`;
}

/**
 * Every board the ladder can ask for, as {tier, size, minimum colour size}.
 */
export function combinations() {
	const out = [];
	const seen = new Set();
	for (let level = FIRST_LEVEL; level <= NO_SINGLE_CELL_REGIONS_FROM; level += 1) {
		const spec = { tier: TIER, size: SIZE, minRegion: minRegionCells(level) };
		const key = `${spec.tier}:${spec.minRegion}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(spec);
	}
	return out;
}
