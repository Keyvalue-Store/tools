// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Tests for the Expression Tester. The fixtures hold what DynamoDB Local
// 3.3.1 answered to 5,014 requests: random scans, gets, queries and updates
// from a seeded generator, and 214 requests written by hand. Each test sends
// the same request to the tester and expects the same answer: the same error
// message, word for word, or the same items. Run with: node --test

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const E = require('../expressions.js');

const FIX = path.join(__dirname, 'fixtures');
const lines = (name) => fs.readFileSync(path.join(FIX, name), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const json = (name) => JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));
const readItem = (it) => E.readItem(E.parseJson(JSON.stringify(it)), true);

// Items compared with their numbers written one way and their sets sorted,
// since a set has no order and DynamoDB Local keeps numbers inside lists
// and maps as they were sent.
function canon(item) {
  const num = (x) => { const n = E.parseNumber(x); return typeof n === 'string' ? x : E.numberText(n); };
  const fix = (v) => {
    if (v.N !== undefined) return { N: num(v.N) };
    if (v.SS) return { SS: v.SS.slice().sort() };
    if (v.NS) return { NS: v.NS.map(num).sort() };
    if (v.BS) return { BS: v.BS.slice().sort() };
    if (v.L) return { L: v.L.map(fix) };
    if (v.M) { const o = {}; for (const k of Object.keys(v.M).sort()) o[k] = fix(v.M[k]); return { M: o }; }
    return v;
  };
  const o = {};
  for (const k of Object.keys(item || {}).sort()) o[k] = fix(item[k]);
  return JSON.stringify(o);
}
// DynamoDB Local's second path in an overlap message is not always one of
// the two paths that overlap. The tester names the one that does, so
// messages are compared up to the first path.
const trim = (m) => m.replace(/(Two document paths (overlap|conflict) with each other; must remove or rewrite one of these paths; path one: \[[^\]]*(\[[^\]]*\][^\]]*)*\]).*$/, '$1');
const errorText = (e) => e.type + ': ' + trim(e.message);

function request(body, op, extra) {
  const req = Object.assign({ operation: op, typed: true }, extra || {});
  for (const k of ['KeyConditionExpression', 'FilterExpression', 'ConditionExpression', 'UpdateExpression', 'ProjectionExpression',
    'ExpressionAttributeNames', 'ExpressionAttributeValues', 'ScanIndexForward']) if (body[k] !== undefined) req[k] = body[k];
  return req;
}
const RUNTIME = /^ValidationException: (The provided expression refers to an attribute that does not exist in the item|An operand in the update expression has an incorrect data type|The document path provided in the update expression is invalid for update|DynamoDB only supports precision|Number (overflow|underflow))/;

const scanItems = json('items-scan.json');
const scanTool = scanItems.map(readItem);
const queryItems = json('items-query.json');
const queryTool = queryItems.map(readItem);

test('scans: filters and projections over 25 items give DynamoDB Local\'s answers', () => {
  const cases = lines('cases-scan.jsonl');
  let checked = 0;
  for (const c of cases) {
    const res = E.run(Object.assign(request(c.request, 'Scan', { keySchema: { partition: { name: 'pk', type: 'S' } } }), { items: scanTool }));
    const want = c.answer.ok ? 'OK ' + (c.request.ProjectionExpression ? c.answer.result.map(canon).sort().join('|') : c.answer.result.slice().sort().join(','))
      : errorText(c.answer);
    let got;
    if (res.error) got = errorText(res.error);
    else if (c.request.ProjectionExpression) got = 'OK ' + res.items.filter((x) => x.match).map((x) => canon(E.itemToTyped(x.projected))).sort().join('|');
    else got = 'OK ' + res.items.filter((x) => x.match).map((x) => x.item.get('pk').v).sort().join(',');
    assert.equal(got, want, JSON.stringify(c.request));
    checked++;
  }
  assert.equal(checked, 1500);
});

test('gets: projections give DynamoDB Local\'s answers', () => {
  for (const c of lines('cases-get.jsonl')) {
    const res = E.run(Object.assign(request(c.request, 'GetItem', { keySchema: { partition: { name: 'pk', type: 'S' } } }), { item: scanTool[+c.key.slice(1)] }));
    const want = c.answer.ok ? 'OK ' + canon(c.answer.result) : errorText(c.answer);
    const got = res.error ? errorText(res.error) : 'OK ' + canon(E.itemToTyped(res.after || new Map()));
    assert.equal(got, want, JSON.stringify(c.request));
  }
});

test('queries: key conditions, filters and order give DynamoDB Local\'s answers', () => {
  const schema = { partition: { name: 'pk', type: 'S' }, sort: { name: 'sk', type: 'N' } };
  for (const c of lines('cases-query.jsonl')) {
    const res = E.run(Object.assign(request(c.request, 'Query', { keySchema: schema }), { items: queryTool }));
    const want = c.answer.ok ? 'OK ' + c.answer.result.join(',') : errorText(c.answer);
    const got = res.error ? errorText(res.error)
      : 'OK ' + res.items.filter((x) => x.match).map((x) => x.item.get('pk').v + '/' + queryItems[x.index].sk.N).join(',');
    assert.equal(got, want, JSON.stringify(c.request));
  }
});

