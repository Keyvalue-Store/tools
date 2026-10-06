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

// ---- The command line, the README's samples, and how requests are read ----

const { spawnSync } = require('node:child_process');
const os = require('node:os');
const CLI = path.join(__dirname, '..', 'cli.js');
// Runs the command line; returns its exit status and what it printed.
function cli(args, input) {
  const r = spawnSync(process.execPath, [CLI].concat(args), { input: input, encoding: 'utf8' });
  return { status: r.status, out: r.stdout, err: r.stderr };
}
const parsed = (x) => E.parseJson(JSON.stringify(x));
// Parsed JSON back to JSON text.
const text = (v) => JSON.stringify(v, (k, x) => x instanceof Map ? Object.fromEntries(x) : x instanceof E.JsonNumber ? Number(x.text) : x);
const unwrap = (list, op, schema) => E.unwrapItems(list.map(parsed), op, schema).map(text);
const PK = { partition: { name: 'pk', type: 'S' } };

test('the output of aws dynamodb scan, query and get-item is unwrapped, and only that', () => {
  const page = { Items: [{ pk: { S: 'a' } }, { pk: { S: 'b' } }], Count: 2, ScannedCount: 2 };
  assert.equal(unwrap([page], 'Scan').length, 2);
  assert.equal(unwrap([page], 'Query', PK).length, 2);
  // The SDK's output, with $metadata, and several pages one after another.
  assert.equal(unwrap([Object.assign({ $metadata: { httpStatusCode: 200 } }, page), page], 'Scan').length, 4);
  // An export to S3: {"Item": {...}} on each line.
  assert.deepEqual(unwrap([{ Item: { pk: { S: 'a' } } }, { Item: { pk: { S: 'b' } } }], 'Scan'), ['{"pk":{"S":"a"}}', '{"pk":{"S":"b"}}']);
  // Items, Count and the rest only wrap items in a Query or Scan.
  assert.deepEqual(unwrap([page], 'UpdateItem'), [JSON.stringify(page)]);
  // An item with an attribute named Items is an item.
  const order = { pk: 'o#1', sk: 'order', Items: [{ sku: 'a', qty: 1 }] };
  assert.deepEqual(unwrap([order], 'UpdateItem', PK), [JSON.stringify(order)]);
  assert.deepEqual(unwrap([order], 'Scan'), [JSON.stringify(order)]);
  assert.deepEqual(unwrap([{ Items: [{ sku: 'a' }], Count: 1 }], 'Scan', { partition: { name: 'Items', type: 'S' } }), ['{"Items":[{"sku":"a"}],"Count":1}']);
  // get-item output for the item operations, with or without ConsumedCapacity.
  assert.deepEqual(unwrap([{ Item: { pk: { S: 'a' } }, ConsumedCapacity: { CapacityUnits: 0.5 } }], 'UpdateItem'), ['{"pk":{"S":"a"}}']);
  assert.deepEqual(unwrap([{ Item: { pk: 'a', qty: 1 } }], 'GetItem', PK), ['{"pk":"a","qty":1}']);
  // An item whose only attribute is a map named Item stays as it is, typed or plain.
  assert.equal(unwrap([{ Item: { sku: 'a', qty: 1 } }], 'UpdateItem', PK)[0], '{"Item":{"sku":"a","qty":1}}');
  assert.equal(unwrap([{ Item: { M: { sku: { S: 'a' } } } }], 'UpdateItem')[0], '{"Item":{"M":{"sku":{"S":"a"}}}}');
  // So does one whose key is named Item.
  assert.equal(unwrap([{ Item: { pk: { S: 'a' } } }], 'UpdateItem', { partition: { name: 'Item', type: 'S' } })[0], '{"Item":{"pk":{"S":"a"}}}');

  // The command line reads scan output too.
  const scan = JSON.stringify({ Items: [{ pk: { S: 'a' }, st: { S: 'new' } }, { pk: { S: 'b' }, st: { S: 'old' } }], Count: 2, ScannedCount: 2 });
  const r = cli(['--filter', 'st = :s', '--values', '{":s":"new"}', '--items', '-'], scan);
  assert.equal(r.status, 0);
  assert.match(r.out, /^1 of 2 items returned:$/m);
});

