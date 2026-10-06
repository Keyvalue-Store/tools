// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Writes test/results/servers.json: for each server version, how many
// recorded cases the Memory Calculator replayed, of which kinds, how many
// of its answers differ (none, when the tests pass), and how the expected
// values for what chance decides compare with what happened.
//
//   node memory/test/generate/measure.js

'use strict';
// node --test runs every .js file under a test folder; this one only runs by hand.
if (process.env.NODE_TEST_CONTEXT) return;
const fs = require('fs');
const path = require('path');
const R = require('../replay.js');

const data = R.load();
const out = { recorded: 'Each case wrote keys to the built server and read used_memory before and after; memory.js replayed the same cases.', versions: [] };
for (const [id, rec] of Object.entries(data)) {
  const kinds = {};
  for (const c of rec.cases) kinds[c.kind] = (kinds[c.kind] || 0) + 1;
  const ch = R.chance(id, rec);
  const sk = R.skiplistStats(id, rec);
  out.versions.push({
    version: id,
    // used_memory when the recorder connected, before it ran anything;
    // memory.js's emptyServer() is the figure INFO gives a fresh server.
    usedMemoryAtStart: rec.startup,
    cases: rec.cases.length,
    kinds: kinds,
    keys: rec.cases.reduce((a, c) => a + c.groups.reduce((b, g) => b + g.count, 0), 0),
    bytesMeasured: rec.cases.reduce((a, c) => a + c.delta, 0),
    rerun: rec.cases.filter((c) => c.tries).length,
    differences: R.differences(id, rec).length,
    leftToChance: { cases: ch.n, meanZ: Number(ch.mean.toFixed(3)), within3sd: Number(ch.within3.toFixed(4)) },
    skiplistCases: { cases: sk.n, meanZ: Number(sk.mean.toFixed(3)) }
  });
}
const sum = (k) => out.versions.reduce((a, v) => a + v[k], 0);
out.total = {};
for (const k of ['cases', 'keys', 'bytesMeasured', 'differences']) out.total[k] = sum(k);
const dest = path.join(__dirname, '..', 'results', 'servers.json');
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, JSON.stringify(out, null, 2) + '\n');
console.log(dest, JSON.stringify(out.total));
