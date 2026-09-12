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

## Your task: finish SoundFont support

`wip/README.md` is the detailed brief. Summary:

The SF2 directory parser (`wip/sf2-parser.js`) is written and tested against
two real soundfonts, but has no playback layer and no UI. MIDI program/bank
parsing is already done and merged into `index.html`.

Remaining work, in order:

1. **Sample loading.** `file.slice()` each needed sample byte range out of the
   .sf2, convert int16 -> Float32 `AudioBuffer` at the sample's own rate.
   Needs a progress indicator — it is tens of MB.
2. **The voice.** `AudioBufferSourceNode` + `playbackRate` from
   `2^((key - rootKey + coarse + fine/100)/12)`; loop points from the sample
   header when `sampleModes` is 1 or 3; volume envelope from the `*VolEnv`
   generators (timecents -> `2^(tc/1200)` seconds; `sustainVolEnv` and
   `initialAttenuation` are centibels -> `10^(-cB/200)`); pan from generator 17.
3. **Routing.** `playMidiNote()` uses the soundfont when `SF.ready`, else the
   existing synth voices. Roles then gate *volume only*, not timbre.
4. **UI.** Upload button beside the MIDI one, progress, clear control.

Settled decisions: **no built-in soundfont** (user uploads their own), **no
persistence** for it (re-pick each session — the user chose this deliberately,
unlike the MIDI file which *is* remembered in IndexedDB), and **core fidelity**
(samples, loops, envelopes, pan — no SF2 filter, no modulator matrix).

## The constraint that drives the whole design

Decoding a whole 315MB soundfont into Float32 audio buffers needs **619 MB**.
iOS Safari will kill the tab. Measured alternatives:

| Strategy | Float32 in browser |
|---|---|
| whole font | 619 MB — impossible |
| whole presets used | 36–48 MB |
| pruned to keys/velocities actually played | **9.4–38.4 MB** |

So resolve the zones each track actually triggers and slice only those samples.
Never hold the whole font. `memtest.js` measures this for any font/MIDI pair.

## Test assets

    /home/sdwvit/MX500-900/games/gzdoom/SGM-v2.01-...V1.2.sf2   315MB, 285 presets
    /home/sdwvit/MX500-900/games/gzdoom/SC-55.sf2                47MB, 136 presets
    /home/sdwvit/Downloads/map29.mid        format 1, 16 tracks, 11392 notes
    /home/sdwvit/Downloads/D_RUNNIN.mid     format 0, 9 channels, 4931 notes

Use both MIDI files. They are different formats and each has already caught a
real bug.

## How to verify

There is no test suite. What has worked:

- **Logic in node.** Extract functions from `index.html` with a small python
  slice and run them (see `wip/sf2test.js`, `wip/memtest.js`). This caught
  every MIDI bug so far and is much faster than the browser.
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
- Do not add `Co-Authored-By` trailers to commits (user's global CLAUDE.md).

## Git

Branch `main`, clean, pushed. Recent:

    d0f8e3f  Parse MIDI program/bank; add tested SF2 directory parser as WIP
    (earlier) speed gating, role distribution, channel split, MIDI upload,
             audio engine, M1 sensor readout
