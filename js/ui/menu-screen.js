import * as Grid from "../puzzle/grid.js";
import * as Ladder from "../puzzle/ladder.js";
import { MAX_LIVES } from "../scoring.js";
import { Emitter } from "../util/emitter.js";

/**
 * Title screen, and two ways off it.
 *
 * The play button carries on: a suspended level if there is one, otherwise the
 * level the player is on. Below it, and only when the two have parted company,
 * a button back to the furthest level they have reached.
 *
 * The menu does not decide what carrying on means -- it just reports the press
 * and lets the router work out whether there is a game to resume. All it asks
 * the save for is what to write on the buttons.
 *
 * Emits: playRequested(), levelChosen(level)
 */
export class MenuScreen extends Emitter {
	constructor(root, save) {
		super();
		this.root = root;
		this.save = save;
		this._playButton = root.querySelector("#play-button");
		this._furthestButton = root.querySelector("#furthest-button");
		this._stats = root.querySelector("#menu-stats");

		this._playButton.addEventListener("click", () => this.emit("playRequested"));
		this._furthestButton.addEventListener("click",
			() => this.emit("levelChosen", this.save.furthestLevel()));
		save.on("statsChanged", () => this.refresh());
		save.on("sessionAvailable", () => this.refresh());
		this.refresh();
	}

	refresh() {
		const carryingOn = this._renderPlayButton();
		this._renderFurthest(carryingOn);
		this._renderStats();
	}

	/** Writes the play button, and answers which level it would start. */
	_renderPlayButton() {
		if (!this.save.hasSession()) {
			const level = this.save.playingLevel();
			this._playButton.textContent = `Play level ${level}`;
			return level;
		}
		const session = this.save.session();
		const level = Math.max(Number(session.level ?? Ladder.FIRST_LEVEL), Ladder.FIRST_LEVEL);
		const seconds = Math.floor(Number(session.elapsed ?? 0));
		const minutes = Math.floor(seconds / 60);
		const rest = String(seconds % 60).padStart(2, "0");
		this._playButton.textContent = `Continue level ${level}  ·  ${minutes}:${rest}`;
		return level;
	}

	/**
	 * The way back to the furthest level reached. Hidden while the play button is
	 * already offering it, which is the usual case. The two only part company in a
	 * save carried over from a version that let the player drop to an easier board.
	 */
	_renderFurthest(carryingOn) {
		const furthest = this.save.furthestLevel();
		this._furthestButton.hidden = furthest === carryingOn;
		if (this._furthestButton.hidden) return;
		this._furthestButton.textContent =
			`Back to level ${furthest}  ·  ${Grid.tierName(Ladder.tierFor(furthest))}`;
	}

	_renderStats() {
		const level = this.save.playingLevel();
		const completed = this.save.levelsCompleted();
		const streak = this.save.stats().streak ?? {};
		const run = Number(streak.current ?? 0);
		const bestRun = Number(streak.best ?? 0);

		const lines = [
			`On level ${level}  ·  ${Grid.tierName(Ladder.tierFor(level))} ${Ladder.SIZE}×${Ladder.SIZE}`,
			`Score ${this.save.runScore()}  ·  best ${this.save.highScore()}`,
			`${this.save.runLives()} of ${MAX_LIVES} lives`,
			`${completed} level${completed === 1 ? "" : "s"} finished`,
		];
		if (run > 0) lines.push(`${run} in a row (best ${bestRun})`);
		else if (bestRun > 0) lines.push(`Best run ${bestRun} in a row`);

		this._stats.replaceChildren();
		const heading = document.createElement("h2");
		heading.textContent = "Progress";
		this._stats.append(heading);
		for (const line of lines) {
			const paragraph = document.createElement("p");
			paragraph.textContent = line;
			this._stats.append(paragraph);
		}
	}
}
