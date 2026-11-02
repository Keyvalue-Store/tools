// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Page logic for the Cluster Rebalancing Planner. All the planning lives in
// ../rebalance.js; this file only reads the inputs and draws the answers.

(function () {
  'use strict';
  const R = window.KVRebalance;
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => Math.round(Number(n)).toLocaleString('en-US');

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
  function figure(value, label) {
    return el('div', { class: 'figure' }, [el('span', { class: 'value', text: value }), el('span', { class: 'label', text: label })]);
  }
  function table(headers, rows, numeric) {
    const wrap = el('div', { class: 'table-wrap' });
    const t = el('table');
    const tr = el('tr');
    headers.forEach((h, i) => tr.append(el('th', { class: numeric && numeric[i] ? 'num' : '', scope: 'col', text: h })));
    t.append(el('thead', null, [tr]));
    const body = el('tbody');
    for (const r of rows) {
      const row = el('tr');
      r.forEach((c, i) => row.append(el('td', { class: numeric && numeric[i] ? 'num' : '' }, [c])));
      body.append(row);
    }
    t.append(body);
    wrap.append(t);
    return wrap;
  }
  function download(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/x-sh;charset=utf-8' }));
    const a = el('a', { href: url, download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function debounce(fn, ms) { let t; return function () { clearTimeout(t); t = setTimeout(fn, ms); }; }
  function readFile(input, target) {
    input.addEventListener('change', () => {
      const f = input.files && input.files[0];
      if (!f) return;
      f.text().then((t) => { $(target).value = t; input.value = ''; update(); });
    });
  }

  // Bar of slots (or load) per primary, before and after; one colour, the
  // labels carry the names.
  function bars(p, byLoad) {
    const rows = p.before.map((b, i) => ({ node: b.node, before: byLoad ? b.load : b.slots, after: byLoad ? p.after[i].load : p.after[i].slots, target: b.target }));
    const max = Math.max(1, ...rows.map((r) => Math.max(r.before, r.after, r.target)));
    const wrap = el('div', { class: 'table-wrap' });
    // Fixed column widths, so a bar in Before and one in After of the same
    // length mean the same number.
    const t = el('table', { style: 'table-layout:fixed' });
    const head = el('tr');
    for (const [h, w] of [['Primary', '30%'], ['Before', '35%'], ['After', '35%']]) head.append(el('th', { scope: 'col', text: h, style: 'width:' + w }));
    t.append(el('thead', null, [head]));
    const body = el('tbody');
    for (const r of rows) {
      const tr = el('tr');
      tr.append(el('td', { class: 'key', text: r.node }));
      for (const v of [r.before, r.after]) {
        const td = el('td');
        const w = Math.max(0.5, 75 * v / max);
        const bar = el('div', { style: 'display:flex;align-items:center;gap:8px' });
        bar.append(el('span', { style: `display:inline-block;height:10px;border-radius:3px;background:var(--accent);width:${w.toFixed(1)}%;min-width:2px` }));
        bar.append(el('span', { class: 'small', style: 'white-space:nowrap;font-variant-numeric:tabular-nums', text: fmt(v) }));
        td.append(bar);
        tr.append(td);
      }
      body.append(tr);
    }
    t.append(body);
    wrap.append(t);
    return wrap;
  }

  let cluster = null;
  const weights = new Map();

  function drawWeights() {
    const box = $('weights');
    box.textContent = '';
    if (!cluster) return;
    const primaries = cluster.nodes.filter((n) => n.primary);
    if (!primaries.length) return;
    const rows = primaries.map((n) => {
      const input = el('input', { type: 'number', min: '0', step: '0.5', value: String(weights.has(n.id) ? weights.get(n.id) : 1), 'aria-label': 'Weight of ' + n.host + ':' + n.port, style: 'width:6em' });
      input.addEventListener('input', () => { const v = Number(input.value); if (v >= 0) weights.set(n.id, v); later(); });
      const drain = el('button', { type: 'button', class: 'btn', text: 'Drain' });
      drain.addEventListener('click', () => { weights.set(n.id, 0); input.value = '0'; update(); });
      return [n.host + ':' + n.port, n.id.slice(0, 8), input, drain];
    });
    box.append(el('p', { class: 'lede', text: 'Weight 2 gives a primary twice the normal share. Weight 0, or Drain, moves every slot off it.' }));
    box.append(table(['Primary', 'Id', 'Weight', ''], rows));
  }

  function readLoad() {
    const by = document.querySelector('input[name="by"]:checked').value;
    if (by === 'slots') return { load: null };
    const text = $('load-text').value;
    const r = by === 'keys' ? R.parseKeySizes(text) : R.parseSlotLoad(text);
    return { load: r.load, errors: r.errors, keys: r.keys, empty: !text.trim() };
  }

  function update() {
    const out = $('plan');
    out.textContent = '';
    const text = $('nodes-text').value;
    if (!text.trim()) { cluster = null; drawWeights(); out.append(el('p', { class: 'muted', text: 'Paste CLUSTER NODES above, or try the example.' })); return; }
    const parsed = R.parseClusterNodes(text);
    const changed = !cluster || parsed.nodes.map((n) => n.id).join() !== cluster.nodes.map((n) => n.id).join();
    cluster = parsed;
    if (changed) { for (const id of [...weights.keys()]) if (!parsed.nodes.some((n) => n.id === id)) weights.delete(id); drawWeights(); }
    if (parsed.errors.length) {
      out.append(verdict('warn', 'Some lines could not be read', parsed.errors.slice(0, 5).map((e) => (e.line ? 'Line ' + e.line + ': ' : '') + e.message + '.')));
      return;
    }
    const L = readLoad();
    if (L.errors && L.errors.length) {
      out.append(verdict('warn', 'Some load lines could not be read', L.errors.slice(0, 5).map((e) => 'Line ' + e.line + ': ' + e.message + '.')));
      return;
    }
    if (L.empty) { out.append(el('p', { class: 'muted', text: 'Paste the sizes above to balance by bytes.' })); return; }
    const w = {};
    for (const [id, v] of weights) w[id] = v;
    const maxSlots = parseInt($('max-slots').value, 10);
    const threshold = Number($('threshold').value);
    const p = R.plan(cluster, { weights: w, load: L.load, threshold: threshold >= 0 ? threshold : 2, maxSlots: maxSlots > 0 ? maxSlots : undefined });

    if (p.problems.length) {
      out.append(verdict('bad', p.problems.every((x) => x.code === 'option') ? 'Cannot plan with these options' : 'Not safe to rebalance yet', p.problems.map((x) => x.message + '. ' + x.fix + '.')));
      return;
    }
    const byLoad = !!L.load;
    if (p.balanced) out.append(verdict('ok', 'Nothing to move', `Every primary is within ${threshold}% of its target.`));
    else {
      out.append(el('div', { class: 'figures' }, [
        figure(fmt(p.movedSlots), 'Slots to move'),
        figure(String(p.moves.length), p.moves.length === 1 ? 'Move' : 'Moves'),
        byLoad ? figure((100 * p.movedLoad / p.total).toFixed(1) + '%', 'Of the bytes move') : figure((100 * p.movedSlots / R.SLOTS).toFixed(1) + '%', 'Of the slots move')
      ]));
      if (p.capped) out.append(verdict('warn', 'Stopped at your limit', 'Run the planner again after this script to continue.'));
    }
    out.append(el('h3', { text: byLoad ? 'Bytes per primary' : 'Slots per primary' }));
    out.append(bars(p, byLoad));
    if (p.moves.length) {
      out.append(el('h3', { text: 'Moves' }));
      out.append(table(['From', 'To', 'Slots', byLoad ? 'Bytes' : 'Count'],
        p.moves.map((m) => [m.fromNode, m.toNode, R.formatRanges(m.ranges), fmt(byLoad ? m.load : m.slots)]), [false, false, false, true]));
      const sh = R.script(cluster, p, { cli: $('cli').value });
      const row = el('div', { class: 'row' });
      const btn = el('button', { type: 'button', class: 'btn', text: 'Download the script' });
      btn.addEventListener('click', () => download('rebalance.sh', sh));
      row.append(btn);
      row.append(el('span', { class: 'muted small', text: 'Run it from a machine that can reach every primary. Set REDISCLI_AUTH for a password.' }));
      out.append(row);
      const details = el('details');
      details.append(el('summary', { text: 'Show the script' }));
      details.append(el('pre', { class: 'out', text: sh }));
      out.append(details);
    }
    for (const n of p.notes) out.append(el('p', { class: 'muted small', text: 'Note: ' + n + '.' }));
  }
  const later = debounce(update, 250);

  function showLoadField() {
    const by = document.querySelector('input[name="by"]:checked').value;
    $('load-field').hidden = $('load-row').hidden = by === 'slots';
    if (by === 'keys') {
      $('load-label').textContent = 'Keys and sizes';
      $('load-text').placeholder = 'user:1001 5120\nsession:{42} 300';
      $('load-hint').textContent = 'A key and a number of bytes on each line, such as the output of MEMORY USAGE for each key. Keys may be quoted the way redis-cli prints them.';
    } else if (by === 'slotload') {
      $('load-label').textContent = 'Slots and sizes';
      $('load-text').placeholder = '0,52000\n1,48100\n100-199 1200000';
      $('load-hint').textContent = 'A slot and a number on each line. A range such as 100-199 spreads its number evenly.';
    }
    update();
  }

  const EXAMPLE = [
    '3f5c6a1e2b7d4c9a8e0f1a2b3c4d5e6f7a8b9c0d 10.0.0.1:6379@16379 myself,master - 0 0 1 connected 0-5460',
    '8a1b2c3d4e5f60718293a4b5c6d7e8f901234567 10.0.0.2:6379@16379 master - 0 1726238317239 2 connected 5461-10922',
    'c0ffee00112233445566778899aabbccddeeff00 10.0.0.3:6379@16379 master - 0 1726238317239 3 connected 10923-16383',
    'd15ea5e0d15ea5e0d15ea5e0d15ea5e0d15ea5e0 10.0.0.4:6379@16379 master - 0 1726238317239 0 connected',
    '1111111111111111111111111111111111111111 10.0.0.11:6379@16379 slave 3f5c6a1e2b7d4c9a8e0f1a2b3c4d5e6f7a8b9c0d 0 1726238317239 1 connected',
    '2222222222222222222222222222222222222222 10.0.0.12:6379@16379 slave 8a1b2c3d4e5f60718293a4b5c6d7e8f901234567 0 1726238317239 2 connected',
    '3333333333333333333333333333333333333333 10.0.0.13:6379@16379 slave c0ffee00112233445566778899aabbccddeeff00 0 1726238317239 3 connected'
  ].join('\n');

  $('example').addEventListener('click', () => { $('nodes-text').value = EXAMPLE; update(); });
  $('nodes-text').addEventListener('input', later);
  $('load-text').addEventListener('input', later);
  for (const id of ['threshold', 'max-slots']) $(id).addEventListener('input', later);
  $('cli').addEventListener('change', update);
  for (const id of ['by-slots', 'by-keys', 'by-slotload']) $(id).addEventListener('change', showLoadField);
  readFile($('nodes-file'), 'nodes-text');
  readFile($('load-file'), 'load-text');
  update();
})();
