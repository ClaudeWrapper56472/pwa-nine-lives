import * as Ladder from "../puzzle/ladder.js";
import { MAX_LIVES } from "../scoring.js";
import { BoardView } from "./board.js";
import { LivesView, createHeart } from "./lives.js";
import { Emitter } from "../util/emitter.js";

/**
 * The playing screen: board, toolbar and the panels that cover them.
 *
 * This is the only view that knows all the pieces exist, and its whole job is
 * translating between them: a tap on the board becomes a GameState call, a
 * GameState event becomes a label update. Nothing here holds game state of its
 * own, so the screen can be closed and reopened mid-level without losing
 * anything.
 *
 * Emits: exitRequested()
 */
export class GameScreen extends Emitter {
	/** How long a status message stays up. */
	static STATUS_MS = 3500;

	/** The flight a regained life makes into its slot on the result card. */
	static LIFE_FLIGHT_MS = 950;

	/** A beat on the card before it sets off, so the player is looking at it. */
	static LIFE_FLIGHT_DELAY_MS = 320;

	/** How many times bigger the heart starts than the slot it lands in. */
	static LIFE_FLIGHT_SCALE = 5;

	constructor(root, game) {
		super();
		this.root = root;
		this.game = game;

		this._tierLabel = root.querySelector("#tier-label");
		this._timeLabel = root.querySelector("#time-label");
		this._scoreValue = root.querySelector("#score-value");
		this._progressLabel = root.querySelector("#progress-label");
		this._statusLabel = root.querySelector("#status-label");
		this._undoButton = root.querySelector("#undo-button");
		this._redoButton = root.querySelector("#redo-button");
		this._clearButton = root.querySelector("#clear-button");
		this._hintButton = root.querySelector("#hint-button");
		this._backButton = root.querySelector("#back-button");
		this._loadingPanel = root.querySelector("#loading-panel");
		this._loadingLabel = root.querySelector("#loading-label");
		this._resultPanel = root.querySelector("#result-panel");
		this._resultTitle = root.querySelector("#result-title");
		this._resultDetail = root.querySelector("#result-detail");
		this._againButton = root.querySelector("#again-button");
		this._resultMenuButton = root.querySelector("#result-menu-button");

		this._playArea = root.querySelector(".play-area");
		this._headerRow = root.querySelector(".header-row");
		this._runRow = root.querySelector(".run-row");
		this._bottomBar = root.querySelector(".bottom-bar");

		this._lives = new LivesView(root.querySelector("#lives"));
		this._resultLives = new LivesView(root.querySelector("#result-lives"));
		this._board = new BoardView(root.querySelector("#board"), game);

		this._statusTimer = null;
		/** The heart in flight to its slot, and the wait before it sets off. */
		this._lifeFlight = null;
		this._lifeFlightTimer = null;
		/** Which button the result card is offering: the next level, or this one again. */
		this._retryMode = false;

		this._wireBoard();
		this._wireButtons();
		this._wireGame();
		this._installKeyboard();

		this._loadingPanel.hidden = true;
		this._resultPanel.hidden = true;
		this._statusLabel.textContent = "";
		this._clearButton.disabled = true;

		// The screen for the viewport changing, the bottom bar for a status message
		// that wraps onto another line. Neither depends on how big the board is, so
		// publishing a new limit cannot start a loop.
		const fit = new ResizeObserver(() => this._publishBoardLimit());
		fit.observe(this.root);
		fit.observe(this._bottomBar);
	}

