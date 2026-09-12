import { clamp } from './util.js';

  const MAX_DT = 0.2, DEADBAND = 0.4;
  // The iOS accelerometer axis signs were never confirmed, so forward and
  // lateral each have a runtime flip. loadConfig() reads the persisted choice;
  // it is called from the UI rather than at import time, so this module can be
  // imported where there is no localStorage.
  const CFG = { signFwd: 1, signLat: 1 };

  function loadConfig() {
    CFG.signFwd = +localStorage.getItem('db.signFwd') || 1;
    CFG.signLat = +localStorage.getItem('db.signLat') || 1;
  }

  // ---- DriveState: the only thing the audio engine reads ----
  const DS = {
    speed:null, aLong:0, aLat:0, jerk:0,
    intensity:0, aggression:0, cornering:0,
    accel:0, brake:0, stationary:true
  };

  const S = {
    started:false, t0:0, lastT:0, count:0, dropped:0, rate:0,
    f:{x:0,y:0,z:0},            // low-passed linear acceleration
    grav:{x:0,y:0,z:0}, gravInit:false,
    prevLong:0, stillSince:0,
    gps:{speed:null,status:'idle'}
  };

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
      S.rate = S.rate ? S.rate*0.9 + (1/dt)*0.1 : 1/dt;
    }
    S.lastT = now; S.count++;

    // Gravity, for the mount check only — acceleration is already gravity-free.
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

    const db = v => Math.abs(v) < DEADBAND ? 0 : v - Math.sign(v)*DEADBAND;
    const aLong = db(S.f.y) * CFG.signFwd;
    const aLat  = db(S.f.x) * CFG.signLat;

    DS.jerk += (Math.abs(aLong - S.prevLong)/dt - DS.jerk) * 0.1;
    S.prevLong = aLong;
    DS.aLong = aLong; DS.aLat = aLat;

    // Asymmetric: braking is much stronger than acceleration in every car.
    DS.accel = clamp(aLong/4, 0, 1);
    DS.brake = clamp(-aLong/7, 0, 1);
    DS.cornering += (clamp(Math.abs(aLat)/5,0,1) - DS.cornering)*0.08;

    const inst = clamp(Math.hypot(aLong, aLat)/5, 0, 1);
    DS.intensity += (inst - DS.intensity) * (1 - Math.exp(-dt/0.5));      // fast, ~0.5s
    DS.aggression += (clamp(inst + DS.jerk/25,0,1) - DS.aggression) * (1 - Math.exp(-dt/30)); // slow, ~30s

    const moving = S.gps.speed !== null ? S.gps.speed > 0.7 : inst > 0.05;
    if (moving) { S.stillSince = 0; DS.stationary = false; }
    else { if (!S.stillSince) S.stillSince = now;
           if (now - S.stillSince > 3000) DS.stationary = true; }
    DS.speed = S.gps.speed;
  }
export { CFG, DS, MAX_DT, S, loadConfig, onMotion };