test('parentheses nested too deep for the tester give an error result, not a crash', () => {
  const values = { ':v': { N: '1' } };
  const deep = E.check({ operation: 'Scan', FilterExpression: '('.repeat(1300) + 'a = ', ExpressionAttributeValues: values, typed: true });
  assert.equal(deep.error.type, 'TesterLimit');
  assert.equal(deep.error.code, 'too-deep');
  assert.equal(deep.error.expression, 'FilterExpression');
  assert.deepEqual([deep.error.start, deep.error.end], [E.MAX_DEPTH, E.MAX_DEPTH + 1]);
  assert.match(E.explain(deep.error), /limit of the tester/);
  const key = E.run({ operation: 'Query', KeyConditionExpression: '('.repeat(2000) + 'pk = :v' + ')'.repeat(2000), ExpressionAttributeValues: { ':v': { S: 'a' } }, typed: true, items: [] });
  assert.equal(key.error.type, 'TesterLimit');
  assert.equal(key.error.expression, 'KeyConditionExpression');
  assert.equal(E.check({ operation: 'Scan', FilterExpression: '('.repeat(4090) + 'a=', ExpressionAttributeValues: values, typed: true }).error.type, 'TesterLimit');
  // Up to the limit, DynamoDB's own answers, as before.
  const most = E.check({ operation: 'Scan', FilterExpression: '('.repeat(E.MAX_DEPTH) + 'a = :v', ExpressionAttributeValues: values, typed: true });
  assert.equal(most.error.message, 'Invalid FilterExpression: Syntax error; token: "<EOF>", near: ":v"');
  const not = E.check({ operation: 'Scan', FilterExpression: 'NOT('.repeat(E.MAX_DEPTH) + 'a = :v' + ')'.repeat(E.MAX_DEPTH), ExpressionAttributeValues: values, typed: true });
  assert.equal(not.error, null);
  // The command line says it's the tester's limit, and exits with 2.
  const r = cli(['--filter', '('.repeat(500) + 'a = :v', '--values', '{":v": 1}']);
  assert.equal(r.status, 2);
  assert.match(r.out, /^The tester can't check this Scan:/);
});

test('key rule errors say which expression they are in, and where', () => {
  const values = { ':p': { S: 'a' }, ':s': { S: 'b' } };
  const schema = { partition: { name: 'pk', type: 'S' }, sort: { name: 'sk', type: 'S' } };
  const key = (expr, extra) => E.check(Object.assign({ operation: 'Query', KeyConditionExpression: expr, ExpressionAttributeValues: values, typed: true, keySchema: schema }, extra)).error;
  let e = key('pk = :p OR sk = :s');
  assert.deepEqual([e.message, e.expression, e.start, e.end], ['Invalid operator used in KeyConditionExpression: OR', 'KeyConditionExpression', 8, 10]);
  e = key('pk = :p AND sk = :s AND sk = :s');
  assert.deepEqual([e.code, e.expression, e.start, e.end], ['key-twice', 'KeyConditionExpression', 24, 31]);
  e = key('pk = :p AND v = :s');
  assert.deepEqual([e.code, e.expression, e.start, e.end], ['key-missing', 'KeyConditionExpression', 12, 18]);
  e = key('pk = :s AND sk = :p', { ExpressionAttributeValues: { ':p': { S: 'a' }, ':s': { N: '1' } } });
  assert.deepEqual([e.code, e.expression, e.start, e.end], ['key-type', 'KeyConditionExpression', 5, 7]);
  e = key('pk = :p', { FilterExpression: 'sk = :s' });
  assert.deepEqual([e.code, e.expression, e.start, e.end], ['filter-key', 'FilterExpression', 0, 2]);
  e = E.check({ operation: 'Scan', FilterExpression: 'pk.x = :p', ExpressionAttributeValues: { ':p': { S: 'a' } }, typed: true, keySchema: schema }).error;
  assert.deepEqual([e.code, e.expression, e.start, e.end], ['key-scalar', 'FilterExpression', 0, 4]);
  e = E.run({ operation: 'UpdateItem', UpdateExpression: 'SET a = :p, pk = :s', ExpressionAttributeValues: values, typed: true, keySchema: schema, item: null }).error;
  assert.deepEqual([e.code, e.expression, e.start, e.end], ['key-update', 'UpdateExpression', 12, 14]);
  // The command line's JSON names the expression.
  const r = cli(['--key-condition', 'pk = :p OR sk = :s', '--values', '{":p":"a",":s":"b"}', '--key', 'pk:S,sk:S', '--json']);
  assert.equal(JSON.parse(r.out).error.expression, 'KeyConditionExpression');
});

test('the operation is told from Key, Item and the other fields, and names are read in any case', () => {
  const read = (x) => E.readRequest(JSON.stringify(Object.assign({ TableName: 'T' }, x))).operation;
  assert.equal(read({ Key: { pk: { S: 'a' } }, ConditionExpression: 'attribute_exists(pk)' }), 'DeleteItem');
  assert.equal(read({ Key: { pk: { S: 'a' } }, ReturnValues: 'ALL_OLD' }), 'DeleteItem');
  assert.equal(read({ Key: { pk: { S: 'a' } }, ProjectionExpression: 'a' }), 'GetItem');
  assert.equal(read({ ProjectionExpression: 'a, b' }), 'Scan');
  assert.equal(read({ Item: { pk: { S: 'a' } }, ConditionExpression: 'attribute_not_exists(pk)' }), 'PutItem');
  assert.equal(read({ Key: { pk: { S: 'a' } }, UpdateExpression: 'SET a = :v' }), 'UpdateItem');
  assert.equal(read({ KeyConditionExpression: 'pk = :p' }), 'Query');
  assert.equal(E.guessOperation({ ProjectionExpression: 'a', item: null }), 'GetItem');
  assert.equal(E.guessOperation({ ProjectionExpression: 'a', items: [] }), 'Scan');
  assert.equal(E.operationName('scan'), 'Scan');
  assert.equal(E.operationName('get-item'), 'GetItem');
  assert.equal(E.operationName('UPDATE_ITEM'), 'UpdateItem');
  assert.throws(() => E.operationName('Scna'), E.InputError);
  assert.equal(E.check({ operation: 'deleteitem', ConditionExpression: 'a = :v', ExpressionAttributeValues: { ':v': 1 } }).operation, 'DeleteItem');
  assert.throws(() => E.check({ operation: 'Select', FilterExpression: 'a = :v' }), /Unknown operation "Select"/);
  // The command line: a projection with --items is a Scan, and a name it doesn't know is an error.
  let r = cli(['--projection', 'x', '--items', '-'], '[{"pk": "a", "x": 1}, {"pk": "b", "x": 2}]');
  assert.match(r.out, /^DynamoDB accepts this Scan\.\n2 of 2 items returned:/);
  r = cli(['--operation', 'scan', '--filter', 'a = :v', '--values', '{":v": 1}']);
  assert.match(r.out, /^DynamoDB accepts this Scan\./);
  r = cli(['--operation', 'Scna', '--filter', 'a = :v', '--values', '{":v": 1}']);
  assert.equal(r.status, 2);
  assert.match(r.err, /Unknown operation "Scna"/);
});

test('a query is in sort key order only when the sort key is known', () => {
  const items = [{ pk: 'a', sk: 3 }, { pk: 'a', sk: 1 }, { pk: 'a', sk: 2 }];
  const query = (keySchema) => E.run({ operation: 'Query', KeyConditionExpression: 'pk = :p', ExpressionAttributeValues: { ':p': 'a' }, ScanIndexForward: false,
    keySchema: keySchema, items: items.map((x) => E.readItem(parsed(x))) });
  let res = query(PK);
  assert.equal(res.order, undefined);
  assert.deepEqual(res.items.map((x) => x.index), [0, 1, 2]);
  res = query({ partition: { name: 'pk', type: 'S' }, sort: { name: 'sk', type: 'N' } });
  assert.equal(res.order, 'descending');
  assert.deepEqual(res.items.map((x) => x.index), [0, 2, 1]);
  const r = cli(['--key-condition', 'pk = :p', '--values', '{":p":"a"}', '--items', '-', '--reverse'], JSON.stringify(items));
  assert.match(r.out, /3 of 3 items returned, in the order given, since --key names no sort key:\n {2}\{pk: "a", sk: 3\}\n {2}\{pk: "a", sk: 1\}/);
  const sorted = cli(['--key-condition', 'pk = :p', '--values', '{":p":"a"}', '--items', '-', '--reverse', '--key', 'pk:S,sk:N'], JSON.stringify(items));
  assert.match(sorted.out, /3 of 3 items returned, in descending sort key order:\n {2}\{pk: "a", sk: 3\}\n {2}\{pk: "a", sk: 2\}/);
});

test('names DynamoDB can\'t read as one name get one placeholder each', () => {
  let r = E.escapeNames('first-name = :v AND _id = :i AND @timestamp > :t AND größe > :g');
  assert.equal(r.expression, '#first_name = :v AND #_id = :i AND #_timestamp > :t AND #gr__e > :g');
  assert.deepEqual(r.names, { '#first_name': 'first-name', '#_id': '_id', '#_timestamp': '@timestamp', '#gr__e': 'größe' });
  // In a path, inside a function, and in the paths of an update.
  assert.equal(E.escapeNames('a.b-c = :v AND attribute_exists(e-mail)').expression, 'a.#b_c = :v AND attribute_exists(#e_mail)');
  r = E.escapeNames('SET first-name = :v, total = price-tax REMOVE e-mail ADD visit-count :one');
  assert.equal(r.expression, 'SET #first_name = :v, #total = price-tax REMOVE #e_mail ADD #visit_count :one');
  // In a SET value a dash is a minus: only the reserved words change.
  assert.equal(E.escapeNames('SET a = first-name').expression, 'SET a = #first-#name');
  assert.equal(E.escapeNames('SET a = if_not_exists(first-name, :z)').expression, 'SET a = if_not_exists(#first_name, :z)');
  // Spaces, placeholders, numbers and operators that aren't DynamoDB's stay as written.
  for (const same of ['price - discount > :v', 'n != :v', 'a!=:v', 'x = 5', 'l[01] = :v', '#a-b = :v']) assert.equal(E.escapeNames(same).expression, same);
  // The rewritten expression reads, and the placeholders stand for the names.
  const filter = E.escapeNames('first-name = :v AND _id = :i');
  const res = E.run({ operation: 'Scan', FilterExpression: filter.expression, ExpressionAttributeNames: filter.names, ExpressionAttributeValues: { ':v': 'Ana', ':i': 7 },
    items: [E.readItem(parsed({ 'first-name': 'Ana', _id: 7 })), E.readItem(parsed({ 'first-name': 'Bo', _id: 7 }))] });
  assert.equal(res.error, null);
  assert.deepEqual(res.items.map((x) => x.match), [true, false]);
});

test('the Key and Item of a request are read, so a new item starts with its key', () => {
  const text = JSON.stringify({ TableName: 'T', Key: { pk: { S: 'o#1' } }, UpdateExpression: 'SET a = :v', ExpressionAttributeValues: { ':v': { S: 'x' } } });
  const req = E.readRequest(text);
  assert.equal(req.key.get('pk').v, 'o#1');
  const res = E.run(Object.assign(req, { item: null, keySchema: PK }));
  assert.deepEqual([...res.after.keys()], ['pk', 'a']);
  // A request built by hand, with Key as JSON.
  const byHand = E.run({ Key: { pk: { S: 'o#2' } }, UpdateExpression: 'SET a = :v', ExpressionAttributeValues: { ':v': { S: 'x' } }, item: null });
  assert.equal(byHand.after.get('pk').v, 'o#2');
  // A PutItem gives its item back.
  const put = E.run(E.readRequest(JSON.stringify({ TableName: 'T', Item: { pk: { S: 'o#3' }, qty: { N: '2' } } })));
  assert.equal(put.operation, 'PutItem');
  assert.equal(put.after.get('qty').t, 'N');
  // A Key that isn't valid is an input problem, named as the Key.
  assert.throws(() => E.readRequest(JSON.stringify({ TableName: 'T', Key: { pk: { N: 'abc' } }, UpdateExpression: 'SET a = :v' })),
    { name: 'InputError', message: 'Key attribute pk: A value provided cannot be converted into a number' });
});

test('the samples in the README run as written', { skip: process.platform === 'win32' && 'needs a POSIX shell' }, () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const blocks = (lang) => [...readme.matchAll(new RegExp('```' + lang + '\\n([\\s\\S]*?)```', 'g'))].map((m) => m[1]);
  // A folder with the files the samples name, and the tool where the samples look for it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'expressions-readme-'));
  try {
    fs.symlinkSync(path.join(__dirname, '..'), path.join(dir, 'expressions'), 'dir');
    const write = (name, x) => fs.writeFileSync(path.join(dir, name), JSON.stringify(x));
    // The code sample: an update of the item it gives.
    write('request.json', { TableName: 'Orders', Key: { pk: { S: 'o#1' } }, UpdateExpression: 'SET qty = qty + :one', ExpressionAttributeValues: { ':one': { N: '1' } } });
    const js = blocks('js');
    assert.equal(js.length, 1);
    // From a file: node -e would lend it fs and the other modules.
    fs.writeFileSync(path.join(dir, 'sample.js'), js[0] + '\nif (r.error || X.numberText(r.after.get("qty").v) !== "2") throw new Error("unexpected result");\n');
    const run = spawnSync(process.execPath, ['sample.js'], { cwd: dir, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    // The command lines: a query over items, an update, a scan's output and escaping.
    write('request.json', { TableName: 'Orders', KeyConditionExpression: 'pk = :pk AND sk > :n', ExpressionAttributeValues: { ':pk': { S: 'c#9' }, ':n': { N: '1' } } });
    write('items.json', [{ pk: { S: 'c#9' }, sk: { N: '2' } }, { pk: { S: 'c#9' }, sk: { N: '1' } }]);
    write('item.json', { pk: { S: 'user#42' }, visits: { N: '7' } });
    write('scan-output.json', { Items: [{ pk: { S: 'a' }, status: { S: 'new' } }], Count: 1, ScannedCount: 1 });
    const lines = blocks('sh').join('\n').split('\n').filter((l) => l.startsWith('node expressions/cli.js'));
    assert.equal(lines.length, 4);
    for (const line of lines) {
      const sh = spawnSync('sh', ['-c', line], { cwd: dir, encoding: 'utf8' });
      // 0 or 1 is DynamoDB's answer; 2 would be a problem with the sample itself.
      assert.ok(sh.status === 0 || sh.status === 1, line + '\n' + sh.stdout + sh.stderr);
      assert.match(sh.stdout, /^(DynamoDB|#)/, line);
    }
    // The test command names a file that is there.
    const tests = blocks('sh').join('\n').split('\n').filter((l) => l.startsWith('node --test'));
    assert.equal(tests.length, 1);
    assert.ok(fs.existsSync(path.join(dir, tests[0].slice('node --test '.length))), tests[0]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
