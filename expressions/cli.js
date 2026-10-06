#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Command line for the Expression Tester. Run "node expressions/cli.js --help".

'use strict';
const fs = require('fs');
const E = require('./expressions.js');

const HELP = `Expression Tester: check DynamoDB expressions the way DynamoDB does, and run them on sample items.

Usage:
  node expressions/cli.js --request request.json [--items items.json | --item item.json] [--key pk:S,sk:N]
      The parameters of a Query, Scan, GetItem, PutItem, UpdateItem or DeleteItem call, as an SDK or
      "aws dynamodb ... --cli-input-json" takes them. Typed ({"S": "x"}) or plain values.

  Or give the parts one by one:
  --key-condition EXPR   KeyConditionExpression (a Query)
  --filter EXPR          FilterExpression (a Query or a Scan)
  --condition EXPR       ConditionExpression (PutItem, DeleteItem, or with --update)
  --update EXPR          UpdateExpression (UpdateItem)
  --projection EXPR      ProjectionExpression
  --names JSON|@FILE     ExpressionAttributeNames
  --values JSON|@FILE    ExpressionAttributeValues
  --operation NAME       Query, Scan, GetItem, PutItem, UpdateItem or DeleteItem, when the expressions
                         don't make it clear

  --items FILE           Items to query or scan: a JSON list, JSON Lines, or a DynamoDB export ("-" reads stdin)
  --item FILE            The item an update, condition or projection works on (leave out for a new item)
  --key NAME:TYPE[,NAME:TYPE]
                         The table's (or index's) partition key and sort key, such as pk:S,sk:N
  --typed / --plain      Read values and items as typed JSON or as plain JSON (default: decide by looking)
  --reverse              Return query results in descending sort key order (ScanIndexForward false)
  --escape EXPR          Rewrite reserved words in EXPR as #placeholders and print the names to add
  --json                 Print JSON

Exit status: 0 when DynamoDB would accept the request, 1 when it would refuse it or a condition fails,
2 for a problem with the input.`;

function readArg(v) {
  if (v === undefined) return undefined;
  if (v.startsWith('@')) return fs.readFileSync(v.slice(1), 'utf8');
  return v;
}
function readFile(name) { return fs.readFileSync(name === '-' ? 0 : name, 'utf8'); }

function parseKey(text) {
  const parts = String(text).split(',').map((s) => s.trim()).filter(Boolean);
  const one = (p) => {
    const m = /^(.+):(S|N|B)$/.exec(p);
    if (!m) throw new E.InputError('--key takes NAME:TYPE pairs such as pk:S,sk:N');
    return { name: m[1], type: m[2] };
  };
  return { partition: parts[0] ? one(parts[0]) : null, sort: parts[1] ? one(parts[1]) : null };
}

// DynamoDB's export to S3 writes {"Item": {...}} on each line.
function unwrapExport(list) { return list.map((x) => (x instanceof Map && x.size === 1 && x.has('Item') && x.get('Item') instanceof Map) ? x.get('Item') : x); }

function show(av) { return E.toPlainText(av); }
function itemText(item) { return '{' + [...item].map(([k, v]) => k + ': ' + show(v)).join(', ') + '}'; }

