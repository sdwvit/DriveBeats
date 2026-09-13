  // ============================================================
  //  DRIVE RECORDER — raw sensor in, one file out
  //
  //  Every formula in motion.js is a guess at what a car feels like, and the
  //  only way to check a guess is against a drive that actually happened. So
  //  this records the INPUTS - the accelerometer and the GPS fixes, exactly as
  //  they arrived - rather than what we made of them. A log replayed through a
  //  changed formula then answers the question the formula was changed for.
  //
  //  Derived values are deliberately not recorded: they are re-derivable, and a
  //  log full of them would be a record of the bug rather than of the drive.
  // ============================================================

  const REC = {
    on: false,
    t0: 0,
    rows: [],
    bytes: 0,
    full: false,
    marks: 0,
    tLast: 0,
    // Location is off by default. Speed and heading are all the calibration
    // needs; latitude and longitude are a map of where somebody drove, and
    // that is not mine to collect without being asked.
    withPosition: false,
    meta: {}
  };

  // 45 minutes at 50Hz. Past this the tab is holding tens of megabytes of
  // strings and the phone starts to feel it, so recording stops and says so
  // rather than dying halfway through a trip.
  const MAX_ROWS = 150000;

  const r3 = v => (typeof v === 'number' && isFinite(v)) ? Math.round(v * 1000) / 1000 : '';
  const r6 = v => (typeof v === 'number' && isFinite(v)) ? Math.round(v * 1e6) / 1e6 : '';
  const r2 = v => (typeof v === 'number' && isFinite(v)) ? Math.round(v * 100) / 100 : '';

  function startRec(meta = {}) {
    REC.on = true; REC.t0 = 0; REC.rows = []; REC.bytes = 0;
    REC.full = false; REC.marks = 0; REC.tLast = 0;
    REC.meta = { started: new Date().toISOString(), ...meta };
  }

  function stopRec() { REC.on = false; }

  function push(row) {
    if (REC.rows.length >= MAX_ROWS) { REC.full = true; REC.on = false; return; }
    REC.rows.push(row);
    REC.bytes += row.length + 1;
  }

  /** Milliseconds since the first sample, so a log is self-contained. */
  function stamp(t) {
    if (!REC.t0) REC.t0 = t;
    const ms = Math.round(t - REC.t0);
    // The furthest point reached, not the last row written: a marker carries
    // the time it was pressed, which need not be the newest thing in the file.
    if (ms > REC.tLast) REC.tLast = ms;
    return ms;
  }

  /**
   * One devicemotion event, as it arrived.
   *
   * `a` is acceleration and `ag` accelerationIncludingGravity: both, because
   * the difference between them is gravity, which is what tells us which way
   * up the phone is, and a log without it cannot reconstruct the car's axes.
   */
  function recMotion(e, t) {
    if (!REC.on) return;
    const a = e.acceleration, ag = e.accelerationIncludingGravity;
    if (!a || a.x === null) return;
    push('m,' + stamp(t) + ',' +
      r3(a.x) + ',' + r3(a.y) + ',' + r3(a.z) + ',' +
      (ag && ag.x !== null ? r3(ag.x) + ',' + r3(ag.y) + ',' + r3(ag.z) : ',,'));
  }

  /** One GPS fix. Position only if the driver opted in. */
  function recFix(c, t) {
    if (!REC.on) return;
    push('g,' + stamp(t) + ',' + r2(c.speed) + ',' + r2(c.heading) + ',' + r2(c.accuracy) + ',' +
      (REC.withPosition ? r6(c.latitude) + ',' + r6(c.longitude) : ','));
  }

  /**
   * A driver-pressed marker: "this is the roundabout", "this is the hill".
   * Ten seconds of log either side of one of these is worth more than the
   * whole rest of the file, because it is the only part where what the car was
   * doing is known rather than inferred.
   */
  function recMark(label, t) {
    if (!REC.on) return;
    REC.marks++;
    push('k,' + stamp(t) + ',' + String(label).replace(/[\r\n,]/g, ' ').slice(0, 60));
  }

  /** The whole log as one file. */
  function recText() {
    const m = REC.meta;
    const head = [
      '# drivebeats drive log v1',
      '# ' + Object.keys(m).map(k => k + '=' + String(m[k]).replace(/[\r\n]/g, ' ')).join(' '),
      '# m,t_ms,ax,ay,az,agx,agy,agz   devicemotion: acceleration, then including gravity',
      '# g,t_ms,speed,heading,accuracy,lat,lon   one GPS fix (lat/lon blank unless opted in)',
      '# k,t_ms,label   driver marker',
      '# accelerations are m/s^2, speed m/s, heading degrees, accuracy metres',
      REC.full ? '# TRUNCATED: hit the ' + MAX_ROWS + '-row limit' : '# complete'
    ].join('\n');
    return head + '\n' + REC.rows.join('\n') + '\n';
  }

  /** Duration in seconds, from the stamps rather than the clock. */
  function recSeconds() {
    return REC.rows.length ? REC.tLast / 1000 : 0;
  }

  function recSummary() {
    const motion = REC.rows.reduce((n, r) => n + (r.charCodeAt(0) === 109 ? 1 : 0), 0);
    const fixes = REC.rows.reduce((n, r) => n + (r.charCodeAt(0) === 103 ? 1 : 0), 0);
    return { rows: REC.rows.length, motion, fixes, marks: REC.marks,
             seconds: recSeconds(), bytes: REC.bytes, full: REC.full };
  }

export { MAX_ROWS, REC, recFix, recMark, recMotion, recSeconds, recSummary, recText, startRec, stopRec };
