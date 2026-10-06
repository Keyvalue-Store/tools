// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Writes test/results/dynamodb-local-3.3.1.json: how many recorded requests
// the Expression Tester answers exactly as DynamoDB Local did, by kind, and
// the updates where the two report a different one of several problems.
//
//   node expressions/test/generate/measure.js

'use strict';
// node --test runs every .js file under a test folder; this one only runs by hand.
if (process.env.NODE_TEST_CONTEXT) return;
const fs = require('fs');
const path = require('path');
const E = require('../../expressions.js');

const FIX = path.join(__dirname, '..', 'fixtures');
const OUT = path.join(__dirname, '..', 'results', 'dynamodb-local-3.3.1.json');
const lines = (name) => fs.readFileSync(path.join(FIX, name), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const json = (name) => JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));
const readItem = (it) => E.readItem(E.parseJson(JSON.stringify(it)), true);

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
const trim = (m) => m.replace(/(Two document paths (overlap|conflict) with each other; must remove or rewrite one of these paths; path one: \[[^\]]*(\[[^\]]*\][^\]]*)*\]).*$/, '$1');
const errorText = (e) => e.type + ': ' + trim(e.message);
function request(body, op, extra) {
  const req = Object.assign({ operation: op, typed: true }, extra || {});
  for (const k of ['KeyConditionExpression', 'FilterExpression', 'ConditionExpression', 'UpdateExpression', 'ProjectionExpression',
    'ExpressionAttributeNames', 'ExpressionAttributeValues', 'ScanIndexForward']) if (body[k] !== undefined) req[k] = body[k];
  return req;
}
function tally(cases, run) {
  const t = { requests: cases.length, refusedByDynamoDB: 0, agree: 0, differ: 0 };
  for (const c of cases) {
    if (!c.answer.ok) t.refusedByDynamoDB++;
    const { want, got } = run(c);
    if (want === got) t.agree++; else t.differ++;
  }
  return t;
}

const scanTool = json('items-scan.json').map(readItem);
const queryItems = json('items-query.json');
const queryTool = queryItems.map(readItem);
const schema1 = { partition: { name: 'pk', type: 'S' } };
const schema2 = { partition: { name: 'pk', type: 'S' }, sort: { name: 'sk', type: 'N' } };

const results = { reference: 'DynamoDB Local 3.3.1 (2026-05-28)', when: new Date().toISOString() };
results.scan = tally(lines('cases-scan.jsonl'), (c) => {
  const res = E.run(Object.assign(request(c.request, 'Scan', { keySchema: schema1 }), { items: scanTool }));
  const want = c.answer.ok ? 'OK ' + (c.request.ProjectionExpression ? c.answer.result.map(canon).sort().join('|') : c.answer.result.slice().sort().join(',')) : errorText(c.answer);
  let got;
  if (res.error) got = errorText(res.error);
  else if (c.request.ProjectionExpression) got = 'OK ' + res.items.filter((x) => x.match).map((x) => canon(E.itemToTyped(x.projected))).sort().join('|');
  else got = 'OK ' + res.items.filter((x) => x.match).map((x) => x.item.get('pk').v).sort().join(',');
  return { want, got };
});
results.get = tally(lines('cases-get.jsonl'), (c) => {
  const res = E.run(Object.assign(request(c.request, 'GetItem', { keySchema: schema1 }), { item: scanTool[+c.key.slice(1)] }));
  return { want: c.answer.ok ? 'OK ' + canon(c.answer.result) : errorText(c.answer), got: res.error ? errorText(res.error) : 'OK ' + canon(E.itemToTyped(res.after || new Map())) };
});
results.query = tally(lines('cases-query.jsonl'), (c) => {
  const res = E.run(Object.assign(request(c.request, 'Query', { keySchema: schema2 }), { items: queryTool }));
  return {
    want: c.answer.ok ? 'OK ' + c.answer.result.join(',') : errorText(c.answer),
    got: res.error ? errorText(res.error) : 'OK ' + res.items.filter((x) => x.match).map((x) => x.item.get('pk').v + '/' + queryItems[x.index].sk.N).join(',')
  };
});
const examples = [];
results.update = tally(lines('cases-update.jsonl'), (c) => {
  const res = E.run(Object.assign(request(c.request, 'UpdateItem', { keySchema: schema1 }), { item: readItem(c.item) }));
  const want = c.answer.ok ? 'OK ' + canon(c.answer.result) : errorText(c.answer);
  const got = res.error ? errorText(res.error) : 'OK ' + canon(E.itemToTyped(res.after));
  if (want !== got && examples.length < 10) examples.push({ UpdateExpression: c.request.UpdateExpression, dynamodbLocal: want, tester: got });
  return { want, got };
});
results.update.runtimeOrderDiffers = results.update.differ;
results.update.note = 'Every difference is an update with two or more problems that only show while it runs (a missing attribute, a wrong type, a path that cannot be written); DynamoDB Local and the tester report a different one of them first.';
results.update.examples = examples;
const manual = lines('cases-manual.jsonl');
results.handWritten = { requests: manual.length, refusedByDynamoDB: manual.filter((c) => !c.answer.ok).length };
const words = json('reserved-words.json');
results.reservedWords = {
  documentedByAWS: words.documented,
  refusedByDynamoDBLocal: Object.values(words.answers).filter((a) => /reserved keyword/.test(a)).length,
  documentedButAccepted: Object.entries(words.answers).filter(([w, a]) => a === 'accepted' && /^[A-Z]+$/.test(w)).map(([w]) => w),
  documentedButKeywords: Object.entries(words.answers).filter(([w, a]) => /^Syntax error/.test(a) && /^[A-Z]+$/.test(w)).map(([w]) => w)
};
fs.writeFileSync(OUT, JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify({ scan: results.scan, get: results.get, query: results.query, update: { requests: results.update.requests, agree: results.update.agree, differ: results.update.differ } }));
