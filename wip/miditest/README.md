# MIDI parser test harness

Scores `parseMidi` (lifted straight out of `index.html`, so it always tests the
shipped code) against a corpus of real files.

    node wip/miditest/harness.mjs    # does every file parse at all?
    node wip/miditest/compare.mjs    # does it find every note a strict reader finds?
    node wip/miditest/nantest.mjs    # BPM guards: no NaN can reach a note duration
    node wip/miditest/labels.mjs     # which track names are kept vs replaced
    node wip/miditest/inspect.mjs F  # one file's tracks, roles, instruments
    node wip/miditest/trace.mjs F    # one file's chunk and event stream

Corpus: `/home/sdwvit/MX500-900/Music/midi`, 407 files (Doom/`sunlust`/`sunder`/
`chillax` wads, Descent 1-2, Stonekeep, Warcraft 2, Donkey Kong Country,
Metroid Fusion, and a pile of Zach Siegel originals). Formats 0 and 1, no SMPTE.

`ref.mjs` is a deliberately strict reference reader used only as the scoring
oracle. It is not meant to be shipped.

## Where it stands

    before:  407 files, 404 parse, 180 match the reference
    after:   407 files, 407 parse, 407 match the reference

## Parser bugs found and fixed

1. **SysEx: `p += vlq()`.** JavaScript evaluates the `p` on the left before
   calling `vlq()`, so the bytes the length field consumed were discarded and
   every later event in the track landed at the wrong offset. Any file carrying
   a SysEx event - a GM/GS/XG reset, which nearly every game MIDI opens with -
   desynced from that point. The meta branch above it was fine only because it
   happened to read the length into a variable first.

2. **A zero track count in the header rejected the whole file.** `ntrk` is `0`
   in `Zach Siegel/{Frozen In Time,Purgatory,Zelda Metal}.mid`, which between
   them hold 4-6 perfectly good MTrk chunks. Chunks are now walked to EOF and
   `ntrk` is treated as the hint it is.

3. **Running status was clobbered by meta and SysEx,** so the next
   running-status event decoded as whichever system message came last. Only
   `0x80..0xef` sets it now.

4. **Realtime bytes `0xf8`/`0xfb`/`0xfe` fell through to `else { p = end }`,**
   abandoning the rest of the track over a byte that carries no data.

5. **A non-`MTrk` chunk ended the file** instead of being skipped by its length.

6. **A same-key retrigger overwrote the note already sounding.** This was the
   bulk of the 227 mismatches - Doom and Stonekeep files restrike a ringing key
   constantly. Each key now holds a queue and each note-off closes the oldest.

7. **Reads could run past the track end** (several Warcraft 2 files) and past
   the buffer on a final track. Out-of-range reads now yield 0 rather than
   throwing away an otherwise fine song.

## Playback bugs found and fixed

8. **`NaN bpm`, then silence mid-song.** `coords.speed` is documented as `null`
   when unknown, but real devices also hand back `NaN`. That fed
   `A.pendingBpm`, and NaN survives both the subtraction and the clamp in the
   tempo slew, so `A.bpm` was poisoned permanently. Every note duration then
   became NaN, and the first AudioParam call with a NaN time threw out of the
   scheduler - which is why playback ran for a while and then stopped dead on
   "some note". Guarded at the GPS callback, guarded again in `applyMapping`,
   and the slew (`slewBpm`) now heals itself instead of latching. `nantest.mjs`
   covers all of it.

## Track labelling

9. **Credits in the track-name meta.** Authors routinely type their credits one
   line per track, so a whole song shows up labelled "Composed By: ...",
   "jamespaddock@tiscali.co.uk", "==============". Those tracks are ordinary
   music - in `sunder/Become the haunted.mid` they hold 341, 244 and 642 notes
   and are the entire song - so they must **not** be dropped. Only the label is
   useless, and it now falls back to the GM instrument name. A name that looks
   like a real part ("Clean Rhythm Guitar", "Backing Keyboards") is kept
   whatever its length. `labels.mjs` shows the split across the corpus.

Tempo (`0x51`) being ignored is **not** a bug - tempo comes from driving, per
`SPEC.md`.
