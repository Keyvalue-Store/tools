#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Command line for the Consistent Hashing Playground. Run "node ring/cli.js --help".

'use strict';
const fs = require('fs');
const R = require('./ring.js');

const HELP = `Consistent Hashing Playground: what happens to the keys when a node joins or leaves.

Usage:
  node ring/cli.js --nodes 5 --add                 Add a sixth node to five
  node ring/cli.js --nodes 5 --remove 2            Take node-2 away from five
  node ring/cli.js --nodes 5 --add --file keys.txt Use your own keys, one per line

Options:
  --nodes N      Nodes before the change (default 5)
  --keys N       Number of made-up keys, key:0, key:1, ... (default 100000)
  --file FILE    Your own keys instead
  --vnodes N     Virtual nodes per node on the hash ring (default 160)
  --json         Print JSON

Jump hash numbers its buckets, so it can only take away the last one; --remove
applies to the others as asked.`;

function main(argv) {
  let n = 5, count = 100000, file = null, vnodes = 160, json = false;
  let change = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { console.log(HELP); return 0; }
    else if (a === '--nodes') n = parseInt(argv[++i], 10);
    else if (a === '--keys') count = parseInt(argv[++i], 10);
    else if (a === '--file') file = argv[++i];
    else if (a === '--vnodes') vnodes = parseInt(argv[++i], 10);
    else if (a === '--add') change = { type: 'add' };
    else if (a === '--remove') { const k = parseInt(argv[++i], 10); change = { type: 'remove', index: k - 1 }; }
    else if (a === '--json') json = true;
    else { console.error('Unknown option ' + a + '. Try --help.'); return 2; }
  }
  if (!change) { console.log(HELP); return 2; }
  if (!(n >= 1 && n <= 1000)) { console.error('--nodes takes 1 to 1000'); return 2; }
  if (change.type === 'remove' && (n < 2 || !(change.index >= 0 && change.index < n))) { console.error(`--remove takes a node from 1 to ${n}, and needs at least 2 nodes`); return 2; }
  const keys = file ? fs.readFileSync(file === '-' ? 0 : file, 'utf8').split('\n').map((l) => l.replace(/\r$/, '')).filter(Boolean) : R.sampleKeys(count);
  const e = R.experiment(keys, n, change, { vnodes });
  if (json) { console.log(JSON.stringify({ nodesBefore: e.before, nodesAfter: e.after, keys: keys.length, ideal: e.ideal, results: e.results }, null, 2)); return 0; }
  const what = change.type === 'add' ? `adding node-${n + 1} to ${n} nodes` : `removing node-${change.index + 1} from ${n} nodes`;
  console.log(`${keys.length} keys, ${what}. A perfect method moves ${(100 * e.ideal / keys.length).toFixed(1)}% of them.`);
  console.log('');
  console.log('Method        Keys moved   Moved between nodes that stayed   Busiest node after, vs even share');
  for (const [algo, r] of Object.entries(e.results)) {
    const name = R.ALGORITHMS[algo].name.padEnd(12);
    const moved = ((100 * r.moved / keys.length).toFixed(1) + '%').padStart(10);
    const needless = String(r.needless).padStart(10);
    const note = algo === 'jump' && change.type === 'remove' && change.index !== n - 1 ? `   (removed ${r.removedNode}: jump hash can only drop the last)` : '';
    console.log(`${name}  ${moved}   ${needless}                        ${r.after.maxOverMean.toFixed(2)}x${note}`);
  }
  return 0;
}

try { process.exitCode = main(process.argv.slice(2)); }
catch (e) { console.error(e.message); process.exitCode = 1; }
