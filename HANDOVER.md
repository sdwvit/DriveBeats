# Handover — DriveBeats

## Context

`/home/sdwvit/IdeaProjects/DriveBeats`, deployed to GitHub Pages from `main`
(`.github/workflows/pages.yml`). Push to `main` deploys. `SPEC.md` is the design
record and is kept current; read it before changing behaviour.

An iPhone is mounted in the car, screen up, top edge forward, tilted slightly
nose-down. It reads the accelerometer and plays generative techno, or a
user-uploaded MIDI file, shaped by how the car is being driven. **It works and
the user has confirmed it sounds good.**

## Layout

Source is in `js/`, eight ES modules. **What ships is still a single file**: the
app has to work in a car with no signal, and ten module requests would make it
depend on the browser having cached ten files rather than one. `build.mjs`
concatenates `js/` back into `index.html` between the `build:start`/`build:end`
markers, stripping the `import`/`export` lines — inside the one IIFE every
module already shares a scope.

    node build.mjs           rebuild index.html from js/
    npm test                 staleness check, then the suite

**Edit `js/`, never the script block in `index.html`** — it is generated, and a
hand edit is lost on the next build. `npm test` fails if you forgot to rebuild.
The markup outside the markers *is* hand-edited.

| Module | What |
|---|---|
| `util.js` | `$`, `clamp`, `fmt` |
| `motion.js` | `CFG`, `DS` (DriveState), `S`, `onMotion` |
| `midi.js` | SMF parser, role assignment, `M` |
| `midi-store.js` | the IndexedDB MIDI library |
| `sf2.js` | SoundFont directory, zones, pruned sample loading, the voice |
| `playback.js` | MIDI scheduling, the speed ladder, soundfont routing |
| `engine.js` | `A`, the generator, voices, continuous mapping |
| `ui.js` | everything that touches the DOM |

`playback.js` and `engine.js` import each other. That is fine — neither touches
the other at module-evaluation time — and it is irrelevant to the build, which
puts them in one scope anyway.

## Tests

`npm test` — 42 tests, node's own runner, no dependencies.

| File | Covers |
|---|---|
| `midi.test.mjs` | the parser, scored against `ref.mjs` |
| `motion.test.mjs` | DriveState from a synthetic accelerometer |
| `layers.test.mjs` | the speed ladder |
| `store.test.mjs` | the MIDI library, against `fake-idb.mjs` |
| `page.test.mjs` | the built `index.html` loads and is wired |

`ref.mjs` is a deliberately strict reference MIDI reader used only as a scoring
oracle — it is not shipped. `fake-audio.mjs` records every node and parameter
automation with the time it was scheduled for; it is what makes the engine
testable, and the engine's own voices are not covered yet (see below).

The in-repo fixtures are two MIDI files that have each caught a real bug. There
is a much larger corpus at `/home/sdwvit/MX500-900/Music/midi` (407 files, Doom
wads, Descent, Warcraft 2, DKC); the parser matched the reference on all 407 at
`47088d9`. Re-scoring it needs a small runner against `js/midi.js` — the old
`wip/miditest/compare.mjs` did this by slicing `index.html` with string markers
and was removed with `wip/`; `git show 47088d9^:wip/miditest/compare.mjs` has it
if you want to port it.

## What is not covered

- **Sound.** The tests prove the right nodes were scheduled with the right
  numbers, not that the result is musical. That is still the user's ear on the
  phone — ask them to listen.
- **The SoundFont path end to end.** `sf2.js` parses and prunes, but no test
  loads a real font; they are 47 MB and 315 MB and cannot go in the repo. The
  memory ceiling is the thing to watch: decoding a whole 315 MB font to Float32
  needs 619 MB and iOS kills the tab, so only the zones the loaded MIDI actually
  triggers are sliced (measured 9.4–38.4 MB). A test that asserts the pruned
  total stays in that band, gated on an env var pointing at a font, is the
  highest-value test still missing.
  Fonts: `/home/sdwvit/MX500-900/games/gzdoom/SGM-v2.01-...V1.2.sf2` (315 MB),
  `SC-55.sf2` (47 MB).
- **The engine's voices.** `fake-audio.mjs` exists for this; nothing uses it yet.

## Things that will bite you

- iOS needs HTTPS and a real user gesture for both motion permission and the
  AudioContext. Both happen on the single "Start Drive" tap. Do not add anything
  before them in that handler.
- The iOS accelerometer axis signs were never confirmed. Forward and lateral
  each have a runtime flip persisted to localStorage. Leave that in.
- `event.acceleration` under-reports *sustained* acceleration, because Apple's
  fusion slowly re-attributes it to gravity (SPEC §3.2.2b). This is why layers
  gate on GPS speed, not acceleration — do not "simplify" that back, it empties
  the mix on a motorway. `layers.test.mjs` guards it.
- `coords.speed` is documented as null when unknown but real devices also return
  NaN, which survives every later arithmetic step and poisons `A.bpm`. It is
  rejected at the door in `startGeo`.
- No built-in soundfont and no persistence for it — the user chose to re-pick it
  each session. The MIDI library *is* persisted.
- Do not add `Co-Authored-By` trailers to commits (user's global CLAUDE.md).

## Browser checking

Serve with `python3 -m http.server` from the project root. Chrome tools work but
the window is often hidden, which pauses rAF and makes the page look frozen;
drive the page with an injected main-world `<script>`, as isolated-world
`dispatchEvent` does not reach page listeners.
