#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Command line for the Graph Key Builder. Run "node graph/cli.js --help".

'use strict';
const fs = require('fs');
const G = require('./graph.js');

const HELP = `Graph Key Builder: the keys a graph takes in an ordered key-value store,
and what following its links costs.

Usage:
  node graph/cli.js keys FILE                 Every key, in the order the store keeps them
  node graph/cli.js walk FILE --from NODE     Follow the links from NODE, hop by hop

FILE has one link a line, "from type to", or "from,type,to" when names have
spaces. Use - to read standard input.

Options for walk:
  --hops N       How many hops to follow (default 2, up to 10)
  --in           Follow links backwards, to the nodes that point at NODE
  --both         Follow links both ways
  --type TYPE    Follow only links of this type`;

function main(argv) {
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') { console.log(HELP); return argv.length ? 0 : 2; }
  const cmd = argv[0], file = argv[1];
  if ((cmd !== 'keys' && cmd !== 'walk') || !file) { console.error('Give keys or walk, then a file. Try --help.'); return 2; }
  const opt = { hops: 2, dir: 'out', type: '' };
  let from = null;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') from = argv[++i];
    else if (a === '--hops') opt.hops = parseInt(argv[++i], 10);
    else if (a === '--in') opt.dir = 'in';
    else if (a === '--both') opt.dir = 'both';
    else if (a === '--type') opt.type = argv[++i];
    else { console.error('Unknown option ' + a + '. Try --help.'); return 2; }
  }
  if (!(opt.hops >= 1 && opt.hops <= 10)) { console.error('--hops takes 1 to 10'); return 2; }

  const parsed = G.parseEdges(fs.readFileSync(file === '-' ? 0 : file, 'utf8'));
  for (const e of parsed.errors) console.error(`Line ${e.line}: ${e.message}`);
  if (!parsed.edges.length) { console.error('No links found.'); return 1; }
  const store = G.build(parsed.edges);

  if (cmd === 'keys') {
    for (const e of store.entries) console.log(e.value ? e.key + '  ' + e.value : e.key);
    return parsed.errors.length ? 1 : 0;
  }

  if (from === null) { console.error('walk needs --from NODE'); return 2; }
  const w = G.walk(store, from, opt);
  if (!w.exists) { console.error(`No node called ${from}.`); return 1; }
  const way = { out: 'out from', in: 'back from', both: 'both ways from' }[w.dir];
  console.log(`Following links ${way} ${from}${w.type ? ', type ' + w.type : ''}, up to ${w.hops} hop${w.hops === 1 ? '' : 's'}.`);
  for (const s of w.steps) {
    const read = s.scans.reduce((n, x) => n + x.keys.length, 0);
    console.log('');
    console.log(`Hop ${s.hop}: ${s.scans.length} prefix scan${s.scans.length === 1 ? '' : 's'}, ${read} key${read === 1 ? '' : 's'} read`);
    for (const x of s.scans) console.log(`  ${x.prefix}  ->  ${x.ends.length ? x.ends.join(', ') : 'nothing'}`);
  }
  console.log('');
  console.log(`Reached ${w.reached} node${w.reached === 1 ? '' : 's'} with ${w.scans} prefix scan${w.scans === 1 ? '' : 's'}, reading ${w.keysRead} key${w.keysRead === 1 ? '' : 's'}.`);
  return 0;
}

try { process.exitCode = main(process.argv.slice(2)); }
catch (e) { console.error(e.message); process.exitCode = 1; }
