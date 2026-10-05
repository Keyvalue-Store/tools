// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Page logic for the Hash Slot Calculator. All the slot rules live in
// ../slots.js; this file only reads the inputs and draws the answers.

(function () {
  'use strict';
  const S = window.KVSlots;
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => Number(n).toLocaleString('en-US');
  const enc = new TextEncoder();

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
      r.forEach((c, i) => {
        const cls = (numeric && numeric[i]) ? 'num' : (c && c.key ? 'key' : '');
        row.append(el('td', { class: cls }, [c && c.node ? c.node : (c && c.key !== undefined ? c.key : c)]));
      });
      body.append(row);
    }
    t.append(body);
    wrap.append(t);
    return wrap;
  }
  // The key with its hashed bytes marked.
  function markedKey(bytes, start, end, tagged) {
    const span = el('span', { class: 'mono' });
    if (!tagged) { span.append(el('mark', { class: 'hashed', text: S.displayKey(bytes) })); return span; }
    span.append(S.displayKey(bytes.subarray(0, start)));
    span.append(el('mark', { class: 'hashed', text: S.displayKey(bytes.subarray(start, end)) }));
    span.append(S.displayKey(bytes.subarray(end)));
    return span;
  }
  function download(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    const a = el('a', { href: url, download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function csvCell(s) { return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
  function debounce(fn, ms) { let t; return function () { clearTimeout(t); t = setTimeout(fn, ms); }; }

  // ---- charts (single series, so one colour; labels carry the names) ----
  const SVGNS = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs, text) {
    const n = document.createElementNS(SVGNS, tag);
    for (const k of Object.keys(attrs || {})) n.setAttribute(k, attrs[k]);
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function roundedBar(x, y, w, h, r, horizontal) {
    // Square at the baseline, 4px rounded at the data end.
    r = Math.min(r, horizontal ? w : h, horizontal ? h / 2 : w / 2);
    if (horizontal) return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }
  function barsByPrimary(names, values, total) {
    const rowH = 30, labelW = 210, valueW = 120, W = 760;
    const H = names.length * rowH + 6;
    const max = Math.max(1, ...values);
    const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Keys per primary' });
    const plotW = W - labelW - valueW;
    names.forEach((name, i) => {
      const y = i * rowH + 4;
      const label = name.length > 28 ? name.slice(0, 27) + '…' : name;
      s.append(svg('text', { x: labelW - 10, y: y + 17, 'text-anchor': 'end' }, label));
      const w = Math.max(values[i] ? 2 : 0, plotW * values[i] / max);
      const p = svg('path', { d: roundedBar(labelW, y + 3, w, rowH - 10, 4, true), class: 'bar' });
      p.append(svg('title', {}, `${name}: ${fmt(values[i])} keys (${(100 * values[i] / (total || 1)).toFixed(1)}%)`));
      s.append(p);
      s.append(svg('text', { x: labelW + w + 8, y: y + 17 }, `${fmt(values[i])} (${(100 * values[i] / (total || 1)).toFixed(1)}%)`));
    });
    s.append(svg('line', { x1: labelW, y1: 2, x2: labelW, y2: H - 2, class: 'axis' }));
    return el('div', { class: 'chart' }, [s]);
  }
  function slotSpread(perSlot) {
    const bins = 64, per = S.SLOTS / bins, W = 760, H = 170, left = 46, bottom = 26, top = 8;
    const counts = new Array(bins).fill(0);
    for (let s = 0; s < S.SLOTS; s++) counts[Math.floor(s / per)] += perSlot[s];
    const max = Math.max(1, ...counts);
    const plotW = W - left - 6, plotH = H - bottom - top, bw = plotW / bins;
    const g = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Keys across the slot range, in groups of 256 slots' });
    for (const f of [0.5, 1]) {
      const y = top + plotH * (1 - f);
      g.append(svg('line', { x1: left, y1: y, x2: W - 6, y2: y, class: 'grid' }));
      g.append(svg('text', { x: left - 6, y: y + 4, 'text-anchor': 'end' }, fmt(Math.round(max * f))));
    }
    counts.forEach((c, i) => {
      const h = plotH * c / max;
      const x = left + i * bw + 1;
      const p = svg('path', { d: roundedBar(x, top + plotH - h, Math.max(1, bw - 2), h, 3, false), class: 'bar' });
      p.append(svg('title', {}, `Slots ${i * per} to ${(i + 1) * per - 1}: ${fmt(c)} keys`));
      g.append(p);
    });
    g.append(svg('line', { x1: left, y1: top + plotH, x2: W - 6, y2: top + plotH, class: 'axis' }));
    for (const s of [0, 4096, 8192, 12288, 16383]) {
      g.append(svg('text', { x: left + plotW * s / (S.SLOTS - 1), y: H - 6, 'text-anchor': s === 0 ? 'start' : (s === 16383 ? 'end' : 'middle') }, String(s)));
    }
    return el('div', { class: 'chart' }, [g]);
  }

  // ---- cluster layout ----
  let layout = S.evenSplit(3);
  let layoutMap = S.slotMap(layout);
  function primaryOf(slot) { const i = layoutMap[slot]; return i >= 0 ? layout[i].node : 'no primary owns it'; }
  function rangesText(n) { return n.ranges.map((r) => r[0] === r[1] ? String(r[0]) : r[0] + ' to ' + r[1]).join(', '); }

  function readLayout() {
    const out = $('layout-result');
    out.textContent = '';
    if ($('layout-nodes').checked) {
      const nodes = S.parseClusterNodes($('nodes-text').value);
      if (!nodes.length) {
        out.append(verdict('warn', 'No primaries found yet', 'Paste the output of CLUSTER NODES from any node. Lines for replicas are skipped, since only primaries own slots. Until then the even split is used.'));
        const n = Math.max(1, Math.min(1000, parseInt($('split-n').value, 10) || 3));
        layout = S.evenSplit(n);
      } else layout = nodes;
    } else {
      const n = Math.max(1, Math.min(1000, parseInt($('split-n').value, 10) || 3));
      layout = S.evenSplit(n);
    }
    layoutMap = S.slotMap(layout);
    let owned = 0;
    for (let s = 0; s < S.SLOTS; s++) if (layoutMap[s] >= 0) owned++;
    const rows = layout.slice(0, 50).map((n) => [{ key: n.node }, rangesText(n), fmt(n.ranges.reduce((a, r) => a + r[1] - r[0] + 1, 0))]);
    out.append(table(['Primary', 'Slots', 'Count'], rows, [false, false, true]));
    if (layout.length > 50) out.append(el('p', { class: 'muted small', text: `Showing 50 of ${fmt(layout.length)} primaries.` }));
    if (owned < S.SLOTS) out.append(verdict('warn', `${fmt(S.SLOTS - owned)} slots have no primary`, 'A cluster with unowned slots refuses commands for keys in them, unless cluster-require-full-coverage is set to no.'));
    refreshAll();
  }

  // ---- one key ----
  function showOne() {
    const out = $('one-result');
    out.textContent = '';
    const v = $('one-key').value;
    const bytes = S.parseKeyLine(v, $('raw').checked);
    const d = S.describeKey(bytes);
    out.append(el('div', { class: 'figures' }, [
      figure(String(d.slot), 'Slot'),
      figure(primaryOf(d.slot), 'Primary'),
      figure('0x' + d.crc.toString(16).toUpperCase().padStart(4, '0'), 'CRC16 of the hashed bytes')
    ]));
    const p = el('p', null, ['Hashed part: ', markedKey(d.bytes, d.start, d.end, d.tagged)]);
    out.append(p);
    out.append(el('p', { class: 'muted small', text: d.tagged
      ? `Only the part inside the first pair of braces is hashed, so every key containing {${S.displayKey(d.hashed)}} lands in slot ${d.slot}.`
      : 'This key has no hash tag, so the whole key is hashed. Put part of it in braces, such as user:{42}:cart, to keep related keys together.' }));
  }

  // ---- one command ----
  function showCommand() {
    const out = $('cmd-result');
    out.textContent = '';
    let r;
    try { r = S.checkCommand($('cmd').value); } catch (e) { r = { error: e.message }; }
    if (r.error) { out.append(verdict('warn', 'This command cannot be read', r.error)); return; }
    if (!r.keys.length) { out.append(verdict('info', r.multiKey ? `This ${r.command} has no keys` : `${r.command} takes no keys`, 'Any node can run it.')); return; }
    if (r.crossSlot) {
      out.append(verdict('bad', `CROSSSLOT: the keys are in ${r.slots.length} different slots`,
        'A cluster refuses this command. Give the keys a shared hash tag, the part in braces, as in user:{42}:name and user:{42}:plan, so they land in one slot.'));
    } else if (r.keys.length > 1) {
      out.append(verdict('ok', `OK: every key is in slot ${r.slots[0]}`, `${primaryOf(r.slots[0])} runs it.`));
    } else {
      out.append(verdict('ok', `One key, in slot ${r.slots[0]}`, r.known ? `${primaryOf(r.slots[0])} runs it.`
        : `${r.command} is not a multi-key command this tool knows, so it was read as a command with one key. ${primaryOf(r.slots[0])} runs it.`));
    }
    for (const n of r.notes) out.append(verdict('warn', 'Note', n));
    out.append(table(['Key', 'Slot', 'Primary'], r.keys.map((k) => [{ node: markedKey(k.bytes, k.start, k.end, k.tagged) }, String(k.slot), primaryOf(k.slot)])));
  }

  // ---- many keys ----
  let manyKeys = null;       // keys from a loaded file, as bytes
  let manyFileName = '';
  function showMany() {
    const out = $('many-result');
    out.textContent = '';
    const keys = manyKeys || S.parseKeyList($('many').value, $('raw').checked);
    if (!keys.length) return;
    const r = S.analyze(keys, layout);
    if (manyKeys) out.append(el('p', { class: 'muted small', text: `Loaded ${manyFileName}. Editing the box above replaces it.` }));
    out.append(el('div', { class: 'figures' }, [
      figure(fmt(r.total), 'Keys'),
      figure(fmt(r.usedSlots), 'Slots used, of 16,384'),
      figure(fmt(r.tagged), 'Keys with a hash tag'),
      figure(fmt(r.busiestSlot), 'Keys in the busiest slot')
    ]));
    if (r.topTags.length && r.total >= 100) {
      const [tag, count] = r.topTags[0];
      const share = count / r.total;
      if (share >= 0.1) out.append(verdict('warn', `{${tag}} puts ${fmt(count)} keys (${(100 * share).toFixed(0)}%) in one slot`,
        'A hash tag keeps keys together, so all of them sit on one primary and can never spread out. That is right for keys you use in one command, and a hot spot for anything else.'));
    }
    if (r.unowned) out.append(verdict('warn', `${fmt(r.unowned)} keys are in slots no primary owns`, 'A cluster refuses commands for them.'));
    out.append(el('h3', { text: 'Keys per primary' }));
    const names = layout.slice(0, 40).map((n) => n.node);
    out.append(barsByPrimary(names, r.perNode.slice(0, 40), r.total));
    if (layout.length > 40) out.append(el('p', { class: 'muted small', text: `The chart shows the first 40 of ${fmt(layout.length)} primaries.` }));
    const ideal = r.total / layout.length;
    const maxShare = Math.max(...r.perNode) / (ideal || 1);
    out.append(el('p', { class: 'muted small', text: `The busiest primary holds ${maxShare.toFixed(2)} times its even share of ${fmt(Math.round(ideal))} keys.` }));
    out.append(el('h3', { text: 'Keys across the slot range' }));
    out.append(slotSpread(r.perSlot));
    out.append(el('h3', { text: 'Busiest slots' }));
    out.append(table(['Slot', 'Keys', 'Primary'], r.topSlots.map(([s, c]) => [String(s), fmt(c), primaryOf(s)]), [false, true, false]));
    if (r.topTags.length) {
      out.append(el('h3', { text: 'Most used hash tags' }));
      out.append(table(['Hash tag', 'Slot', 'Keys'], r.topTags.map(([t, c]) => [{ key: '{' + t + '}' }, String(S.keySlot(enc.encode(t))), fmt(c)]), [false, false, true]));
    }
    out.append(el('h3', { text: 'Each key' }));
    const shown = r.rows.slice(0, 50);
    out.append(table(['Key', 'Slot', 'Primary'], shown.map((row) => [{ node: markedKey(row.bytes, row.start, row.end, row.tagged) }, String(row.slot), row.node >= 0 ? layout[row.node].node : 'no primary'])));
    const row = el('div', { class: 'row' });
    if (r.rows.length > 50) row.append(el('span', { class: 'muted small', text: `Showing 50 of ${fmt(r.rows.length)} keys.` }));
    const btn = el('button', { type: 'button', class: 'btn primary', text: 'Download every key as CSV' });
    btn.addEventListener('click', () => {
      const lines = ['key,slot,primary'];
      for (const k of r.rows) lines.push([csvCell(S.displayKey(k.bytes)), k.slot, csvCell(k.node >= 0 ? layout[k.node].node : '')].join(','));
      download('key-slots.csv', lines.join('\n') + '\n');
    });
    row.append(btn);
    out.append(row);
  }

  function exampleKeys() {
    let seed = 42;
    const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; };
    const hex = (n) => { let s = ''; for (let i = 0; i < n; i++) s += '0123456789abcdef'[Math.floor(rnd() * 16)]; return s; };
    const lines = [];
    for (let i = 0; i < 900; i++) lines.push(`user:${1000 + Math.floor(rnd() * 90000)}:profile`);
    for (let i = 0; i < 400; i++) lines.push(`session:${hex(16)}`);
    for (let i = 0; i < 300; i++) { const u = 1000 + Math.floor(rnd() * 200); lines.push(`cart:{${u}}:items`, `cart:{${u}}:total`); }
    for (let i = 0; i < 250; i++) lines.push(`feed:{global}:${2026}-10-${String(1 + Math.floor(rnd() * 28)).padStart(2, '0')}:${hex(6)}`);
    for (let i = 0; i < 150; i++) lines.push(`rate:203.0.113.${Math.floor(rnd() * 255)}`);
    return lines.join('\n');
  }

  function refreshAll() { showOne(); showCommand(); showMany(); }

  // ---- wiring ----
  $('one-key').addEventListener('input', showOne);
  $('cmd').addEventListener('input', showCommand);
  const manyLater = debounce(showMany, 250);
  $('many').addEventListener('input', () => { manyKeys = null; manyLater(); });
  $('raw').addEventListener('change', () => { manyKeys = manyKeys && manyFileBytes ? S.parseKeyBuffer(manyFileBytes, $('raw').checked) : manyKeys; refreshAll(); });
  let manyFileBytes = null;
  $('many-file').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    f.arrayBuffer().then((buf) => {
      manyFileBytes = new Uint8Array(buf);
      manyKeys = S.parseKeyBuffer(manyFileBytes, $('raw').checked);
      manyFileName = `${f.name}, ${fmt(manyKeys.length)} keys`;
      $('many').value = '';
      showMany();
    }).catch(() => { $('many-result').textContent = ''; $('many-result').append(verdict('bad', 'The file could not be read', 'Try loading it again.')); });
    e.target.value = '';
  });
  $('many-example').addEventListener('click', () => { manyKeys = null; $('many').value = exampleKeys(); showMany(); });
  $('many-clear').addEventListener('click', () => { manyKeys = null; $('many').value = ''; showMany(); });
  for (const id of ['layout-split', 'layout-nodes']) $(id).addEventListener('change', readLayout);
  $('split-n').addEventListener('input', () => { $('layout-split').checked = true; readLayout(); });
  $('nodes-text').addEventListener('input', debounce(() => { if ($('nodes-text').value.trim()) $('layout-nodes').checked = true; readLayout(); }, 250));

  readLayout();
})();
