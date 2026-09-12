# DriveBeats — Design Spec

**One line:** a web app running on an iPhone mounted in a car that reads the
accelerometer, estimates how the car is being driven, and continuously shapes
generative music to match.

**Platform:** iOS Safari (added to home screen as a PWA).
**Audio:** synthesized live via Web Audio API. No files, no licensing, no library.
**Mapping:** continuous — driving parameters drive tempo, filter and density in
real time, rather than selecting between pre-made tracks.

---

## 1. The actual hard problem

The naive version of this app is "read accelerometer, make music louder when the
number is big." That does not work, for three reasons:

1. **Gravity dominates.** The accelerometer reads ~9.81 m/s² at rest. Real
   driving events are 1–8 m/s². The signal you want is 10–20% of the signal you
   get.
2. **The phone is not the car.** Readings are in *phone* axes. A phone in a cup
   holder, in a vent mount, or flat on the passenger seat all produce completely
   different axis assignments for the same braking event.
3. **Road noise.** Suspension, engine vibration and bumps inject broadband noise
   that is often larger in amplitude than gentle acceleration.

So the sensing half of this app is really a small signal-processing pipeline:
**de-gravity → find the car's frame → project → filter → derive features.**
Everything in §3 exists to solve that. The music half (§4) is comparatively easy.

### 1.1 What the numbers actually look like

Reference magnitudes for a normal passenger car, used throughout for scaling:

| Event | Longitudinal accel | In g |
|---|---|---|
| Gentle acceleration | 0.5 – 1.5 m/s² | 0.05 – 0.15 g |
| Brisk acceleration | 2 – 3 m/s² | 0.2 – 0.3 g |
| Hard acceleration (performance car) | 4 – 6 m/s² | 0.4 – 0.6 g |
| Coasting / engine braking | −0.3 – −1 m/s² | ~0.05 g |
| Normal braking | −2 – −3 m/s² | 0.2 – 0.3 g |
| Hard braking | −6 – −8 m/s² | 0.6 – 0.8 g |
| Emergency / ABS | −9 m/s² | ~0.9 g |
| Normal cornering (lateral) | 2 – 4 m/s² | 0.2 – 0.4 g |
| Spirited cornering | 5 – 7 m/s² | 0.5 – 0.7 g |
| Road noise / bumps (broadband) | 0.5 – 2 m/s² peak | — |

Two things fall out of this table:
- The **useful dynamic range is roughly 0–8 m/s²**, and road noise occupies the
  bottom ~1.5 m/s² of it. A dead-band is mandatory, not optional.
- Braking is **much stronger than acceleration** in every car. The mapping must
  scale the two asymmetrically or braking will always pin the meters.

---

## 2. Sensor layer (iOS Safari specifics)

### 2.1 API choice

iOS Safari supports **only** `DeviceMotionEvent` / `DeviceOrientationEvent`.
The Generic Sensor API (`Accelerometer`, `LinearAccelerationSensor`) is **not
available** and must not be depended on.

Fortunately `devicemotion` on iOS is better than the spec minimum:

- `event.accelerationIncludingGravity` — raw, phone frame.
- `event.acceleration` — **gravity already removed by Apple's sensor fusion.**
  This is reliable on iOS (unlike many Android devices, where it is synthesized
  or absent). We use this as the primary input.
- `event.rotationRate` — gyro, in deg/s. Used for cornering cross-check and to
  detect the phone being re-positioned.
- `event.interval` — sample period. iOS delivers ~60 Hz.

We still read `accelerationIncludingGravity` in parallel, because the **gravity
vector** (obtained as `accelerationIncludingGravity − acceleration`) is exactly
what §3.1 needs to find "down".

### 2.2 Permission

Motion access on iOS requires an explicit, **user-gesture-initiated** call:

```js
if (typeof DeviceMotionEvent?.requestPermission === 'function') {
  const state = await DeviceMotionEvent.requestPermission();
}
```

