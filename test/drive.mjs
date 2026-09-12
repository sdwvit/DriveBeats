// A car, a phone, and a mount - simulated well enough to judge the music by.
//
// The unit tests in motion.test.mjs feed acceleration straight down the device
// axes, which is the one case the old code got right. This builds the case it
// got wrong: a drive described in the car's own frame (forward, left, up) and
// then rotated into whatever orientation the phone happens to be sitting in,
// with gravity along for the ride exactly as a real devicemotion event carries
// it. Everything here is in SI units at values a car actually produces.

const G = 9.81;

// ---- mounts -----------------------------------------------------
//
// Each is the car's axes expressed in device coordinates. A real phone is
// never quite square to the car, so each one is nudged off true as well.

export const MOUNTS = {
  // Face-up on the dash, top of the phone pointing down the road.
  dash:      { fwd: { x: 0, y: 1, z: 0 },  left: { x: -1, y: 0, z: 0 }, up: { x: 0, y: 0, z: 1 } },
  // Upright in a windscreen cradle, portrait: the road is behind the screen.
  cradle:    { fwd: { x: 0, y: 0, z: -1 }, left: { x: -1, y: 0, z: 0 }, up: { x: 0, y: 1, z: 0 } },
  // The same cradle turned landscape.
  landscape: { fwd: { x: 0, y: 0, z: -1 }, left: { x: 0, y: 1, z: 0 },  up: { x: 1, y: 0, z: 0 } },
  // Mounted the other way round - the case the flip buttons existed for.
  backwards: { fwd: { x: 0, y: -1, z: 0 }, left: { x: 1, y: 0, z: 0 },  up: { x: 0, y: 0, z: 1 } },
};

/** Deterministic noise in [-1, 1), zero-mean to well under a thousandth. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
}

const scale = (v, k) => ({ x: v.x * k, y: v.y * k, z: v.z * k });
const add = (...vs) => vs.reduce((a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }));

/** Car-frame acceleration -> the device-frame vector the sensor would report. */
function toDevice(m, { long = 0, lat = 0, vert = 0 }) {
  return add(scale(m.fwd, long), scale(m.left, lat), scale(m.up, vert));
}

// ---- the drive --------------------------------------------------

/**
 * A town trip, as a list of phases. `long`/`lat` are m/s^2 in the car's frame.
 *
 *   2.2 m/s^2  is an ordinary pull away from a junction (0-30 mph in 6s)
 *  -4.0 m/s^2  is firm but unremarkable braking
 *   3.0 m/s^2  lateral is a roundabout taken at a normal speed
 */
export const TOWN_DRIVE = [
  { name: 'stopped',  s: 5,  long: 0,    lat: 0 },
  { name: 'pull away', s: 6, long: 2.2,  lat: 0 },
  { name: 'cruise',   s: 10, long: 0,    lat: 0 },
  { name: 'corner',   s: 4,  long: -0.3, lat: 3.0 },
  { name: 'cruise2',  s: 5,  long: 0,    lat: 0 },
  { name: 'brake',    s: 4,  long: -4.0, lat: 0 },
  { name: 'stopped2', s: 5,  long: 0,    lat: 0 },
];

/** Walking with the phone in a pocket: fast, shaky, and going nowhere. */
export function walkingSample(t) {
  const step = Math.sin(t * 2 * Math.PI * 1.9);      // ~1.9 steps a second
  const sway = Math.sin(t * 2 * Math.PI * 0.95);
  return { long: 2.6 * step, lat: 1.8 * sway, vert: 3.4 * step };
}

/**
 * Run a drive through onMotion at a realistic event rate.
 *
 * opts.mount     one of MOUNTS (default dash)
 * opts.hz        devicemotion rate (default 50, what a phone actually gives)
 * opts.gps       'coords' to feed fixes once a second, false for none
 * opts.gravity   false to omit accelerationIncludingGravity, i.e. a browser
 *                that reports linear acceleration only
 * opts.road      road-noise amplitude in m/s^2 (default 0.25, a decent surface)
 * opts.sample    called with a snapshot each phase boundary and every 0.5s
 */
export function runDrive(motion, phases, opts = {}) {
  const {
    mount = MOUNTS.dash, hz = 50, gps = 'coords', gravity = true,
    road = 0.25, sample = null, gpsEvery = 1, sampleEvery = 0.5,
  } = opts;
  const { onMotion, onFix } = motion;

  const dt = 1 / hz;
  let t = 0, speed = 0, nextFix = 0, nextSample = 0;
  // Deterministic road noise: a test that fails one run in twenty is worse than
  // no test at all. mulberry32, because the textbook LCG written in JS silently
  // loses its low bits - seed * 1103515245 is past 2^53 - and comes out with a
  // mean well away from zero, which integrates into phantom speed and makes the
  // simulator, not the code, the thing under test.
  const noise = mulberry32(12345);
  const out = [];

  for (const ph of phases) {
    const end = t + ph.s;
    while (t < end) {
      // The car cannot brake past a standstill.
      const long = (speed <= 0 && ph.long < 0) ? 0 : ph.long;
      speed = Math.max(0, speed + long * dt);
      const lat = speed > 1 ? ph.lat : 0;      // no cornering force while parked

      const car = {
        long: long + noise() * road,
        lat: lat + noise() * road,
        // Bumps. `bump` lets a phase be rough vertically and smooth otherwise,
        // which is the case that has to be thrown away rather than integrated.
        vert: noise() * (ph.bump !== undefined ? ph.bump : road * 2),
      };
      const a = toDevice(mount, car);
      const e = {
        acceleration: a,
        accelerationIncludingGravity: gravity
          ? add(a, scale(mount.up, G))         // a phone at rest reports +1g "up"
          : null,
      };
      onMotion(e, t * 1000);

      if (gps && t >= nextFix) {
        onFix({ speed, t: t * 1000 });
        nextFix += gpsEvery;
      }
      if (sample && t >= nextSample) {
        out.push(sample({ t, phase: ph.name, trueSpeed: speed }));
        nextSample += sampleEvery;
      }
      t += dt;
    }
    if (sample) out.push(sample({ t, phase: ph.name + ':end', trueSpeed: speed }));
  }
  return { t, speed, samples: out };
}

/** Walking, fed through the same path. */
export function runWalk(motion, seconds, opts = {}) {
  const { mount = MOUNTS.cradle, hz = 50, gps = true, sample = null } = opts;
  const { onMotion, onFix } = motion;
  const dt = 1 / hz;
  const out = [];
  let nextFix = 0, nextSample = 0;
  for (let t = 0; t < seconds; t += dt) {
    const a = toDevice(mount, walkingSample(t));
    onMotion({
      acceleration: a,
      accelerationIncludingGravity: add(a, scale(mount.up, G)),
    }, t * 1000);
    if (gps && t >= nextFix) { onFix({ speed: 1.4, t: t * 1000 }); nextFix += 1; }
    if (sample && t >= nextSample) { out.push(sample({ t })); nextSample += 0.5; }
  }
  return out;
}
