import * as Grid from "./grid.js";

/**
 * One puzzle: the board size, the region each cell belongs to, and the solution.
 *
 * The solution is stored as `columns[row]`, which is the whole answer -- one cat
 * per row means a permutation is all there is to record.
 */
export class CatLevel {
	constructor() {
		this.size = 0;
		this.regions = new Uint8Array(0); // region id per cell, row-major
		this.columns = new Uint8Array(0); // solution: column of the cat in each row
		this.tier = Grid.Tier.EASY;
		this.seed = 0;
		this.attempts = 0;
		this.rating = null; // a Rating, or null when nothing has rated it
	}

	regionAt(row, col) {
		return this.regions[Grid.indexOf(this.size, row, col)];
	}

	solutionIndex(row) {
		return Grid.indexOf(this.size, row, this.columns[row]);
	}

	isSolutionCell(index) {
		return this.columns[Grid.rowOf(this.size, index)] === Grid.colOf(this.size, index);
	}

	/**
	 * Stable identity, used to avoid serving a board the player has already had.
	 *
	 * Hashed rather than stored whole: a few hundred 81-character strings would
	 * bloat the save for nothing, and a hash collision costs exactly one skipped
	 * puzzle.
	 */
	fingerprint() {
		return CatLevel.fingerprintOf(this.size, Grid.regionsToString(this.regions));
	}

	static fingerprintOf(boardSize, regionsText) {
		return Grid.hashString(`${boardSize}:${regionsText}`);
	}

	/**
	 * Squares in the smallest colour. One means the board has a free placement in
	 * it, which the later levels forbid.
	 */
	smallestRegion() {
		const counts = new Int32Array(this.size);
		for (const region of this.regions) counts[region] += 1;
		let smallest = counts[0];
		for (const count of counts) smallest = Math.min(smallest, count);
		return smallest;
	}

	isValid() {
		return Grid.isValidSolution(this.size, this.regions, this.columns)
			&& Grid.regionsAreConnected(this.size, this.regions);
	}

	describe() {
		return `${Grid.tierName(this.tier)} ${this.size}x${this.size}, seed ${this.seed}`;
	}

	toJSON() {
		return {
			size: this.size,
			regions: Grid.regionsToString(this.regions),
			columns: Grid.columnsToString(this.columns),
			tier: this.tier,
			seed: this.seed,
		};
	}

	static fromJSON(data) {
		if (!data || typeof data !== "object") return null;
		const level = new CatLevel();
		level.size = Number(data.size ?? 0);
		level.regions = Grid.regionsFromString(String(data.regions ?? ""));
		level.columns = Grid.columnsFromString(String(data.columns ?? ""));
		level.tier = Number(data.tier ?? Grid.Tier.EASY);
		level.seed = Number(data.seed ?? 0);
		if (level.size < Grid.MIN_SIZE || level.regions.length !== level.size * level.size) {
			return null;
		}
		return level;
	}
}
