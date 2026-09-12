#!/usr/bin/env node
// Concatenate js/*.js back into index.html.
//
// The app must work in a car with no signal, so what ships is one self-contained
// file: ten separate module requests would make the app depend on the browser
// having cached all ten rather than one. Source lives in js/ so it can be
// imported by node for tests; index.html is generated and committed.
//
//     node build.mjs           rebuild index.html from js/
//     node build.mjs --check   fail if index.html is stale (used by npm test)
//
// Modules are concatenated in the order below, which is also their dependency
// order. `import`/`export` lines are stripped: inside the single IIFE every
// module already shares one scope, so the bindings resolve as they did before
// the split. Nothing else is rewritten - the file on disk is the file that ships.

import fs from 'fs';
import path from 'path';

const ROOT = import.meta.dirname;
const ORDER = ['util', 'motion', 'midi', 'midi-store', 'sf2', 'playback', 'engine', 'ui'];
const START = '<!-- build:start -->';
const END = '<!-- build:end -->';

function strip(src, file) {
  const out = [];
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^import[\s{]/.test(l)) {
      if (!/;\s*$/.test(l)) throw new Error(`${file}: multi-line import not supported`);
      continue;
    }
    if (/^export\s*{/.test(l)) {
      if (!/;\s*$/.test(l)) throw new Error(`${file}: multi-line export not supported`);
      continue;
    }
    if (/^\s*export\s+(const|let|var|function|class|default)\b/.test(l))
      throw new Error(`${file}:${i + 1}: inline 'export' keyword - use a trailing export { ... } block`);
    out.push(l);
  }
  // Leading blanks are the gap left by the removed import block. Trailing
  // blanks are the module's own separator line and must survive, so that a
  // rebuild reproduces the original spacing exactly.
  return out.join('\n').replace(/^\n+/, '').replace(/\n$/, '');
}

const bodies = ORDER.map(n => {
  const f = path.join(ROOT, 'js', n + '.js');
  return strip(fs.readFileSync(f, 'utf8'), 'js/' + n + '.js');
});

// One shared scope means one namespace: a name declared twice would have been a
// syntax error before the split too, so catch it here rather than in the browser.
const seen = new Map();
bodies.forEach((b, i) => {
  for (const m of b.matchAll(/^  (?:async function|function|const|let|var) ([A-Za-z_$][\w$]*)/gm)) {
    if (seen.has(m[1]))
      throw new Error(`duplicate top-level '${m[1]}' in js/${ORDER[i]}.js and js/${seen.get(m[1])}.js`);
    seen.set(m[1], ORDER[i]);
  }
});

// Module bodies already carry the two-space indent they had inside the IIFE.
const script = [
  '<script>',
  '(() => {',
  "  'use strict';",
  ...bodies,
  '})();',
  '</script>',
].join('\n');

const htmlPath = path.join(ROOT, 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const a = html.indexOf(START), b = html.indexOf(END);
if (a < 0 || b < 0) throw new Error('index.html is missing the build:start / build:end markers');

const next = html.slice(0, a + START.length) + '\n' + script + '\n' + html.slice(b);

if (process.argv.includes('--check')) {
  if (next !== html) {
    console.error('index.html is stale - run `node build.mjs` and commit the result.');
    process.exit(1);
  }
  console.log('index.html is up to date with js/');
} else if (next === html) {
  console.log('index.html already up to date');
} else {
  fs.writeFileSync(htmlPath, next);
  console.log(`index.html rebuilt from ${ORDER.length} modules (${script.length} bytes of script)`);
}
