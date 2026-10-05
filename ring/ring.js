// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Consistent Hashing Playground. Spreads keys over nodes four ways (plain
// modulo, a hash ring with virtual nodes, rendezvous hashing and jump
// consistent hash) and measures what happens when a node joins or leaves:
// how even the load is, and how many keys have to move. One file, no
// dependencies. In a browser it defines KVRing; in Node, require() returns
// the same functions.

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KVRing = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const encoder = new TextEncoder();

  // MurmurHash3, x86 32-bit version, by Austin Appleby (public domain).
  function murmur3(key, seed) {
    const data = typeof key === 'string' ? encoder.encode(key) : key;
    const len = data.length;
    let h = (seed || 0) >>> 0;
    const c1 = 0xcc9e2d51, c2 = 0x1b873593;
    const blocks = len >>> 2;
    for (let i = 0; i < blocks; i++) {
      const o = i * 4;
      let k = (data[o]) | (data[o + 1] << 8) | (data[o + 2] << 16) | (data[o + 3] << 24);
      k = Math.imul(k, c1); k = (k << 15) | (k >>> 17); k = Math.imul(k, c2);
      h ^= k; h = (h << 13) | (h >>> 19); h = (Math.imul(h, 5) + 0xe6546b64) | 0;
    }
    const tail = blocks * 4;
    let k = 0;
    switch (len & 3) {
      case 3: k ^= data[tail + 2] << 16; // falls through
      case 2: k ^= data[tail + 1] << 8; // falls through
      case 1: k ^= data[tail]; k = Math.imul(k, c1); k = (k << 15) | (k >>> 17); k = Math.imul(k, c2); h ^= k;
    }
    h ^= len;
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0;
  }

  // Jump consistent hash, from "A Fast, Minimal Memory, Consistent Hash
  // Algorithm" by John Lamping and Eric Veach (2014). key is a 64-bit BigInt.
  const MASK64 = (1n << 64n) - 1n;
  function jump(key, buckets) {
    let k = BigInt.asUintN(64, key);
    let b = -1, j = 0;
    while (j < buckets) {
      b = j;
      k = (k * 2862933555777941757n + 1n) & MASK64;
      j = Math.floor((b + 1) * (2147483648 / (Number(k >> 33n) + 1)));
    }
    return b;
  }
  // A 64-bit key from two 32-bit hashes of the text.
  function key64(key) { return (BigInt(murmur3(key, 0)) << 32n) | BigInt(murmur3(key, 0x9747b28c)); }

  // ---- placing keys ----

  // Each algorithm takes the node names and returns a function from key to node index.
  const ALGORITHMS = {
    modulo: {
      name: 'Modulo', note: 'hash(key) mod N',
      build: (nodes) => (key) => murmur3(key, 0) % nodes.length
    },
    ring: {
      name: 'Hash ring', note: 'virtual nodes on a circle',
      build: (nodes, opt) => {
        const v = Math.max(1, (opt && opt.vnodes) || 160);
        const points = new Uint32Array(nodes.length * v);
        const owner = new Int32Array(nodes.length * v);
        const order = [];
        nodes.forEach((n, i) => { for (let r = 0; r < v; r++) order.push([murmur3(n + '#' + r, 0), i]); });
        order.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        order.forEach(([p, i], idx) => { points[idx] = p; owner[idx] = i; });
        const fn = (key) => {
          const h = murmur3(key, 0);
          let lo = 0, hi = points.length;
          while (lo < hi) { const mid = (lo + hi) >>> 1; if (points[mid] < h) lo = mid + 1; else hi = mid; }
          return owner[lo === points.length ? 0 : lo];
        };
        fn.points = points; fn.owner = owner;
        return fn;
      }
    },
    rendezvous: {
      name: 'Rendezvous', note: 'highest score wins',
      build: (nodes) => {
        const seeds = nodes.map((n) => murmur3(n, 0));
        return (key) => {
          const bytes = encoder.encode(key);
          let best = -1, bestScore = -1;
          for (let i = 0; i < seeds.length; i++) {
            const s = murmur3(bytes, seeds[i]);
            if (s > bestScore || (s === bestScore && nodes[i] < nodes[best])) { best = i; bestScore = s; }
          }
          return best;
        };
      }
    },
    jump: {
      name: 'Jump hash', note: 'numbered buckets',
      build: (nodes) => (key) => jump(key64(key), nodes.length)
    }
  };

  function assign(algo, nodes, keys, opt) {
    const f = ALGORITHMS[algo].build(nodes, opt);
    const out = new Int32Array(keys.length);
    for (let i = 0; i < keys.length; i++) out[i] = f(keys[i]);
    return out;
  }

  function loadStats(owners, n) {
    const counts = new Array(n).fill(0);
    for (const o of owners) counts[o]++;
    const mean = owners.length / n;
    let sq = 0;
    for (const c of counts) sq += (c - mean) * (c - mean);
    const max = Math.max(...counts), min = Math.min(...counts);
    return { counts, mean, min, max, maxOverMean: mean ? max / mean : 0, stddev: Math.sqrt(sq / n) };
  }

  // Compare before and after a change of nodes. Moves between two nodes that
  // were there both times are the ones consistent hashing exists to avoid.
  function compare(before, beforeNodes, after, afterNodes) {
    let moved = 0, needless = 0;
    const afterSet = new Set(afterNodes), beforeSet = new Set(beforeNodes);
    for (let i = 0; i < before.length; i++) {
      const a = beforeNodes[before[i]], b = afterNodes[after[i]];
      if (a !== b) {
        moved++;
        if (afterSet.has(a) && beforeSet.has(b)) needless++;
      }
    }
    return { moved, needless };
  }

  function nodeNames(n, prefix) { return Array.from({ length: n }, (_, i) => (prefix || 'node-') + (i + 1)); }
  function sampleKeys(n, prefix) { return Array.from({ length: n }, (_, i) => (prefix || 'key:') + i); }

  // Run one experiment: place keys on N nodes, then add a node or take one
  // away, for every algorithm. change: { type: 'add' } or { type: 'remove', index }.
  function experiment(keys, n, change, opt) {
    const before = nodeNames(n);
    let after;
    if (change.type === 'add') after = before.concat('node-' + (n + 1));
    else {
      const idx = change.index === undefined ? n - 1 : change.index;
      after = before.filter((_, i) => i !== idx);
    }
    const results = {};
    for (const algo of Object.keys(ALGORITHMS)) {
      let bNodes = before, aNodes = after;
      // Jump hash numbers its buckets, so it can only add or drop the last one.
      if (algo === 'jump' && change.type === 'remove') aNodes = before.slice(0, n - 1);
      const b = assign(algo, bNodes, keys, opt);
      const a = assign(algo, aNodes, keys, opt);
      const c = compare(b, bNodes, a, aNodes);
      results[algo] = {
        before: loadStats(b, bNodes.length), after: loadStats(a, aNodes.length),
        moved: c.moved, needless: c.needless, removedNode: change.type === 'remove' ? before.filter((x) => !aNodes.includes(x))[0] : null
      };
    }
    const ideal = change.type === 'add' ? keys.length / (n + 1) : keys.length / n;
    return { before, after, ideal, results };
  }

  return {
    murmur3: murmur3,
    jump: jump,
    key64: key64,
    ALGORITHMS: ALGORITHMS,
    assign: assign,
    loadStats: loadStats,
    compare: compare,
    nodeNames: nodeNames,
    sampleKeys: sampleKeys,
    experiment: experiment
  };
});
