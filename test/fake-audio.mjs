// A recording stand-in for AudioContext.
//
// Every node created and every parameter automation is appended to ctx.log with
// the time it was scheduled for, so a test can assert what the engine *would*
// play without any audio hardware. It deliberately does not model the graph's
// sound - only its structure and timing, which is what the scheduling code
// decides.

class FakeParam {
  constructor(ctx, node, name) {
    this.ctx = ctx; this.node = node; this.name = name;
    this._value = 0;
  }
  get value() { return this._value; }
  set value(v) { this._value = v; this._log('value', v, this.ctx.currentTime); }
  _log(op, v, t) {
    this.ctx.log.push({ node: this.node.type, id: this.node.id, param: this.name, op, value: v, time: t });
  }
  setValueAtTime(v, t) { this._value = v; this._log('setValueAtTime', v, t); return this; }
  linearRampToValueAtTime(v, t) { this._value = v; this._log('linearRamp', v, t); return this; }
  exponentialRampToValueAtTime(v, t) { this._value = v; this._log('exponentialRamp', v, t); return this; }
  setTargetAtTime(v, t) { this._value = v; this._log('setTargetAtTime', v, t); return this; }
  cancelScheduledValues(t) { this._log('cancel', null, t); return this; }
}

class FakeNode {
  constructor(ctx, type) {
    this.ctx = ctx; this.type = type; this.id = ctx._nextId++;
    this.outputs = [];
    ctx.log.push({ node: type, id: this.id, op: 'create', time: ctx.currentTime });
  }
  _param(name) { return this[name] || (this[name] = new FakeParam(this.ctx, this, name)); }
  connect(dest) { this.outputs.push(dest); return dest; }
  disconnect() { this.outputs.length = 0; }
  start(t = this.ctx.currentTime) {
    this.startTime = t;
    this.ctx.log.push({ node: this.type, id: this.id, op: 'start', time: t, buffer: this.buffer || null });
  }
  stop(t = this.ctx.currentTime) {
    this.stopTime = t;
    this.ctx.log.push({ node: this.type, id: this.id, op: 'stop', time: t });
  }
}

function makeNode(ctx, type, params, extra) {
  const n = new FakeNode(ctx, type);
  for (const p of params) n._param(p);
  return Object.assign(n, extra);
}

export class FakeAudioContext {
  constructor(sampleRate = 48000) {
    this.sampleRate = sampleRate;
    this.currentTime = 0;
    this.state = 'running';
    this.log = [];
    this._nextId = 1;
    this.destination = new FakeNode(this, 'destination');
  }
  advance(seconds) { this.currentTime += seconds; }
  resume() { this.state = 'running'; return Promise.resolve(); }

  createGain() { return makeNode(this, 'gain', ['gain']); }
  createOscillator() {
    return makeNode(this, 'oscillator', ['frequency', 'detune'], { type: 'sine' });
  }
  createBiquadFilter() {
    return makeNode(this, 'filter', ['frequency', 'Q', 'gain'], { type: 'lowpass' });
  }
  createStereoPanner() { return makeNode(this, 'panner', ['pan']); }
  createDynamicsCompressor() {
    return makeNode(this, 'compressor', ['threshold', 'knee', 'ratio', 'attack', 'release']);
  }
  createWaveShaper() { return makeNode(this, 'waveshaper', []); }
  createBufferSource() {
    return makeNode(this, 'bufferSource', ['playbackRate', 'detune'],
      { buffer: null, loop: false, loopStart: 0, loopEnd: 0 });
  }
  createBuffer(channels, length, rate) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return {
      numberOfChannels: channels, length, sampleRate: rate,
      duration: length / rate,
      getChannelData: i => data[i],
    };
  }

  // ---- assertions helpers ----

  /** Every 'start' event, in scheduled-time order. */
  starts() {
    return this.log.filter(e => e.op === 'start').sort((a, b) => a.time - b.time);
  }
  /** Peak value any gain node was ramped to - 0 means the layer is silent. */
  peakGain(nodeId) {
    return this.log
      .filter(e => e.id === nodeId && e.param === 'gain' && typeof e.value === 'number')
      .reduce((m, e) => Math.max(m, e.value), 0);
  }
  clear() { this.log.length = 0; }
}
