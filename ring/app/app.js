// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Page logic for the Consistent Hashing Playground. The hashing lives in
// ../ring.js; this file reads the controls and draws the ring and charts.

(function () {
  'use strict';
  const R = window.KVRing;
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => Number(n).toLocaleString('en-US');
  // Node colours: a fixed categorical order, checked for colour-blind contrast.
  const COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948', '#5F6B7A'];
  const SVGNS = 'http://www.w3.org/2000/svg';

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
  function svg(tag, attrs, text) {
    const n = document.createElementNS(SVGNS, tag);
    for (const k of Object.keys(attrs || {})) n.setAttribute(k, attrs[k]);
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function fillChange() {
    const n = +$('nodes').value;
    const sel = $('change');
    const old = sel.value;
    sel.textContent = '';
    sel.append(el('option', { value: 'add', text: `Add node-${n + 1}` }));
    for (let i = 1; i <= n; i++) sel.append(el('option', { value: 'remove-' + i, text: `Remove node-${i}` }));
    sel.value = Array.from(sel.options).some((o) => o.value === old) ? old : 'add';
  }

  // The ring after the change: each node's points as ticks on the circle,
  // a sample of keys inside it, and the keys that moved drawn larger.
  function ringPicture(nodes, keys, before, after, beforeNodes) {
    const size = 420, c = size / 2, rOuter = 180, rKeys = 150;
    const s = svg('svg', { viewBox: `0 0 ${size} ${size}`, role: 'img', 'aria-label': 'The hash ring after the change, with the keys that moved drawn larger', class: 'ring-svg' });
    s.append(svg('circle', { cx: c, cy: c, r: rOuter, fill: 'none', stroke: '#DCE3EA', 'stroke-width': 10 }));
    const f = R.ALGORITHMS.ring.build(nodes, { vnodes: +$('vnodes').value });
    const ang = (h) => (h / 4294967296) * Math.PI * 2 - Math.PI / 2;
    for (let i = 0; i < f.points.length; i++) {
      const a = ang(f.points[i]);
      const x1 = c + (rOuter - 6) * Math.cos(a), y1 = c + (rOuter - 6) * Math.sin(a);
      const x2 = c + (rOuter + 6) * Math.cos(a), y2 = c + (rOuter + 6) * Math.sin(a);
      s.append(svg('line', { x1, y1, x2, y2, stroke: COLORS[f.owner[i] % COLORS.length], 'stroke-width': 2 }));
    }
    const step = Math.max(1, Math.floor(keys.length / 600));
    const moved = svg('g');
    for (let i = 0; i < keys.length; i += step) {
      const a = ang(R.murmur3(keys[i], 0));
      const owner = after[i];
      const wasMoved = beforeNodes[before[i]] !== nodes[owner];
      const rr = rKeys - (i % 7) * 9;
      const dot = svg('circle', { cx: c + rr * Math.cos(a), cy: c + rr * Math.sin(a), r: wasMoved ? 4.5 : 2.2, fill: COLORS[owner % COLORS.length] });
      if (wasMoved) { dot.setAttribute('stroke', '#17212E'); dot.setAttribute('stroke-width', '1.5'); moved.append(dot); }
      else s.append(dot);
    }
    s.append(moved);
    s.append(svg('text', { x: c, y: c - 6, 'text-anchor': 'middle', 'font-size': 15, fill: '#17212E', 'font-weight': 700 }, 'Hash ring'));
    s.append(svg('text', { x: c, y: c + 14, 'text-anchor': 'middle', 'font-size': 12, fill: '#5F6B7A' }, 'Large dots moved'));
    return s;
  }

  // Keys per node after the change, one small chart per method.
  function loadChart(nodes, counts, mean) {
    const W = 260, rowH = 20, labelW = 64, H = nodes.length * rowH + 8;
    const max = Math.max(1, ...counts, mean * 1.3);
    const plotW = W - labelW - 46;
    const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Keys per node' });
    nodes.forEach((n, i) => {
      const y = i * rowH + 4;
      const w = Math.max(1, plotW * counts[i] / max);
      s.append(svg('text', { x: labelW - 6, y: y + 13, 'text-anchor': 'end', 'font-size': 11 }, n));
      const r = Math.min(4, w, 6);
      const bar = svg('path', { d: `M${labelW},${y + 2}H${labelW + w - r}Q${labelW + w},${y + 2} ${labelW + w},${y + 2 + r}V${y + 14 - r}Q${labelW + w},${y + 14} ${labelW + w - r},${y + 14}H${labelW}Z`, fill: COLORS[i % COLORS.length] });
      bar.append(svg('title', {}, `${n}: ${fmt(counts[i])} keys`));
      s.append(bar);
      s.append(svg('text', { x: Math.max(labelW + w, labelW + plotW * mean / max) + 5, y: y + 13, 'font-size': 11 }, fmt(counts[i])));
    });
    const mx = labelW + plotW * mean / max;
    s.append(svg('line', { x1: mx, y1: 0, x2: mx, y2: H, stroke: '#17212E', 'stroke-dasharray': '3 3', 'stroke-width': 1 }));
    return el('div', { class: 'chart' }, [s]);
  }

  function run() {
    const n = +$('nodes').value;
    $('nodes-out').textContent = n;
    $('vnodes-out').textContent = $('vnodes').value;
    const out = $('result');
    out.textContent = '';
    const keys = R.sampleKeys(+$('count').value);
    const ch = $('change').value;
    const change = ch === 'add' ? { type: 'add' } : { type: 'remove', index: +ch.split('-')[1] - 1 };
    const opt = { vnodes: +$('vnodes').value };
    const e = R.experiment(keys, n, change, opt);
    const idealPct = 100 * e.ideal / keys.length;

    // Table of the four methods.
    const wrap = el('div', { class: 'table-wrap' });
    const t = el('table');
    t.append(el('thead', null, [el('tr', null, [el('th', { text: 'Method' }), el('th', { class: 'num', text: 'Keys moved' }),
      el('th', { class: 'num', text: 'Moved between nodes that stayed' }), el('th', { class: 'num', text: 'Busiest node, vs an even share' })])]));
    const body = el('tbody');
    for (const [algo, r] of Object.entries(e.results)) {
      const pct = 100 * r.moved / keys.length;
      const note = algo === 'jump' && change.type === 'remove' && change.index !== n - 1 ? ` (removed ${r.removedNode})` : '';
      body.append(el('tr', null, [
        el('td', null, [el('strong', { text: R.ALGORITHMS[algo].name }), el('div', { class: 'muted small', text: R.ALGORITHMS[algo].note + note })]),
        el('td', { class: 'num', text: pct.toFixed(1) + '%' }),
        el('td', { class: 'num', text: fmt(r.needless) }),
        el('td', { class: 'num', text: r.after.maxOverMean.toFixed(2) + '×' })
      ]));
    }
    t.append(body); wrap.append(t);

    const what = change.type === 'add' ? `Adding node-${n + 1}` : `Removing node-${change.index + 1}`;
    const ringNodes = e.after;
    const before = R.assign('ring', e.before, keys, opt);
    const after = R.assign('ring', ringNodes, keys, opt);
    const grid = el('div', { class: 'ring-wrap' });
    const left = el('div');
    left.append(ringPicture(ringNodes, keys, before, after, e.before));
    const legend = el('div', { class: 'legend' });
    ringNodes.forEach((name, i) => legend.append(el('span', null, [el('i', { style: 'background:' + COLORS[i % COLORS.length] }), name])));
    left.append(legend);
    const right = el('div');
    right.append(el('p', null, [el('strong', { text: `${what}: a perfect method moves ${idealPct.toFixed(1)}% of the keys, ` }),
      change.type === 'add' ? 'the new node\'s fair share.' : 'the share the leaving node held.']));
    right.append(wrap);
    right.append(el('p', { class: 'muted small', text: 'Modulo hashing has to move most keys, and most of those between nodes that never changed. The other three move close to the minimum and never move a key between two nodes that stayed. The ring evens out as you add virtual nodes.' }));
    if (change.type === 'remove' && change.index !== n - 1) right.append(el('p', { class: 'muted small', text: `Jump hash numbers its nodes, so it can only drop the last one: node-${n}.` }));
    grid.append(left, right);
    out.append(grid);

    out.append(el('h3', { text: 'Keys per node after the change' }));
    out.append(el('p', { class: 'muted small', text: 'The dashed line is an even share.' }));
    const multiples = el('div', { class: 'multiples' });
    for (const [algo, r] of Object.entries(e.results)) {
      const nodesAfter = algo === 'jump' && change.type === 'remove' ? e.before.slice(0, n - 1) : e.after;
      const card = el('div', { class: 'card' });
      card.append(el('h4', { text: R.ALGORITHMS[algo].name }));
      card.append(loadChart(nodesAfter, r.after.counts, r.after.mean));
      multiples.append(card);
    }
    out.append(multiples);
  }

  let timer;
  const later = () => { clearTimeout(timer); timer = setTimeout(run, 120); };
  $('nodes').addEventListener('input', () => { fillChange(); later(); });
  $('vnodes').addEventListener('input', later);
  $('count').addEventListener('change', run);
  $('change').addEventListener('change', run);
  fillChange();
  run();
})();
