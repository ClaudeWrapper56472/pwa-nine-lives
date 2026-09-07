/**
 * The row of hearts in the top bar, and on the result card.
 *
 * Spent lives stay on screen as hollow outlines rather than disappearing. A row
 * that shrinks tells you how many you have; a row that hollows out tells you how
 * many you have *left of how many*, which is the number that matters when you
 * are deciding whether to guess.
 */

const HEART_PATH = "M12 21C12 21 1.5 14.4 1.5 7.9 1.5 4.3 4.2 1.5 "
	+ "7.6 1.5 9.7 1.5 11.2 2.6 12 3.9 12.8 2.6 14.3 1.5 16.4 1.5 19.8 1.5 "
	+ "22.5 4.3 22.5 7.9 22.5 14.4 12 21 12 21Z";

/**
 * One heart. Shared so the one that flies in for a regained life is cut from the
 * same shape as the one it lands on.
 */
export function createHeart() {
	const heart = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	heart.setAttribute("class", "heart");
	heart.setAttribute("viewBox", "0 0 24 22");
	heart.setAttribute("aria-hidden", "true");
	heart.innerHTML = `<path d="${HEART_PATH}" />`;
	return heart;
}

export class LivesView {
	constructor(root) {
		this.root = root;
		this._remaining = -1;
		this._total = -1;
	}

	set(remaining, total) {
		if (this._remaining === remaining && this._total === total) return;
		if (this._total !== total) {
			this.root.replaceChildren();
			for (let i = 0; i < total; i += 1) this.root.append(createHeart());
		}
		this._remaining = remaining;
		this._total = total;
		const hearts = this.root.children;
		for (let i = 0; i < hearts.length; i += 1) {
			hearts[i].classList.toggle("is-spent", i >= remaining);
		}
		this.root.setAttribute("aria-label", `${remaining} of ${total} lives left`);
	}

	/** The heart at this slot, for anything that needs to point at one. */
	heartAt(index) {
		return this.root.children[index] ?? null;
	}

	/**
	 * Plays the landing beat on one heart.
	 *
	 * The class is stripped and the element measured before it goes back on: a
	 * running animation would otherwise ignore being asked to start again, and a
	 * player who earns two clean boards in a row would see the second one arrive
	 * without a sound.
	 */
	flash(index) {
		const heart = this.heartAt(index);
		if (heart === null) return;
		heart.classList.remove("is-returning");
		void heart.offsetWidth;
		heart.classList.add("is-returning");
		heart.addEventListener("animationend",
			() => heart.classList.remove("is-returning"), { once: true });
	}
}