	/**
	 * How much height is left for the board: the screen, less its padding, less
	 * everything stacked around it.
	 *
	 * The board is square and takes the width it is given, so on a screen too
	 * short for a full-width one it is the height that has to do the deciding. The
	 * stylesheet caps the board's width with this.
	 */
	_publishBoardLimit() {
		const height = this.root.clientHeight;
		// Hidden, so there is nothing to measure and the last limit still holds.
		if (height === 0) return;
		const styles = getComputedStyle(this.root);
		const gap = parseFloat(getComputedStyle(this._playArea).rowGap) || 0;
		// Four things stack in the play area, so three gaps between them.
		const around = this._headerRow.offsetHeight + this._runRow.offsetHeight
			+ this._progressLabel.offsetHeight + this._bottomBar.offsetHeight + gap * 3;
		const limit = height - parseFloat(styles.paddingTop)
			- parseFloat(styles.paddingBottom) - around;
		this.root.style.setProperty("--board-limit", `${Math.max(limit, 0)}px`);
	}

	_wireBoard() {
		this._board.on("cellTapped", (index) => {
			this.game.select(index);
			this.game.toggleCross(index);
		});
		// Two ways to commit a cat, one meaning. The board reports the gesture; what
		// it amounts to is decided here.
		for (const gesture of ["cellDoubleTapped", "cellRightClicked"]) {
			this._board.on(gesture, (index) => {
				this.game.select(index);
				this.game.toggleCat(index);
			});
		}
		this._board.on("dragStarted", (index) => this.game.beginCrossRun(index));
		this._board.on("dragReached", (index) => this.game.extendCrossRun(index));
		this._board.on("dragEnded", () => this.game.endCrossRun());
	}

	_wireButtons() {
		this._backButton.addEventListener("click", () => this._onBackPressed());
		this._undoButton.addEventListener("click", () => this.game.undo());
		this._redoButton.addEventListener("click", () => this.game.redo());
		this._clearButton.addEventListener("click", () => this.game.clearBoard());
		this._hintButton.addEventListener("click", () => this.game.useHint());
		this._againButton.addEventListener("click", () => this._onPlayAgainPressed());
		this._resultMenuButton.addEventListener("click", () => this._onBackPressed());
	}

	_wireGame() {
		const game = this.game;
		game.on("generationStarted", (level) => {
			// The card this heart was flying to is going away.
			this._cancelLifeFlight();
			this._resultPanel.hidden = true;
			this._loadingPanel.hidden = false;
			this._loadingLabel.textContent = `Setting up level ${level}…`;
		});
		game.on("generationFinished", (success) => {
			this._loadingPanel.hidden = true;
			if (!success) this._showStatus("Could not build a level. Try again.");
		});
		game.on("levelLoaded", () => {
			this._resultPanel.hidden = true;
			this._tierLabel.textContent = Ladder.describe(game.levelNumber);
			this._showStatus("Tap or drag to cross out. Double tap to place a cat.");
		});
		game.on("timeChanged", (seconds) => {
			this._timeLabel.textContent = formatTime(seconds);
		});
		game.on("livesChanged", (remaining, total) => this._lives.set(remaining, total));
		game.on("scoreChanged", (score) => {
			this._scoreValue.textContent = String(score);
		});
		game.on("wrongCat", (_index, message) => this._showStatus(message));
		game.on("catsChanged", (placed, total) => {
			this._progressLabel.textContent = `${placed} / ${total} cats`;
		});
		// Disabled when there is nothing of the player's to wipe, so it never looks
		// like a button that does nothing.
		game.on("cellsChanged", () => {
			this._clearButton.disabled = !game.board.hasPlayerMarks();
		});
		game.on("historyChanged", (canUndo, canRedo) => {
			this._undoButton.disabled = !canUndo;
			this._redoButton.disabled = !canRedo;
		});
		game.on("hintOffered", (_index, message) => this._showStatus(message));
		game.on("hintsChanged", (remaining) => {
			this._hintButton.disabled = remaining <= 0;
		});
		game.on("levelCompleted", (level, seconds, hints, regained) => {
			this._retryMode = false;
			this._resultTitle.textContent = `Level ${level} done`;
			const parts = [formatTime(seconds)];
			const lost = game.mistakes();
			if (lost > 0) parts.push(`${lost} wrong cat${lost === 1 ? "" : "s"}`);
			if (hints > 0) parts.push(`${hints} hint${hints === 1 ? "" : "s"}`);
			parts.push(`${game.score} points`);
			this._resultDetail.textContent = parts.join("   ");
			this._againButton.textContent = `Level ${level + 1}`;
			this._resultPanel.hidden = false;
			this._showEarnedLife(game.livesLeft, regained);
			this._againButton.focus();
		});
		game.on("levelFailed", (score) => {
			this._retryMode = true;
			this._resultTitle.textContent = "Out of lives";
			this._resultDetail.textContent = `${score} points, back to zero. Try again.`;
			this._againButton.textContent = "Try again";
			this._resultPanel.hidden = false;
			this._resultLives.set(game.livesLeft, MAX_LIVES);
			this._againButton.focus();
		});
	}

