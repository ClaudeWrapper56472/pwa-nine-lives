/**
 * Lives and points.
 *
 * Its own module because the game and the save format both need these numbers,
 * and the save layer should not have to reach into GameState for them.
 *
 * Lives belong to a run rather than to a level: they carry from one level to the
 * next, a clean level earns one back, and running out ends the run and puts the
 * score back to zero. That is what makes a wrong cat cost something beyond the
 * level it happens on.
 */

/** Wrong cats a run can afford, and the most a player can ever hold. */
export const MAX_LIVES = 9;

/** Points for each cat the player places. */
export const POINTS_PER_CAT = 10;

/**
 * Points for finishing a level, and the same again for finishing it without
 * spending a life or taking a hint.
 */
export const POINTS_PER_LEVEL = 100;
