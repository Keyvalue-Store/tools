// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Page logic for the Keyspace Map. The analysis lives in ../keyspace.js;
// this file reads the inputs and draws the results.

(function () {
  'use strict';
  const K = window.KVKeyspace;
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => Number(n).toLocaleString('en-US');

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
    warn: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2l9 16H1z" fill="currentColor" opacity=".15"/><path d="M10 8v4.5M10 15.2v.3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    ok: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="9" fill="currentColor" opacity=".15"/><path d="M5.5 10.5l3 3 6-7" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  };
  function verdict(kind, title, body) {
    const box = el('div', { class: 'verdict ' + kind, role: 'status' });
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
  function sizeText(n) {
    if (n < 1024) return fmt(n) + ' bytes';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }
  function debounce(fn, ms) { let t; return function () { clearTimeout(t); t = setTimeout(fn, ms); }; }
  function csvCell(s) { return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }

  const SVGNS = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs, text) {
    const n = document.createElementNS(SVGNS, tag);
    for (const k of Object.keys(attrs || {})) n.setAttribute(k, attrs[k]);
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function barPath(x, y, w, h) { const r = Math.min(4, w, h / 2); return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`; }
  // Keys per pattern, biggest first. One series, so one colour; labels name the bars.
  function patternChart(patterns, total) {
    const rows = patterns.slice(0, 12);
    const rowH = 28, labelW = 300, W = 780, H = rows.length * rowH + 4;
    const max = Math.max(1, ...rows.map((p) => p.count));
    const plotW = W - labelW - 140;
    const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Keys per pattern' });
    rows.forEach((p, i) => {
      const y = i * rowH + 2;
      const label = p.pattern.length > 40 ? p.pattern.slice(0, 39) + '…' : p.pattern;
      s.append(svg('text', { x: labelW - 10, y: y + 17, 'text-anchor': 'end', 'font-family': 'ui-monospace, Menlo, Consolas, monospace' }, label));
      const w = Math.max(2, plotW * p.count / max);
      const bar = svg('path', { d: barPath(labelW, y + 4, w, rowH - 10), class: 'bar' });
      bar.append(svg('title', {}, `${p.pattern}: ${fmt(p.count)} keys (${(100 * p.count / total).toFixed(1)}%)`));
      s.append(bar);
      s.append(svg('text', { x: labelW + w + 8, y: y + 17 }, `${fmt(p.count)} (${(100 * p.count / total).toFixed(1)}%)`));
    });
    s.append(svg('line', { x1: labelW, y1: 0, x2: labelW, y2: H, class: 'axis' }));
    return el('div', { class: 'chart' }, [s]);
  }

  function treeNode(node, sep, total, depth) {
    const share = (100 * node.count / total).toFixed(1) + '%';
    const label = node.name + (node.children.length && sep ? sep : '');
    if (!node.children.length) return el('div', { class: 'leaf' }, [label, el('span', { class: 'n', text: `${fmt(node.count)} keys, ${share}` })]);
    const d = el('details', { class: 'node' });
    if (depth < 1) d.open = true;
    const extra = node.ends ? `, ${fmt(node.ends)} end here` : '';
    d.append(el('summary', null, [label, el('span', { class: 'n', text: `${fmt(node.count)} keys, ${share}${extra}` })]));
    for (const c of node.children) d.append(treeNode(c, sep, total, depth + 1));
    if (node.more) d.append(el('div', { class: 'leaf muted', text: `${fmt(node.more.nodes)} more, ${fmt(node.more.count)} keys` }));
    return d;
  }

  let fileKeys = null, fileName = '';

  function run() {
    const out = $('result');
    out.textContent = '';
    const keys = fileKeys || K.parseKeyList($('in').value, $('raw').checked);
    if (!keys.length) return;
    const r = K.analyze(keys, { separator: $('sep').value, fold: $('fold').checked, foldBusy: $('busy').checked });
    if (fileKeys) out.append(el('p', { class: 'muted small', text: `Loaded ${fileName}. Typing in the box above replaces it.` }));
    out.append(el('div', { class: 'figures' }, [
      figure(fmt(r.total), 'Keys'),
      figure(fmt(r.patterns.length), 'Patterns'),
      figure(sizeText(r.totalBytes), 'Of key names'),
      figure(r.separator ? '"' + r.separator + '"' : 'None', 'Separator')
    ]));
    if (r.findings.length) {
      out.append(el('h3', { text: 'Worth a look' }));
      for (const f of r.findings) out.append(verdict('warn', `${f.label}: ${fmt(f.count)}`, [(f.text.startsWith('prefixes') ? 'These ' : 'These keys ') + f.text, 'For example: ' + f.examples.join(', ')]));
    } else out.append(verdict('ok', 'No naming slips found', 'Every key uses the same separator, and no prefixes look like typos or case variants of each other.'));
    out.append(el('h3', { text: 'Patterns' }));
    out.append(el('p', { class: 'muted small', text: 'Parts that vary are folded: <id> for numbers, <hex> for hashes, <uuid>, <date>, <email>, <ip>, <token> for long random strings, and <*> for a level of one-off names. Braces stay, since they mark hash tags.' }));
    out.append(patternChart(r.patterns, r.total));
    const wrap = el('div', { class: 'table-wrap' });
    const t = el('table');
    t.append(el('thead', null, [el('tr', null, [el('th', { text: 'Pattern' }), el('th', { class: 'num', text: 'Keys' }), el('th', { class: 'num', text: 'Share' }), el('th', { class: 'num', text: 'Average length' }), el('th', { text: 'Example' })])]));
    const body = el('tbody');
    for (const p of r.patterns.slice(0, 100)) {
      body.append(el('tr', null, [
        el('td', { class: 'key', text: p.pattern }), el('td', { class: 'num', text: fmt(p.count) }),
        el('td', { class: 'num', text: (100 * p.count / r.total).toFixed(1) + '%' }),
        el('td', { class: 'num', text: fmt(Math.round(p.bytes / p.count)) + ' bytes' }),
        el('td', { class: 'key', text: p.examples[0] })
      ]));
    }
    t.append(body); wrap.append(t); out.append(wrap);
    const row = el('div', { class: 'row' });
    if (r.patterns.length > 100) row.append(el('span', { class: 'muted small', text: `Showing 100 of ${fmt(r.patterns.length)} patterns.` }));
    const btn = el('button', { type: 'button', class: 'btn primary', text: 'Download the patterns as CSV' });
    btn.addEventListener('click', () => {
      const lines = ['pattern,keys,share,key_bytes,example'];
      for (const p of r.patterns) lines.push([csvCell(p.pattern), p.count, (p.count / r.total).toFixed(6), p.bytes, csvCell(p.examples[0] || '')].join(','));
      const url = URL.createObjectURL(new Blob([lines.join('\n') + '\n'], { type: 'text/csv' }));
      const a = el('a', { href: url, download: 'key-patterns.csv' }); document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    row.append(btn);
    out.append(row);
    out.append(el('h3', { text: 'Tree' }));
    const tree = K.tree(r.root, 50);
    const box = el('div', { class: 'tree-root' });
    for (const c of tree.children) box.append(treeNode(c, r.separator, r.total, 0));
    if (tree.more) box.append(el('div', { class: 'leaf muted', text: `${fmt(tree.more.nodes)} more, ${fmt(tree.more.count)} keys` }));
    out.append(box);
  }

  function example() {
    let seed = 11;
    const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; };
    const ri = (n) => Math.floor(rnd() * n);
    const hex = (n) => { let s = ''; for (let i = 0; i < n; i++) s += '0123456789abcdef'[ri(16)]; return s; };
    const word = () => { let s = ''; const n = 4 + ri(5); for (let i = 0; i < n; i++) s += 'abcdefghijklmnoprstuvy'[ri(22)]; return s; };
    const lines = [];
    for (let i = 0; i < 1200; i++) lines.push(`user:${100000 + ri(900000)}:profile`);
    for (let i = 0; i < 600; i++) lines.push(`user:${100000 + ri(900000)}:settings`);
    for (let i = 0; i < 500; i++) lines.push(`session:${hex(32)}`);
    for (let i = 0; i < 300; i++) lines.push(`cart:{${ri(50000)}}:items`);
    for (let i = 0; i < 200; i++) lines.push(`feed:2026-10-${String(1 + ri(28)).padStart(2, '0')}:${ri(100000)}`);
    for (let i = 0; i < 120; i++) lines.push(`member:${word()}${i}:avatar`);
    for (let i = 0; i < 80; i++) lines.push(`rate:203.0.113.${ri(255)}`);
    lines.push('usr:100231:profile', 'usr:100988:profile', 'User:100410:profile', 'config', 'cache::homepage');
    return lines.join('\n');
  }

  const later = debounce(run, 300);
  $('in').addEventListener('input', () => { fileKeys = null; later(); });
  for (const id of ['sep', 'fold', 'busy']) $(id).addEventListener('change', run);
  $('raw').addEventListener('change', () => { if (fileKeys && fileBytes) fileKeys = K.parseKeyBuffer(fileBytes, $('raw').checked); run(); });
  let fileBytes = null;
  $('in-file').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    f.arrayBuffer().then((buf) => {
      fileBytes = new Uint8Array(buf);
      fileKeys = K.parseKeyBuffer(fileBytes, $('raw').checked);
      fileName = `${f.name}, ${fmt(fileKeys.length)} keys`;
      $('in').value = '';
      run();
    });
    e.target.value = '';
  });
  $('example').addEventListener('click', () => { fileKeys = null; $('in').value = example(); run(); });
  $('clear').addEventListener('click', () => { fileKeys = null; $('in').value = ''; run(); });
})();
