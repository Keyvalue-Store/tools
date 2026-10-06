// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Page logic for the Expression Tester. Every DynamoDB rule lives in
// ../expressions.js; this file reads the form and draws the answers.

(function () {
  'use strict';
  const X = window.KVExpressions;
  const $ = (id) => document.getElementById(id);
  const EXPR_FIELDS = ['KeyConditionExpression', 'FilterExpression', 'ConditionExpression', 'UpdateExpression', 'ProjectionExpression'];
  const KIND_OF = { KeyConditionExpression: 'key', FilterExpression: 'filter', ConditionExpression: 'condition', UpdateExpression: 'update', ProjectionExpression: 'projection' };
  let pastedKey = null;

  // ---- small DOM helpers ----
  function el(tag, attrs, children) {
    const n = document.createElement(tag);
    if (attrs) for (const k of Object.keys(attrs)) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'text') n.textContent = attrs[k];
      else n.setAttribute(k, attrs[k]);
    }
    for (const c of [].concat(children || [])) if (c != null) n.append(c.nodeType ? c : document.createTextNode(String(c)));
    return n;
  }
  const ICONS = {
    ok: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="9" fill="currentColor" opacity=".15"/><path d="M5.5 10.5l3 3 6-7" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    bad: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="9" fill="currentColor" opacity=".15"/><path d="M6.5 6.5l7 7M13.5 6.5l-7 7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    warn: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2l9 16H1z" fill="currentColor" opacity=".15"/><path d="M10 8v4.5M10 15.2v.3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    info: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="9" fill="currentColor" opacity=".15"/><path d="M10 9v5M10 6v.3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
  };
  function verdict(kind, title, body) {
    const box = el('div', { class: 'verdict ' + kind, role: kind === 'bad' ? 'alert' : 'status' });
    box.innerHTML = ICONS[kind];
    const p = el('div');
    p.append(el('p', null, [el('strong', { text: title })]));
    for (const line of [].concat(body || [])) if (line) p.append(el('p', null, [line]));
    box.append(p);
    return box;
  }
  function table(headers, rows) {
    const wrap = el('div', { class: 'table-wrap' });
    const t = el('table');
    const tr = el('tr');
    for (const h of headers) tr.append(el('th', { scope: 'col', text: h }));
    t.append(el('thead', null, [tr]));
    const body = el('tbody');
    for (const r of rows) {
      const row = el('tr');
      for (const c of r) row.append(el('td', { class: c && c.mono ? 'key' : '' }, [c && c.mono !== undefined ? c.mono : c]));
      body.append(row);
    }
    t.append(body);
    wrap.append(t);
    return wrap;
  }
  function debounce(fn, ms) { let t; return function () { clearTimeout(t); t = setTimeout(fn, ms); }; }
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);

  // ---- which fields an operation uses ----
  function showFields() {
    const op = $('op').value;
    for (const n of document.querySelectorAll('[data-ops]')) n.classList.toggle('hidden-op', !n.getAttribute('data-ops').split(' ').includes(op));
    const many = op === 'Query' || op === 'Scan';
    $('items-label').textContent = many ? 'Items in the table' : 'The item as it is now';
    $('items-hint').textContent = many
      ? 'A JSON list of items, or one item per line. Typed ({"S": "x"}) or plain JSON. Output of aws dynamodb scan, or an export to S3, works too.'
      : 'One item, typed or plain JSON. ' + (op === 'GetItem' ? '' : 'Leave it empty for an item that doesn\'t exist yet.');
  }

  // ---- reading the form ----
  function readJsonField(id, label) {
    const t = $(id).value.trim();
    if (!t) return undefined;
    try { return X.parseJson(t); }
    catch (e) { throw new X.InputError(label + ': ' + e.message); }
  }
  function keySchema() {
    const pk = $('pk-name').value.trim(), sk = $('sk-name').value.trim();
    if (!pk) return undefined;
    return { partition: { name: pk, type: $('pk-type').value }, sort: sk ? { name: sk, type: $('sk-type').value } : null };
  }
  function readItems(op) {
    const t = $('items').value.trim();
    if (!t) return op === 'Query' || op === 'Scan' ? [] : null;
    let list;
    try { list = X.parseJsonItems(t); }
    catch (e) { throw new X.InputError('Items: ' + e.message); }
    // aws dynamodb scan output, and exports to S3, wrap the items.
    if (list.length === 1 && list[0] instanceof Map && Array.isArray(list[0].get('Items'))) list = list[0].get('Items');
    list = list.map((x) => (x instanceof Map && x.size === 1 && x.get('Item') instanceof Map) ? x.get('Item') : x);
    const items = list.map((x, i) => {
      try { return X.readItem(x); }
      catch (e) { throw new X.InputError('Item ' + (i + 1) + ': ' + e.message); }
    });
    if (op === 'Query' || op === 'Scan') return items;
    if (items.length > 1) throw new X.InputError('This operation works on one item; the items box holds ' + items.length + '.');
    return items[0] || null;
  }
  function buildRequest() {
    const op = $('op').value;
    const req = { operation: op, keySchema: keySchema() };
    for (const f of EXPR_FIELDS) {
      const box = $(f);
      if (box.closest('.hidden-op')) continue;
      if (box.value !== '') req[f] = box.value;
    }
    const names = readJsonField('names', 'ExpressionAttributeNames');
    const values = readJsonField('values', 'ExpressionAttributeValues');
    if (names !== undefined) req.ExpressionAttributeNames = names;
    if (values !== undefined) req.ExpressionAttributeValues = values;
    if (op === 'Query' && $('reverse').checked) req.ScanIndexForward = false;
    const items = readItems(op);
    if (op === 'Query' || op === 'Scan') req.items = items;
    else req.item = items;
    if (pastedKey) req.key = pastedKey;
    return req;
  }

  // ---- drawing ----
  function marked(text, start, end) {
    const pre = el('div', { class: 'expr' });
    if (start === undefined || end === undefined) { pre.textContent = text; return pre; }
    const s = Math.min(start, text.length), e = Math.max(s, Math.min(end, text.length));
    pre.append(text.slice(0, s));
    pre.append(el('mark', { text: text.slice(s, e) || ' ' }));
    pre.append(text.slice(e));
    return pre;
  }

  // The condition as DynamoDB groups it: AND before OR, NOT before AND.
  function treeLines(n, text, trace, prefix, last, out) {
    while (n.k === 'paren') n = n.inner;
    const mark = trace ? (trace.get(n) ? '✓ ' : '✗ ') : '';
    const head = prefix + (prefix ? (last ? '└─ ' : '├─ ') : '');
    const childPrefix = prefix + (prefix ? (last ? '   ' : '│  ') : ' ');
    if (n.k === 'and' || n.k === 'or') {
      const kids = [];
      const flatten = (m) => { while (m.k === 'paren') m = m.inner; if (m.k === n.k) { flatten(m.a); flatten(m.b); } else kids.push(m); };
      flatten(n);
      out.push(head + mark + (n.k === 'and' ? 'AND (all of)' : 'OR (any of)'));
      kids.forEach((k, i) => treeLines(k, text, trace, childPrefix, i === kids.length - 1, out));
    } else if (n.k === 'not') {
      out.push(head + mark + 'NOT');
      treeLines(n.a, text, trace, childPrefix, true, out);
    } else {
      out.push(head + mark + text.slice(n.start, n.end).replace(/\s+/g, ' '));
    }
    return out;
  }
  function tree(expr, trace) {
    return el('pre', { class: 'out tree', text: treeLines(expr.ast, expr.text, trace, '', true, []).join('\n') });
  }
  function itemText(item) { return '{' + [...item].map(([k, v]) => k + ': ' + X.toPlainText(v)).join(', ') + '}'; }
  // One attribute per line, each value on one line.
  function compact(obj) {
    const keys = Object.keys(obj);
    if (!keys.length) return '{}';
    return '{\n' + keys.map((k) => '  ' + JSON.stringify(k) + ': ' + JSON.stringify(obj[k])).join(',\n') + '\n}';
  }
  function pretty(item) { return compact(X.itemToTyped(item)); }

  function render(req, res) {
    const out = $('result');
    out.textContent = '';
    const ex = res.expressions || {};
    if (res.error && res.error.type !== 'ConditionalCheckFailedException') {
      out.append(verdict('bad', 'DynamoDB would refuse this ' + res.operation, [el('code', { text: res.error.type + ': ' + res.error.message }), X.explain(res.error)]));
      const field = res.error.expression;
      if (field && req[field] !== undefined) {
        out.append(el('p', { class: 'small muted', text: field + (res.error.start !== undefined ? ', with the problem marked:' : ':') }));
        out.append(marked(req[field], res.error.start, res.error.end));
      }
      return;
    }
    if (res.error) {
      out.append(verdict('warn', 'The condition is false for the item', ['DynamoDB refuses the write with ' + res.error.type + ': ' + res.error.message + '. Nothing changes.']));
    } else {
      out.append(verdict('ok', 'DynamoDB accepts this ' + res.operation, res.operation === 'UpdateItem' && !req.item ? 'There is no item yet, so DynamoDB creates one.' : null));
    }

    // How the conditions read.
    for (const kind of ['key', 'filter', 'condition']) {
      if (!ex[kind]) continue;
      out.append(el('h3', { text: 'How DynamoDB reads the ' + X.EXPRESSIONS[kind] }));
      out.append(tree(ex[kind], kind === 'condition' ? res.conditionTrace : null));
    }

    // Placeholders.
    const rows = [];
    for (const [k, v] of res.names || []) rows.push([{ mono: k }, el('span', null, [el('span', { class: 'muted', text: 'the name ' }), el('code', { text: v })])]);
    for (const [k, v] of res.values || []) rows.push([{ mono: k }, el('span', null, [el('span', { class: 'muted', text: 'the ' + ({ S: 'string', N: 'number', B: 'binary', BOOL: 'boolean', NULL: 'null', L: 'list', M: 'map', SS: 'string set', NS: 'number set', BS: 'binary set' })[v.t] + ' ' }), el('code', { text: X.toPlainText(v) })])]);
    if (rows.length) {
      out.append(el('h3', { text: 'Placeholders' }));
      out.append(table(['Placeholder', 'Stands for'], rows));
    }

    // What comes back.
    if (res.items) {
      const total = (req.items || []).length;
      const hit = res.items.filter((x) => x.match);
      out.append(el('h3', { text: 'Items returned' }));
      if (!total) { out.append(el('p', { class: 'muted', text: 'Add items to the table above to see which ones come back.' })); return; }
      let line = plural(hit.length, 'item', 'items') + ' of ' + total + ' returned';
      if (res.operation === 'Query') line += ', in ' + (req.ScanIndexForward === false ? 'descending' : 'ascending') + ' sort key order. ' + plural((res.notMatchingKey || []).length, 'item doesn\'t', 'items don\'t') + ' match the key condition';
      out.append(el('p', { text: line + '.' }));
      for (const x of res.items) {
        const d = el('details', { class: 'item' });
        d.append(el('summary', null, [el('span', { class: x.match ? 'yes' : 'no', text: x.match ? 'returned ' : 'filtered out ' }), itemText(x.projected && x.match ? x.projected : x.item)]));
        if (ex.filter) d.append(tree(ex.filter, x.trace));
        else d.append(el('pre', { class: 'out', text: pretty(x.projected || x.item) }));
        out.append(d);
      }
      return;
    }
    if (res.operation === 'UpdateItem' && res.after) {
      const two = el('div', { class: 'two-col' });
      two.append(el('div', null, [el('h3', { text: 'Before' }), el('pre', { class: 'out', text: req.item ? pretty(req.item) : '(no item)' })]));
      two.append(el('div', null, [el('h3', { text: 'After' }), el('pre', { class: 'out', text: pretty(res.after) })]));
      out.append(two);
      if (res.changed && res.changed.length) out.append(el('p', { text: 'Changed: ' + res.changed.map((c) => c.name + ' (' + c.change + ')').join(', ') + '.' }));
      else out.append(el('p', { text: 'Nothing changed.' }));
      return;
    }
    if (res.operation === 'GetItem') {
      out.append(el('h3', { text: 'Returned' }));
      out.append(el('pre', { class: 'out', text: req.item ? pretty(res.after || new Map()) : '(add the item above)' }));
    }
  }

  function run() {
    const out = $('result');
    let req;
    try { req = buildRequest(); }
    catch (e) {
      out.textContent = '';
      out.append(verdict('warn', 'The tester can\'t read this yet', e.message));
      return;
    }
    if (!EXPR_FIELDS.some((f) => req[f] !== undefined)) {
      out.textContent = '';
      out.append(verdict('info', 'Write an expression above', 'Or pick one of the examples.'));
      return;
    }
    try { render(req, X.run(req)); }
    catch (e) {
      out.textContent = '';
      out.append(verdict('warn', 'The tester can\'t read this yet', e.message));
    }
  }

  // ---- buttons ----
  function fill(op, fields, items, key) {
    $('op').value = op;
    for (const f of EXPR_FIELDS) $(f).value = fields[f] || '';
    $('names').value = fields.names ? compact(fields.names) : '';
    $('values').value = fields.values ? compact(fields.values) : '';
    $('items').value = items || '';
    if (key) { $('pk-name').value = key[0]; $('pk-type').value = key[1]; $('sk-name').value = key[2] || ''; $('sk-type').value = key[3] || 'S'; }
    pastedKey = null;
    showFields();
    run();
  }
  $('ex-update').addEventListener('click', () => fill('UpdateItem', {
    UpdateExpression: 'SET visits = if_not_exists(visits, :zero) + :one, #tags = list_append(#tags, :new) REMOVE draft',
    ConditionExpression: 'attribute_exists(pk) AND #v = :expected',
    names: { '#tags': 'tags', '#v': 'version' },
    values: { ':zero': { N: '0' }, ':one': { N: '1' }, ':new': { L: [{ S: 'returning' }] }, ':expected': { N: '7' } }
  }, compact({ pk: { S: 'user#42' }, sk: { S: 'profile' }, tags: { L: [{ S: 'beta' }] }, version: { N: '7' }, draft: { BOOL: true } }), ['pk', 'S', 'sk', 'S']));
  $('ex-query').addEventListener('click', () => fill('Query', {
    KeyConditionExpression: 'pk = :customer AND begins_with(sk, :year)',
    FilterExpression: 'amount >= :min OR contains(tags, :tag)',
    values: { ':customer': 'c#9', ':year': 'order#2026', ':min': 100, ':tag': 'gift' }
  }, [
    '{"pk": "c#9", "sk": "order#2026-03-01", "amount": 120, "tags": ["gift"]}',
    '{"pk": "c#9", "sk": "order#2026-05-17", "amount": 35}',
    '{"pk": "c#9", "sk": "order#2026-09-30", "amount": 15, "tags": ["gift", "rush"]}',
    '{"pk": "c#9", "sk": "order#2025-12-24", "amount": 300}',
    '{"pk": "c#4", "sk": "order#2026-02-02", "amount": 999}'
  ].join('\n'), ['pk', 'S', 'sk', 'S']));
  $('ex-error').addEventListener('click', () => fill('Scan', {
    FilterExpression: 'status = :active AND size(data) > :n',
    values: { ':active': { S: 'active' }, ':n': { N: '10' } }
  }, '{"pk": {"S": "a"}, "status": {"S": "active"}, "data": {"S": "a long enough string"}}', ['pk', 'S', '', 'S']));

  $('escape').addEventListener('click', () => {
    let names;
    try { names = readJsonField('names', 'ExpressionAttributeNames'); }
    catch (e) { $('escape-note').textContent = e.message; return; }
    let current = names instanceof Map ? names : new Map();
    let added = 0;
    for (const f of EXPR_FIELDS) {
      const box = $(f);
      if (!box.value || box.closest('.hidden-op')) continue;
      const r = X.escapeNames(box.value, current);
      box.value = r.expression;
      current = new Map(Object.entries(r.names));
      added += r.added.length;
    }
    if (current.size) $('names').value = compact(Object.fromEntries(current));
    $('escape-note').textContent = added ? plural(added, 'placeholder', 'placeholders') + ' added.' : 'No reserved words to replace.';
    run();
  });

  $('fill').addEventListener('click', () => {
    let req;
    try { req = X.readRequest($('pasted').value); }
    catch (e) { $('fill-note').textContent = e.message; return; }
    const op = req.operation;
    $('op').value = op;
    for (const f of EXPR_FIELDS) $(f).value = req[f] !== undefined ? req[f] : '';
    $('names').value = req.ExpressionAttributeNames ? jsonText(req.ExpressionAttributeNames) : '';
    $('values').value = req.ExpressionAttributeValues ? jsonText(req.ExpressionAttributeValues) : '';
    if (req.ScanIndexForward === false) $('reverse').checked = true;
    if (op === 'PutItem' && req.Item) $('items').value = '';
    pastedKey = req.Key ? X.readItem(req.Key) : null;
    $('fill-note').textContent = 'Filled in a ' + op + (req.TableName ? ' on ' + req.TableName : '') + '. Add the item' + (op === 'Query' || op === 'Scan' ? 's' : '') + ' below.';
    showFields();
    run();
  });
  // JSON text for the boxes, keeping every digit of the numbers as written.
  function jsonText(v) {
    const pad = (n) => ' '.repeat(n);
    const go = (x, lvl) => {
      if (x instanceof X.JsonNumber) return x.text;
      if (x === null || typeof x !== 'object') return JSON.stringify(x);
      if (Array.isArray(x)) return x.length ? '[' + x.map((y) => go(y, lvl + 2)).join(', ') + ']' : '[]';
      const entries = x instanceof Map ? [...x] : Object.entries(x);
      if (!entries.length) return '{}';
      if (lvl > 0) return '{' + entries.map(([k, y]) => JSON.stringify(k) + ': ' + go(y, lvl + 2)).join(', ') + '}';
      return '{\n' + entries.map(([k, y]) => pad(lvl + 2) + JSON.stringify(k) + ': ' + go(y, lvl + 2)).join(',\n') + '\n' + pad(lvl) + '}';
    };
    return go(v, 0);
  }

  const later = debounce(run, 250);
  for (const id of EXPR_FIELDS.concat(['names', 'values', 'items', 'pk-name', 'sk-name'])) $(id).addEventListener('input', later);
  for (const id of ['pk-type', 'sk-type', 'reverse']) $(id).addEventListener('change', run);
  $('op').addEventListener('change', () => { showFields(); run(); });

  showFields();
  $('ex-update').click();
})();
