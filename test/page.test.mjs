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
const ORDER = ['util', 'motion', 'midi', 'midi-store', 'sf2', 'playback', 'engine', 'ui'];

test('the modules load without throwing, with their listeners attached', () => {
  const script = ORDER.map(n => fs.readFileSync(path.join(ROOT, 'js', n + '.js'), 'utf8')
    .split('\n')
    .filter(l => !/^import[\s{]/.test(l) && !/^export\s*{/.test(l))
    .join('\n')).join('\n');

  const listeners = [];
  const el = () => new Proxy({
    style: {}, classList: { add() {}, remove() {}, toggle() {} },
    addEventListener: (ev) => listeners.push(ev),
    querySelectorAll: () => [],
    hidden: false, textContent: '', innerHTML: '', value: '', dataset: {},
    click() {},
  }, {
    get: (t, k) => (k in t ? t[k] : ''),
    set: (t, k, v) => (t[k] = v, true),
  });

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
    },
    localStorage: { getItem: () => null, setItem() {} },
    navigator: {},
    indexedDB: undefined,           // the code must tolerate a store it cannot open
    performance: { now: () => 0 },
    setInterval: () => 0,
    setTimeout: () => 0,
    location: { protocol: 'https:', hostname: 'localhost' },
  };
  sandbox.window = sandbox;

  const args = Object.keys(sandbox);
  const run = new Function(...args, script);
  assert.doesNotThrow(() => run(...args.map(k => sandbox[k])));

  // The Start button and the two file pickers must be wired, or the page is a
  // dead end on the phone.
  assert.ok(listeners.filter(e => e === 'click').length >= 5, 'click handlers attached');
  assert.ok(listeners.includes('change'), 'file inputs wired');
});
