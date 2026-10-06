// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Replays the cases recorded from the built servers through memory.js and
// lists every difference. The tests use it; run it by hand to see them:
//
//   node memory/test/replay.js [version ...]

'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const M = require('../memory.js');

// The recorded cases: test/fixtures/runs.json.gz, or the file KV_FIXTURE
// names.
function load() {
  const file = process.env.KV_FIXTURE || path.join(__dirname, 'fixtures', 'runs.json.gz');
  if (!fs.existsSync(file)) throw new Error(file + " is missing: it comes with the repository, or generate/record.py writes it.");
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
}

// What chance decided in a recorded case, in the form estimate() takes.
function observed(c) {
  const table = (t) => (t && t.n ? { collisions: t.nonEmpty !== undefined ? t.n - t.nonEmpty : 0, children: t.children || 0 } : undefined);
  return {
    keys: table(c.keys),
    expires: table(c.expires),
    groups: c.obs.map((o) => (o && (o.collisions !== undefined || o.children !== undefined) ? o : undefined))
  };
}

// What an emptied database still holds, which estimate() counts for a
// database that never had keys. Every case starts after a FLUSHALL, which
// keeps the structs of the two tables where they're made on demand (Redis
// 7.4+, Valkey 8.0+). In Valkey 8.1+ each table also keeps one 64-byte
// bucket: serverCron gives it back after FLUSHALL.
function before(id, r) {
  const F = M.features(id);
  let b = 0;
  if (F.ks !== 'dict') b += r.tables.database;
  if (F.ks === 'ht') b += (r.keys ? 64 : 0) + (r.ttlKeys ? 64 : 0);
  return b;
}

// One recorded case against the model, given what chance decided. A
// skiplist's nodes have random sizes nobody can see from outside, so cases
// with one get a tolerance of six standard deviations, and the bytes the
// nodes must have taken are checked against the sizes nodes can have.
function check(id, c) {
  const obs = observed(c);
  const r = M.estimate(c.groups, id, c.settings, { observed: obs });
  const skip = r.groups.some((g) => g.encoding === 'skiplist');
  const diff = c.delta - (r.total - before(id, r));
  const out = [];
  if (skip ? Math.abs(diff) > 6 * r.sd + 1e-6 : Math.abs(diff) > 1e-6) {
    out.push({ kind: 'bytes', measured: c.delta, model: r.total - before(id, r), diff: diff, sd: r.sd, skiplist: skip });
  }
  if (skip) {
    // What the nodes took, by the model of everything else: no less than
    // every node at one level, and for a sorted set of one member, the size
    // of one node at some level.
    const F = M.features(id);
    const zero = obs.groups.slice();
    let floor = 0, one = null, sets = 0;
    r.groups.forEach((g, i) => {
      if (g.encoding !== 'skiplist') return;
      sets += g.count;
      const ks = M._internal.skiplistNodes(F, c.groups[i].member, c.groups[i].members);
      for (const k of ks) floor += g.count * k.count * M.sizeClass(k.base + 16);
      if (c.groups[i].members === 1) one = ks[0].base;
      zero[i] = Object.assign({}, zero[i], { nodes: 0 });
    });
    const r0 = M.estimate(c.groups, id, c.settings, { observed: Object.assign({}, obs, { groups: zero }) });
    const nodes = c.delta - (r0.total - before(id, r0));
    const sizes = [];
    for (let l = 1; l <= 32; l++) sizes.push(M.sizeClass(one + 16 * l));
    if (nodes < floor || (sets === 1 && one !== null && !sizes.includes(nodes))) {
      out.push({ kind: 'skiplist nodes', measured: nodes, atLeast: floor, oneNode: sets === 1 && one !== null ? sizes.slice(0, 6) : undefined });
    }
  }
  // The recorder asked for the encoding of each group's first key, which
  // is one with a TTL when the group has any.
  r.groups.forEach((g, i) => {
    const want = g.ttlKeys ? g.encodingTtl : g.encoding;
    if (c.groups[i].count > 0 && c.enc[i] !== want) out.push({ kind: 'encoding', group: i, measured: c.enc[i], model: want });
  });
  return { problems: out, skiplist: skip, z: skip && r.sd > 0 ? diff / r.sd : null };
}

function differences(id, rec) {
  const out = [];
  rec.cases.forEach((c, i) => {
    const r = check(id, c);
    for (const p of r.problems) out.push(Object.assign({ case: i, groups: c.groups, settings: c.settings }, p));
  });
  return out;
}

// The skiplist cases as a whole: their mean z-score shows a bias in the
// expected node sizes.
function skiplistStats(id, rec) {
  const zs = rec.cases.map((c) => check(id, c).z).filter((z) => z !== null);
  const n = zs.length;
  const mean = n ? zs.reduce((a, b) => a + b, 0) / n : 0;
  return { n: n, mean: mean };
}

// The expected values for what chance decides, against what happened: for
// each case with random parts, how many standard deviations the
// measurement is from the estimate made without knowing the outcome.
function chance(id, rec) {
  const zs = [];
  for (const c of rec.cases) {
    const r = M.estimate(c.groups, id, c.settings);
    if (r.sd < 1) continue;
    zs.push((c.delta - (r.total - before(id, r))) / r.sd);
  }
  const n = zs.length;
  return {
    n: n,
    mean: n ? zs.reduce((a, b) => a + b, 0) / n : 0,
    within3: n ? zs.filter((z) => Math.abs(z) <= 3).length / n : 1,
    max: n ? Math.max(...zs.map(Math.abs)) : 0
  };
}

module.exports = { load: load, observed: observed, check: check, differences: differences, skiplistStats: skiplistStats, chance: chance, before: before };

// node --test runs every .js file under a test folder; this one only runs
// by hand (the tests require it).
if (require.main === module && !process.env.NODE_TEST_CONTEXT) {
  const data = load();
  const want = process.argv.slice(2);
  let total = 0;
  for (const [id, rec] of Object.entries(data)) {
    if (want.length && !want.some((w) => id.includes(w))) continue;
    const d = differences(id, rec);
    total += d.length;
    const s = skiplistStats(id, rec);
    const ch = chance(id, rec);
    console.log(id, rec.cases.length, 'cases,', d.length, 'differences; skiplist cases', s.n, 'mean z', s.mean.toFixed(3) +
      '; left to chance', ch.n, 'mean z', ch.mean.toFixed(3), 'within 3 sd', (100 * ch.within3).toFixed(1) + '%', 'max', ch.max.toFixed(2));
    for (const x of d.slice(0, 25)) console.log('  ', JSON.stringify(x));
  }
  process.exitCode = total ? 1 : 0;
}
