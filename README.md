# Nine Lives

A cat-themed logic puzzle, as an installable progressive web app. Ported from the
Godot 4 project in `~/Sites/godot-sudoku`.

No dependencies, no build step, no framework. Plain ES modules served as files.

## The rules

An N×N grid is carved into N irregular colour regions. Place one cat in every
row, every column and every colour — and no two cats may touch, not even
diagonally. Every level has exactly one solution.

Tap a cell to cross it out, or **drag along a row or column to cross the whole
run**. The first cell a drag reaches decides its axis, so a wandering finger
cannot wipe a diagonal through your working. Crossing out is the bulk of play, so
it gets the cheap gesture — and it is free, a note to yourself that is never
checked.

**Double tap a cell** to place a cat. That is the committing move and the only one
that costs anything: a cat on the wrong cell is refused and **spends a life**. The
first of the two taps crosses the cell out, so a cat shows a cross for a moment on
its way down — the alternative is every cross waiting to see whether a second tap
follows, and crossing out is far too common to make it wait.

## Lives and score

Every board is 10×10. What climbs is the reasoning: the techniques a level asks
for ramp from Easy to Expert over the first 28 levels and stay at Expert after
that. Finishing a level moves you up; losing one does not move you back.

Lives and points belong to the **run**, not the level, so a wrong cat costs
something beyond the board it happens on.

| | |
| --- | --- |
| Placing a cat | **+10** |
| Finishing a level | **+100** |
| Finishing one clean — no life spent, no hint taken | **+200**, and a life back |
| A cat on the wrong cell | **−1 life** |
| Running out of all nine lives | score back to **zero**, lives back to nine |

A run starts on nine lives. The clean-level bonus is the only way to earn one
back, and it never takes you past nine. The high score survives a run ending —
it is the only number that never goes down.

Restarting a level gives you the same board again, not a clean record: a life
already spent on it stays spent, and a hint already taken stays taken. Otherwise
restarting would buy back the clean bonus for nothing.

**Keyboard:** arrows move, `Space`/`X` crosses out, `Enter`/`C` places a cat,
`Backspace` clears, `H` hints, `Cmd`/`Ctrl`+`Z` undoes, `Esc` leaves. The selected
cell is outlined while you are playing by key; a tap puts the outline away again.
Right-click is the mouse's one-press way to place a cat.

## Running it

Modules, workers and the service worker all need a real origin, so open it over
HTTP rather than as a file:

```bash
cd ~/Sites/pwa-meowdoku
python3 -m http.server 8000
# then http://localhost:8000
```

Installing it from the browser's Add to Home Screen gives a standalone portrait
app that plays offline.

```bash
node tests/verify.mjs      # 140 assertions over the puzzle layer, about a second
```

The self-check needs Node 18 or newer (`structuredClone`, `crypto`). It runs the
whole puzzle layer headlessly, verifies every one of the 320 shipped levels is
legal, uniquely solvable and rated to the tier it is filed under, and plays a
board through GameState to check the scoring and the lives.

## Deploying

A push to `main` runs the self-check and, if it passes, publishes to GitHub
Pages. There is no build step: the job copies the app's files into `_site` and
uploads that, so the list in `.github/workflows/pages.yml` has to stay in step
with `ASSETS` in `sw.js`.

Settings → Pages → Source has to be set to **GitHub Actions** for the workflow to
have anywhere to publish to. Every URL in the app is relative, so it runs under
the project path without any base configuration.

## Layout

