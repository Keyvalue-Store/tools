// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Page logic for the Typed JSON Converter. The conversion lives in
// ../typedjson.js; this file reads the inputs and shows the result.

(function () {
  'use strict';
  const T = window.KVTypedJSON;
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => Number(n).toLocaleString('en-US');
  const plural = (n, one, many) => fmt(n) + ' ' + (n === 1 ? one : many);

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
    for (const line of [].concat(body || [])) p.append(el('p', null, [line]));
    box.append(p);
    return box;
  }
  function debounce(fn, ms) { let t; return function () { clearTimeout(t); t = setTimeout(fn, ms); }; }

  let lastName = 'converted.json';

  function options() {
    return {
      direction: document.querySelector('input[name="dir"]:checked').value,
      sets: $('sets').value,
      output: $('output').value,
      table: $('table').value.trim() || 'my-table',
      indent: $('compact').checked ? 0 : 2
    };
  }

  function run() {
    const status = $('status');
    status.textContent = '';
    const src = $('in').value;
    $('copy').disabled = $('save').disabled = true;
    if (!src.trim()) { $('out').value = ''; return; }
    let r;
    try { r = T.convert(src, options()); }
    catch (e) {
      $('out').value = '';
      status.append(verdict('bad', 'This could not be converted', e.message));
      return;
    }
    $('out').value = r.text;
    $('copy').disabled = $('save').disabled = false;
    const what = r.direction === 'toPlain' ? 'Typed JSON to plain JSON' : 'Plain JSON to typed JSON';
    const count = r.shape === 'batch' ? plural(r.count, 'batch-write-item request', 'batch-write-item requests') : plural(r.stats.items, 'item', 'items');
    const read = r.shapeName ? ` Read as ${r.shapeName}.` : '';
    status.append(verdict('ok', `${what}: ${count}`, `${read} ${plural(r.stats.numbers, 'number', 'numbers')} kept digit for digit.`.trim()));
    if (r.stats.binary) status.append(verdict('info', `${plural(r.stats.binary, 'binary value', 'binary values')} kept as base64 text`,
      'Plain JSON has no way to hold raw bytes. Converting back makes these strings (S), not binary (B).'));
    if (r.stats.precision.length) status.append(verdict('warn', 'Some numbers have more than 38 significant digits',
      'DynamoDB keeps 38 and refuses the rest. Fields: ' + r.stats.precision.slice(0, 8).join(', ') + (r.stats.precision.length > 8 ? ' and more' : '')));
    if (r.shape === 'batch') status.append(verdict('info', 'One request per line',
      ['Each line is a whole request. Save the result as batches.jsonl, then send the lines one at a time:',
        el('code', { text: "split -l 1 batches.jsonl batch- && for f in batch-*; do aws dynamodb batch-write-item --request-items file://$f; done" })]));
    lastName = r.direction === 'toPlain' ? 'plain.json' : (r.shape === 'batch' ? 'batches.jsonl' : 'typed.json');
    if (/\n./.test(r.text.trim()) && r.text.trim().split('\n').every((l) => l.startsWith('{'))) lastName = lastName.replace(/\.json$/, '.jsonl');
  }

  const later = debounce(run, 200);
  $('in').addEventListener('input', later);
  for (const r of document.querySelectorAll('input[name="dir"]')) r.addEventListener('change', run);
  for (const id of ['sets', 'output', 'compact']) $(id).addEventListener('change', run);
  $('table').addEventListener('input', later);

  $('in-file').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    f.text().then((t) => { $('in').value = t; run(); });
    e.target.value = '';
  });
  $('clear').addEventListener('click', () => { $('in').value = ''; run(); });
  $('ex-typed').addEventListener('click', () => {
    $('in').value = JSON.stringify({
      Items: [
        { pk: { S: 'user#42' }, sk: { S: 'profile' }, name: { S: 'Ana Silva' }, visits: { N: '17' }, balance: { N: '1234567890123456789.25' },
          tags: { SS: ['beta', 'mobile'] }, address: { M: { city: { S: 'Lisbon' }, zip: { S: '1100-148' } } }, active: { BOOL: true }, avatar: { NULL: true } },
        { pk: { S: 'user#43' }, sk: { S: 'profile' }, name: { S: 'Ben Okafor' }, visits: { N: '3' }, scores: { NS: ['7', '9.5'] }, history: { L: [{ S: 'signup' }, { N: '20261005' }] } }
      ],
      Count: 2, ScannedCount: 2, ConsumedCapacity: null
    }, null, 2);
    run();
  });
  $('ex-plain').addEventListener('click', () => {
    $('in').value = '{\n  "pk": "order#9001",\n  "sk": "2026-10-05T09:30:00Z",\n  "total": 149.90,\n  "items": ["mug", "kettle"],\n  "shipped": false,\n  "note": null,\n  "customer": {"id": 42, "tier": "gold"}\n}';
    run();
  });

  $('copy').addEventListener('click', () => {
    const text = $('out').value;
    const done = () => { $('copy').textContent = 'Copied'; setTimeout(() => { $('copy').textContent = 'Copy'; }, 1500); };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, () => { $('out').select(); document.execCommand('copy'); done(); });
    else { $('out').select(); document.execCommand('copy'); done(); }
  });
  $('save').addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([$('out').value], { type: 'application/json' }));
    const a = el('a', { href: url, download: lastName });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
})();
