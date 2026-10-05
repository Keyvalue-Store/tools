#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Command line for the Keyspace Map. Run "node keyspace/cli.js --help".

'use strict';
const fs = require('fs');
const K = require('./keyspace.js');

const HELP = `Keyspace Map: what a list of keys holds, as a tree of prefixes and naming patterns.

Usage:
  redis-cli --scan > keys.txt
  node keyspace/cli.js keys.txt          ("-" reads standard input)

Options:
  --sep X        Separator between key parts (default: guessed). "none" for no separator
  --no-fold      Keep IDs, hashes and dates as written instead of folding them into <id>, <hex>, <date>
  --no-busy      Keep levels of one-off names instead of folding them into <*>
  --raw          Take each line exactly as written (no "quote" decoding, no "1) " stripping)
  --top N        Patterns to list (default 30)
  --depth N      Tree levels to print (default 3)
  --json         Print JSON`;

function main(argv) {
  const opt = { separator: 'auto', fold: true, foldBusy: true };
  let file = null, top = 30, depth = 3, json = false, raw = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { console.log(HELP); return 0; }
    else if (a === '--sep') { const v = argv[++i]; opt.separator = v === 'none' ? '' : v; }
    else if (a === '--no-fold') opt.fold = false;
    else if (a === '--no-busy') opt.foldBusy = false;
    else if (a === '--raw') raw = true;
    else if (a === '--top') top = parseInt(argv[++i], 10) || 30;
    else if (a === '--depth') depth = parseInt(argv[++i], 10) || 3;
    else if (a === '--json') json = true;
    else if (a.startsWith('--')) { console.error('Unknown option ' + a + '. Try --help.'); return 2; }
    else file = a;
  }
  if (!file) { console.log(HELP); return 2; }
  const bytes = fs.readFileSync(file === '-' ? 0 : file);
  const keys = K.parseKeyBuffer(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length), raw);
  const r = K.analyze(keys, opt);
  if (json) {
    console.log(JSON.stringify({ keys: r.total, keyBytes: r.totalBytes, separator: r.separator, patterns: r.patterns.slice(0, top),
      tree: K.tree(r.root, 100), findings: r.findings }, null, 2));
    return 0;
  }
  const pct = (n) => (100 * n / (r.total || 1)).toFixed(1) + '%';
  console.log(`${r.total} keys, ${r.totalBytes} bytes of key names, separator ${r.separator ? '"' + r.separator + '"' : 'none'}.`);
  console.log('');
  console.log('Patterns');
  for (const p of r.patterns.slice(0, top)) {
    console.log(`${String(p.count).padStart(9)}  ${pct(p.count).padStart(6)}  ${p.pattern}   e.g. ${p.examples[0]}`);
  }
  if (r.patterns.length > top) console.log(`  ... ${r.patterns.length - top} more patterns`);
  console.log('');
  console.log('Tree');
  const t = K.tree(r.root, 20);
  (function walk(node, level) {
    if (level > depth) return;
    for (const c of node.children) {
      console.log(`${'  '.repeat(level - 1)}${c.name}${r.separator && c.children.length ? r.separator : ''}  ${c.count} (${pct(c.count)})`);
      walk(c, level + 1);
    }
    if (node.more) console.log(`${'  '.repeat(level - 1)}... ${node.more.nodes} more, ${node.more.count} keys`);
  })(t, 1);
  if (r.findings.length) {
    console.log('');
    console.log('Worth a look');
    for (const f of r.findings) console.log(`  ${f.label}: ${f.count}. For example: ${f.examples.join(', ')}`);
  }
  return 0;
}

try { process.exitCode = main(process.argv.slice(2)); }
catch (e) { console.error(e.message); process.exitCode = 1; }
