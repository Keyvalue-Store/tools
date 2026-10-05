// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Tests for the Typed JSON Converter. sdk-roundtrip.jsonl holds documents and
// the typed JSON the AWS SDK (@aws-sdk/util-dynamodb 3.996.9) made from them.
// Run with: node --test

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const T = require('../typedjson.js');


test('matches the AWS SDK in both directions', () => {
  const lines = fs.readFileSync(path.join(__dirname, 'fixtures', 'sdk-roundtrip.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 150);
  for (const line of lines) {
    const f = JSON.parse(line);
    assert.deepEqual(JSON.parse(T.convert(f.plain, { direction: 'toTyped' }).text), JSON.parse(f.typed));
    assert.deepEqual(JSON.parse(T.convert(f.typed, { direction: 'toPlain' }).text), JSON.parse(f.plain));
  }
});

test('numbers keep every digit', () => {
  const typed = '{"id": {"N": "12345678901234567890123456789012345678"}, "tiny": {"N": "-0.000000000000000000000000000000000001234567890123456789"}}';
  const out = T.convert(typed).text;
  assert.match(out, /"id": 12345678901234567890123456789012345678/);
  assert.match(out, /"tiny": -0\.000000000000000000000000000000000001234567890123456789/);
  const back = T.convert(out).text;
  assert.match(back, /"N": "12345678901234567890123456789012345678"/);
});

test('numbers DynamoDB accepts become valid JSON numbers', () => {
  const cases = { '+5': '5', '.5': '0.5', '5.': '5', '007': '7', '-0': '0', '1E3': '1e+3', '1e-05': '1e-5', '-00.250': '-0.250', '0.0': '0.0' };
  for (const [from, to] of Object.entries(cases)) assert.equal(T.jsonNumber(from), to, from);
  assert.throws(() => T.jsonNumber('12abc'), /not a number/);
  assert.throws(() => T.jsonNumber('NaN'), /not a number/);
});

test('reads the shapes AWS tools print', () => {
  const scan = '{"Items":[{"pk":{"S":"a"},"n":{"N":"1"}},{"pk":{"S":"b"},"n":{"N":"2"}}],"Count":2,"ScannedCount":2,"ConsumedCapacity":null}';
  let r = T.convert(scan);
  assert.equal(r.shape, 'items');
  assert.deepEqual(JSON.parse(r.text), [{ pk: 'a', n: 1 }, { pk: 'b', n: 2 }]);

  r = T.convert('{"Item":{"pk":{"S":"a"},"tags":{"SS":["x","y"]}}}');
  assert.equal(r.shape, 'item');
  assert.deepEqual(JSON.parse(r.text), { pk: 'a', tags: ['x', 'y'] });

  const s3 = '{"Item":{"pk":{"S":"a"}}}\n{"Item":{"pk":{"S":"b"},"ok":{"BOOL":true}}}\n';
  r = T.convert(s3);
  assert.equal(r.shape, 's3export');
  assert.equal(r.text, '{"pk":"a"}\n{"pk":"b","ok":true}\n');

  const stream = JSON.stringify({ Records: [{ eventID: '1', eventName: 'MODIFY', dynamodb: {
    Keys: { Id: { N: '101' } }, NewImage: { Id: { N: '101' }, Message: { S: 'new' } }, OldImage: { Id: { N: '101' }, Message: { S: 'old' } } } }] });
  r = T.convert(stream);
  assert.equal(r.shape, 'stream');
  assert.deepEqual(JSON.parse(r.text), [{ eventName: 'MODIFY', Keys: { Id: 101 }, NewImage: { Id: 101, Message: 'new' }, OldImage: { Id: 101, Message: 'old' } }]);

  r = T.convert('{"Responses":{"Music":[{"Artist":{"S":"No One You Know"}}]},"UnprocessedKeys":{}}');
  assert.equal(r.shape, 'batchget');
  assert.deepEqual(JSON.parse(r.text), { Music: [{ Artist: 'No One You Know' }] });
});

test('every DynamoDB type converts', () => {
  const typed = { s: { S: '' }, n: { N: '-1.5' }, b: { B: 'aGVsbG8=' }, t: { BOOL: false }, z: { NULL: true },
    m: { M: { inner: { L: [{ S: 'x' }, { N: '2' }] } } }, ss: { SS: ['a', 'b'] }, ns: { NS: ['1', '2.5'] }, bs: { BS: ['AAE='] } };
  const r = T.convert(JSON.stringify(typed));
  assert.deepEqual(JSON.parse(r.text), { s: '', n: -1.5, b: 'aGVsbG8=', t: false, z: null, m: { inner: ['x', 2] }, ss: ['a', 'b'], ns: [1, 2.5], bs: ['AAE='] });
  assert.equal(r.stats.binary, 2);
  assert.equal(r.stats.sets, 3);
});

test('lists become sets only when asked and only when they can', () => {
  const doc = '{"a":["x","y"],"b":["x","x"],"c":[1,2],"d":[1,1.0],"e":["x",1],"f":[]}';
  assert.deepEqual(JSON.parse(T.convert(doc).text).a, { L: [{ S: 'x' }, { S: 'y' }] });
  const r = JSON.parse(T.convert(doc, { sets: 'both' }).text);
  assert.deepEqual(r.a, { SS: ['x', 'y'] });
  assert.deepEqual(r.b, { L: [{ S: 'x' }, { S: 'x' }] });
  assert.deepEqual(r.c, { NS: ['1', '2'] });
  assert.deepEqual(r.d, { L: [{ N: '1' }, { N: '1.0' }] });
  assert.deepEqual(r.e, { L: [{ S: 'x' }, { N: '1' }] });
  assert.deepEqual(r.f, { L: [] });
  const strOnly = JSON.parse(T.convert(doc, { sets: 'strings' }).text);
  assert.deepEqual(strOnly.c, { L: [{ N: '1' }, { N: '2' }] });
});

test('batch-write-item requests come 25 items to a line', () => {
  const items = Array.from({ length: 60 }, (_, i) => ({ pk: 'item#' + i, n: i }));
  const r = T.convert(JSON.stringify(items), { output: 'batch', table: 'orders' });
  const lines = r.text.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.orders.length), [25, 25, 10]);
  assert.deepEqual(lines[2].orders[9], { PutRequest: { Item: { pk: { S: 'item#59' }, n: { N: '59' } } } });
});