Requirements this imposes on the app:
- Must be served over **HTTPS** (secure context). `localhost` works for dev;
  testing on the actual phone needs a real TLS origin or a tunnel.
- The permission prompt must be behind a real tap. This is the same tap that
  unlocks Web Audio (§4.1), so **one "Start Drive" button does both**.
- Permission is **not persistent across page loads** in Safari — it re-prompts.
  This is a design constraint on the start-up flow, not a bug to work around.

### 2.3 Sampling

- Nominal 60 Hz from the event; do not assume it. Timestamp every sample and
  compute real `dt` — iOS throttles under thermal load and when backgrounded.
- Drop samples with implausible `dt` (>200 ms) rather than integrating across a
  gap, which would produce a huge phantom acceleration spike.

---

## 3. Signal pipeline

Five stages. Each is independently testable against recorded sample data.

```
devicemotion
   │
   ├─ (a) gravity estimate ──────────┐
   │                                 ▼
   └─ linear accel (phone frame) → [rotate to car frame] → a_long, a_lat, a_vert
                                          │
                                          ▼
                                   [filter + dead-band]
                                          │
                                          ▼
                                 [feature extraction] → drive state
```

### 3.1 Finding "down"

Gravity vector `g = accelerationIncludingGravity − acceleration`, further
smoothed with a very slow low-pass (τ ≈ 2–5 s). Slow smoothing is correct here:
gravity's direction relative to the phone changes only when the phone moves in
its mount, which is rare.

`ĝ` gives us the vertical axis. Everything perpendicular to it is the horizontal
plane containing forward and lateral.

### 3.2 The mount, and the car frame

**Mount is fixed and specified:** phone screen facing up, top edge pointing
forward (head first), pitched slightly nose-down. Rigidly mounted, not loose in
a holder.

This is a design decision, not an assumption to be inferred — the app may
*require* this mount and tell the user so. It collapses the hardest part of §3
into a near-constant.

In iOS device coordinates (`x` across the screen, `y` up the screen toward the
top edge, `z` out of the screen):

| Car axis | Phone axis | Sign |
|---|---|---|
| Forward / back (longitudinal) | `y` | + is forward |
| Left / right (lateral) | `x` | + is right |
| Up / down (vertical) | `z` | + is up |

So `aLong = acceleration.y`, `aLat = acceleration.x`, modulo two corrections
below and a sign convention that **must be confirmed empirically in M1** —
Safari has historically reported `accelerationIncludingGravity` with inverted
sign relative to the W3C spec and to Chrome. Do not hardcode a sign from this
document; measure it on the target phone and write down what was observed.

#### 3.2.1 Correcting the nose-down pitch

The phone is pitched down by some angle θ. That tilt **leaks gravity into the
forward axis**: a component of magnitude `g·sin(θ)` appears along `y`.

This is not a small effect. At θ = 15°, that is **2.5 m/s²** — the same size as
a normal braking event, sitting there as a constant offset. At θ = 30° it is
4.9 m/s², larger than brisk acceleration.

Two ways to remove it:

