// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Records what DynamoDB Local answers to thousands of requests, for the
// tests to replay against the Expression Tester. Most requests are made up
// by a seeded random generator, so every run sends the same ones; the rest
// are written by hand to pin down particular rules. Needs DynamoDB Local
// running on DDB_PORT (8000 by default):
//
//   java -Djava.library.path=./DynamoDBLocal_lib -jar DynamoDBLocal.jar -inMemory -port 8000
//   node expressions/test/generate/record.js
//
// Writes test/fixtures/items-*.json, cases-*.jsonl and reserved-words.json.

'use strict';
// node --test runs every .js file under a test folder; this one only runs by hand.
if (process.env.NODE_TEST_CONTEXT) return;
const fs = require('fs');
const path = require('path');
const { call, table } = require('./dynamodb-local.js');
const E = require('../../expressions.js');

const FIX = path.join(__dirname, '..', 'fixtures');

// ---- seeded randomness (mulberry32) ----
let seed = 20261006;
function rand() {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (a) => a[Math.floor(rand() * a.length)];
const chance = (p) => rand() < p;
const int = (n) => Math.floor(rand() * n);

// ---- values and items ----
const STRINGS = ['', 'a', 'b', 'ab', 'abc', 'A', 'z', 'Zed', 'é', 'héllo', '😀', '｡', '¿', 'a b', 'x'.repeat(20), '10', '2', 'abcdef'];
const NUMBERS = ['0', '1', '-1', '2', '10', '1.5', '-0.25', '100', '1e3', '0.001', '99999999999999999999999999999999999999', '1E-130', '9.9E125', '-7', '3', '3.0', '42'];
const BINS = ['AA==', 'AQ==', 'AAE=', '/w==', 'AQID', 'YWJj', 'YQ=='];
function scalar() {
  const t = pick(['S', 'S', 'N', 'N', 'B', 'BOOL', 'NULL']);
  if (t === 'S') return { S: pick(STRINGS) };
  if (t === 'N') return { N: pick(NUMBERS) };
  if (t === 'B') return { B: pick(BINS) };
  if (t === 'BOOL') return { BOOL: chance(0.5) };
  return { NULL: true };
}
function uniq(list) { return [...new Set(list)]; }
function value(depth) {
  const r = rand();
  if (depth > 2 || r < 0.55) return scalar();
  if (r < 0.65) return { SS: uniq(Array.from({ length: 1 + int(3) }, () => pick(STRINGS.filter(Boolean)))) };
  if (r < 0.72) return { NS: uniq(Array.from({ length: 1 + int(3) }, () => pick(['1', '2', '3', '10', '-1', '0.5']))) };
  if (r < 0.76) return { BS: uniq(Array.from({ length: 1 + int(2) }, () => pick(BINS))) };
  if (r < 0.88) return { L: Array.from({ length: int(4) }, () => value(depth + 1)) };
  const m = {};
  for (let i = 0; i < int(4); i++) m[pick(['x', 'y', 'z', 'a', 'n', 'inner_', 'k'])] = value(depth + 1);
  return { M: m };
}
const ATTRS = ['a', 'b', 'c', 'n', 's', 'l', 'm', 'ss', 'ns', 'bs', 'nm', 'tags', 'price', 'title', 'data2'];
function item(pk, sk) {
  const it = { pk: { S: pk } };
  if (sk !== undefined) it.sk = sk;
  for (const a of ATTRS) if (chance(0.55)) it[a] = value(0);
  if (chance(0.5)) it.m = { M: { x: value(1), y: { M: { z: value(2) } }, k: scalar() } };
  if (chance(0.5)) it.l = { L: [value(1), value(1), { M: { x: scalar() } }] };
  if (chance(0.3)) it.n = { N: pick(NUMBERS) };
  if (chance(0.3)) it.s = { S: pick(STRINGS) };
  return it;
}

// ---- expressions ----
class Ctx {
  constructor() { this.names = {}; this.values = {}; this.vn = 0; this.nn = 0; }
  val(v) { const k = ':v' + (this.vn++); this.values[k] = v; return k; }
  name(n) { const k = '#n' + (this.nn++); this.names[k] = n; return k; }
}
function pathText(ctx) {
  const base = pick(ATTRS.concat(['zz', 'status', 'name', 'data', 'count', 'size', 'value', 'pk']));
  let p = (chance(0.25) || (['status', 'name', 'data', 'count', 'value'].includes(base) && chance(0.7))) ? ctx.name(base) : base;
  const steps = chance(0.35) ? 1 + int(2) : 0;
  for (let i = 0; i < steps; i++) {
    if (chance(0.5)) p += '[' + pick(['0', '1', '2', '5']) + ']';
    else p += '.' + (chance(0.2) ? ctx.name(pick(['x', 'y', 'z'])) : pick(['x', 'y', 'z', 'k']));
  }
  return p;
}
function operand(ctx, opts) {
  const r = rand();
  if (r < 0.45) return pathText(ctx);
  if (r < 0.88) return ctx.val(opts && opts.scalar ? scalar() : (chance(0.85) ? scalar() : value(1)));
  return 'size(' + pathText(ctx) + ')';
}
function condition(ctx, depth) {
  const r = rand();
  if (depth < 3 && r < 0.25) return condition(ctx, depth + 1) + pick([' AND ', ' OR ', ' and ']) + condition(ctx, depth + 1);
  if (depth < 3 && r < 0.32) return 'NOT ' + condition(ctx, depth + 1);
  if (depth < 3 && r < 0.4) return '(' + condition(ctx, depth + 1) + ')';
  const k = rand();
  if (k < 0.45) return operand(ctx) + ' ' + pick(['=', '<>', '<', '<=', '>', '>=']) + ' ' + operand(ctx);
  if (k < 0.55) return operand(ctx) + ' BETWEEN ' + operand(ctx, { scalar: true }) + ' AND ' + operand(ctx, { scalar: true });
  if (k < 0.62) return operand(ctx) + ' IN (' + Array.from({ length: 1 + int(3) }, () => operand(ctx)).join(', ') + ')';
  const f = pick(['attribute_exists', 'attribute_not_exists', 'attribute_type', 'begins_with', 'contains', 'begins_with', 'contains']);
  if (f === 'attribute_exists' || f === 'attribute_not_exists') return f + '(' + pathText(ctx) + ')';
  if (f === 'attribute_type') return f + '(' + pathText(ctx) + ', ' + ctx.val({ S: pick(['S', 'N', 'L', 'M', 'SS', 'NS', 'BS', 'B', 'BOOL', 'NULL', 'X']) }) + ')';
  if (f === 'begins_with') return f + '(' + pathText(ctx) + ', ' + ctx.val(chance(0.85) ? { S: pick(STRINGS) } : scalar()) + ')';
  return f + '(' + pathText(ctx) + ', ' + operand(ctx) + ')';
}
const STRAYS = ['(', ')', ',', 'AND', 'OR', 'NOT', '=', '<', ':v0', '#n0', '!', '-', '[', ']', '.', '1', 'size', 'foo(a)', 'BETWEEN', 'IN', '((', '))', '_', 'status', ' ', 'Size(a)', '+'];
function mutate(text) {
  const toks = E.tokenize(text).filter((t) => t.t !== 'EOF');
  if (!toks.length) return text;
  const r = rand();
  const t = pick(toks);
  if (r < 0.35) return text.slice(0, t.start) + text.slice(t.end);
  if (r < 0.75) return text.slice(0, t.start) + pick(STRAYS) + ' ' + text.slice(t.start);
  if (r < 0.9) return text.slice(0, t.end) + ' ' + pick(STRAYS) + text.slice(t.end);
  return text.slice(0, t.start) + pick(STRAYS) + text.slice(t.end);
}
function finishMaps(ctx, body, noValues) {
  if (chance(0.06)) ctx.values[':unused' + int(9)] = scalar();
  if (chance(0.05)) ctx.names['#unused' + int(9)] = 'q';
  if (chance(0.04)) { const k = Object.keys(ctx.values)[0]; if (k) delete ctx.values[k]; }
  if (chance(0.03)) { const k = Object.keys(ctx.names)[0]; if (k) delete ctx.names[k]; }
  if (chance(0.03)) { const k = Object.keys(ctx.values)[0]; if (k) ctx.values[k] = pick([{ N: 'abc' }, { SS: [] }, { NS: ['1', '1.0'] }, { SS: ['a', 'a'] }, { N: '1E+200' }, {}, { S: 'x', N: '1' }, { NULL: false }]); }
  if (Object.keys(ctx.names).length) body.ExpressionAttributeNames = ctx.names;
  if (!noValues && Object.keys(ctx.values).length) body.ExpressionAttributeValues = ctx.values;
}
function updateExpr(ctx) {
  const clauses = [];
  const kinds = ['SET', 'REMOVE', 'ADD', 'DELETE'].filter(() => chance(0.45));
  if (!kinds.length) kinds.push('SET');
  for (const kw of kinds) {
    const acts = [];
    for (let i = 0, n = 1 + int(2); i < n; i++) {
      const p = pathText(ctx);
      if (kw === 'SET') {
        const r = rand();
        let v;
        if (r < 0.35) v = operand(ctx);
        else if (r < 0.55) v = operand(ctx) + pick([' + ', ' - ']) + operand(ctx);
        else if (r < 0.7) v = 'if_not_exists(' + pathText(ctx) + ', ' + operand(ctx) + ')';
        else if (r < 0.82) v = 'list_append(' + pick([pathText(ctx), ctx.val({ L: [scalar()] })]) + ', ' + pick([pathText(ctx), ctx.val({ L: [scalar(), scalar()] }), 'if_not_exists(' + pathText(ctx) + ', ' + ctx.val({ L: [] }) + ')']) + ')';
        else v = 'if_not_exists(' + pathText(ctx) + ', ' + operand(ctx) + ')' + pick([' + ', ' - ']) + operand(ctx);
        acts.push(p + ' = ' + v);
      } else if (kw === 'REMOVE') acts.push(p);
      else acts.push(p + ' ' + ctx.val(kw === 'ADD' ? pick([{ N: pick(NUMBERS) }, { SS: ['q', 'a'] }, { NS: ['1', '7'] }, { BS: ['AA=='] }, scalar()]) : pick([{ SS: ['a', 'q'] }, { NS: ['1'] }, { BS: ['AQ=='] }, scalar()])));
    }
    clauses.push(kw + ' ' + acts.join(', '));
  }
  if (chance(0.04)) clauses.push(pick(['SET a = ' + ctx.val(scalar()), 'REMOVE c']));
  return clauses.sort(() => rand() - 0.5).join(' ');
}

// ---- answers in a form the tests compare ----
function answer(r, shape) {
  if (!r.ok) return { ok: false, type: r.type, message: r.message };
  return { ok: true, result: shape(r.data) };
}

async function main() {
  const out = {};
  const write = (name, lines) => fs.writeFileSync(path.join(FIX, name), lines.map((x) => JSON.stringify(x)).join('\n') + '\n');

  // Scan: filters and projections over 25 items.
  await table('rec_scan', [['pk', 'S']]);
  const scanItems = Array.from({ length: 25 }, (_, i) => item('i' + i));
  for (const it of scanItems) await call('PutItem', { TableName: 'rec_scan', Item: it });
  fs.writeFileSync(path.join(FIX, 'items-scan.json'), JSON.stringify(scanItems, null, 0) + '\n');
  out.scan = [];
  for (let c = 0; c < 1500; c++) {
    const ctx = new Ctx();
    let ex = condition(ctx, 0);
    if (chance(0.25)) ex = mutate(ex);
    if (chance(0.03)) ex = '((' + ex + '))';
    const body = { FilterExpression: ex };
    if (chance(0.15)) body.ProjectionExpression = Array.from({ length: 1 + int(3) }, () => pathText(ctx)).join(', ');
    finishMaps(ctx, body);
    const r = await call('Scan', Object.assign({ TableName: 'rec_scan', ConsistentRead: true }, body));
    out.scan.push({ request: body, answer: answer(r, (d) => d.Items.map((i) => body.ProjectionExpression ? i : i.pk.S)) });
  }
  write('cases-scan.jsonl', out.scan);

  // GetItem with projections.
  out.get = [];
  for (let c = 0; c < 600; c++) {
    const ctx = new Ctx();
    const key = 'i' + int(25);
    const body = { ProjectionExpression: Array.from({ length: 1 + int(4) }, () => pathText(ctx)).join(', ') };
    if (chance(0.2)) body.ProjectionExpression = mutate(body.ProjectionExpression);
    finishMaps(ctx, body, true);
    const r = await call('GetItem', Object.assign({ TableName: 'rec_scan', Key: { pk: { S: key } } }, body));
    out.get.push({ request: body, key: key, answer: answer(r, (d) => d.Item || {}) });
  }
  write('cases-get.jsonl', out.get);

  // Query: key conditions over a table with a sort key.
  await table('rec_query', [['pk', 'S'], ['sk', 'N']]);
  const seen = new Set();
  const queryItems = [];
  for (let i = 0; i < 30; i++) {
    const it = item(pick(['p', 'q', 'r']), { N: String(int(20) - 5) + (chance(0.2) ? '.5' : '') });
    const k = it.pk.S + '/' + it.sk.N;
    if (seen.has(k)) continue;
    seen.add(k);
    queryItems.push(it);
    await call('PutItem', { TableName: 'rec_query', Item: it });
  }
  fs.writeFileSync(path.join(FIX, 'items-query.json'), JSON.stringify(queryItems, null, 0) + '\n');
  out.query = [];
  for (let c = 0; c < 1200; c++) {
    const ctx = new Ctx();
    const P = ctx.val({ S: pick(['p', 'q', 'r', 'p', 'zz', '']) });
    const skp = chance(0.15) ? ctx.name('sk') : 'sk';
    const pkp = chance(0.15) ? ctx.name('pk') : 'pk';
    const parts = [chance(0.92) ? pkp + ' = ' + P : pick([pkp + ' > ' + P, skp + ' = ' + P, 'n = ' + P])];
    if (chance(0.7)) {
      const v = () => ctx.val(chance(0.9) ? { N: String(int(20) - 5) } : pick([{ S: '1' }, scalar()]));
      parts.push(pick([skp + ' = ' + v(), skp + ' < ' + v(), skp + ' <= ' + v(), skp + ' > ' + v(), skp + ' >= ' + v(), skp + ' BETWEEN ' + v() + ' AND ' + v(),
        'begins_with(' + skp + ', ' + v() + ')', v() + ' < ' + skp, skp + ' <> ' + v(), 'size(' + skp + ') > ' + v(), 'n > ' + v(), skp + ' IN (' + v() + ')', 'attribute_exists(' + skp + ')', 'NOT ' + skp + ' = ' + v()]));
    }
    if (chance(0.05)) parts.push(pkp + ' = ' + P);
    let ex = parts.sort(() => rand() - 0.5).join(pick([' AND ', ' AND ', ' OR ']));
    if (chance(0.1)) ex = '(' + ex + ')';
    if (chance(0.1)) ex = mutate(ex);
    const body = { KeyConditionExpression: ex, ScanIndexForward: chance(0.7) };
    if (chance(0.3)) body.FilterExpression = condition(ctx, 1);
    finishMaps(ctx, body);
    const r = await call('Query', Object.assign({ TableName: 'rec_query' }, body));
    out.query.push({ request: body, answer: answer(r, (d) => d.Items.map((i) => i.pk.S + '/' + i.sk.N)) });
  }
  write('cases-query.jsonl', out.query);

  // UpdateItem, sometimes with a condition, each on an item of its own.
  await table('rec_update', [['pk', 'S']]);
  out.update = [];
  for (let c = 0; c < 1500; c++) {
    const ctx = new Ctx();
    const it = item('u');
    await call('PutItem', { TableName: 'rec_update', Item: it });
    let ex = updateExpr(ctx);
    if (chance(0.15)) ex = mutate(ex);
    const body = { UpdateExpression: ex };
    if (chance(0.2)) body.ConditionExpression = condition(ctx, 1);
    finishMaps(ctx, body);
    const r = await call('UpdateItem', Object.assign({ TableName: 'rec_update', Key: { pk: { S: 'u' } }, ReturnValues: 'ALL_NEW' }, body));
    out.update.push({ request: body, item: it, answer: answer(r, (d) => d.Attributes) });
  }
  write('cases-update.jsonl', out.update);

  // Written by hand: one rule each.
  out.manual = [];
  const manual = require('./manual-cases.js');
  for (const m of manual) {
    if (m.table) await table('rec_manual', m.table);
    else await table('rec_manual', [['pk', 'S']]);
    if (m.item) await call('PutItem', { TableName: 'rec_manual', Item: m.item });
    for (const extra of m.items || []) await call('PutItem', { TableName: 'rec_manual', Item: extra });
    const body = Object.assign({ TableName: 'rec_manual' }, m.request);
    const r = await call(m.op, body);
    const shape = m.op === 'Scan' || m.op === 'Query' ? (d) => d.Items : m.op === 'GetItem' ? (d) => d.Item || {} : (d) => d.Attributes || {};
    out.manual.push({ note: m.note, op: m.op, table: m.table || [['pk', 'S']], request: m.request, item: m.item, items: m.items, answer: answer(r, shape) });
  }
  write('cases-manual.jsonl', out.manual);

  // Every word on AWS's list of reserved words, used as a name.
  await table('rec_words', [['pk', 'S']]);
  const documented = fs.readFileSync(path.join(__dirname, 'reserved-words-aws.txt'), 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
  const words = {};
  for (const w of documented.concat(['id', 'email', 'price', 'title', 'tags', 'version', 'remove'])) {
    const r = await call('Scan', { TableName: 'rec_words', FilterExpression: w + ' = :v', ExpressionAttributeValues: { ':v': { N: '1' } } });
    words[w] = r.ok ? 'accepted' : r.message.replace('Invalid FilterExpression: ', '');
  }
  fs.writeFileSync(path.join(FIX, 'reserved-words.json'), JSON.stringify({ documented: documented.length, answers: words }, null, 1) + '\n');
  console.log('Recorded', out.scan.length, 'scans,', out.get.length, 'gets,', out.query.length, 'queries,', out.update.length, 'updates,', out.manual.length, 'hand-written cases and', Object.keys(words).length, 'names.');
}

main().catch((e) => { console.error(e); process.exit(1); });
