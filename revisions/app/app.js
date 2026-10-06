// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Page logic for the Revision Viewer. The file is read by session.js, in a
// worker when the browser allows one; this asks it questions and draws the
// answers.

(function () {
  'use strict';
  const R = window.KVRevisions;
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => Number(n).toLocaleString('en-US');
  const size = (n) => R.human(n);
  const pct = (x) => (x >= 0.1 ? (100 * x).toFixed(1) : x >= 0.001 ? (100 * x).toFixed(2) : x > 0 ? '< 0.1' : '0');
  const plural = (n, one, many) => fmt(n) + ' ' + (n === 1 ? one : many);
  const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

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
    bad: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="9" fill="currentColor" opacity=".15"/><path d="M6.5 6.5l7 7M13.5 6.5l-7 7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    ok: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="9" fill="currentColor" opacity=".15"/><path d="M5.5 10.5l3 3 6-7" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    info: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="9" fill="currentColor" opacity=".15"/><path d="M10 9v5M10 6.2v.3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
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
  const figure = (value, label) => el('div', { class: 'figure' }, [el('span', { class: 'value', text: value }), el('span', { class: 'label', text: label })]);
  function table(headers, rows, numeric, cls) {
    const wrap = el('div', { class: 'table-wrap' + (cls ? ' ' + cls : '') });
    const t = el('table');
    t.append(el('thead', null, [el('tr', null, headers.map((h, i) => el('th', { class: numeric && numeric.includes(i) ? 'num' : '', text: h })))]));
    const body = el('tbody');
    for (const r of rows) body.append(r instanceof HTMLElement ? r : el('tr', null, r.map((c, i) => el('td', { class: numeric && numeric.includes(i) ? 'num' : '' }, [c]))));
    t.append(body);
    wrap.append(t);
    return wrap;
  }
  // A table row that does something when picked, by mouse or keyboard.
  function pickRow(cells, numeric, onPick, keyCol) {
    const tr = el('tr', { class: 'pick', tabindex: '0' }, cells.map((c, i) => el('td', { class: (numeric && numeric.includes(i) ? 'num' : '') + (i === keyCol ? ' key' : '') }, [c])));
    tr.addEventListener('click', onPick);
    tr.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onPick(); } });
    return tr;
  }
  // A table that shows its first rows and a button for the rest. total:
  // how many rows there are in all, when rows holds only the first of them.
  function longTable(headers, rows, numeric, cls, first, total) {
    const box = el('div');
    const draw = (all) => {
      box.textContent = '';
      box.append(table(headers, all ? rows : rows.slice(0, first), numeric, cls));
      if (!all && rows.length > first) {
        const b = el('button', { type: 'button', class: 'linkish small', text: total > rows.length ? `Show ${fmt(rows.length)} of ${fmt(total)}` : `Show all ${fmt(rows.length)}` });
        b.addEventListener('click', () => draw(true));
        box.append(el('p', { class: 'small' }, [b]));
      }
    };
    draw(false);
    return box;
  }
  // One short line for screen readers, such as the revision just shown.
  // Emptied first, so the same line twice is read twice.
  let announcing;
  function announce(text) {
    const box = $('announce');
    box.textContent = '';
    clearTimeout(announcing);
    announcing = setTimeout(() => { box.textContent = text; }, 60);
  }
  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type: type }));
    const a = el('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---- The session: in a worker, or in the page ----

  function localClient() {
    const s = window.KVRevisionsSession(R);
    const digest = window.crypto && window.crypto.subtle ? async (b) => hex(new Uint8Array(await window.crypto.subtle.digest('SHA-256', b))) : null;
    return { worker: false, call: (method, ...args) => Promise.resolve().then(() => (method === 'open' ? s.open(args[0], args[1], digest) : s[method](...args))) };
  }
  // A worker that answers, or null. onStop runs if it stops later on.
  function workerClient(onStop) {
    return new Promise((resolve) => {
      let w;
      try { w = new Worker('worker.js'); } catch (e) { resolve(null); return; }
      const pending = new Map();
      let next = 1, ready = false, stopped = false;
      const stop = (why) => {
        stopped = true;
        w.terminate();
        for (const p of pending.values()) p.reject(new Error(why));
        pending.clear();
      };
      w.onmessage = (ev) => {
        const p = pending.get(ev.data.id);
        if (!p) return;
        pending.delete(ev.data.id);
        if (ev.data.error !== undefined) p.reject(new Error(ev.data.error)); else p.resolve(ev.data.value);
      };
      // The worker catches its own errors, so an error here means it broke
      // down, most likely out of memory, and can't be trusted again.
      w.onerror = (ev) => {
        if (ev && ev.preventDefault) ev.preventDefault();
        stop('The page\'s reader stopped, most likely for lack of memory.');
        if (ready) onStop(); else resolve(null);
      };
      const call = (method, ...args) => {
        if (stopped) return Promise.reject(new Error('The page\'s reader stopped. Open the file again.'));
        return new Promise((res, rej) => {
          const id = next++;
          pending.set(id, { resolve: res, reject: rej });
          w.postMessage({ id: id, method: method, args: args }, method === 'open' ? [args[0]] : []);
        });
      };
      const timer = setTimeout(() => { stop('The page\'s reader did not start.'); resolve(null); }, 4000);
      call('ping').then(() => { ready = true; clearTimeout(timer); resolve({ worker: true, call: call }); }, () => { clearTimeout(timer); resolve(null); });
    });
  }
  // One session for the page, made on first use, so two files opened in
  // quick succession share it. If its worker stops, the next use makes a
  // new one.
  let client = null;
  function session() {
    if (!client) {
      const made = workerClient(() => { if (client === made) client = null; }).then((c) => c || localClient());
      client = made;
    }
    return client;
  }

  // ---- Opening a file ----

  // opening counts the files picked. Each takes a ticket when picked, before
  // its bytes are read, so whatever happens to one picked before the latest
  // is dropped, even when a small file picked second is read first.
  let overview = null, opening = 0;
  const ticketNow = () => ++opening;
  async function openFile(buffer, name, ticket) {
    if (ticket !== opening) return;
    overview = null;
    $('result').textContent = '';
    $('browse').hidden = true;
    $('detail').textContent = '';
    const status = $('status');
    status.textContent = '';
    status.append(el('p', { class: 'muted small', text: `Reading ${name}, ${size(buffer.byteLength)}…` }), el('div', { class: 'progress busy' }, [el('span')]));
    await new Promise((r) => setTimeout(r, 30));
    if (ticket !== opening) return;
    let o;
    try {
      const c = await session();
      if (ticket !== opening) return;
      o = await c.call('open', buffer, name);
    } catch (err) {
      if (ticket !== opening) return;
      status.textContent = '';
      $('result').append(verdict('bad', 'This file could not be read', [err && err.message ? err.message : String(err)]));
      return;
    }
    if (ticket !== opening || !o) return;
    overview = o;
    status.textContent = '';
    render();
    browseReset();
  }

  // ---- The overview ----

  const QUOTAS = [[2, '2 GiB, the default'], [4, '4 GiB'], [8, '8 GiB, the most etcd suggests'], [16, '16 GiB'], [32, '32 GiB']];
  // quotaText: the size last typed for a quota not in the list, as typed.
  let prefixUnder = '', prefixDepth = 3, quotaText = '';

  function render() {
    const o = overview;
    const out = $('result');
    out.textContent = '';
    const etcd = o.etcd.storageVersion ? 'etcd ' + o.etcd.storageVersion.replace(/\.0$/, '') : o.etcd.clusterVersion ? 'etcd ' + o.etcd.clusterVersion.replace(/\.0$/, '') : 'etcd';
    out.append(el('div', { class: 'figures' }, [
      figure(size(o.size.database), 'Database size'),
      figure(pct(o.size.quotaUsed) + '%', 'Of a ' + size(o.size.quota) + ' quota'),
      figure(fmt(o.keys.live), 'Keys'),
      figure(fmt(o.keys.revisions), 'Revisions kept'),
      figure(String(o.etcd.revision), 'Current revision'),
      figure(pct(o.space.free / (o.size.database || 1)) + '%', 'Free pages')
    ]));

    const facts = el('dl', { class: 'facts' });
    const fact = (k, v) => { facts.append(el('dt', { text: k }), el('dd', null, [v])); };
    fact('File', `${o.name}: ${o.file.snapshot ? 'a snapshot' : 'a member\'s database file'}, ${size(o.file.bytes)}`);
    fact('Written by', etcd + (o.etcd.storageVersion ? '' : ' (3.5 or older keeps no storage version)'));
    fact('SHA-256', o.file.sha256 ? (o.file.sha256.matches ? 'matches the one etcdctl wrote at the end' : 'DOES NOT MATCH the one etcdctl wrote at the end') : 'none: a member\'s own file has no hash at the end');
    fact('Compaction', o.etcd.compactedAt ? `compacted at revision ${o.etcd.compactedAt}; the oldest revision left is ${o.etcd.oldestRevision}` : 'never compacted');
    fact('Members', o.members.length ? o.members.map((m) => (m.name || m.id) + (m.learner ? ' (learner)' : '') + (m.peerURLs.length ? ' at ' + m.peerURLs.join(', ') : '')).join('; ') : 'none recorded');
    fact('Alarms', o.alarms.length ? o.alarms.map((a) => a.alarm + ' on member ' + a.member).join(', ') : 'none');
    fact('Authentication', o.auth.enabled ? `on: ${plural(o.auth.users.length, 'user', 'users')} (${o.auth.users.join(', ')}), ${plural(o.auth.roles.length, 'role', 'roles')}` : 'off');
    fact('Leases', o.leaseCount ? plural(o.leaseCount, 'lease', 'leases') + ', with ' + plural(o.leaseKeys, 'key', 'keys') + ' attached' : 'none');
    fact('Pages', `${plural(o.pages.belowHighWater, 'page', 'pages')} of ${size(o.file.pageSize)}: ${fmt(o.pages.inUse)} in use, ${fmt(o.pages.free)} free`);
    if (o.kubernetes) fact('Kubernetes', `${plural(o.kubernetes.kinds.reduce((a, k) => a + k.objects, 0), 'object', 'objects')}, shown with the field names of Kubernetes ${o.kubernetesVersion || ''}`.trim());
    out.append(facts);

    // The quota changes what counts as close to full. Any size can be typed,
    // as the command line's --quota takes it.
    const listed = QUOTAS.find(([g]) => g * R.GiB === o.size.quota);
    const sel = el('select', { id: 'quota' });
    for (const [g, label] of QUOTAS) sel.append(el('option', { value: String(g), text: label }));
    sel.append(el('option', { value: 'other', text: 'Another size' }));
    sel.value = listed ? String(listed[0]) : 'other';
    const typed = el('input', { type: 'text', id: 'quota-size', class: 'mono', autocomplete: 'off', spellcheck: 'false', placeholder: '6GiB', 'aria-describedby': 'quota-hint' });
    typed.value = listed ? '' : quotaText || String(o.size.quota);
    const hint = el('span', { id: 'quota-hint', class: 'hint', text: 'Such as 6GiB or 8589934592' });
    const set = el('button', { type: 'button', class: 'btn', text: 'Set' });
    const other = el('span', { class: 'quota-other' }, [el('label', { for: 'quota-size', class: 'sr-only', text: 'Quota size' }), typed, set, hint]);
    other.hidden = Boolean(listed);
    const setQuota = async (bytes, focus) => {
      overview = await (await session()).call('setQuota', bytes);
      render();
      $(focus).focus();
    };
    sel.addEventListener('change', () => {
      if (sel.value !== 'other') { setQuota(Number(sel.value) * R.GiB, 'quota'); return; }
      other.hidden = false;
      typed.focus();
    });
    const apply = () => {
      const bytes = R.parseSize(typed.value);
      if (!(bytes > 0)) {
        typed.setAttribute('aria-invalid', 'true');
        hint.className = 'error small';
        hint.textContent = 'Type a size, such as 6GiB or 8589934592';
        announce(hint.textContent);
        typed.focus();
        return;
      }
      quotaText = typed.value.trim();
      setQuota(bytes, QUOTAS.some(([g]) => g * R.GiB === bytes) ? 'quota' : 'quota-size');
    };
    set.addEventListener('click', apply);
    typed.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); apply(); } });
    out.append(el('div', { class: 'row' }, [el('label', { for: 'quota', text: 'The cluster\'s quota (--quota-backend-bytes)' }), sel, other]));

    out.append(el('h3', { text: 'What to look at' }));
    if (!o.findings.length) out.append(verdict('ok', 'Nothing stands out', 'No alarm, the database is far from its quota, and nothing takes an unusual share of it.'));
    for (const f of o.findings) out.append(verdict(f.level, f.title, f.text));

    out.append(el('h3', { text: 'Where the space goes' }));
    out.append(spaceChart(o.space));

    if (o.kubernetes && o.kubernetes.resources.length) {
      out.append(el('h3', { text: 'Kubernetes resources' }));
      out.append(el('p', { class: 'muted small', text: 'Bytes of current values, and of old revisions and deletions not yet compacted away. Pick a resource to list its keys.' }));
      const rows = o.kubernetes.resources.map((r) => pickRow([r.resource, fmt(r.keys), size(r.bytes), size(r.historyBytes), fmt(r.revisions)], [1, 2, 3, 4], () => { browseTo(r.prefix); }));
      out.append(longTable(['Resource', 'Objects', 'Now', 'Old revisions', 'Revisions'], rows, [1, 2, 3, 4], 'pick-table', 12));
      out.append(el('h3', { text: 'Kinds' }));
      const kinds = o.kubernetes.kinds.map((k) => [(k.apiVersion ? k.apiVersion + ' ' : '') + k.kind, k.format === 'json' ? 'JSON' : 'protobuf', fmt(k.objects), size(k.bytes),
        k.bytes ? pct(k.managedFieldsBytes / k.bytes) + '%' : '']);
      out.append(longTable(['Kind', 'Stored as', 'Objects', 'Bytes', 'managedFields'], kinds, [2, 3, 4], '', 10));
    }

    out.append(el('h3', { text: 'Key prefixes' }));
    const prefixBox = el('div', { id: 'prefixes' });
    out.append(prefixBox);
    drawPrefixes();

    const split = el('div', { class: 'two-col' });
    const left = el('div'), right = el('div');
    left.append(el('h3', { text: 'Biggest keys' }));
    left.append(table(['Key', 'Now', 'Revisions'], o.biggestKeys.filter((k) => k.live).slice(0, 10).map((k) => pickRow([k.key, size(k.bytes), fmt(k.revisions)], [1, 2], () => showKey(k.key, true), 0)), [1, 2], 'pick-table'));
    right.append(el('h3', { text: 'Most revisions kept' }));
    const most = o.mostRevisions.filter((k) => k.revisions > 1).slice(0, 10);
    if (most.length) right.append(table(['Key', 'Revisions', 'Old revisions'], most.map((k) => pickRow([k.key, fmt(k.revisions), size(k.historyBytes)], [1, 2], () => showKey(k.key, true), 0)), [1, 2], 'pick-table'));
    else right.append(el('p', { class: 'muted', text: 'Every key has one revision: the file holds no history.' }));
    split.append(left, right);
    out.append(split);

    if (o.leaseList.length) {
      out.append(el('h3', { text: 'Leases' }));
      out.append(el('p', { class: 'muted small', text: 'Keys attached to a lease are deleted when it expires. kube-apiserver puts events on leases of an hour. The leases with the most keys come first.' }));
      out.append(table(['Lease ID', 'TTL', 'Keys'], o.leaseList.map((l) => [el('span', { class: 'mono', text: l.id }), fmt(l.ttl) + ' s', fmt(l.keys)]), [1, 2]));
      const rest = o.leaseCount - o.leaseList.length;
      if (rest > 0) out.append(el('p', { class: 'muted small', text: `And ${plural(rest, 'more lease', 'more leases')}.` }));
    }

    const base = o.name.replace(/\.[^.]*$/, '');
    const b1 = el('button', { type: 'button', class: 'btn primary', text: 'Download every key as CSV' });
    b1.addEventListener('click', async () => download(base + '-keys.csv', await (await session()).call('csv'), 'text/csv'));
    const b2 = el('button', { type: 'button', class: 'btn', text: 'Download the report as JSON' });
    b2.addEventListener('click', async () => download(base + '-report.json', await (await session()).call('reportJson'), 'application/json'));
    out.append(el('div', { class: 'row' }, [b1, b2]));
  }

  // One bar: current values, old revisions, the rest in use, free pages.
  const SVGNS = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs, text) {
    const n = document.createElementNS(SVGNS, tag);
    for (const k of Object.keys(attrs || {})) n.setAttribute(k, attrs[k]);
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function spaceChart(sp) {
    const parts = [
      ['values', 'Current values', sp.values],
      ['history', 'Old revisions and deletions', sp.history],
      ['other', 'Page structure, half-filled pages and etcd\'s bookkeeping', sp.other],
      ['free', 'Free pages', sp.free]
    ];
    const total = Math.max(1, parts.reduce((a, p) => a + p[2], 0));
    const W = 760, H = 34;
    const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', class: 'space', role: 'img', 'aria-label': parts.map((p) => `${p[1]}: ${size(p[2])}`).join('; ') });
    let x = 0;
    for (const [cls, label, n] of parts) {
      const w = W * n / total;
      if (w <= 0) continue;
      const r = svg('rect', { x: x.toFixed(2), y: 2, width: Math.max(w, 1.5).toFixed(2), height: H - 4, class: 'seg ' + cls });
      r.append(svg('title', {}, `${label}: ${size(n)}, ${pct(n / total)}%`));
      s.append(r);
      x += w;
    }
    const legend = el('ul', { class: 'legend' }, parts.map(([cls, label, n]) => el('li', null, [el('span', { class: 'swatch ' + cls }), `${label}: ${size(n)} (${pct(n / total)}%)`])));
    return el('div', { class: 'chart' }, [s, legend]);
  }

  async function drawPrefixes() {
    const box = $('prefixes');
    if (!box) return;
    const depth = prefixUnder ? 1 : prefixDepth;
    const res = await (await session()).call('prefixes', depth, prefixUnder);
    box.textContent = '';
    const crumbs = el('div', { class: 'crumbs' });
    const go = (p) => { prefixUnder = p; drawPrefixes(); };
    const top = el('button', { type: 'button', class: 'linkish', text: 'All keys' });
    top.addEventListener('click', () => go(''));
    crumbs.append(top);
    if (prefixUnder) {
      const parts = prefixUnder.split('/');
      let acc = '';
      parts.forEach((part, i) => {
        if (i === parts.length - 1) return;
        acc += part + '/';
        const here = acc;
        crumbs.append(' › ');
        if (i === parts.length - 2) crumbs.append(el('span', { class: 'mono', text: part + '/' }));
        else {
          const b = el('button', { type: 'button', class: 'linkish mono', text: part + '/' });
          b.addEventListener('click', () => go(here));
          crumbs.append(b);
        }
      });
    }
    const controls = el('div', { class: 'row' }, [crumbs]);
    if (!prefixUnder) {
      const sel = el('select', { id: 'depth' });
      for (let d = 1; d <= 5; d++) sel.append(el('option', { value: String(d), text: plural(d, 'level', 'levels') }));
      sel.value = String(prefixDepth);
      sel.addEventListener('change', () => { prefixDepth = Number(sel.value); drawPrefixes(); });
      controls.append(el('span', { class: 'spacer' }), el('label', { for: 'depth', class: 'small', text: 'Group by' }), sel);
    } else {
      const b = el('button', { type: 'button', class: 'btn', text: 'List these keys' });
      b.addEventListener('click', () => browseTo(prefixUnder));
      controls.append(el('span', { class: 'spacer' }), b);
    }
    box.append(controls);
    const capped = res.total > res.rows.length ? ` There are ${fmt(res.total)}; the list holds the ${fmt(res.rows.length)} biggest.` : '';
    box.append(el('p', { class: 'muted small', text: (prefixUnder ? 'One level further down. Pick a prefix to go deeper.' : 'Keys grouped by their first parts, split on "/". Pick a prefix to look inside it.') + capped }));
    const rows = res.rows.map((p) => pickRow([p.prefix || '(keys with no "/")', fmt(p.liveKeys), size(p.bytes), size(p.historyBytes), fmt(p.revisions)], [1, 2, 3, 4], () => {
      if (p.prefix && p.prefix !== prefixUnder) go(p.prefix); else browseTo(p.prefix);
    }, 0));
    box.append(longTable(['Prefix', 'Keys', 'Now', 'Old revisions', 'Revisions'], rows, [1, 2, 3, 4], 'pick-table', 15, res.total));
  }

  // ---- Browsing the keys ----

  let browsePrefix = '', shown = 50;
  function browseReset() {
    browsePrefix = '';
    $('filter').value = '';
    $('show').value = 'all';
    $('sort').value = 'key';
    $('browse').hidden = false;
    listKeys(false);
  }
  function browseTo(prefix) {
    browsePrefix = prefix || '';
    $('filter').value = '';
    listKeys(false);
    $('browse').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  async function listKeys(more) {
    shown = more ? shown + 50 : 50;
    const res = await (await session()).call('keys', { query: $('filter').value, show: $('show').value, sort: $('sort').value, prefix: browsePrefix, limit: shown });
    const box = $('matches');
    box.textContent = '';
    if (browsePrefix) {
      const clear = el('button', { type: 'button', class: 'linkish', text: 'show all keys' });
      clear.addEventListener('click', () => { browsePrefix = ''; listKeys(false); });
      box.append(el('p', { class: 'small' }, ['Keys under ', el('code', { text: browsePrefix }), ' (', clear, ')']));
    }
    box.append(el('p', { class: 'muted small', text: res.total > res.rows.length ? `${fmt(res.total)} keys match. Showing the first ${fmt(res.rows.length)}.` : `${plural(res.total, 'key matches', 'keys match')}.` }));
    const rows = res.rows.map((k) => pickRow([k.key, k.live ? size(k.bytes) : 'deleted', fmt(k.revisions), k.kind], [1, 2], () => showKey(k.key, false), 0));
    box.append(table(['Key', 'Now', 'Revisions', 'Kind'], rows, [1, 2], 'pick-table keys-table'));
    if (res.total > res.rows.length) {
      const b = el('button', { type: 'button', class: 'btn', text: 'Show 50 more' });
      b.addEventListener('click', () => listKeys(true));
      box.append(el('div', { class: 'row' }, [b]));
    }
  }

  let current = null;
  async function showKey(key, scroll) {
    const c = await session();
    const k = await c.call('key', key);
    const box = $('detail');
    box.textContent = '';
    if (!k) return;
    current = k;
    box.append(el('h3', { class: 'mono key-title', text: key }));
    const facts = el('dl', { class: 'facts' });
    const fact = (a, b) => { if (b !== '' && b !== null && b !== undefined) facts.append(el('dt', { text: a }), el('dd', { text: String(b) })); };
    fact('Kind', k.kind);
    fact('Now', k.live ? size(k.bytes) : 'deleted at revision ' + k.modRevision);
    fact('Old revisions', plural(k.revisions - 1, 'revision', 'revisions') + ', ' + size(k.historyBytes));
    if (k.live) {
      fact('Created at revision', k.createRevision);
      fact('Last changed at revision', k.modRevision + ' (version ' + k.version + ')');
    }
    fact('Lease', k.lease);
    box.append(facts);
    const pane = el('div', { id: 'value' });
    const rows = k.history.map((h, i) => {
      const what = h.deleted ? 'deleted' : h.version === 1 ? 'created' : 'changed';
      const tr = pickRow([String(h.revision), h.deleted ? '' : String(h.version), h.deleted ? '' : size(h.bytes), what], [0, 1, 2], () => {
        for (const r of tr.parentNode.querySelectorAll('tr.on')) r.classList.remove('on');
        tr.classList.add('on');
        showValue(key, i, pane);
      });
      return tr;
    });
    box.append(el('p', { class: 'muted small', text: 'Every revision of this key the file keeps, oldest first. Pick one to see its value and what changed.' }));
    box.append(table(['Revision', 'Version', 'Size', 'What happened'], rows, [0, 1, 2], 'pick-table history-table'));
    box.append(pane);
    let pick = k.history.length - 1;
    while (pick > 0 && k.history[pick].deleted) pick--;
    if (rows[pick]) { rows[pick].classList.add('on'); showValue(key, pick, pane); }
    if (scroll) box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // The tab picked last, kept from one revision to the next. A revision
  // with no earlier value to compare shows its value whatever was picked.
  let view = 'value';
  async function showValue(key, index, pane) {
    const entry = current;
    const v = await (await session()).call('value', key, index);
    // Another key was picked while this one loaded.
    if (!pane.isConnected) return;
    const h = entry.history[index];
    pane.textContent = '';
    if (!v) {
      pane.append(el('p', { class: 'muted', text: 'The key was deleted at this revision; there is no value.' }));
      announce(`Revision ${h.revision}: the key was deleted.`);
      return;
    }
    const tabs = el('div', { class: 'tabs', role: 'tablist' });
    const body = el('div');
    const tab = (id, label) => {
      const b = el('button', { type: 'button', role: 'tab', class: 'tab', text: label });
      b.addEventListener('click', () => { view = id; draw(); });
      return b;
    };
    const valueTab = tab('value', 'Value at revision ' + h.revision);
    const changesTab = v.previous !== null ? tab('changes', 'Changes from revision ' + v.previous) : null;
    tabs.append(valueTab);
    if (changesTab) tabs.append(changesTab);
    function draw() {
      const mode = view === 'changes' && changesTab ? 'changes' : 'value';
      valueTab.setAttribute('aria-selected', String(mode === 'value'));
      if (changesTab) changesTab.setAttribute('aria-selected', String(mode === 'changes'));
      body.textContent = '';
      if (mode === 'value') body.append(el('pre', { class: 'out value-text', text: v.text }));
      else body.append(diffView(v.changes));
    }
    draw();
    announce(`Revision ${h.revision} of ${key}, version ${h.version}.`);
    let note = '';
    if (v.kubernetes && v.kubernetes.known) note = v.kubernetes.format === 'json' ? 'A custom resource, stored as JSON, shown as kubectl get -o yaml shows it.' : 'Stored as protobuf, shown as kubectl get -o yaml shows it.';
    else if (v.kubernetes) note = `${v.kubernetes.apiVersion} ${v.kubernetes.kind} isn't a kind this page knows, so its fields show as protobuf field numbers.`;
    else if (v.what.format === 'encrypted') note = 'Encrypted at rest by kube-apiserver, so only the provider and key name can be read.';
    const save = el('button', { type: 'button', class: 'btn', text: 'Download this value' });
    save.addEventListener('click', () => download(key.split('/').filter(Boolean).pop() + '-' + h.revision + (v.kubernetes && v.kubernetes.known ? '.yaml' : '.txt'), v.text + '\n', 'text/plain'));
    pane.append(tabs, body, el('div', { class: 'row' }, [save, note ? el('span', { class: 'muted small', text: note }) : null]));
  }

  // Changed lines with three lines around them; longer unchanged runs fold.
  function diffView(lines) {
    const box = el('div', { class: 'out diff' });
    if (!lines) { box.append(el('div', { class: 'skip', text: 'These values are too long to compare line by line.' })); return box; }
    if (!lines.some((l) => l[0] !== ' ')) { box.append(el('div', { class: 'skip', text: 'The value did not change: the write set it to the same thing.' })); return box; }
    const near = new Set();
    lines.forEach((l, i) => { if (l[0] !== ' ') for (let j = i - 3; j <= i + 3; j++) near.add(j); });
    let skipped = 0;
    const flush = () => { if (skipped) box.append(el('div', { class: 'skip', text: `… ${plural(skipped, 'unchanged line', 'unchanged lines')}` })); skipped = 0; };
    lines.forEach((l, i) => {
      if (!near.has(i)) { skipped++; return; }
      flush();
      box.append(el('div', { class: l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : 'same', text: l }));
    });
    flush();
    return box;
  }

  // ---- Inputs ----

  function readPicked(f) {
    if (!f) return;
    const ticket = ticketNow();
    f.arrayBuffer().then((buf) => openFile(buf, f.name, ticket), (err) => {
      if (ticket !== opening) return;
      $('result').textContent = '';
      $('result').append(verdict('bad', 'The browser could not read this file', [err && err.message ? err.message : String(err), 'Files of several gigabytes can be too big for a browser tab; the command line reads them.']));
    });
  }
  // Emptied after each pick, so picking the same file again opens it again.
  $('file').addEventListener('change', (ev) => { readPicked(ev.target.files[0]); ev.target.value = ''; });

  // A file dropped anywhere on the page opens, so a drop that misses the
  // box doesn't make the browser leave the page for the file. Drags of
  // text, within the page, are left alone. The box lights up while a file
  // is over it; entering and leaving its children fire events too, so they
  // are counted.
  const drop = $('drop');
  const carriesFiles = (ev) => Boolean(ev.dataTransfer) && Array.from(ev.dataTransfer.types || []).includes('Files');
  let over = 0;
  drop.addEventListener('dragenter', (ev) => { if (carriesFiles(ev)) { over++; drop.classList.add('over'); } });
  drop.addEventListener('dragleave', (ev) => { if (carriesFiles(ev) && --over <= 0) { over = 0; drop.classList.remove('over'); } });
  window.addEventListener('dragover', (ev) => { if (carriesFiles(ev)) { ev.preventDefault(); ev.dataTransfer.dropEffect = 'copy'; } });
  window.addEventListener('drop', (ev) => {
    if (!carriesFiles(ev)) return;
    ev.preventDefault();
    over = 0;
    drop.classList.remove('over');
    readPicked(ev.dataTransfer.files[0]);
  });

  // The example is a gzipped snapshot in example.js, loaded only when asked for.
  $('example').addEventListener('click', () => {
    const ticket = ticketNow();
    const go = async () => {
      if (typeof DecompressionStream === 'undefined') {
        if (ticket !== opening) return;
        $('result').textContent = '';
        $('result').append(verdict('bad', 'This browser can\'t unpack the example', 'It needs DecompressionStream, which browsers have had since 2023. Your own snapshots open without it.'));
        return;
      }
      const bin = atob(window.KV_EXAMPLE_ETCD);
      const gz = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) gz[i] = bin.charCodeAt(i);
      const buf = await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
      openFile(buf, 'example.db', ticket);
    };
    if (window.KV_EXAMPLE_ETCD) { go(); return; }
    const s = document.createElement('script');
    s.src = 'example.js';
    s.onload = go;
    s.onerror = () => {
      if (ticket !== opening) return;
      $('result').textContent = '';
      $('result').append(verdict('bad', 'The example could not be loaded', 'example.js is missing next to this page.'));
    };
    document.body.append(s);
  });

  let t;
  $('filter').addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => listKeys(false), 200); });
  $('show').addEventListener('change', () => listKeys(false));
  $('sort').addEventListener('change', () => listKeys(false));
})();