- **Use `event.acceleration`** (gravity already removed by Apple's fusion). The
  tilt offset is gone for free. This is the primary path.
- **Measure and subtract:** capture the gravity vector while stationary and
  subtract its `y` component. Valid because the mount is rigid, so θ is
  constant. Useful as a cross-check against the fusion output.

The app estimates θ from gravity at rest and **warns if the phone is mounted far
from the declared orientation** — e.g. portrait in a vent mount, or upside down —
but allows the user to continue anyway (decision 4). A wrong mount silently
produces wrong music, which is much worse than a warning; but hard-blocking
would make the app impossible to test at a desk.

#### 3.2.2 The two failure modes this mount introduces

These are the real reasons this section isn't just a lookup table.

**(a) Body pitch under braking — "nose dive."** A car's suspension pitches
forward 2–5° under hard braking, and squats under hard acceleration. The phone
is rigidly mounted to the car, so it pitches too. That tilt leaks gravity into
the forward axis, *correlated with the very event being measured*. It inflates
apparent braking and deflates apparent acceleration by up to ~0.9 m/s² at 5°.

For this app that is **acceptable and arguably desirable** — it exaggerates
exactly the events the music should respond to. It matters only if absolute
accuracy is ever needed (it isn't). Noted so it isn't mistaken for a bug during
M3 tuning.

**(b) Fusion drift on sustained acceleration — the one that actually bites.**
A linear accelerometer cannot distinguish "tilted in a gravity field" from
"accelerating in a straight line" — they are physically identical readings.
Apple's fusion resolves this by assuming that *sustained* constant acceleration
is more likely to be tilt, and slowly re-attributes it to the gravity estimate.

Consequence: `event.acceleration` is excellent for **transients** (a brake stab,
a hard launch) but **under-reports sustained acceleration**. A long steady
highway on-ramp pull may read strongly for the first couple of seconds and then
decay toward zero even though you are still accelerating.

Mitigations, in order of preference:

1. **Accept it.** Music responding to changes in driving rather than to steady
   states is defensible, and possibly better. Steady-state energy is carried by
   `speed` → tempo anyway (§4.4), which does not decay.
2. **Complementary filter with GPS.** Use the accelerometer for the fast path
   and `d(speed)/dt` from Geolocation for the slow path, crossing over around
   0.2–0.5 Hz. This reconstructs sustained acceleration correctly and is the
   standard fix. Cost: GPS becomes load-bearing rather than optional.
3. **Derive gravity yourself** from `accelerationIncludingGravity` with a very
   slow high-pass, and tune the time constant longer than Apple's. Trades one
   arbitrary time constant for another you control.

**Recommendation:** build with (1), measure the decay in M2 recordings, and only
add (2) if it is audible. This is a decision to make with data, not in advance.

### 3.3 Filtering

Applied to each projected axis:

1. **Low-pass**, one-pole IIR, cutoff ~2–3 Hz. Vehicle body dynamics live below
   ~2 Hz; road and engine vibration lives above. This is the single most
   effective cleanup step.
2. **Dead-band** of ~0.4 m/s², applied *after* low-pass, so idling at a light
   reads as exactly zero and the music sits still instead of shimmering.
3. **Asymmetric normalization** into a 0..1 signal, using separate scales for
   acceleration (÷ 4 m/s²) and braking (÷ 7 m/s²), per §1.1.
4. **Slew limiting** on anything that feeds audio, so a single spurious spike
   cannot produce a click or a jump in tempo.

### 3.4 Derived features

The music engine consumes only this struct, never raw sensor data. This is the
seam that makes both halves testable in isolation.

```
DriveState {
  speed        : m/s      // from Geolocation, smoothed; null if unavailable
  aLong        : m/s²     // signed: + accelerating, − braking
  aLat         : m/s²     // signed: + right, − left
  jerk         : m/s³     // d(aLong)/dt — how abrupt the inputs are
  intensity    : 0..1     // smoothed magnitude of horizontal accel
  aggression   : 0..1     // slow-moving average of intensity + jerk (~30 s)
  cornering    : 0..1     // smoothed |aLat|
  event        : 'hard-brake' | 'hard-accel' | 'hard-corner' | null
  confidence   : 0..1     // how much we trust the car-frame estimate
  stationary   : bool     // speed ≈ 0 and accel ≈ 0 for > 3 s
}
```

Note the two timescales: `intensity` is fast (reacts in ~0.5 s) and drives
immediate musical response; `aggression` is slow (~30 s) and drives the overall
character of the piece. Using only the fast one produces music that twitches;
using only the slow one produces music that feels unresponsive. Both are needed.

### 3.5 GPS as a second sensor

`navigator.geolocation.watchPosition({ enableHighAccuracy: true })` gives speed
directly in `coords.speed` (m/s, or null). It is slow (~1 Hz) and unreliable in
tunnels and urban canyons, so it is **supplementary**, never required:

- Ground truth for the sign/scale calibration in §3.2.
- Absolute speed, which accelerometry alone cannot provide (integrating
  acceleration to get velocity drifts unusably within seconds).
- A `stationary` check that doesn't depend on accelerometer thresholds.

The app must fully function with GPS denied or unavailable — degraded, not
broken.

---

## 4. Music engine

### 4.1 Audio unlock

iOS requires an `AudioContext` to be created or resumed inside a user gesture.
Combined with §2.2, the start-up flow is exactly:

```
[ Start Drive ] tap
   ├─ new AudioContext() + resume()
   ├─ play a silent buffer (belt-and-braces unlock)
   ├─ DeviceMotionEvent.requestPermission()
   ├─ navigator.geolocation.watchPosition()
   └─ navigator.wakeLock.request('screen')
```

All of it on one tap. There is no way to do any of it earlier.

### 4.2 Why generative is the right call here

With a recorded track, "faster music" means `playbackRate`, which pitch-shifts —
the track goes chipmunk. Avoiding that needs time-stretching, which is expensive
and artifact-prone in a browser. **Generating the music means tempo is just a
number in the scheduler.** No stretching, no pitch shift, no artifacts. Same for
key changes, density, and instrumentation.

### 4.3 Architecture

A **lookahead scheduler**: a `setInterval` (~25 ms) that looks ~100 ms into the
future and schedules any notes falling in that window at precise
`audioContext.currentTime` values. Never schedule from timers directly; never
schedule more than ~200 ms ahead, or parameter changes will feel laggy.

Voices, all synthesized:
- **Kick / drums** — oscillator + envelope, or noise burst through a bandpass.
- **Bass** — saw/square through a low-pass, following a root-note sequence.
- **Pad** — 2–3 detuned oscillators, slow filter sweep.
- **Lead / arp** — sequenced, only present at higher intensity.

Master chain: `voices → bus → [low-pass filter] → [compressor] → destination`.
The compressor matters more than usual, because road noise means the driver will
have the volume high and sudden density changes must not be startling.

### 4.4 Mapping

| DriveState | Musical parameter | Range | Curve |
|---|---|---|---|
| `speed` | tempo (BPM) | 104 → 132 | linear, clamped, quantized to bars |
| `speed` + `aggression` | rhythmic feel | half → straight → double | stepped, hysteresis |
| `intensity` | master low-pass cutoff | 600 Hz → 16 kHz | exponential |
| `intensity` | percussion density | 1/4 → 1/16 notes | stepped |
| `aggression` | scale / mode | minor pent → phrygian | stepped, hysteresis |
| `speed` | which layers are audible | pad → full band | 10/20/30/70 mph ladder, hysteresis |
| `cornering` | stereo pan of pad/lead | −0.7 → +0.7 | linear, follows sign of `aLat` |
| `aLong` < 0 (braking) | filter dip + reverse swell | — | transient |
| `jerk` | envelope attack time | 40 ms → 2 ms | inverse |
| `stationary` | reduce to pad only | — | 4 s fade |

Rules that keep it musical rather than gimmicky:

- **Tempo changes are quantized to bar boundaries** and slew-limited to ~±4 BPM
  per bar. Continuously sliding tempo sounds broken, not responsive.
- **Energy comes from feel, not from BPM range.** A 70→150 BPM sweep would leave
  the genre entirely at both ends — 70 BPM is not techno and 150 is hardcore.
  Instead the tempo band stays musically narrow (104–132) and the large energy
  jumps come from *rhythmic subdivision*: half-time when cruising, straight when
  moving, double-time when driving hard. The perceived range is enormous while
  the actual tempo barely moves, and every transition stays on the grid. This is
  how the genre itself creates energy, and it is the single most important
  mapping decision in the document.
- **Every threshold has hysteresis.** Without it, driving at exactly the boundary
  makes the lead voice flicker on and off, which is maddening.
- **Cornering pans, it does not transpose.** Pitch changes tied to steering feel
  seasick; spatial movement feels correct.
- **Stationary is a real state, not just low intensity.** At a red light the
  music should *rest* on a sustained pad, not just play quietly. This is the
  single biggest contributor to "feels intentional" vs "feels like a meter."

---

### 4.5 Musical design — driving techno / synthwave

**Key and scale.** Fixed root (A) for the whole session; changing root mid-drive
is disorienting. `aggression` selects the scale, with hysteresis:

| Aggression | Scale | Character |
|---|---|---|
| 0.0 – 0.35 | A natural minor | open, cruising |
| 0.35 – 0.7 | A minor pentatonic | leaner, more driving |
| 0.7 – 1.0 | A phrygian | dark, tense, aggressive |

Because all three share a tonic and most chord tones, transitions between them
are smooth rather than jarring — this is why they were chosen over unrelated
modes.

**Voices.**

| Voice | Synthesis | Present when |
|---|---|---|
| Kick | sine with fast pitch envelope (~120→45 Hz) + click | always above half-time |
| Bass | saw through resonant LP, 1/8 or 1/16 root pattern | always |
| Pad | 3 detuned saws, slow filter sweep, long release | always, incl. at rest |
| Hats | filtered white noise, short decay | straight feel and above |
| Arp | square/pulse, 1/16, follows scale | `aggression` > 0.4 |
| Lead | saw + slow vibrato, sparse long notes | `aggression` > 0.7 |

**Structure.** No verse/chorus — this is loop-based. An 8-bar cycle with the
pad chord moving i → VI → III → VII, everything else riding it. Musical
interest comes from the driving-driven parameter changes, not from composition.
That is the point of the form: it can be interrupted and re-shaped at any bar
without ever sounding wrong.

**Master chain.** `voices → bus → LP filter → soft-knee compressor →
destination`, with a gentle limiter before output. The compressor is load-bearing
(§4.3): road noise means the volume will be high, and density changes must not
startle.

### 4.6 Behaviour at rest

The music **never fully stops during a session.** When `stationary` is true —
parked before setting off, or waiting at a light — the engine fades over ~4 s to
the pad alone: sustained, slowly filtering, still moving through the 8-bar chord
cycle so that it remains *in time* and can be rejoined seamlessly.

This is deliberately not "the same music, quieter." A rest is a musical event.
Dropping to a pad makes a red light feel composed rather than like a dropout,
and gives the app audible presence while the phone is being mounted.

Re-entry when motion resumes: kick and bass return on the next **bar** boundary,
not immediately. A beat of anticipation reads as intent; an instant return reads
as a glitch.


### 4.7 Uploaded MIDI

A user-supplied MIDI file can replace the built-in generator. MIDI is note
data, not audio, so the §4.2 argument still holds in full: tempo remains a
number in the scheduler, with no time-stretching and no pitch shift.

**Model: layers gated by driving.** The notes play exactly as written; driving
decides which layers are audible, plus tempo and filter. This keeps the user's
composition intact while staying reactive — the alternative, letting
`aggression` re-pick a scale, would clash against a written melody, so scale
selection is disabled whenever a file is loaded.

Each track is assigned a role, guessed on load and overridable in the UI.
Assignment picks primary voices, then distributes the remaining tracks by
character (sustain length and pitch) rather than dumping them all into one
role — on a 16-track file, a single-pick-per-role scheme left 75% of the notes
in `keys`, which makes the layer gating meaningless. Tracks with very few notes
are excluded from the primary picks, since a stab or a drone should not beat
the real bassline to the `bass` role.

| Role | Guessed from | Audible when |
|---|---|---|
| `drums` | MIDI channel 10 | ≥ 10 mph (quieter at half-time feel) |
| `bass` | lowest average pitch | ≥ 10 mph |
| `pad` | longest average note among the middle tracks | **always, including at rest** |
| `keys` | anything left over | ≥ 20 mph |
| `lead` | highest average pitch | ≥ 30 mph |
| `off` | — | never |

If a file has no pad track, the generated pad bed stands in, so a rest is never
silence.

#### The speed ladder

Layers are gated by a ladder of speed breakpoints, in **mph** because that is
what the driver reads off the dashboard:

| Breakpoint | Adds | Result |
|---|---|---|
| stopped | — | pad alone |
| 10 mph | bass, drums | **a whole song** |
| 20 mph | keys | |
| 30 mph | lead | full arrangement |
| 70 mph | — | everything at full: no half-feel thinning, hats on every 16th |

The 10 mph tier is deliberately a complete arrangement — pad, bass and drums —
so that crawling through town is still worth listening to. The tiers above it
add colour, not substance. A layer is won at its breakpoint but not lost until
2 mph below it, so hovering on a limit does not flicker the mix in and out.

The same ladder gates the generator's own parts (`A.tier`), so both music
sources behave alike.

**Gating must not key on acceleration alone.** `intensity` and `aggression` are
both derived from the accelerometer, and at a steady 70 mph the accelerometer
reads nothing — so a purely acceleration-driven gate empties the mix exactly
when the drive feels fastest. Keying the ladder on GPS speed is what makes the
motorway case work. With GPS unavailable, sustained `aggression` stands in,
spread over the same 0–70 mph ladder, so the behaviour degrades rather than
breaking.

**Implementation.** The Standard MIDI File parser is inline — no dependency, no
CDN — because the app must work in a car with no signal. It handles format 0
and 1, running status, note-on-with-velocity-0 as note-off, and notes left
hanging at end of track; SMPTE timecode division is rejected with a message.

Tracks are split **by MIDI channel**, not by MTrk chunk. Format 0 files carry
every instrument on a single track separated only by channel, so treating a
chunk as an instrument would collapse a whole song into one role — and because
role detection keys on channel 10, a single percussion note would make the
entire file play as drums.
**The library.** Every uploaded file is kept in IndexedDB under `midi:<name>`,
with `current` as a pointer to whichever one is loaded; the current file and its
role overrides are restored automatically on the next launch. The UI lists the
saved files so a second one can be chosen without going back to the phone's file
browser, which is not something to be doing at the wheel. "Use built-in" drops
back to the generator but keeps the library; removing a file is explicit, and
removing the one that is playing falls back to the generator.

Unlike the MIDI file, a soundfont is deliberately **not** persisted (§4.8).

The file's own tempo map is deliberately ignored — tempo comes from driving.

---

### 4.8 SoundFont (.sf2) playback

A user-supplied SoundFont replaces the synthesized voices, so an uploaded MIDI
file plays with real sampled instruments instead of the five built-in timbres.
It is optional and layers on top of §4.7 — roles, gating and tempo are
unchanged.

**With a font loaded, roles gate volume only, not timbre.** The sample decides
what a note sounds like; the role decides how loud that layer is. This is the
whole point — otherwise a piano track routed to `bass` would still come out as
a square-wave bass.

#### The constraint that drives the design

Decoding a whole 315 MB font into `Float32` audio buffers needs **619 MB**, and
iOS Safari kills the tab well before that. Measured, per strategy:

| Strategy | Float32 held in the browser |
|---|---|
| whole font | 619 MB — impossible |
| every preset the file references | 36–48 MB |
| **pruned to the zones actually triggered** | **3.7–30.8 MB** |

So the font is **never held in memory**. Only the RIFF directory and the
`pdta` (preset data) chunk are read up front — 0.24 MB even on the 315 MB
font, which is why parsing it takes ~30 ms. Sample PCM is then sliced off disk
with `File.slice()` for just the zones the loaded MIDI can reach.

**Pruning keys on `(bank, program, key, velocity)` taken from the notes
themselves**, not from the track's dominant program — a track can change
program mid-song, and pruning has to match exactly what playback will later
ask for or a note arrives with no sample loaded. Distinct pairs actually
present are used rather than the key×velocity cross product, which
over-selects badly on velocity-layered fonts.

Reads are sorted by file offset and merged when less than 64 KB apart, turning
~76 scattered slices into ~18. The loader yields to the event loop between
runs so the progress bar paints and iOS does not see one long block.

Samples are decoded into buffers created at the **context's** sample rate, with
the difference folded into `playbackRate`, because `createBuffer` rejects some
of the odd rates real fonts use. Loop points stay frame-exact either way.

#### The voice

Core fidelity only: sample, tuning, loop, volume envelope, pan. No SF2
low-pass filter and no modulator matrix — both are audible refinements, not
the difference between "sounds like the instrument" and "doesn't".

| Element | Source |
|---|---|
| pitch | `2^(cents/1200)`, `cents = (key−root)·scaleTuning + coarse·100 + fine + correction` |
| root key | `overridingRootKey` (gen 58) if set, else the sample header's |
| loop | sample header, when `sampleModes` is 1 or 3 |
| envelope | `*VolEnv` generators; timecents → `2^(tc/1200)` s |
| level | `initialAttenuation` and `sustainVolEnv`, centibels → `10^(−cB/200)` |
| pan | generator 17, ±500 → ±1 |

**Preset generators are added to the instrument's, not substituted for them**
(SF2 spec §9.4). Getting this backwards silently detunes and re-levels every
layered preset.

**`scaleTuning` (gen 56) is not optional.** Drum zones set it to 0 so that the
key selects a sample without transposing it. Without it a snare mapped high up
the keyboard plays back at 12× rate — which is exactly what the first
implementation did.

**`exclusiveClass` (gen 57)** cuts the previous note in the same class over
12 ms. This is what stops an open hi-hat ringing through the closed one that
follows it.

Release is scheduled at note-off from the envelope's *actual* level at that
instant, computed rather than assumed: notes are scheduled with a known
duration, so a short note must release from mid-attack, not jump to the
sustain level first. `cancelAndHoldAtTime` would express this directly but
Safari does not have it.

**Polyphony is capped at 64 voices.** Over the cap a note is dropped rather
than handed back to the synth — a single note in a different timbre is more
noticeable than a missing one. The cap is checked per note, not per zone, so a
stereo sample (a left and a right zone) is never split in half; actual peak
concurrency measures ~66.

#### No persistence, deliberately

Unlike the MIDI file, the font is **not** stored in IndexedDB and must be
picked again each session. Storing tens to hundreds of MB in IndexedDB on a
phone invites eviction and quota failures, and the `File` handle cannot be
persisted anyway — the alternative would be re-reading the whole font into
storage, which is the one thing this design exists to avoid.

When no font is loaded, or when a note falls outside every zone in the font,
playback falls back to the §4.7 synth voices with no interruption.

---

## 5. iOS runtime constraints

These are not edge cases; they will all happen on the first real drive.

| Constraint | Consequence | Mitigation |
|---|---|---|
| Screen sleep kills everything | App stops mid-drive | `navigator.wakeLock` + re-acquire on `visibilitychange` |
| No background execution | Locking the phone stops audio and sensors | Document it; the phone must stay unlocked and mounted |
| `devicemotion` stops when hidden | Silent freeze, not an error | Detect via `visibilitychange`, pause cleanly, resume on return |
| Permission re-prompts each load | PWA relaunch needs a fresh tap | Accept it; make the Start screen fast and one-tap |
| Thermal throttling | Sample rate drops, audio glitches | Keep voice count modest; measure real `dt`; degrade gracefully |
| Silent-mode switch | Web Audio may be muted | Warn the user on the start screen |
| Battery drain | GPS + screen + audio is heavy | Assume the phone is on a charger; state it as a requirement |
| Incoming call / notification | Audio interrupted | Handle `AudioContext` `statechange`, offer resume |

---

## 6. Safety

The phone must be **mounted, and not touched while driving**. Everything after
the initial tap has to work with zero interaction.

- No small tap targets, no menus, no text to read while moving.
- The display is glanceable only: large, high-contrast, minimal motion.
- Never show anything that invites the driver to look at it for more than a
  moment, and in particular never gamify — no scores, no "how hard can you
  brake" feedback, nothing that rewards aggressive driving. The music reacts to
  the drive; it must not *encourage* a drive.
- Dark colour scheme by default for night use.
- The **rigid mount is a functional requirement, not a preference** (§3.2). A
  phone sliding around a cup holder produces garbage input and, separately, is
  a loose object in a crash. The start screen should state the required
  orientation and verify it against gravity before starting — **warning, not
  blocking** (decision 4), so the app stays testable on a desk.

This is worth stating in the spec because the obvious fun version of this app
(score your driving!) is the version that is actually dangerous.

---

## 7. Decisions

All previously open questions are settled. Recorded here with reasoning so they
can be revisited deliberately rather than drifted away from.

1. **Signed, not unsigned.** Braking and accelerating are musically distinct.
   The fixed mount (§3.2) makes this cheap — the forward axis is known a priori.
2. **Style: driving techno / synthwave.** See §4.5. Chosen because it
   synthesizes well from plain oscillators, and because tempo and density are
   native expressive parameters in the genre rather than bolted on.
3. **GPS: instrumented from M1, not load-bearing yet.** Log it from the first
   milestone so M2 recordings contain ground truth, but do not let the music
   depend on it. This makes the drift question (§3.2.2b) answerable from data
   already collected, with no re-drive. If drift proves audible, the
   complementary filter can be added in M5 against existing recordings.
4. **Mount check: warn, do not block.** Verify orientation against gravity at
   startup and warn clearly if it is wrong, but allow the user to continue —
   otherwise the app is untestable on a desk. See §6.
5. **At rest: sustained ambient bed.** The music never fully stops during a
   session. See §4.6.
6. **Uploaded MIDI: layers gated by driving**, parsed inline and remembered in
   IndexedDB. See §4.7.
7. **SoundFont: optional, user-supplied, pruned, not persisted.** No font ships
   with the app — it must work offline and a usable font is tens to hundreds of
   MB. Only the zones the loaded MIDI actually triggers are read off disk, and
   the font is re-picked each session. See §4.8.
8. **SoundFont fidelity: samples, tuning, loops, envelopes, pan — no filter, no
   modulators.** The excluded parts are refinements; the included parts are the
   difference between sounding like the instrument and not. See §4.8.

---

## 8. Suggested build order

Each milestone is independently useful and independently verifiable.

**M1 — Sensor readout.** Start button, permissions, live numeric display of raw
and gravity-compensated acceleration at measured sample rate. **GPS logged
alongside from the outset** (decision 3) though nothing consumes it yet. No
audio.
*Verifies:* permissions, HTTPS, sample rate, that iOS `acceleration` is usable,
and — critically — **the actual sign convention of each axis on the target
phone in the target mount** (§3.2). Brake once, accelerate once, turn once, and
write down what each axis did. Everything downstream depends on this.

**M2 — Recording harness.** Log `DriveState` inputs to a file, download after a
drive. Build an offline replay tool that feeds recordings through the pipeline.
*This is the highest-leverage milestone:* without it, every pipeline tweak needs
a physical drive to evaluate. With it, they take seconds at a desk.
Also the milestone that answers §3.2.2b: record a long steady highway pull and
look at whether `acceleration.y` decays. That single recording decides whether
GPS is optional.

**M3 — Pipeline.** Filtering, dead-band, frame estimation, feature extraction.
Tuned entirely against M2 recordings. Visualize each stage.

**M4 — Audio engine, static.** Lookahead scheduler, voices, master chain, fixed
tempo and parameters. No sensor input. Verifies it sounds good *before* adding
reactivity, so any later badness is provably a mapping problem.

**M5 — Connect them.** Apply §4.4. Tune against replayed recordings driving the
real audio engine, then on the road.

**M6 — Harden.** Wake lock, visibility, interruption recovery, thermals, PWA
manifest, real-drive testing.
