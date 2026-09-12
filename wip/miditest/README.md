# MIDI parser test harness

Scores `parseMidi` (lifted straight out of `index.html`, so it always tests the
shipped code) against a corpus of real files.

    node wip/miditest/harness.mjs    # does every file parse at all?
    node wip/miditest/compare.mjs    # does it find every note a strict reader finds?
    node wip/miditest/trace.mjs FILE # dump one file's chunk and event stream

Corpus: `/home/sdwvit/MX500-900/Music/midi`, 407 files (Doom/`sunlust`/`sunder`/
`chillax` wads, Descent 1-2, Stonekeep, Warcraft 2, Donkey Kong Country,
Metroid Fusion, and a pile of Zach Siegel originals). Formats 0 and 1, no SMPTE.

`ref.mjs` is a deliberately strict reference reader used only as the scoring
oracle. It is not meant to be shipped.

## Baseline at commit 0c276e8

    harness:  407 files, 404 parse, 3 throw
    compare:  180 identical to reference, 227 lose notes

Every difference is a **loss** - the shipped parser never invents notes. Losses
run from a single note up to 17% of the file (`Descent/Game09.mid`, 4780 of
5768).

## Bugs found, none yet fixed

Held back deliberately: another agent was editing `index.html` at the time.

1. **`index.html:296`, SysEx branch: `p += vlq()`.** JavaScript evaluates the
   `p` on the left before calling `vlq()`, so the bytes the VLQ consumed are
   discarded and `p` lands short by the length of the length field. Any file
   carrying a SysEx event - a GM/GS/XG reset, which nearly every game MIDI
   opens with - desyncs the event stream from that point on. The meta branch a
   few lines up is fine only because it happens to read `ml` into a variable
   first.

2. **A zero track count in the header rejects the whole file.** `ntrk` is `0`
   in `Zach Siegel/{Frozen In Time,Purgatory,Zelda Metal}.mid`, which between
   them hold 4-6 perfectly good MTrk chunks. `for (t = 0; t < ntrk; t++)` never
   runs, so the file throws "No notes found". Walk chunks to EOF and treat
   `ntrk` as a hint.

3. **Running status is clobbered by meta and SysEx.** `running = st` runs for
   `0xff` and `0xf0` too, so the next running-status event decodes as a meta
   event. Only status bytes `0x80..0xef` may set it. 15 files hit this.

4. **Realtime status bytes fall off the end of the `if` chain.** `0xf8`, `0xfb`
   and `0xfe` reach `else { p = end }`, which abandons the rest of the track.

5. **A non-`MTrk` chunk `break`s out of the file** rather than being skipped.
   The spec requires unknown chunk types be skipped by their length.

6. **A same-key retrigger overwrites `open[key]`,** dropping the note already
   held. This is the bulk of the 227 diffs. Doom and Stonekeep files retrigger
   a sounding note constantly. Needs a queue per key, not one slot.

7. **Reads can overrun the track `end`** by a byte (several Warcraft 2 files),
   which on a final track means reading past the buffer.

Tempo (`0x51`) being ignored is **not** a bug - tempo comes from driving, per
`SPEC.md`.
