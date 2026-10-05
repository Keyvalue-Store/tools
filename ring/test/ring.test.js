// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Tests for the Consistent Hashing Playground. murmur3-cases.jsonl holds
// hashes from the Python mmh3 package; jump-cases.jsonl holds buckets from
// the C code printed in Lamping and Veach's jump hash paper. Run with: node --test

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const R = require('../ring.js');

const lines = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('MurmurHash3 matches mmh3', () => {
  const cases = lines('murmur3-cases.jsonl');
  assert.equal(cases.length, 500);
  for (const c of cases) assert.equal(R.murmur3(c.s, c.seed), c.hash, JSON.stringify(c.s));
  assert.equal(R.murmur3('', 0), 0);
  assert.equal(R.murmur3('', 1), 0x514e28b7);
});

test('jump hash matches the reference code', () => {
  const cases = lines('jump-cases.jsonl');
  assert.equal(cases.length, 500);
  for (const c of cases) assert.equal(R.jump(BigInt(c.key), c.buckets), c.bucket);
  assert.equal(R.jump(0n, 1), 0);
});

const keys = R.sampleKeys(20000);

test('consistent methods never move a key between two nodes that stayed', () => {
  for (const change of [{ type: 'add' }, { type: 'remove', index: 1 }]) {
    const e = R.experiment(keys, 5, change);
    for (const algo of ['ring', 'rendezvous', 'jump']) assert.equal(e.results[algo].needless, 0, algo + ' ' + change.type);
    assert.ok(e.results.modulo.needless > keys.length / 2, 'modulo reshuffles most keys');
  }
});

test('adding a node moves about its fair share of keys', () => {
  const e = R.experiment(keys, 4, { type: 'add' });
  const ideal = e.ideal / keys.length;
  for (const algo of ['rendezvous', 'jump']) {
    const share = e.results[algo].moved / keys.length;
    assert.ok(Math.abs(share - ideal) < 0.02, `${algo} moved ${share}, ideal ${ideal}`);
  }
  assert.ok(e.results.modulo.moved / keys.length > 0.7);
});

test('removing a node moves only its keys', () => {
  const nodes = R.nodeNames(6);
  const without = nodes.filter((n) => n !== 'node-3');
  for (const algo of ['ring', 'rendezvous']) {
    const before = R.assign(algo, nodes, keys);
    const after = R.assign(algo, without, keys);
    for (let i = 0; i < keys.length; i++) {
      if (nodes[before[i]] !== 'node-3') assert.equal(without[after[i]], nodes[before[i]], algo);
    }
  }
});

test('more virtual nodes give a more even ring', () => {
  const spread = (v) => R.loadStats(R.assign('ring', R.nodeNames(10), keys, { vnodes: v }), 10).maxOverMean;
  assert.ok(spread(1) > 1.5);
  assert.ok(spread(160) < 1.2);
  assert.ok(spread(160) < spread(10));
});

test('jump hash can only drop its last bucket', () => {
  const e = R.experiment(keys, 4, { type: 'remove', index: 0 });
  assert.equal(e.results.jump.removedNode, 'node-4');
  assert.equal(e.results.rendezvous.removedNode, 'node-1');
});

test('load figures add up', () => {
  const s = R.loadStats(new Int32Array([0, 0, 1, 2, 2, 2]), 3);
  assert.deepEqual(s.counts, [2, 1, 3]);
  assert.equal(s.mean, 2);
  assert.equal(s.maxOverMean, 1.5);
});
