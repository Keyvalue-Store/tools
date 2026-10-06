// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Tests for the Graph Key Builder. sqlite-3.45.1.json holds the order SQLite
// keeps the test graph's keys in, and the answer to every prefix scan, from
// generate/record.py. Run with: node --test

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const G = require('../graph.js');

const fixture = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');
const store = G.build(G.parseEdges(fixture('links.txt')).edges);
const sqlite = JSON.parse(fixture('sqlite-3.45.1.json'));

test('keys come out in the order SQLite keeps them', () => {
  assert.deepEqual(store.entries.map((e) => e.key), sqlite.order);
  // JavaScript's own sort would put 😀 before ～; byte order puts it after.
  assert.notDeepEqual([...sqlite.order].sort(), sqlite.order);
});

test('every prefix scan finds what SQLite finds', () => {
  assert.equal(sqlite.scans.length, 150);
  for (const s of sqlite.scans) assert.deepEqual(G.scan(store, s.prefix), s.keys, s.prefix);
});

test('reads links in both forms and reports bad lines', () => {
  const p = G.parseEdges('# a comment\n\nweb calls auth\r\nteam one,owns,web\nweb cart\na b c d\nx,,y\nsolo\n');
  assert.deepEqual(p.edges.map((e) => [e.from, e.type, e.to]), [['web', 'calls', 'auth'], ['team one', 'owns', 'web'], ['web', 'link', 'cart']]);
  assert.deepEqual(p.errors.map((e) => e.line), [6, 7, 8]);
});

test('names with a slash or percent sign stay in their own prefix', () => {
  assert.equal(G.nodeKey('alice/x'), 'n/alice%2Fx');
  assert.equal(G.outKey('100%', 'follows', 'a/b'), 'o/100%25/follows/a%2Fb');
  for (const s of ['a/b', '100%', '%2F', 'a%2Fb/c', '']) assert.equal(G.unescapePart(G.escapePart(s)), s);
  assert.deepEqual(G.scan(store, 'o/alice/knows/').map((k) => k.split('/').pop()), ['Bob', 'Zoë', 'alice%2Fx', 'alice-2', 'bob', 'o']);
  assert.deepEqual(G.scan(store, 'o/alice%2Fx/'), ['o/alice%2Fx/knows/carol']);
});

test('builds one record per node and two keys per link, once each', () => {
  const s = G.build(G.parseEdges('a x b\na x b\nb y a').edges);
  assert.equal(s.nodes, 2);
  assert.equal(s.links, 2);
  assert.equal(s.entries.length, 6);
  assert.equal(G.get(s, 'n/a'), '{}');
  assert.equal(G.get(s, 'o/a/x/b'), '');
  assert.equal(G.get(s, 'n/c'), undefined);
});

test('a walk scans one prefix per node and direction', () => {
  const s = G.build(G.parseEdges(['web calls auth', 'web calls cart', 'cart reads cart-db', 'auth reads user-db', 'team owns cart'].join('\n')).edges);
  const out = G.walk(s, 'web', { hops: 2 });
  assert.deepEqual(out.steps.map((x) => x.found), [['auth', 'cart'], ['user-db', 'cart-db']]);
  assert.equal(out.scans, 3);
  assert.equal(out.keysRead, 4);
  assert.equal(out.reached, 4);
  const back = G.walk(s, 'cart-db', { hops: 5, dir: 'in' });
  assert.deepEqual(back.steps.map((x) => x.found), [['cart'], ['web', 'team'], []]);
  assert.equal(back.scans, 4);
  const both = G.walk(s, 'cart', { hops: 1, dir: 'both' });
  assert.deepEqual(both.steps[0].scans.map((x) => x.prefix), ['o/cart/', 'i/cart/']);
  assert.equal(G.walk(s, 'web', { type: 'reads' }).reached, 0);
  assert.equal(G.walk(s, 'nobody').exists, false);
});
