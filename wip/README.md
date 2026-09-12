# Work in progress — SoundFont (SF2) support

Not wired into `index.html` yet. `sf2-parser.js` is written and tested against
real soundfonts but has no playback layer and no UI.

## What is done

- `sf2-parser.js` — reads the RIFF chunk directory and the `pdta` preset data,
  builds preset -> instrument -> sample zones with key/velocity ranges, and
  resolves `(bank, program, key, velocity)` to a set of sample zones. It never
  reads sample data; `SF.smplOff` records where the PCM lives so it can be
  sliced on demand.
- `index.html` now parses MIDI program change and bank select (CC0), so every
  track carries `bank` and `program`.

## Verified

| | SC-55 (47MB) | SGM (315MB) |
|---|---|---|
| parse time | 21ms | 29ms |
| presets | 136 | 285 |
| samples | 720 | 1825 |

Parse is fast on the 315MB file because only the 0.24MB `pdta` is read.

## The memory result that drives the design

Measured with `memtest.js` (SGM + real MIDI files):

| Strategy | Float32 in browser |
|---|---|
| whole font | **619 MB** — impossible on iOS |
| whole presets used | 36–48 MB |
| pruned to keys/velocities actually played | **9.4–38.4 MB** |

So: resolve the zones each track actually triggers, slice only those samples
out of the file, and never hold the whole font.

## What is left

1. Sample loading: `file.slice()` each needed sample range, int16 -> Float32
   AudioBuffer at the sample's own rate. Show progress; it is tens of MB.
2. Voice: `AudioBufferSourceNode` + `playbackRate` from
   `2^((key - rootKey + coarse + fine/100)/12)`, loop points from the sample
   header when `sampleModes` is 1 or 3, volume envelope from `attackVolEnv`
   etc (timecents -> `2^(tc/1200)` seconds; `sustainVolEnv` and
   `initialAttenuation` are centibels -> `10^(-cB/200)`), pan from generator 17.
3. Route `playMidiNote` to the soundfont voice when `SF.ready`, else the
   existing synth. Roles then gate volume only, not timbre.
4. UI: an upload button beside the MIDI one, progress, and a clear control.

## Testing

    node wip/sf2test.js <font.sf2>
    S=<scratch> node wip/memtest.js <font.sf2> <file.mid>

Both need the `NodeFile` shim already in those files.
