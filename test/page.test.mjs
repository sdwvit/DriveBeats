// The shipped page: does index.html actually agree with js/?
//
// index.html loads js/ui.js as a module and the browser pulls the rest in
// through its imports, so there is no build step to keep honest. The app has no
// browser test and audio can only be judged by ear in the car, so these checks
// stand in for "the page still loads": the entry module is actually referenced,
// every element the code reaches for exists, and the modules run to completion
// with their listeners attached.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));

test('every id the code looks up exists in the markup', () => {
  const missing = [];
  for (const f of fs.readdirSync(path.join(ROOT, 'js'))) {
    const src = fs.readFileSync(path.join(ROOT, 'js', f), 'utf8');
    for (const m of src.matchAll(/\$\('([^']+)'\)/g)) {
      if (!ids.has(m[1])) missing.push(`js/${f}: $('${m[1]}')`);
    }
  }
  assert.deepEqual(missing, [], 'these lookups would return null at runtime');
});

test('index.html loads the entry module', () => {
  assert.match(html, /<script type="module" src="js\/ui\.js"><\/script>/);
});

// Node cannot import the modules with a fake DOM in scope, so they are
// concatenated in dependency order - the order the browser resolves them in -
// with their import/export lines dropped, and run in one sandbox.
const ORDER = ['util', 'motion', 'recorder', 'midi', 'midi-store', 'sf2', 'playback', 'engine', 'ui'];

