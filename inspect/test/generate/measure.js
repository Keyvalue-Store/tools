// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Writes test/results/results.json: what each fixture decoded to, how often
// random tokens, hex strings and binary values were taken for something
// they aren't, and how long a big value takes. Everything random comes from
// a fixed seed, so the numbers come out the same on every run.
//
//   node inspect/test/generate/measure.js

'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const I = require('../../inspect.js');

const FIX = path.join(__dirname, '..', 'fixtures');
const OUT = path.join(__dirname, '..', 'results', 'results.json');

// A small seeded generator (mulberry32).
let seed = 20261005;
function rand() {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const bytes = (n) => Uint8Array.from({ length: n }, () => Math.floor(rand() * 256));
const between = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

// What each fixture came out as. test/inspect.test.js checks the values.
const fixtures = fs.readdirSync(FIX).filter((f) => f.endsWith('.json') && fs.existsSync(path.join(FIX, f.slice(0, -5) + '.bin'))).sort();
const byWriter = {}, checks = { valueByValue: 0, imageTypeAndSize: 0, namedOnly: 0 };
const rows = fixtures.map((f) => {
  const exp = JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));
  const b = new Uint8Array(fs.readFileSync(path.join(FIX, f.slice(0, -5) + '.bin')));
  const a = I.analyze(b);
  const source = exp.source.split(',')[0];
  const writer = /^Written/.test(source) ? source : source.split(' ')[0];
  byWriter[writer] = (byWriter[writer] || 0) + 1;
  if (exp.format === 'image') checks.imageTypeAndSize++;
  else if (exp.value === null) checks.namedOnly++;
  else checks.valueByValue++;
  return { file: f.slice(0, -5) + '.bin', bytes: b.length, writtenBy: exp.source, layers: a.layers.map((l) => l.id), format: a.result.id, expected: exp.format };
});

// Random base64 tokens and hex strings, the kind of IDs and hashes that fill
// a keyspace, should stay text. Random bytes should stay binary data.
function misread(text) {
  const a = I.analyze(I.fromInput(text).bytes);
  return a.layers.length > 0 || a.result.id !== 'text';
}
let b64 = 0, b64url = 0, hex = 0;
const B64_TRIES = 50000, HEX_TRIES = 20000, BIN_TRIES = 20000;
for (let i = 0; i < B64_TRIES; i++) {
  const t = Buffer.from(bytes(between(4, 48))).toString(i % 2 ? 'base64url' : 'base64');
  if (misread(t)) { if (i % 2) b64url++; else b64++; }
}
for (let i = 0; i < HEX_TRIES; i++) if (misread(Buffer.from(bytes(between(4, 32))).toString('hex'))) hex++;
const binary = {};
for (let i = 0; i < BIN_TRIES; i++) {
  const id = I.analyze(bytes(between(1, 64))).result.id;
  binary[id] = (binary[id] || 0) + 1;
}

// Speed: a 5.9 MB JSON document, gzipped.
const records = [];
const WORDS = 'the cart was saved after checkout and the user came back later to look at their order history again'.split(' ');
const sentence = () => Array.from({ length: between(4, 16) }, () => WORDS[between(0, WORDS.length - 1)]).join(' ');
for (let i = 0; records.length < 32000; i++) records.push({ id: i, user: 'user-' + between(1, 99999), score: Math.round(rand() * 100000) / 100, tags: ['new', 'sale', 'gift'].slice(0, between(0, 3)), active: rand() < 0.5, created: 1791218550 + between(0, 86400), note: sentence() });
const json = Buffer.from(JSON.stringify(records));
const gz = new Uint8Array(zlib.gzipSync(json));
I.analyze(gz);
const started = process.hrtime.bigint();
const runs = 5;
for (let i = 0; i < runs; i++) I.analyze(gz);
const ms = Math.round(Number(process.hrtime.bigint() - started) / 1e6 / runs);

const results = {
  note: 'Measured in October 2026 by test/generate/measure.js. test/inspect.test.js checks every fixture against what the language that wrote it reads back.',
  fixtures: rows.length,
  fixturesByWriter: byWriter,
  checked: checks,
  quotedOutputs: fs.readdirSync(FIX).filter((f) => /-quoted-/.test(f)).length,
  randomInput: {
    base64Tokens: { tried: B64_TRIES, lengths: '4 to 48 bytes, half base64 and half base64url', misread: b64 + b64url },
    hexStrings: { tried: HEX_TRIES, lengths: '4 to 32 bytes', misread: hex },
    binaryValues: { tried: BIN_TRIES, lengths: '1 to 64 bytes', result: binary }
  },
  speed: { value: `a ${(json.length / 1048576).toFixed(1)} MB JSON document, gzipped to ${(gz.length / 1048576).toFixed(2)} MB`, milliseconds: ms, node: process.version },
  fixtureList: rows
};
fs.writeFileSync(OUT, JSON.stringify(results, null, 1) + '\n');
console.log(JSON.stringify(Object.assign({}, results, { fixtureList: undefined }), null, 1));