function main(argv) {
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new E.InputError(a + ' needs a value'); return argv[++i]; };
    if (a === '--help' || a === '-h') { console.log(HELP); return 0; }
    else if (a === '--request') opt.request = next();
    else if (a === '--key-condition') opt.KeyConditionExpression = next();
    else if (a === '--filter') opt.FilterExpression = next();
    else if (a === '--condition') opt.ConditionExpression = next();
    else if (a === '--update') opt.UpdateExpression = next();
    else if (a === '--projection') opt.ProjectionExpression = next();
    else if (a === '--names') opt.names = next();
    else if (a === '--values') opt.values = next();
    else if (a === '--operation') opt.operation = next();
    else if (a === '--items') opt.items = next();
    else if (a === '--item') opt.item = next();
    else if (a === '--key') opt.key = next();
    else if (a === '--typed') opt.typed = true;
    else if (a === '--plain') opt.typed = false;
    else if (a === '--reverse') opt.reverse = true;
    else if (a === '--escape') opt.escape = next();
    else if (a === '--json') opt.json = true;
    else { console.error('Unknown option ' + a + '. Try --help.'); return 2; }
  }

  if (opt.escape !== undefined) {
    const names = opt.names ? Object.fromEntries(E.parseJson(readArg(opt.names))) : undefined;
    const r = E.escapeNames(opt.escape, names);
    if (opt.json) console.log(JSON.stringify({ expression: r.expression, ExpressionAttributeNames: r.names }, null, 2));
    else {
      console.log(r.expression);
      console.log(JSON.stringify(r.names));
      if (!r.added.length) console.log('No reserved words to replace.');
    }
    return 0;
  }

  const req = opt.request ? E.readRequest(readFile(opt.request)) : {};
  for (const k of ['KeyConditionExpression', 'FilterExpression', 'ConditionExpression', 'UpdateExpression', 'ProjectionExpression']) if (opt[k] !== undefined) req[k] = opt[k];
  if (opt.names !== undefined) req.ExpressionAttributeNames = E.parseJson(readArg(opt.names));
  if (opt.values !== undefined) req.ExpressionAttributeValues = E.parseJson(readArg(opt.values));
  if (opt.operation) req.operation = opt.operation;
  else if (!opt.request) req.operation = undefined;
  if (opt.reverse) req.ScanIndexForward = false;
  if (opt.typed !== undefined) req.typed = opt.typed;
  if (opt.key) req.keySchema = parseKey(opt.key);
  if (!E.OPERATIONS[req.operation]) {
    const guess = E.check(Object.assign({}, req, { operation: undefined })).operation;
    req.operation = guess;
  }
  if (!['KeyConditionExpression', 'FilterExpression', 'ConditionExpression', 'UpdateExpression', 'ProjectionExpression'].some((k) => req[k] !== undefined)) {
    console.log(HELP);
    return 2;
  }
  if (opt.items) req.items = unwrapExport(E.parseJsonItems(readFile(opt.items))).map((x) => E.readItem(x, opt.typed));
  if (opt.item) req.item = E.readItem(E.parseJson(readFile(opt.item)), opt.typed);
  else if (req.Item instanceof Map && req.operation === 'PutItem') req.newItem = E.readItem(req.Item, opt.typed);
  if (req.Key instanceof Map) req.key = E.readItem(req.Key, opt.typed);

  const res = E.run(req);
  if (opt.json) {
    const out = { operation: res.operation, accepted: !res.error || res.error.type === 'ConditionalCheckFailedException' };
    if (res.error) out.error = { type: res.error.type, message: res.error.message, help: E.explain(res.error), expression: res.error.expression, start: res.error.start, end: res.error.end };
    if (res.items) out.items = res.items.filter((x) => x.match).map((x) => E.itemToTyped(x.projected || x.item));
    if (res.after) out.item = E.itemToTyped(res.after);
    if (res.changed) out.changed = res.changed.map((c) => ({ attribute: c.name, change: c.change }));
    console.log(JSON.stringify(out, null, 2));
  } else {
    if (res.error && res.error.type !== 'ConditionalCheckFailedException') {
      console.log('DynamoDB would refuse this ' + res.operation + ':');
      console.log('  ' + res.error.type + ': ' + res.error.message);
      const help = E.explain(res.error);
      if (help) console.log('\n' + help);
      return 1;
    }
    console.log('DynamoDB accepts this ' + res.operation + '.');
    if (res.error) {
      console.log('The condition is false for the item, so DynamoDB answers ConditionalCheckFailedException and changes nothing.');
      return 1;
    }
    if (res.items) {
      const hit = res.items.filter((x) => x.match);
      const total = (req.items || []).length;
      if (!total) console.log('Give --items to see which items it returns.');
      else {
        console.log(hit.length + ' of ' + total + ' items returned' + (res.operation === 'Query' ? ', in sort key order' + (req.ScanIndexForward === false ? ', descending' : '') : '') + ':');
        for (const x of hit) console.log('  ' + itemText(x.projected || x.item));
      }
    } else if (res.operation === 'UpdateItem' && res.after) {
      console.log('The item afterwards:');
      console.log('  ' + itemText(res.after));
      for (const c of res.changed || []) console.log('  ' + c.change + ': ' + c.name);
    } else if (res.operation === 'GetItem' && req.item) {
      console.log('Returned:');
      console.log('  ' + itemText(res.after || new Map()));
    } else if (res.conditionHolds !== undefined) console.log('The condition holds for the item.');
  }
  return res.error ? 1 : 0;
}

try { process.exitCode = main(process.argv.slice(2)); }
catch (e) {
  if (e instanceof E.InputError || e.code === 'ENOENT') { console.error(e.message); process.exitCode = 2; }
  else { console.error(e.message); process.exitCode = 2; }
}