test('the modules load without throwing, with their listeners attached', () => {
  const script = ORDER.map(n => fs.readFileSync(path.join(ROOT, 'js', n + '.js'), 'utf8')
    .split('\n')
    .filter(l => !/^import[\s{]/.test(l) && !/^export\s*{/.test(l))
    .join('\n')).join('\n');

  return loadPage(script);
});

/** Run the concatenated modules in one sandbox and hand back what they wired. */
function loadPage(script, over = {}) {
  const listeners = [];
  const el = () => {
    const handlers = {};
    return new Proxy({
      style: {}, classList: { add() {}, remove() {}, toggle() {} },
      addEventListener: (ev, fn) => { listeners.push(ev); (handlers[ev] ||= []).push(fn); },
      // So a test can press the button rather than only count that it exists.
      fire: (ev, arg) => (handlers[ev] || []).map(fn => fn(arg)),
      querySelectorAll: () => [],
      hidden: false, textContent: '', innerHTML: '', value: '', dataset: {},
      click() {},
    }, {
      get: (t, k) => (k in t ? t[k] : ''),
      set: (t, k, v) => (t[k] = v, true),
    });
  };

  const nodes = new Map();
  const sandbox = {
    document: {
      getElementById: id => {
        if (!ids.has(id)) throw new Error(`getElementById('${id}') - no such element`);
        if (!nodes.has(id)) nodes.set(id, el());
        return nodes.get(id);
      },
      addEventListener: ev => listeners.push(ev),
      visibilityState: 'visible',
      // The log download builds an anchor and clicks it.
      createElement: () => el(),
      body: { appendChild() {}, removeChild() {} },
    },
    localStorage: { getItem: () => null, setItem() {} },
    navigator: {},
    indexedDB: undefined,           // the code must tolerate a store it cannot open
    performance: { now: () => 0 },
    setInterval: () => 0,
    setTimeout: () => 0,
    location: { protocol: 'https:', hostname: 'localhost' },
    Blob: function () {}, File: function () {},
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    ...over,
  };
  sandbox.window = sandbox;

  const args = Object.keys(sandbox);
  const run = new Function(...args, script);
  assert.doesNotThrow(() => run(...args.map(k => sandbox[k])));

  // The Start button and the two file pickers must be wired, or the page is a
  // dead end on the phone.
  assert.ok(listeners.filter(e => e === 'click').length >= 5, 'click handlers attached');
  assert.ok(listeners.includes('change'), 'file inputs wired');
  return { nodes, listeners, sandbox };
}

const PAGE = () => ORDER.map(n => fs.readFileSync(path.join(ROOT, 'js', n + '.js'), 'utf8')
  .split('\n')
  .filter(l => !/^import[\s{]/.test(l) && !/^export\s*{/.test(l))
  .join('\n')).join('\n');

// ---------------------------------------------------------------
// the motion permission prompt
// ---------------------------------------------------------------

/**
 * iOS treats a call as "in a user gesture" only while the click handler is
 * still running synchronously. After its first await the gesture is spent and
 * requestPermission() rejects with "requires a user gesture" instead of showing
 * the dialog - which is what "it keeps saying it needs a gesture but never
 * asks" looks like from the driver's seat. So: was it asked for before the
 * handler yielded?
 */
function startWithFakeIOS(over = {}) {
  const calls = [];
  const audio = {
    state: 'suspended',
    resume: () => { calls.push('resume'); return Promise.resolve(); },
    suspend: () => Promise.resolve(),
    currentTime: 0, sampleRate: 48000,
    destination: {},
    createGain: () => node(['gain']), createOscillator: () => node(['frequency', 'detune']),
    createBiquadFilter: () => node(['frequency', 'Q', 'gain']),
    createStereoPanner: () => node(['pan']),
    createDynamicsCompressor: () => node(['threshold', 'knee', 'ratio', 'attack', 'release']),
    createBufferSource: () => node(['playbackRate']),
    createBuffer: (c, n) => ({ getChannelData: () => new Float32Array(n) }),
  };
  function node(params) {
    const o = { connect: () => {}, disconnect: () => {}, start: () => {}, stop: () => {}, type: '' };
    for (const p of params) o[p] = { value: 0, setValueAtTime: () => {}, linearRampToValueAtTime: () => {},
      exponentialRampToValueAtTime: () => {}, setTargetAtTime: () => {}, cancelScheduledValues: () => {} };
    return o;
  }

  const { nodes } = loadPage(PAGE(), {
    AudioContext: function () { return audio; },
    DeviceMotionEvent: {
      requestPermission: () => {
        calls.push('requestPermission');
        return over.deny ? Promise.resolve('denied')
          : over.noGesture ? Promise.reject(Object.assign(new Error('requires a user gesture'), { name: 'NotAllowedError' }))
          : Promise.resolve('granted');
      },
    },
  });

  const pending = nodes.get('startBtn').fire('click')[0];
  // Read the moment the handler yields, before any promise is allowed to settle.
  const beforeAwait = calls.slice();
  return { calls, beforeAwait, pending, nodes };
}

test('motion permission is requested before the click handler yields', () => {
  const { beforeAwait } = startWithFakeIOS();
  assert.ok(beforeAwait.includes('requestPermission'),
    'asked for after the first await - iOS will refuse it without prompting');
});

test('unlocking audio does not cost us the permission prompt', () => {
  // Both want the same tap. Starting the resume and the permission request
  // together, and awaiting afterwards, is what lets them share it.
  const { beforeAwait } = startWithFakeIOS();
  assert.ok(beforeAwait.includes('resume'), 'audio is unlocked in the gesture too');
  assert.equal(beforeAwait.length, 2, 'and nothing else is waited on in between');
});

test('a refused prompt tells the driver what to do about it', async () => {
  const { pending, nodes } = startWithFakeIOS({ noGesture: true });
  await pending;
  const err = nodes.get('startErr');
  assert.equal(err.hidden, false, 'the failure is shown');
  assert.match(err.textContent, /reload/i, 'and says how to recover');
  assert.match(err.textContent, /Motion & Orientation/i, 'including the iOS setting');
});

test('a denied prompt is reported as a denial, not as a broken page', async () => {
  const { pending, nodes } = startWithFakeIOS({ deny: true });
  await pending;
  assert.match(nodes.get('startErr').textContent, /denied/i);
});
