// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Page logic for the Graph Key Builder. The work happens in ../graph.js;
// this file reads the inputs and draws the results.

(function () {
  'use strict';
  const G = window.KVGraph;
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => Number(n).toLocaleString('en-US');
  const SHOW = 500;

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
  function figure(value, label) {
    return el('div', { class: 'figure' }, [el('span', { class: 'value', text: value }), el('span', { class: 'label', text: label })]);
  }
  function table(head, rows) {
    const t = el('table');
    t.append(el('thead', null, [el('tr', null, head.map((h) => el('th', { class: h.num ? 'num' : '', text: h.text })))]));
    const body = el('tbody');
    for (const r of rows) body.append(el('tr', null, r.map((c, i) => el('td', { class: head[i].cls || (head[i].num ? 'num' : ''), text: c }))));
    t.append(body);
    return t;
  }
  function options(select, list, keep) {
    const before = select.value;
    select.textContent = '';
    for (const o of list) select.append(el('option', { value: o.value, text: o.text }));
    if (keep && list.some((o) => o.value === before)) select.value = before;
  }

  const EXAMPLE = [
    '# Who calls whom, what reads which database, which team owns what.',
    'web calls auth',
    'web calls cart',
    'web calls search',
    'cart calls pricing',
    'cart reads cart-db',
    'pricing reads pricing-db',
    'search reads search-index',
    'auth reads user-db',
    'payments-team owns cart',
    'payments-team owns pricing',
    'core-team owns auth'
  ].join('\n');

  let store = null;

  function render() {
    const out = $('result');
    out.textContent = '';
    const p = G.parseEdges($('in').value);
    for (const e of p.errors.slice(0, 5)) out.append(el('p', { class: 'error', text: `Line ${e.line}: ${e.message}` }));
    if (p.errors.length > 5) out.append(el('p', { class: 'error', text: `and ${fmt(p.errors.length - 5)} more lines like that` }));
    store = p.edges.length ? G.build(p.edges) : null;
    $('walk-section').hidden = !store;
    if (!store) return;

    out.append(el('div', { class: 'figures' }, [
      figure(fmt(store.nodes), store.nodes === 1 ? 'Node' : 'Nodes'),
      figure(fmt(store.links), store.links === 1 ? 'Link' : 'Links'),
      figure(fmt(store.entries.length), 'Keys in the store')
    ]));
    out.append(el('p', { class: 'muted small', text: 'Each node gets a record of its own under n/, where its fields would go. Each link is stored twice: under o/ with the node it leaves, and under i/ with the node it reaches, so it can be followed either way. A "/" or "%" inside a name is written %2F or %25.' }));
    const rows = store.entries.slice(0, SHOW).map((e) => [e.key, e.value]);
    const wrap = el('div', { class: 'table-wrap keys-wrap' }, [table([{ text: 'Key', cls: 'key' }, { text: 'Value', cls: 'key' }], rows)]);
    out.append(wrap);
    if (store.entries.length > SHOW) out.append(el('p', { class: 'muted small', text: `Showing the first ${fmt(SHOW)} of ${fmt(store.entries.length)} keys.` }));

    const n = G.names(store);
    options($('from'), n.nodes.map((x) => ({ value: x, text: x })), true);
    options($('type'), [{ value: '', text: 'Any type' }].concat(n.types.map((x) => ({ value: x, text: x }))), true);
    walk();
  }

  function walk() {
    const out = $('walk-result');
    out.textContent = '';
    if (!store || !$('from').value) return;
    const hops = Math.max(1, Math.min(10, parseInt($('hops').value, 10) || 1));
    const w = G.walk(store, $('from').value, { hops, dir: $('dir').value, type: $('type').value });
    out.append(el('div', { class: 'figures' }, [
      figure(fmt(w.reached), w.reached === 1 ? 'Node reached' : 'Nodes reached'),
      figure(fmt(w.scans), w.scans === 1 ? 'Prefix scan' : 'Prefix scans'),
      figure(fmt(w.keysRead), w.keysRead === 1 ? 'Key read' : 'Keys read')
    ]));
    for (const s of w.steps) {
      const read = s.scans.reduce((t, x) => t + x.keys.length, 0);
      out.append(el('h3', { text: `Hop ${s.hop}: ${fmt(s.scans.length)} prefix scan${s.scans.length === 1 ? '' : 's'}, ${fmt(read)} key${read === 1 ? '' : 's'} read` }));
      const rows = s.scans.map((x) => [x.prefix, fmt(x.keys.length), x.ends.length ? x.ends.join(', ') : 'nothing']);
      out.append(el('div', { class: 'table-wrap' }, [table([{ text: 'Prefix scanned', cls: 'key' }, { text: 'Keys read', num: true }, { text: 'Leads to' }], rows)]));
    }
    if (w.steps.length < w.hops) out.append(el('p', { class: 'muted small', text: `Hop ${w.steps.length} found no new nodes, so the walk stops there.` }));
  }

  let timer;
  $('in').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(render, 250); });
  for (const id of ['from', 'dir', 'type', 'hops']) $(id).addEventListener('change', walk);
  $('hops').addEventListener('input', walk);
  $('example').addEventListener('click', () => { $('in').value = EXAMPLE; render(); $('from').value = 'web'; walk(); });
  $('clear').addEventListener('click', () => { $('in').value = ''; render(); });
})();