test('numbers past 38 significant digits are flagged', () => {
  const r = T.convert('{"ok": 12345678901234567890123456789012345678, "toolong": 123456789012345678901234567890123456789}');
  assert.deepEqual(r.stats.precision, ['toolong']);
});

test('strings, odd names and escapes survive', () => {
  // Written as text: an object literal would treat __proto__ as the prototype.
  const text = '{"__proto__": "still a field", "line\\nbreak": "tab\\there", "emoji": "😀 €", "quote": "say \\"hi\\" \\\\ bye", "ctl": "\\u0001\\u2028"}';
  const typed = T.convert(text).text;
  assert.equal(JSON.parse(typed)['__proto__'].S, 'still a field');
  assert.deepEqual(JSON.parse(T.convert(typed).text), JSON.parse(text));
  assert.equal(Object.keys(JSON.parse(T.convert(typed).text)).length, 5);
});

test('mistakes are reported with where they are', () => {
  assert.throws(() => T.convert('{"a": {"S": 5}}'), /S value must be a string \(at a\.S\)/);
  assert.throws(() => T.convert('{"a": {"N": "five"}}', { direction: 'toPlain' }), /not a number \(at a\.N\)/);
  assert.throws(() => T.convert('{"a": {"M": {"b": {"X": 1}}}}', { direction: 'toPlain' }), /Expected a typed value/);
  assert.throws(() => T.convert('{"a": 1,}'), /line 1, column 9/);
  assert.throws(() => T.convert('{"pk":"a"}\n{"pk": }\n'), /line 2/);
  assert.throws(() => T.convert('[1, 2]', { direction: 'toTyped' }), /Only objects can become DynamoDB items/);
});

test('direction is picked from what was pasted', () => {
  assert.equal(T.convert('{"name": "Ana"}').direction, 'toTyped');
  assert.equal(T.convert('{"name": {"S": "Ana"}}').direction, 'toPlain');
  assert.equal(T.convert('[{"name": {"S": "Ana"}}]').direction, 'toPlain');
  assert.equal(T.convert('{"name": "Ana"}\n{"name": "Ben"}').direction, 'toTyped');
});
