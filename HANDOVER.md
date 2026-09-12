# Handover — DriveBeats

## Context

`/home/sdwvit/IdeaProjects/DriveBeats`, deployed to GitHub Pages from `main`
(`.github/workflows/pages.yml`). The whole app is a single self-contained
`index.html` — no build step, no dependencies, no CDN (it must work in a car
with no signal). `SPEC.md` is the design record and is kept current; read it
before changing behaviour. Push to `main` deploys.

An iPhone is mounted in the car, screen up, top edge forward, tilted slightly
nose-down. It reads the accelerometer and plays generative techno, or a
user-uploaded MIDI file, shaped by how the car is being driven. **It works and
the user has confirmed it sounds good.**

## State

SoundFont (.sf2) support is **complete and merged** — parser, pruned sample
loader, voice, routing and UI are all in `index.html`. The `wip/` folder is
gone; nothing is outstanding from it. See SPEC §4.8 for the design and why
each piece is the way it is.

What it does: upload a .sf2 beside the MIDI file and notes play with real
samples instead of the synth voices. Roles then gate volume only. No font
ships with the app and the font is not persisted (re-pick each session) — both
deliberate, see SPEC §7.7.

**Audio has still never been verified from tooling**, only by the user on the
phone. The logic is tested (below) but nobody has heard the soundfont path.
That is the first thing to ask the user to check.

## The constraint that drives the soundfont design

Decoding a whole 315MB font into Float32 buffers needs **619 MB** and iOS
Safari will kill the tab. Pruning to the zones the loaded MIDI actually
triggers brings it to 3.7–30.8 MB on the real test files. So the font is never
held in memory — only the RIFF directory and the 0.24MB `pdta` chunk are read
up front, and sample PCM is `File.slice()`d off disk per zone. Do not
"simplify" this into loading the file.

## Test assets

    /home/sdwvit/MX500-900/games/gzdoom/SGM-v2.01-...V1.2.sf2   315MB, 285 presets
    /home/sdwvit/MX500-900/games/gzdoom/SC-55.sf2                47MB, 136 presets
    /home/sdwvit/Downloads/map29.mid        format 1, 16 tracks, 11392 notes
    /home/sdwvit/Downloads/D_RUNNIN.mid     format 0, 9 channels, 4931 notes

Use both MIDI files against both fonts. They are different formats and each
has already caught a real bug.

## How to verify

There is no test suite. What has worked, and what found every bug so far:

- **Logic in node.** Slice the functions out of `index.html` with a small
  python script and run them against the real assets. Two harnesses were used
  and are worth rebuilding if you touch this area:
  - *Unit*: extract the SF block (from the `SOUNDFONT (SF2)` banner to the
    `MIDI PLAYBACK` banner), stub `AudioContext`, then parse each font, prune
    against each MIDI, and play every distinct `(bank, program, key, velocity)`
    through the real `sfVoice`. Assert: no zone misses, `playbackRate` stays
    in roughly 0.1–5, no `exponentialRampToValueAtTime` target ≤ 0, no
    backwards event times, loop points inside the buffer.
  - *Integration*: extract the entire `<script>` body, stub DOM + Web Audio,
    append a `module.exports` before the closing `})();`, then drive
    `schedulerMidi` over two full song lengths. Assert: loop wraps ≥ 2, voices
    start, peak concurrency sits at the 64 cap. This is what caught the
    `onended`-after-`stop` bug where the voice counter never came back down
    and the cap silently swallowed every note after the 64th.
- **Syntax.** Extract the `<script>` block and `node --check` it. The file is
  assembled by script, so a truncated write is a real risk — it happened once.
- **Browser.** Chrome tools work but the window is often hidden, which pauses
  rAF and makes the page look frozen. Drive the page with an injected
  main-world `<script>`; isolated-world `dispatchEvent` does not reach page
  listeners. Serve with `python3 -m http.server` from the project root.

## Things that will bite you

- **Audio has never been verified from tooling**, only by the user on the
  phone. Assume nothing about how it sounds; ask them to listen.
- iOS needs HTTPS and a real user gesture for both motion permission and the
  AudioContext. Both happen on the single "Start Drive" tap. Do not add
  anything before them in that handler.
- The iOS accelerometer axis signs were never confirmed. Instead of guessing,
  forward and lateral each have a runtime flip persisted to localStorage.
  Leave that in.
- `event.acceleration` under-reports *sustained* acceleration, because Apple's
  fusion slowly re-attributes it to gravity (SPEC §3.2.2b). Layer gating
  therefore keys on speed as well as acceleration — do not "simplify" that back
  to acceleration alone, it empties the mix on a motorway.
- In the soundfont voice, **preset generators add to instrument generators**,
  they do not replace them (SF2 §9.4), and **`scaleTuning` (gen 56) must be
  honoured** or drum samples transpose with the key and play back at ~12×.
- Wire `src.onended` *before* `src.start()`/`src.stop()`. See above.
- Do not add `Co-Authored-By` trailers to commits (user's global CLAUDE.md).

## Ideas deliberately not done

- SF2 low-pass filter and the modulator matrix (SPEC §4.8 — refinements).
- 24-bit sample support (`sm24` chunk); 16-bit only.
- Persisting the font. See SPEC §7.7 for why not.

## Git

Branch `main`.
