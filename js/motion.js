import { clamp } from './util.js';

  const MAX_DT = 0.2, DEADBAND = 0.4;
  // Manual overrides. They used to be the only way to get the axes right; the
  // car frame below works them out on its own now, so these are a last resort
  // for a mount the maths cannot make sense of.
  const CFG = { signFwd: 1, signLat: 1 };

  function loadConfig() {
    CFG.signFwd = +localStorage.getItem('db.signFwd') || 1;
    CFG.signLat = +localStorage.getItem('db.signLat') || 1;
  }

  // A fix older than this tells us nothing about how fast we are going now.
  const GPS_STALE = 4;
  // Dead reckoning is integrated acceleration, and integrated acceleration
  // drifts. Bleeding it away over this long keeps a drift from pinning the mix
  // at full speed for the rest of the drive; a real drive gets a fix long
  // before it matters.
  const DR_DECAY = 90;
  // Sensor bias is what makes dead reckoning useless: a constant 0.05 m/s^2 of
  // offset integrates into a car doing walking pace while parked on the drive.
  // Tracking the long-run mean of forward acceleration and integrating what is
  // left removes it, and a real pull away is over in seconds - far too quick
  // for a minute-long average to follow.
  const BIAS_TC = 60;
  // Intensity is the fast channel - it is what opens the master filter, so it
  // is the first thing a driver hears. Rising and falling at the same rate
  // meant a shared compromise: quick enough to answer the throttle made it
  // chatter on every pothole. Asymmetric, a push in the back lands almost at
  // once and the decay still settles smoothly.
  const INT_UP = 0.12, INT_DOWN = 0.6;
  // Sustained effort, in seconds. This was 30, which is most of a town trip:
  // the arrangement was still deciding what it thought about the first corner
  // when the drive ended.
  const AGGR_TC = 8;
  // Learning the forward direction: how hard the car has to be accelerating
  // for a horizontal reading to be evidence of which way forward is.
  const LEARN_DV = 0.6;          // m/s^2 of GPS-measured acceleration
  const LEARN_RATE = 0.06;

  // ---- DriveState: the only thing the audio engine reads ----
  const DS = {
    speed:null, aLong:0, aLat:0, jerk:0,
    intensity:0, aggression:0, cornering:0,
    accel:0, brake:0, stationary:true,
    // Where DS.speed came from: 'gps' when a fix is current, 'dead' when it is
    // integrated forward acceleration, 'none' when we do not know at all.
    speedSrc:'none',
    // How the car's axes were arrived at: 'device' is the old fixed assumption
    // (no gravity reading to work from), 'assumed' is the mount orientation
    // with a guessed forward, 'learned' is forward confirmed against GPS.
    calib:'device'
  };

  const S = {
    started:false, t0:0, lastT:0, count:0, dropped:0, rate:0,
    f:{x:0,y:0,z:0},            // low-passed linear acceleration
    grav:{x:0,y:0,z:0}, gravInit:false,
    prevLong:0, stillSince:0, longBias:0,
    // The car's forward direction in device coordinates, and how much of it
    // has been confirmed against GPS rather than guessed from the mount.
    fwd:null, fwdConf:0,
    estSpeed:0,                 // dead-reckoned, m/s
    gps:{speed:null, heading:null, status:'idle', t:0, prevSpeed:null, prevT:0}
  };

  // The initial state, in one place. Tests used to rebuild this shape by hand,
  // which quietly rots the moment a field is added: a stale reset left the
  // accelerometer bias from one case seeding the next, and the drift landed as
  // phantom speed in a test about something else entirely.
  const initialDS = { ...DS };
  const initialS = JSON.parse(JSON.stringify(S));

  /** Back to a phone that has just been picked up. */
  function resetMotion() {
    Object.assign(DS, initialDS);
    Object.assign(S, JSON.parse(JSON.stringify(initialS)));
    CFG.signFwd = 1; CFG.signLat = 1;
  }

  // ---- small vector helpers (device coordinates throughout) ----
  const dot = (a, b) => a.x*b.x + a.y*b.y + a.z*b.z;
  const len = a => Math.hypot(a.x, a.y, a.z);
  const scale = (a, k) => ({ x:a.x*k, y:a.y*k, z:a.z*k });
  const sub = (a, b) => ({ x:a.x-b.x, y:a.y-b.y, z:a.z-b.z });
  const add = (a, b) => ({ x:a.x+b.x, y:a.y+b.y, z:a.z+b.z });
  const cross = (a, b) => ({
    x: a.y*b.z - a.z*b.y,
    y: a.z*b.x - a.x*b.z,
    z: a.x*b.y - a.y*b.x
  });
  function unit(a) {
    const l = len(a);
    return l > 1e-6 ? scale(a, 1/l) : null;
  }
  /** `a` with everything along `u` removed - i.e. flattened into the road. */
  const flatten = (a, u) => sub(a, scale(u, dot(a, u)));

  // ---------- the car's axes ----------
  //
  // This is the thing that made a drive sound worse than a walk. Forward was
  // hard-coded to the device's +y and lateral to its +x, which is only true for
  // a phone held upright in portrait, pointing straight ahead. In any real
  // mount - landscape, tilted back against the windscreen, face-up in a cup
  // holder - accelerating drove the wrong axis, or split between two and read
  // as a corner, or cancelled out. A phone in a pocket has no such problem,
  // because walking shakes every axis at once, so something always registered:
  // hence a walk producing better music than a drive.
  //
  // Gravity gives us "up" for free, whatever the mount. Flattening out the
  // vertical leaves acceleration in the plane of the road, and the only thing
  // left to find is which way in that plane is forward.

  /** Best guess at forward before GPS has confirmed anything. */
  function guessForward(up) {
    // In the order a phone is usually mounted: face-up on a dash (up is +z, so
    // the top of the phone points down the road), upright in a cradle (up is
    // +y, so the road is behind the screen), and landscape as a last resort.
    const cand = [{x:0,y:1,z:0}, {x:0,y:0,z:-1}, {x:1,y:0,z:0}];
    for (const c of cand) {
      const h = unit(flatten(c, up));
      if (h && len(flatten(c, up)) > 0.5) return h;
    }
    return null;
  }

  /**
   * The car's frame, or null when there is no gravity reading to build it from
   * (a browser that only reports linear acceleration, and every existing test).
   * Callers fall back to the old fixed device axes in that case.
   */
  function carAxes() {
    if (!S.gravInit) return null;
    const up = unit(S.grav);
    if (!up) return null;
    if (!S.fwd) { S.fwd = guessForward(up); S.fwdConf = 0; }
    if (!S.fwd) return null;
    // Keep forward in the road plane: the mount shifts, and a forward vector
    // with a vertical component turns bumps into phantom acceleration.
    const fwd = unit(flatten(S.fwd, up));
    if (!fwd) return null;
    S.fwd = fwd;
    // Right-handed: up x forward points to the driver's left in device coords.
    const left = unit(cross(up, fwd));
    if (!left) return null;
    return { up, fwd, left };
  }

  /**
   * Learn which way forward actually is.
   *
   * When GPS says the car sped up or slowed down, the horizontal acceleration
   * measured at that moment IS the forward axis - pointing forwards if the car
   * gained speed, backwards if it lost it. Nudging towards that a little at a
   * time converges within a couple of pulls away from a junction, and settles
   * the sign question the flip buttons used to ask the driver.
   */
  function learnForward(h, dv, up) {
    if (Math.abs(dv) < LEARN_DV) return;
    const dir = unit(h);
    if (!dir) return;
    const want = dv > 0 ? dir : scale(dir, -1);
    const next = unit(flatten(add(S.fwd, scale(want, LEARN_RATE)), up));
    if (!next) return;
    S.fwd = next;
    S.fwdConf = Math.min(1, S.fwdConf + 0.08);
  }

  // ---------- motion ----------
  // `now` is injectable so a test can feed an exact event rate; the browser
  // always calls this as a plain devicemotion listener and takes the default.
  function onMotion(e, now) {
    if (now === undefined) now = performance.now();
    const a = e.acceleration, ag = e.accelerationIncludingGravity;
    if (!a || a.x === null) return;

    let dt = 1/60;
    if (S.lastT) {
      dt = (now - S.lastT)/1000;
      if (dt > MAX_DT) { S.dropped++; S.lastT = now; return; }
      // Android batches sensor events, so two can carry the same timestamp.
      // dt = 0 makes the jerk term 0/0, and NaN survives both the smoothing
      // and clamp() - aggression would stay NaN for the rest of the drive.
      if (!(dt > 0)) return;
      S.rate = S.rate ? S.rate*0.9 + (1/dt)*0.1 : 1/dt;
    }
    S.lastT = now; S.count++;

    // Gravity: the mount check, and now the road plane as well.
    if (ag && ag.x !== null) {
      const gx = ag.x-a.x, gy = ag.y-a.y, gz = ag.z-a.z;
      if (!S.gravInit) { S.grav={x:gx,y:gy,z:gz}; S.gravInit=true; }
      else { const k=0.02;
        S.grav.x+=(gx-S.grav.x)*k; S.grav.y+=(gy-S.grav.y)*k; S.grav.z+=(gz-S.grav.z)*k; }
    }

    // One-pole low-pass at ~2.5Hz: body dynamics below, road noise above.
    const fc = 2.5, alpha = dt/((1/(2*Math.PI*fc)) + dt);
    S.f.x += (a.x - S.f.x)*alpha;
    S.f.y += (a.y - S.f.y)*alpha;
    S.f.z += (a.z - S.f.z)*alpha;

    // How much the car's own speed changed since the last fix, which is the
    // only unambiguous statement about forward we ever get.
    const dv = gpsAccel();

    let rawLong, rawLat;
    const ax = carAxes();
    if (ax) {
      const h = flatten(S.f, ax.up);
      learnForward(h, dv, ax.up);
      // Re-read the axes: learnForward may have just moved them.
      const now2 = carAxes() || ax;
      rawLong = dot(h, now2.fwd);
      rawLat  = dot(h, now2.left);
      DS.calib = S.fwdConf > 0.3 ? 'learned' : 'assumed';
    } else {
      // No gravity to work from: the old fixed assumption, which is right for a
      // phone held upright and pointing forwards and wrong for everything else.
      rawLong = S.f.y;
      rawLat  = S.f.x;
      DS.calib = 'device';
    }

    const db = v => Math.abs(v) < DEADBAND ? 0 : v - Math.sign(v)*DEADBAND;
    const aLong = db(rawLong) * CFG.signFwd;
    const aLat  = db(rawLat)  * CFG.signLat;

    DS.jerk += (Math.abs(aLong - S.prevLong)/dt - DS.jerk) * 0.1;
    S.prevLong = aLong;
    DS.aLong = aLong; DS.aLat = aLat;

    // Asymmetric: braking is much stronger than acceleration in every car.
    DS.accel = clamp(aLong/4, 0, 1);
    DS.brake = clamp(-aLong/7, 0, 1);
    DS.cornering += (clamp(Math.abs(aLat)/5,0,1) - DS.cornering)*0.08;

    // Dead reckoning integrates the raw reading, not the deadbanded one: the
    // deadband exists to stop small noise driving the music, but subtracting
    // 0.4 m/s^2 from every sample of a six-second pull away loses 2.4 m/s of
    // real speed, which is the difference between two rungs of the ladder.
    updateSpeed(dt, rawLong * CFG.signFwd, now);

    const inst = clamp(Math.hypot(aLong, aLat)/5, 0, 1);
    DS.intensity += (inst - DS.intensity) *
                    (1 - Math.exp(-dt / (inst > DS.intensity ? INT_UP : INT_DOWN)));
    // Sustained speed is effort too. Without this term a motorway cruise - no
    // acceleration at all, by definition - decays to the same aggression as a
    // car parked at the kerb.
    const effort = clamp(Math.max(inst, speedEffort()), 0, 1);
    DS.aggression += (clamp(effort + DS.jerk/25,0,1) - DS.aggression) * (1 - Math.exp(-dt/AGGR_TC));

    const moving = DS.speed !== null ? DS.speed > 0.7 : inst > 0.05;
    if (moving) { S.stillSince = 0; DS.stationary = false; }
    else { if (!S.stillSince) S.stillSince = now;
           if (now - S.stillSince > 3000) DS.stationary = true; }
  }

  /** Is the last fix recent enough to mean anything? */
  function gpsFresh(now) {
    if (S.gps.speed === null || !isFinite(S.gps.speed)) return false;
    // A fix with no timestamp is taken at face value: that is a caller feeding
    // speed straight in, which is what the tests and a manual override do.
    if (!S.gps.t) return true;
    return (now - S.gps.t) / 1000 < GPS_STALE;
  }

  /**
   * Acceleration according to GPS, m/s^2, across the last two fixes. Zero
   * unless a new fix has actually arrived - the same fix read twice says
   * nothing, and dividing by its zero interval says NaN.
   */
  function gpsAccel() {
    const g = S.gps;
    if (g.speed === null || g.prevSpeed === null || !g.t || !g.prevT) return 0;
    const dtg = (g.t - g.prevT) / 1000;
    if (!(dtg > 0.05) || dtg > 6) return 0;
    const dv = (g.speed - g.prevSpeed) / dtg;
    return isFinite(dv) ? dv : 0;
  }

  /**
   * DS.speed, from GPS where we have it and from integrated forward
   * acceleration where we do not.
   *
   * This is the other half of why driving fell flat. The speed ladder is what
   * brings layers in, and its input was GPS speed alone - which plenty of
   * Android devices simply report as null - falling back to aggression, a
   * 30-second average. So the arrangement took half a minute to notice a
   * motorway. Dead reckoning is not accurate, but it is immediate, and it is
   * corrected the moment a fix lands.
   */
  function updateSpeed(dt, rawLong, now) {
    S.longBias += (rawLong - S.longBias) * (1 - Math.exp(-dt / BIAS_TC));
    // Integrate regardless: it keeps the estimate alive between fixes, which
    // arrive about once a second at best.
    S.estSpeed = Math.max(0, S.estSpeed + (rawLong - S.longBias) * dt);
    S.estSpeed *= Math.exp(-dt / DR_DECAY);

    if (gpsFresh(now)) {
      // Trust the fix, but slew to it rather than jumping: a fix that lands
      // 4 m/s off would otherwise step the tempo and the layer ladder at once.
      S.estSpeed += (S.gps.speed - S.estSpeed) * Math.min(1, dt * 4);
      DS.speed = S.gps.speed;
      DS.speedSrc = 'gps';
      return;
    }
    if (S.count > 30 && (S.estSpeed > 0.7 || DS.speedSrc === 'dead')) {
      DS.speed = S.estSpeed;
      DS.speedSrc = 'dead';
      return;
    }
    DS.speed = null;
    DS.speedSrc = 'none';
  }

  /** Speed as a 0..1 sense of effort: flat out by roughly 70 mph. */
  function speedEffort() {
    return DS.speed === null ? 0 : clamp(DS.speed / 31, 0, 1);
  }

  /**
   * A new GPS fix. Kept here rather than in the UI so that the previous fix,
   * which is what makes it possible to learn the forward axis, is recorded in
   * exactly one place.
   */
  function onFix({ speed = null, heading = null, t = Date.now() } = {}) {
    const g = S.gps;
    g.prevSpeed = g.speed; g.prevT = g.t;
    g.speed = (typeof speed === 'number' && isFinite(speed) && speed >= 0) ? speed : null;
    g.heading = (typeof heading === 'number' && isFinite(heading)) ? heading : null;
    g.t = t;
    g.status = 'ok';
  }

export { AGGR_TC, BIAS_TC, INT_DOWN, INT_UP, CFG, DS, DR_DECAY, GPS_STALE, MAX_DT, S, carAxes, gpsAccel, loadConfig, onFix, onMotion, resetMotion };
