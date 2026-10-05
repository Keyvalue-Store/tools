// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Tests for the Keyspace Map. The valkey-scan-*.txt fixtures are real
// `valkey-cli --scan` output from Valkey 9.1.2, holding 9,161 keys made from
// the patterns in expected-patterns.json. Run with: node --test

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const K = require('../keyspace.js');

const enc = new TextEncoder();
const fixture = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n));
const keys = (list) => list.map((k) => enc.encode(k));

test('real --scan output maps to the patterns the keys were made from', () => {
  const want = JSON.parse(fixture('expected-patterns.json'));
  for (const form of ['raw', 'quoted']) {
    const list = K.parseKeyBuffer(new Uint8Array(fixture(`valkey-scan-${form}.txt`)));
    assert.equal(list.length, 9161, form);
    const r = K.analyze(list);
    assert.equal(r.separator, ':');
    const got = {};
    for (const p of r.patterns) got[p.pattern] = p.count;
    assert.deepEqual(got, want, form);
    assert.deepEqual(r.findings.map((f) => f.kind + ':' + f.count), ['noSeparator:3', 'case:1', 'near:1']);
  }
});

test('segments that vary are folded into placeholders', () => {
  const cases = {
    '42': '<id>', '9f86d081884c7d659a2feaa0c55ad015': '<hex>', '3fa85f64-5717-4562-b3fc-2c963f66afa6': '<uuid>',
    '2026-10-05': '<date>', '2026-10-05T09:30:00Z': '<date>', 'ana@example.com': '<email>', '203.0.113.7': '<ip>',
    'eyJhbGciOiJIUzI1NiJ9abc123': '<token>', '{42}': '{<id>}', 'profile': null, 'deadbeef': null, 'v2': null, '{user}': null
  };
  for (const [seg, want] of Object.entries(cases)) assert.equal(K.classify(seg), want, seg);
});

test('the separator is the one most keys use', () => {
  assert.equal(K.guessSeparator(['a:b', 'c:d', 'e/f']), ':');
  assert.equal(K.guessSeparator(['a/b/c', 'd/e', 'f/g']), '/');
  assert.equal(K.guessSeparator(['user_42', 'user_43', 'cart_1']), '_');
  assert.equal(K.guessSeparator(['cache:user-42', 'cache:user-43']), ':');
  assert.equal(K.guessSeparator(['alpha', 'beta']), '');
});

test('levels full of one-off names fold into <*>, categories stay', () => {
  const list = [];
  for (let i = 0; i < 60; i++) list.push(`member:name${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}x:avatar`);
  for (const c of ['red', 'green', 'blue']) for (let i = 0; i < 20; i++) list.push(`color:${c}:${i}`);
  const r = K.analyze(keys(list));
  const got = Object.fromEntries(r.patterns.map((p) => [p.pattern, p.count]));
  assert.deepEqual(got, { 'member:<*>:avatar': 60, 'color:red:<id>': 20, 'color:green:<id>': 20, 'color:blue:<id>': 20 });
  const flat = K.analyze(keys(list), { foldBusy: false });
  assert.equal(flat.patterns.length, 63);
  const raw = K.analyze(keys(list), { fold: false, foldBusy: false });
  assert.equal(raw.patterns.length, 120);
});

test('naming slips are found', () => {
  const r = K.analyze(keys(['user:1', 'user:2', 'User:3', 'usr:4', 'orders:1', 'order:2', 'lonely', 'a::b', 'x:y/z:1', 'p/q:1']));
  const kinds = Object.fromEntries(r.findings.map((f) => [f.kind, f]));
  assert.equal(kinds.noSeparator.count, 1);
  assert.deepEqual(kinds.case.examples, ['user / User']);
  assert.ok(kinds.near.examples.includes('user / usr'));
  assert.ok(kinds.near.examples.includes('orders / order'));
  assert.equal(kinds.empty.count, 1);
  assert.equal(kinds.otherSeparator.count, 1);
  const long = K.analyze([new Uint8Array(300).fill(97), enc.encode('k:\x01')]);
  assert.equal(Object.fromEntries(long.findings.map((f) => [f.kind, f.count])).long, 1);
  assert.equal(Object.fromEntries(long.findings.map((f) => [f.kind, f.count])).unclean, 1);
});

test('the tree adds up', () => {
  const r = K.analyze(keys(['a:1', 'a:2', 'a:x:1', 'b:1', 'b']));
  const t = K.tree(r.root);
  assert.equal(t.count, 5);
  assert.equal(t.children.reduce((s, c) => s + c.count, 0), 5);
  const a = t.children.find((c) => c.name === 'a');
  assert.equal(a.count, 3);
  assert.equal(t.children.find((c) => c.name === 'b').ends, 1);
  assert.equal(r.totalBytes, 3 + 3 + 5 + 3 + 1);
  assert.equal(r.patterns.reduce((s, p) => s + p.count, 0), 5);
  assert.equal(r.patterns.reduce((s, p) => s + p.bytes, 0), r.totalBytes);
});

test('binary keys and quoted output', () => {
  const list = K.parseKeyList('1) "bin:\\x00\\xff"\n"plain:1"\n');
  assert.deepEqual(Array.from(list[0]), [98, 105, 110, 58, 0, 255]);
  assert.equal(K.keyText(list[0]).text, 'bin:\\x00\\xff');
  assert.equal(K.keyText(list[0]).clean, false);
  assert.equal(K.keyText(list[1]).text, 'plain:1');
});