```
index.html               The shell: both screens, shown and hidden
manifest.webmanifest     Installability: name, icons, portrait, standalone
sw.js                    Precaches everything; code network-first, content cache-first
css/style.css            Widget chrome, layout, and every cell rule

js/puzzle/               Pure puzzle logic. No DOM, so it all runs under Node.
  grid.js                Geometry, bitmask helpers, the rules themselves
  level.js               One level: size, regions, solution
  solver.js              Row-by-row search, solution counting, rival finding
  generator.js           Placement, region carving, uniqueness repair
  rater.js               Technique-by-technique logical solver
  ladder.js              Level number -> which tier to generate
  bank.js                Reads precomputed levels from content/

js/commands/             Undo system
  command.js             Base class
  set-mark-command.js    Change one cell
  cross-run-command.js   One drag across a run of cells
  clear-board-command.js Wipe the player's own marks, as one step
  undo-stack.js          Two stacks, serialization, command factory

js/
  game-state.js          The running game, and every event the UI listens to
  puzzle-state.js        The board model commands act on
  save-manager.js        The save document in localStorage, plus suspend hooks
  save-migration.js      Pure version-migration functions
  scoring.js             Lives and point values, shared by the game and the save
  settings.js            Preferences
  builder.js             Bank-then-generate, shared by page and worker
  worker.js              Level generation off the main thread
  util/emitter.js        Named events, the stand-in for Godot signals
  util/rng.js            Seeded PCG32
  ui/                    palette.js, board.js, lives.js, menu-screen.js,
                         game-screen.js, main.js

content/level_bank.json  320 precomputed levels (data, not code)
art/, icons/             The cat, the mascot, the app icons
tests/verify.mjs         Self-check for the puzzle layer
.github/workflows/       Self-check on every push; deploy to Pages from main
```

## What the port changed

The puzzle layer is a direct translation — same algorithms, same constants, same
save format at version 4, so the shipped level bank is used unmodified. What had
to move is everything that touched the engine.

| Godot | Here |
|---|---|
| Signals | `Emitter`: `on(name, fn)` / `emit(name, …)` with real arguments |
| `Thread` for generation and prefetch | Two long-lived module Web Workers, one request/reply each |
| `RandomNumberGenerator` | `Rng`, PCG32 in BigInt, so a seed still reproduces a level |
| `_draw()` per cell | One div per cell: CSS for the fill and outline, inline SVG for the cross, an `<img>` for the cat |
| `_gui_input` with touch and mouse branches | Pointer events on `window` for the length of the gesture, one path for both |
| `user://sudoku_save.json`, temp file plus rename | `localStorage`, where a write is already all-or-nothing |
| `NOTIFICATION_APPLICATION_PAUSED` and friends | `visibilitychange`, `pagehide`, `freeze` |
| `PackedByteArray` / `PackedInt32Array` | `Uint8Array` / `Int32Array` |
| `Vector2i` cells in the rater | Packed `row * size + col` indices |
| `Theme` resource plus `palette.gd` | Custom properties in the stylesheet plus `ui/palette.js` |
| `AspectRatioContainer` and `SquareSlot` | `aspect-ratio: 1` on the grid |
| `tools/build_level_bank.gd` | Not ported. The bank is shipped content; regenerate it in the Godot project. |

Cell metrics are the one place the drawing model shows through. Godot computed
corner radius, outline width and the cat's overhang from the cell's pixel size
inside `_draw()`. `BoardView` measures the board once and publishes `--cell` and
`--gap`, and every one of those rules is a `calc()` off those two numbers.

Placing a cat is a hold rather than a double-tap. A double-tap has to cross the
cell out on the first tap, because nothing at that moment knows a second is
coming, and then paint the cat over it -- so the cross visibly flashes on and off
under the move replacing it, and lands on the undo stack having never been asked
for. A hold fires before anything is released, so no tap ever happens.

The drag also gained an axis. The original locked a run to the row it started
in; here the first cell the drag reaches decides row or column, which keeps the
same protection against a careless swipe wiping a diagonal while making vertical
runs possible.

### One bug fixed rather than reproduced

A command already on the undo stack can name a cell that has since been settled.
Cross a cell, clear the board, then lose a life on that same cell: the clear
command still holds the old cross, and reverting it repaints over the red the
game paid a life to establish. The Godot original has the same hole — its smoke
test covers undoing out of a *loss*, not this sequence.

Commands now write through `PuzzleState.putIfEditable`, which refuses to disturb
a cell holding a cat or a red cross. No command ever legitimately targets one:
every entry point already checks before creating the command, so the guard only
ever fires on a stale record.

## Deliberate omissions

- **No sound, no animation.** The cats are static.
- **No tutorial.** The rules fit in one line, which the game screen shows on load.
- **No level select.** You are on a level; you play that level.
- **No settings screen.** `Settings` has the plumbing and no options to show yet.
- **The rater stops at locked groups.** Deeper chain reasoning would let the
  generator accept levels it currently rejects.
