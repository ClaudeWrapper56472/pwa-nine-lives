/**
 * Offline play.
 *
 * Everything the game needs is static and small -- the level bank is the largest
 * file at about 48 KB -- so the whole app is precached on install. A puzzle you
 * can already play should not stop working because the train went into a tunnel.
 *
 * Two strategies, split by what goes wrong when a file is stale.
 *
 * Code -- the shell, the modules, the stylesheet -- is fetched from the network
 * first and falls back to the cache. They are a few kilobytes each, so the cost
 * of asking is small, and the cost of not asking is a browser pinned to an old
 * build forever: a cache-first worker with a hand-written version string serves
 * whatever it captured until someone remembers to bump the string, and a stale
 * mix of modules fails in ways that look like the app is simply broken.
 *
 * Content -- the art, the icons, the level bank -- is served cache-first. It is
 * the bulk of the bytes and it only changes when its filename does.
 */
const CACHE = "nine-lives-v5";

/** Files whose freshness matters more than the round trip to check it. */
const CODE = /\.(?:html|js|css|webmanifest)$/;

const ASSETS = [
	"./",
	"index.html",
	"manifest.webmanifest",
	"css/style.css",
	"art/cat.png",
	"art/mascot.png",
	"icons/apple-touch-icon-180-1788505200.png",
	"icons/icon-192.png",
	"icons/icon-512.png",
	"icons/icon-1024.png",
	"content/level_bank.json",
	"js/builder.js",
	"js/game-state.js",
	"js/puzzle-state.js",
	"js/save-manager.js",
	"js/save-migration.js",
	"js/scoring.js",
	"js/settings.js",
	"js/worker.js",
	"js/commands/clear-board-command.js",
	"js/commands/command.js",
	"js/commands/cross-run-command.js",
	"js/commands/set-mark-command.js",
	"js/commands/undo-stack.js",
	"js/puzzle/bank.js",
	"js/puzzle/generator.js",
	"js/puzzle/grid.js",
	"js/puzzle/ladder.js",
	"js/puzzle/level.js",
	"js/puzzle/rater.js",
	"js/puzzle/solver.js",
	"js/ui/board.js",
	"js/ui/game-screen.js",
	"js/ui/lives.js",
	"js/ui/main.js",
	"js/ui/menu-screen.js",
	"js/ui/palette.js",
	"js/util/emitter.js",
	"js/util/rng.js",
];

self.addEventListener("install", (event) => {
	event.waitUntil(
		caches.open(CACHE)
			.then((cache) => cache.addAll(ASSETS))
			.then(() => self.skipWaiting()),
	);
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches.keys()
			.then((names) => Promise.all(
				names.filter((name) => name !== CACHE).map((name) => caches.delete(name)),
			))
			.then(() => self.clients.claim()),
	);
});

self.addEventListener("fetch", (event) => {
	const request = event.request;
	if (request.method !== "GET") return;
	if (new URL(request.url).origin !== self.location.origin) return;

	if (request.mode === "navigate") {
		event.respondWith(navigate(request));
		return;
	}

	if (CODE.test(new URL(request.url).pathname)) {
		event.respondWith(freshest(request));
		return;
	}

	event.respondWith(
		caches.match(request).then((cached) => cached ?? store(request)),
	);
});

/**
 * Opening the app. Any URL in scope is the app, so a deep link, a refresh from
 * the home screen, or a launch with no network gets the shell rather than a 404
 * or an error page.
 */
async function navigate(request) {
	const shell = async () => await caches.match(request) ?? await caches.match("index.html");
	let response;
	try {
		response = await store(request);
	} catch (error) {
		const cached = await shell();
		if (cached !== undefined) return cached;
		throw error;
	}
	if (response.ok) return response;
	return await shell() ?? response;
}

/** Network first, with the cache as the answer when the network has no good one. */
async function freshest(request) {
	let response;
	try {
		response = await store(request);
	} catch (error) {
		const cached = await caches.match(request);
		if (cached !== undefined) return cached;
		throw error;
	}
	if (response.ok) return response;
	return await caches.match(request) ?? response;
}

/** Fetches and files the result, so the next load has it offline. */
async function store(request) {
	const response = await fetch(request);
	if (response.ok) {
		const copy = response.clone();
		const cache = await caches.open(CACHE);
		await cache.put(request, copy);
	}
	return response;
}
