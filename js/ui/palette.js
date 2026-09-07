/**
 * Every colour the game draws from script, in one place.
 *
 * Warm paper rather than the usual puzzle-app slate: the board should look like
 * something a cat would sit on.
 *
 * The split mirrors the original's two colour systems. Widget chrome -- buttons,
 * cards, label colours -- lives in the stylesheet as custom properties, which is
 * what CSS is for. What is here is the part a stylesheet cannot say: "this cell
 * belongs to region 4". A region's colour is chosen per level, per cell, at
 * runtime, so it is set as an inline custom property and the rest of the cell's
 * appearance derives from it.
 */

/**
 * One colour per region, and a region count always equals the board size, so
 * there are as many of these as Ladder.SIZE. Chosen to stay distinguishable when
 * sitting next to each other.
 */
export const REGIONS = [
	"#52a8c0", // teal
	"#efa062", // orange
	"#c97a9b", // rose
	"#97ce7f", // green
	"#a394d1", // lilac
	"#edcf63", // butter
	"#7fb0e8", // sky
	"#d98a6a", // clay
	"#8bc3a6", // sage
	"#a8a29a", // stone -- a neutral, because by the tenth region every other hue
	           // family is already taken and two similar colours would read as
	           // one region
];

export function regionColour(region) {
	return REGIONS[((region % REGIONS.length) + REGIONS.length) % REGIONS.length];
}
