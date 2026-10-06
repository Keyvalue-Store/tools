// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Graph Key Builder. Turns a list of links into the keys a graph takes in an
// ordered key-value store, such as RocksDB, LMDB, Badger or etcd, and follows
// the links the way a graph layer on such a store does: one prefix scan per
// node, counted. One file, no dependencies. In a browser it defines KVGraph;
// in Node, require() returns the same functions.

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KVGraph = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const encoder = new TextEncoder();

  // The parts of a key are joined with "/", so a "/" or "%" inside a name is
  // written %2F or %25. Without that, the scan for o/alice/ would also pick up
  // the links of a node called "alice/x".
  function escapePart(s) { return String(s).replace(/%/g, '%25').replace(/\//g, '%2F'); }
  function unescapePart(s) { return String(s).replace(/%2F|%25/g, (m) => (m === '%2F' ? '/' : '%')); }

  //   n/<node>               the node's own record, {} until it has fields
  //   o/<from>/<type>/<to>   a link, filed under the node it leaves
  //   i/<to>/<type>/<from>   the same link, filed under the node it reaches
  function nodeKey(id) { return 'n/' + escapePart(id); }
  function outKey(from, type, to) { return 'o/' + escapePart(from) + '/' + escapePart(type) + '/' + escapePart(to); }
  function inKey(to, type, from) { return 'i/' + escapePart(to) + '/' + escapePart(type) + '/' + escapePart(from); }

  // Ordered stores compare keys byte by byte, in UTF-8. JavaScript's own
  // string order differs for some characters outside ASCII, so it isn't used.
  function compareBytes(a, b) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return a.length - b.length;
  }
  function startsWith(a, p) {
    if (a.length < p.length) return false;
    for (let i = 0; i < p.length; i++) if (a[i] !== p[i]) return false;
    return true;
  }

  // One link a line: "from type to", or "from,type,to" when names have
  // spaces. Two names make a link of type "link". Blank lines and lines that
  // start with # are skipped.
  function parseEdges(text) {
    const edges = [], errors = [];
    String(text).split(/\r?\n/).forEach((raw, i) => {
      const line = raw.trim();
      if (!line || line.startsWith('#')) return;
      const parts = (line.includes(',') ? line.split(',') : line.split(/\s+/)).map((p) => p.trim());
      if (parts.length < 2 || parts.length > 3 || parts.some((p) => p === '')) {
        errors.push({ line: i + 1, text: raw, message: 'expected "from type to" or "from,type,to"' });
        return;
      }
      if (parts.length === 2) parts.splice(1, 0, 'link');
      edges.push({ from: parts[0], type: parts[1], to: parts[2], line: i + 1 });
    });
    return { edges, errors };
  }

  // Every key the links make, in store order. A link listed twice is stored once.
  function build(edges) {
    const map = new Map();
    for (const e of edges) {
      map.set(nodeKey(e.from), '{}');
      map.set(nodeKey(e.to), '{}');
      map.set(outKey(e.from, e.type, e.to), '');
      map.set(inKey(e.to, e.type, e.from), '');
    }
    const entries = Array.from(map, ([key, value]) => ({ key, value, bytes: encoder.encode(key) }));
    entries.sort((a, b) => compareBytes(a.bytes, b.bytes));
    let nodes = 0, links = 0;
    for (const e of entries) { if (e.key[0] === 'n') nodes++; else if (e.key[0] === 'o') links++; }
    return { entries, nodes, links };
  }

  // Where a key is, or would go: what a store's seek does.
  function seek(store, bytes) {
    const list = store.entries;
    let lo = 0, hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (compareBytes(list[mid].bytes, bytes) < 0) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  function get(store, key) {
    const b = encoder.encode(key);
    const i = seek(store, b);
    const e = store.entries[i];
    return e && compareBytes(e.bytes, b) === 0 ? e.value : undefined;
  }

  // A prefix scan: seek to the prefix, then read keys while they start with it.
  function scan(store, prefix) {
    const p = encoder.encode(prefix);
    const keys = [];
    for (let i = seek(store, p); i < store.entries.length && startsWith(store.entries[i].bytes, p); i++) keys.push(store.entries[i].key);
    return keys;
  }

  // The prefixes that hold one node's links: "out", "in" or "both" ways,
  // and of one type only if a type is given.
  function prefixes(id, dir, type) {
    const t = type ? escapePart(type) + '/' : '';
    const list = [];
    if (dir !== 'in') list.push('o/' + escapePart(id) + '/' + t);
    if (dir !== 'out') list.push('i/' + escapePart(id) + '/' + t);
    return list;
  }

  // The node at the other end of a link key is its last part.
  function otherEnd(key) { return unescapePart(key.slice(key.lastIndexOf('/') + 1)); }

  // Follow links from a node, hop by hop, as a graph layer on a key-value
  // store does: one prefix scan per node and direction, each node once.
  function walk(store, start, opt) {
    const o = opt || {};
    const hops = Math.max(1, Math.min(o.hops || 2, 10));
    const dir = o.dir === 'in' || o.dir === 'both' ? o.dir : 'out';
    const seen = new Set([start]);
    const steps = [];
    let frontier = [start], scans = 0, keysRead = 0;
    for (let h = 1; h <= hops && frontier.length; h++) {
      const step = { hop: h, scans: [], found: [] };
      for (const id of frontier) {
        for (const prefix of prefixes(id, dir, o.type)) {
          const keys = scan(store, prefix);
          scans++;
          keysRead += keys.length;
          step.scans.push({ node: id, prefix, keys, ends: keys.map(otherEnd) });
          for (const k of keys) {
            const n = otherEnd(k);
            if (!seen.has(n)) { seen.add(n); step.found.push(n); }
          }
        }
      }
      steps.push(step);
      frontier = step.found;
    }
    return { start, hops, dir, type: o.type || '', exists: get(store, nodeKey(start)) !== undefined, steps, scans, keysRead, reached: seen.size - 1 };
  }

  // The names of the nodes and link types, sorted, for menus.
  function names(store) {
    const nodes = [], types = new Set();
    for (const e of store.entries) {
      if (e.key[0] === 'n') nodes.push(unescapePart(e.key.slice(2)));
      else if (e.key[0] === 'o') types.add(unescapePart(e.key.split('/')[2]));
    }
    return { nodes, types: Array.from(types).sort() };
  }

  return {
    escapePart: escapePart,
    unescapePart: unescapePart,
    nodeKey: nodeKey,
    outKey: outKey,
    inKey: inKey,
    compareBytes: compareBytes,
    parseEdges: parseEdges,
    build: build,
    get: get,
    scan: scan,
    prefixes: prefixes,
    walk: walk,
    names: names
  };
});