	/**
	 * Draws the run's lives on the result card.
	 *
	 * A life handed back is worth watching arrive, so the bar goes up as it was
	 * during the level and the heart fills in after the card has painted. Two
	 * frames, because one only guarantees the panel is no longer hidden -- the
	 * spent heart has to be on screen before it can be seen coming back.
	 */
	_showEarnedLife(livesLeft, regained) {
		this._cancelLifeFlight();
		if (!regained) {
			this._resultLives.set(livesLeft, MAX_LIVES);
			return;
		}
		// The bar goes up as it stood during the level. The slot stays empty until
		// the heart flying in reaches it, which is the whole point of the flight.
		this._resultLives.set(livesLeft - 1, MAX_LIVES);
		const slot = livesLeft - 1;
		this._lifeFlightTimer = setTimeout(() => {
			this._lifeFlightTimer = null;
			this._flyLifeHome(slot, livesLeft);
		}, GameScreen.LIFE_FLIGHT_DELAY_MS);
	}

	/**
	 * Sends a big heart from the top of the screen down into the slot it fills.
	 *
	 * It travels a quadratic curve rather than a straight line, shrinking as it
	 * goes, and the slot underneath only fills once it lands -- so the life is
	 * something the player watches arrive rather than a number that changed while
	 * they were reading the time.
	 *
	 * Fixed positioning throughout, because the target is measured with
	 * getBoundingClientRect and that is already in viewport coordinates.
	 */
	_flyLifeHome(slot, livesLeft) {
		const target = this._resultLives.heartAt(slot);
		const land = () => {
			this._resultLives.set(livesLeft, MAX_LIVES);
			this._resultLives.flash(slot);
		};
		// Nothing to aim at, or the player has asked for less movement: the life
		// still arrives, it just does not make a journey of it.
		if (target === null || this._resultPanel.hidden
			|| window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
			land();
			return;
		}

		const box = target.getBoundingClientRect();
		if (box.width === 0) {
			land();
			return;
		}

		const flyer = createHeart();
		flyer.classList.add("flying-heart");
		flyer.style.width = `${box.width}px`;
		document.body.append(flyer);

		const path = curveThrough(
			{ x: window.innerWidth / 2, y: window.innerHeight * 0.12 },
			{ x: box.left + box.width / 2, y: box.top + box.height / 2 },
			GameScreen.LIFE_FLIGHT_SCALE, box.width, box.height);

		const flight = flyer.animate(path, {
			duration: GameScreen.LIFE_FLIGHT_MS,
			easing: "cubic-bezier(0.4, 0, 0.2, 1)",
			fill: "forwards",
		});
		this._lifeFlight = flight;
		const finish = () => {
			if (this._lifeFlight !== flight) return;
			this._lifeFlight = null;
			flyer.remove();
			land();
		};
		flight.addEventListener("finish", finish);
		flight.addEventListener("cancel", () => flyer.remove());
	}

	/**
	 * Drops any flight still running. Leaving one in the air would land a heart on
	 * a card that has moved on to a different level.
	 */
	_cancelLifeFlight() {
		if (this._lifeFlightTimer !== null) {
			clearTimeout(this._lifeFlightTimer);
			this._lifeFlightTimer = null;
		}
		if (this._lifeFlight !== null) {
			const flight = this._lifeFlight;
			this._lifeFlight = null;
			flight.cancel();
		}
	}