test('updates: the item afterwards, or the error, match DynamoDB Local', () => {
  const cases = lines('cases-update.jsonl');
  const results = JSON.parse(fs.readFileSync(path.join(__dirname, 'results', 'dynamodb-local-3.3.1.json'), 'utf8'));
  let differ = 0;
  for (const c of cases) {
    const res = E.run(Object.assign(request(c.request, 'UpdateItem', { keySchema: { partition: { name: 'pk', type: 'S' } } }), { item: readItem(c.item) }));
    const want = c.answer.ok ? 'OK ' + canon(c.answer.result) : errorText(c.answer);
    const got = res.error ? errorText(res.error) : 'OK ' + canon(E.itemToTyped(res.after));
    if (got === want) continue;
    // When an update has two or more problems that only show while it runs,
    // DynamoDB Local doesn't always report the same one first as the tester.
    // Both must still be such problems.
    assert.match(want, RUNTIME, JSON.stringify(c.request));
    assert.match(got, RUNTIME, JSON.stringify(c.request));
    differ++;
  }
  assert.equal(differ, results.update.runtimeOrderDiffers);
});

test('hand-written requests: the answers match DynamoDB Local', () => {
  for (const c of lines('cases-manual.jsonl')) {
    const keySchema = { partition: { name: c.table[0][0], type: c.table[0][1] } };
    if (c.table[1]) keySchema.sort = { name: c.table[1][0], type: c.table[1][1] };
    const req = request(c.request, c.op, { keySchema: keySchema });
    if (c.op === 'Query' || c.op === 'Scan') req.items = (c.items || [c.item]).map(readItem);
    else req.item = readItem(c.item);
    const res = E.run(req);
    let want, got;
    if (!c.answer.ok) want = errorText(c.answer);
    else if (c.op === 'Query' || c.op === 'Scan') want = 'OK ' + c.answer.result.map(canon).join('|');
    else want = 'OK ' + canon(c.answer.result);
    if (res.error) got = errorText(res.error);
    else if (c.op === 'Query' || c.op === 'Scan') got = 'OK ' + res.items.filter((x) => x.match).map((x) => canon(E.itemToTyped(x.projected || x.item))).join('|');
    else got = 'OK ' + canon(E.itemToTyped(res.after || new Map()));
    assert.equal(got, want, c.note);
  }
});

test('reserved words: the tester refuses exactly the names DynamoDB Local refuses', () => {
  const words = json('reserved-words.json').answers;
  let reserved = 0;
  for (const [w, answer] of Object.entries(words)) {
    const refused = /reserved keyword/.test(answer);
    assert.equal(E.isReserved(w) && !/^(AND|OR|NOT|BETWEEN|IN|SET|REMOVE|ADD|DELETE)$/i.test(w), refused, w);
    const res = E.check({ operation: 'Scan', FilterExpression: w + ' = :v', ExpressionAttributeValues: { ':v': { N: '1' } }, typed: true });
    assert.equal(res.error ? res.error.message.replace('Invalid FilterExpression: ', '') : 'accepted', answer, w);
    if (refused) reserved++;
  }
  assert.equal(reserved, 563);
});

test('numbers keep every digit and are written without an exponent', () => {
  const n = (t) => E.numberText(E.parseNumber(t));
  assert.equal(n('1.50'), '1.5');
  assert.equal(n('-0'), '0');
  assert.equal(n('1e2'), '100');
  assert.equal(n('123.4500e-2'), '1.2345');
  assert.equal(n('1E-130'), '0.' + '0'.repeat(129) + '1');
  assert.equal(n('99999999999999999999999999999999999999'), '99999999999999999999999999999999999999');
  assert.equal(E.parseNumber('123456789012345678901234567890123456789'), 'precision');
  assert.equal(E.parseNumber('1E+126'), 'overflow');
  assert.equal(E.parseNumber('1E-131'), 'underflow');
  assert.equal(E.parseNumber('0x10'), 'convert');
  assert.equal(n('٥'), '5');
  const sum = E.addNumbers(E.parseNumber('0.1'), E.parseNumber('0.2'));
  assert.equal(E.numberText(sum), '0.3');
});

test('escaping names puts placeholders on reserved words only', () => {
  const r = E.escapeNames('status = :s AND size(data) > :n AND begins_with(title, :t)');
  assert.equal(r.expression, '#status = :s AND size(#data) > :n AND begins_with(title, :t)');
  assert.deepEqual(r.names, { '#status': 'status', '#data': 'data' });
  const again = E.escapeNames('status = :a OR status = :b', { '#status': 'other' });
  assert.equal(again.expression, '#status2 = :a OR #status2 = :b');
});

test('a pasted request is read with its expressions and maps', () => {
  const req = E.readRequest(JSON.stringify({
    TableName: 'Orders', Key: { pk: { S: 'o#1' } }, UpdateExpression: 'SET #st = :s', ConditionExpression: 'attribute_exists(pk)',
    ExpressionAttributeNames: { '#st': 'status' }, ExpressionAttributeValues: { ':s': { S: 'shipped' } }
  }));
  assert.equal(req.operation, 'UpdateItem');
  assert.equal(req.UpdateExpression, 'SET #st = :s');
  assert.equal(req.TableName, 'Orders');
  const res = E.run(Object.assign(req, { item: readItem({ pk: { S: 'o#1' }, status: { S: 'new' } }), keySchema: { partition: { name: 'pk', type: 'S' } } }));
  assert.equal(res.error, null);
  assert.equal(res.after.get('status').v, 'shipped');
});

test('plain values are read the way the document clients write them', () => {
  const res = E.run({
    operation: 'Scan', FilterExpression: 'price < :max AND contains(tags, :t)',
    ExpressionAttributeValues: { ':max': 20, ':t': 'red' },
    items: [readItem({ pk: { S: 'a' }, price: { N: '15' }, tags: { SS: ['red', 'big'] } }), readItem({ pk: { S: 'b' }, price: { N: '25' }, tags: { SS: ['red'] } })]
  });
  assert.equal(res.error, null);
  assert.deepEqual(res.items.map((x) => x.match), [true, false]);
});