	/**
	 * Keyboard play. The board is quicker to drive from the keyboard than from the
	 * pointer, which matters while developing and is the only way in for anyone who
	 * cannot use a pointer at all.
	 */
	_installKeyboard() {
		window.addEventListener("keydown", (event) => {
			if (this.root.hidden || !this._resultPanel.hidden || !this._loadingPanel.hidden) return;
			// A focused button owns Space and Enter; stealing them would break the
			// toolbar for keyboard users.
			if (event.target instanceof HTMLButtonElement && (event.key === " " || event.key === "Enter")) {
				return;
			}
			const game = this.game;
			const key = event.key;
			// Playing by key, so the selected cell needs its outline back.
			this._board.showSelection(true);
			if (key === " " || key === "x" || key === "X") game.toggleCross(game.selected);
			else if (key === "Enter" || key === "c" || key === "C") game.toggleCat(game.selected);
			else if (key === "Backspace" || key === "Delete") game.clearCell(game.selected);
			else if (key === "h" || key === "H") game.useHint();
			else if ((key === "z" || key === "Z") && (event.ctrlKey || event.metaKey)) {
				if (event.shiftKey) game.redo();
				else game.undo();
			} else if ((key === "y" || key === "Y") && event.ctrlKey) game.redo();
			else if (key === "ArrowLeft") game.moveSelection(0, -1);
			else if (key === "ArrowRight") game.moveSelection(0, 1);
			else if (key === "ArrowUp") game.moveSelection(-1, 0);
			else if (key === "ArrowDown") game.moveSelection(1, 0);
			else if (key === "Escape") this._onBackPressed();
			else return;
			event.preventDefault();
		});
	}

	_onPlayAgainPressed() {
		this._resultPanel.hidden = true;
		if (this._retryMode) this.game.restartLevel();
		// The level after the one just finished, which is what the button says.
		// A player who dropped back to an easier board carries on from there.
		else this.game.startLevel(this.game.levelNumber + 1);
	}

	_onBackPressed() {
		if (!this.game.finished) this.game.suspend();
		this.emit("exitRequested");
	}

	_showStatus(message) {
		this._statusLabel.textContent = message;
		if (this._statusTimer !== null) clearTimeout(this._statusTimer);
		this._statusTimer = setTimeout(() => {
			this._statusLabel.textContent = "";
			this._statusTimer = null;
		}, GameScreen.STATUS_MS);
	}
}

function formatTime(seconds) {
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * Keyframes along a quadratic curve from `from` to `to`, shrinking from `scale`
 * to life size.
 *
 * The control point is pushed sideways past the target and kept high, so the
 * heart sweeps out and comes back down into its slot instead of sliding along
 * the straight line between the two. It is clamped to the viewport, because a
 * slot near an edge would otherwise throw the curve off screen.
 *
 * Sampled into steps rather than handed to offset-path: the transform has to
 * carry the scale as well as the position, and one list of keyframes doing both
 * stays in step by construction.
 */
function curveThrough(from, to, scale, width, height) {
	const controlX = Math.min(Math.max(to.x + (to.x - from.x) * 0.55, width),
		window.innerWidth - width);
	const controlY = from.y + (to.y - from.y) * 0.2;
	const steps = 24;
	const frames = [];
	for (let step = 0; step <= steps; step += 1) {
		const t = step / steps;
		const rest = 1 - t;
		const x = rest * rest * from.x + 2 * rest * t * controlX + t * t * to.x;
		const y = rest * rest * from.y + 2 * rest * t * controlY + t * t * to.y;
		const size = scale + (1 - scale) * t;
		frames.push({
			offset: t,
			// The element is anchored at the viewport origin, so its own half-size
			// comes off the point to centre it on the curve.
			transform: `translate(${x - width / 2}px, ${y - height / 2}px) scale(${size})`,
			opacity: t < 0.06 ? String(t / 0.06) : "1",
		});
	}
	return frames;
}
