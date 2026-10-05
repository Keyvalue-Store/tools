// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Page logic for the Snapshot Viewer. The file format lives in ../rdb.js;
// this file reads the file in steps, keeps a light record of every key, and
// draws the results.

(function () {
  'use strict';
  const R = window.KVRdb;
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => Number(n).toLocaleString('en-US');
  const MAX_KEPT = 1000000;

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
  function figure(value, label) {
    return el('div', { class: 'figure' }, [el('span', { class: 'value', text: value }), el('span', { class: 'label', text: label })]);
  }
  function sizeText(n) {
    if (n < 1024) return fmt(n) + ' bytes';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }
  function plural(n, one, many) { return fmt(n) + ' ' + (n === 1 ? one : many); }
  function table(headers, rows, numeric) {
    const wrap = el('div', { class: 'table-wrap' });
    const t = el('table');
    t.append(el('thead', null, [el('tr', null, headers.map((h, i) => el('th', { class: numeric && numeric.includes(i) ? 'num' : '', text: h })))]));
    const body = el('tbody');
    for (const r of rows) body.append(r instanceof HTMLElement ? r : el('tr', null, r.map((c, i) => el('td', { class: numeric && numeric.includes(i) ? 'num' : '' }, [c]))));
    t.append(body); wrap.append(t);
    return wrap;
  }
  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type: type }));
    const a = el('a', { href: url, download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function csvCell(s) { return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }

  // How long until an expiry, from when the snapshot was written.
  function ttlText(expire, now) {
    if (expire === null || expire === undefined) return '';
    if (now === null) return R.fmtTime(expire);
    const s = (Number(expire) - now) / 1000;
    if (s <= 0) return 'already expired';
    if (s < 120) return 'in ' + Math.round(s) + ' s';
    if (s < 7200) return 'in ' + Math.round(s / 60) + ' min';
    if (s < 172800) return 'in ' + Math.round(s / 3600) + ' h';
    if (s < 365 * 86400) return 'in ' + Math.round(s / 86400) + ' days';
    return R.fmtTime(expire).slice(0, 10);
  }

  const SVGNS = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs, text) {
    const n = document.createElementNS(SVGNS, tag);
    for (const k of Object.keys(attrs || {})) n.setAttribute(k, attrs[k]);
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function barPath(x, y, w, h) { const r = Math.min(4, w, h / 2); return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`; }
  // Bytes per data type, biggest first. One series, one colour.
  function typeChart(byType, total) {
    const rows = Object.entries(byType).sort((a, b) => b[1].bytes - a[1].bytes);
    const rowH = 30, labelW = 110, W = 760, H = rows.length * rowH + 4;
    const max = Math.max(1, ...rows.map((r) => r[1].bytes));
    const plotW = W - labelW - 210;
    const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Bytes in the file by data type' });
    rows.forEach(([type, v], i) => {
      const y = i * rowH + 2;
      s.append(svg('text', { x: labelW - 10, y: y + 18, 'text-anchor': 'end' }, type));
      const w = Math.max(2, plotW * v.bytes / max);
      const bar = svg('path', { d: barPath(labelW, y + 5, w, rowH - 12), class: 'bar' });
      bar.append(svg('title', {}, `${type}: ${sizeText(v.bytes)} in ${plural(v.keys, 'key', 'keys')}`));
      s.append(bar);
      s.append(svg('text', { x: labelW + w + 8, y: y + 18 }, `${sizeText(v.bytes)}, ${(100 * v.bytes / total).toFixed(1)}%, ${plural(v.keys, 'key', 'keys')}`));
    });
    s.append(svg('line', { x1: labelW, y1: 0, x2: labelW, y2: H, class: 'axis' }));
    return el('div', { class: 'chart' }, [s]);
  }

  // ---- State ----
  let bytes = null, info = null, entries = [], kept = 0, sum = null, name = '', now = null;

  function readFile(buf, fileName) {
    bytes = new Uint8Array(buf);
    name = fileName;
    entries = []; kept = 0; now = null;
    $('result').textContent = '';
    $('browse').hidden = true;
    $('value').textContent = '';
    const status = $('status');
    status.textContent = '';
    const bar = el('span');
    status.append(el('p', { class: 'muted small', text: `Reading ${fileName}, ${sizeText(bytes.length)}…` }), el('div', { class: 'progress' }, [bar]));
    sum = R.summary({ top: 30 });
    let p;
    try {
      const src = R.bufferSource(bytes);
      p = R.parser(src, {
        onKey(e) {
          if (now === null) { const ct = R.auxValue(p.info, 'ctime'); now = ct ? Number(ct) * 1000 : 0; if (now) sum.setNow(now); }
          sum.add(e);
          if (kept < MAX_KEPT) { entries.push(e); kept++; }
        }
      });
      info = p.info;
    } catch (err) { return fail(err); }
    function step() {
      try {
        const t0 = Date.now();
        while (!p.done && Date.now() - t0 < 40) p.step(2000);
        bar.style.width = (p.done ? 100 : Math.min(99, 100 * currentPos() / bytes.length)).toFixed(1) + '%';
        if (!p.done) return setTimeout(step, 0);
        status.textContent = '';
        render();
      } catch (err) { fail(err); }
    }
    setTimeout(step, 0);
  }
  // The parser does not expose its position, so estimate it from the last key.
  function currentPos() { const e = entries[entries.length - 1]; return e ? e.offset + e.size : 0; }

  function fail(err) {
    $('status').textContent = '';
    const msg = err && err.message ? err.message : String(err);
    const kept0 = entries.length;
    $('result').textContent = '';
    $('result').append(verdict('bad', 'This file could not be read to the end', [msg, kept0 ? `The ${plural(kept0, 'key', 'keys')} before that point are listed below.` : 'Make sure it is an RDB snapshot or an AOF file that starts with one.']));
    if (kept0 && info) { render(true); }
  }

  function render(partial) {
    const s = sum.result();
    const out = $('result');
    if (!partial) out.textContent = '';
    const server = R.auxValue(info, 'valkey-ver') ? 'Valkey ' + R.auxValue(info, 'valkey-ver') : R.auxValue(info, 'redis-ver') ? 'Redis ' + R.auxValue(info, 'redis-ver') : 'Unknown';
    out.append(el('div', { class: 'figures' }, [
      figure(fmt(s.keys), 'Keys'),
      figure(sizeText(bytes.length), 'File size'),
      figure(fmt(s.expiring), 'With an expiry'),
      figure(server, 'Written by'),
      figure('RDB ' + info.version, info.flavor === 'valkey' ? 'Valkey format' : info.flavor === 'redis' ? 'Redis format' : 'Format')
    ]));
    const facts = el('dl', { class: 'facts' });
    const fact = (k, v) => { facts.append(el('dt', { text: k }), el('dd', { text: v })); };
    fact('File', name);
    const ctime = R.auxValue(info, 'ctime');
    if (ctime) fact('Written', R.fmtTime(Number(ctime) * 1000));
    const used = R.auxValue(info, 'used-mem');
    if (used) fact('Server memory then', sizeText(Number(used)));
    if (info.checksum) fact('Checksum', info.checksum.status === 'ok' ? 'correct (CRC64 ' + info.checksum.stored + ')' : info.checksum.status === 'off' ? 'not written (rdbchecksum no)' : info.checksum.status === 'missing' ? 'missing' : 'WRONG: the file says ' + info.checksum.stored + ', its bytes give ' + info.checksum.computed);
    if (info.functions.length) fact('Function libraries', info.functions.map(R.functionName).join(', '));
    if (Object.keys(s.modules).length) fact('Module values', Object.entries(s.modules).map(([m, n]) => `${m} (${fmt(n)})`).join(', '));
    if (info.moduleAux.length) fact('Module data', info.moduleAux.map((m) => m.module + ' ' + m.when).join(', '));
    const slotAux = info.aux.filter((a) => a[0] === 'slot-info').length;
    if (info.slotInfo || slotAux) fact('Cluster', `written by a cluster node; sizes recorded for ${plural(info.slotInfo || slotAux, 'slot', 'slots')}`);
    if (info.templates) fact('Hash templates', plural(info.templates, 'template', 'templates') + ' of shared field names');
    if (s.fieldTtls) fact('Hash fields with a TTL', fmt(s.fieldTtls));
    const repl = R.auxValue(info, 'repl-id');
    if (repl) fact('Replication ID', repl + ' at offset ' + R.auxValue(info, 'repl-offset'));
    out.append(facts);
    if (info.checksum && info.checksum.status === 'mismatch') out.append(verdict('bad', 'The checksum does not match', 'The file may be damaged or cut short and patched. The values below are what the bytes say.'));
    if (info.trailing) out.append(verdict('info', `${sizeText(info.trailing)} follow the snapshot`, 'An append-only file with an RDB preamble keeps the commands written after the snapshot there. The Mass Insert Builder can read them as commands.'));
    if (kept < s.keys) out.append(verdict('info', `Listing the first ${fmt(kept)} keys`, 'The totals cover every key. For the full list of a snapshot this big, use the command line.'));

    out.append(el('h3', { text: 'Where the bytes go' }));
    out.append(typeChart(s.byType, s.bytes || 1));
    out.append(table(['Type', 'Keys', 'Bytes in the file', 'Elements'],
      Object.entries(s.byType).sort((a, b) => b[1].bytes - a[1].bytes).map(([t, v]) => [t, fmt(v.keys), sizeText(v.bytes), t === 'string' || t === 'module' ? '' : fmt(v.elements)]), [1, 2, 3]));
    out.append(el('h3', { text: 'Encodings' }));
    out.append(el('p', { class: 'muted small', text: 'How each value was stored. Compact encodings (listpack, intset) are used for small values; big ones switch to hashtables, skiplists and quicklists.' }));
    out.append(table(['Type and encoding', 'Keys', 'Bytes'], Object.entries(s.byEncoding).sort((a, b) => b[1].bytes - a[1].bytes).map(([t, v]) => [t, fmt(v.keys), sizeText(v.bytes)]), [1, 2]));

    out.append(el('h3', { text: 'Biggest keys' }));
    const bigRows = s.largest.slice(0, 20).map((x) => {
      const full = entries.find((e) => e.db === x.db && e.size === x.size && e.key === x.key) || null;
      const tr = el('tr', { class: full ? 'pick' : '' }, [
        el('td', { class: 'key', text: R.showKey(x.key) }), el('td', { text: x.type }),
        el('td', { class: 'num', text: x.length === null ? '' : fmt(x.length) + (x.type === 'string' ? ' bytes' : '') }),
        el('td', { class: 'num', text: sizeText(x.size) }), el('td', { class: 'num', text: x.db })
      ]);
      if (full) tr.addEventListener('click', () => { showValue(full); $('browse').scrollIntoView({ behavior: 'smooth' }); });
      return tr;
    });
    out.append(table(['Key', 'Type', 'Length', 'In the file', 'DB'], bigRows, [2, 3, 4]));

    const split = el('div', { class: 'split' });
    const left = el('div'), right = el('div');
    left.append(el('h3', { text: 'Prefixes' }));
    left.append(el('p', { class: 'muted small', text: `The key up to its first colon. ${plural(s.prefixCount, 'prefix', 'prefixes')} in all.` }));
    left.append(table(['Prefix', 'Keys', 'Bytes'], s.prefixes.slice(0, 15).map((p) => [el('span', { class: 'mono', text: p.prefix }), fmt(p.keys), sizeText(p.bytes)]), [1, 2]));
    right.append(el('h3', { text: 'Expiries' }));
    if (!s.expiring) right.append(el('p', { class: 'muted', text: 'No key has an expiry.' }));
    else {
      right.append(el('p', { class: 'muted small', text: `${plural(s.expiring, 'key has', 'keys have')} an expiry. Time left, counted from when the file was written:` }));
      const rows = Object.entries(s.ttl).filter(([, n]) => n).map(([b, n]) => [b, fmt(n)]);
      if (s.expired) rows.unshift(['already expired', fmt(s.expired)]);
      right.append(table(['Time left', 'Keys'], rows, [1]));
    }
    if (s.idle) { right.append(el('h3', { text: 'Idle time' })); right.append(el('p', { class: 'muted small', text: 'Written because maxmemory-policy uses LRU.' })); right.append(table(['Idle for', 'Keys'], Object.entries(s.idle).map(([b, n]) => [b, fmt(n)]), [1])); }
    if (s.freq) { right.append(el('h3', { text: 'Access frequency' })); right.append(el('p', { class: 'muted small', text: 'The LFU counter, 0 to 255 on a log scale. Written because maxmemory-policy uses LFU.' })); right.append(table(['Counter', 'Keys'], Object.entries(s.freq).map(([b, n]) => [b, fmt(n)]), [1])); }
    split.append(left, right);
    out.append(split);
    if (Object.keys(s.byDb).length > 1 || !s.byDb[0]) {
      out.append(el('h3', { text: 'Databases' }));
      out.append(table(['Database', 'Keys', 'Bytes', 'Expiring'], Object.entries(s.byDb).map(([d, v]) => [d, fmt(v.keys), sizeText(v.bytes), fmt(v.expiring)]), [1, 2, 3]));
    }
    const row = el('div', { class: 'row' });
    const b1 = el('button', { type: 'button', class: 'btn primary', text: 'Download every key as CSV' });
    b1.addEventListener('click', () => {
      const lines = ['db,key,type,encoding,elements,bytes,expires'];
      for (const e of entries) lines.push([e.db, csvCell(keyText(e.key)), e.type, csvCell(e.encoding), e.length === null ? '' : e.length, e.size, e.expire === null ? '' : R.fmtTime(e.expire)].join(','));
      download(name.replace(/\.[^.]*$/, '') + '-keys.csv', lines.join('\n') + '\n', 'text/csv');
    });
    const b2 = el('button', { type: 'button', class: 'btn', text: 'Download the key names' });
    b2.addEventListener('click', () => download(name.replace(/\.[^.]*$/, '') + '-key-names.txt', entries.map((e) => R.showKey(e.key)).join('\n') + '\n', 'text/plain'));
    row.append(b1, b2, el('span', { class: 'muted small', text: 'The key names open in the Keyspace Map, which finds the naming patterns.' }));
    out.append(row);

    // Browsing
    const types = Array.from(new Set(entries.map((e) => e.type))).sort();
    const sel = $('type');
    sel.textContent = '';
    sel.append(el('option', { value: '', text: 'Any' }));
    for (const t of types) sel.append(el('option', { value: t, text: t }));
    $('browse').hidden = false;
    $('filter').value = '';
    filterKeys();
  }

  const strict = new TextDecoder('utf-8', { fatal: true });
  function keyText(b) { try { return strict.decode(b); } catch (e) { return R.showBytes(b); } }

  let picked = null;
  function filterKeys() {
    const box = $('matches');
    box.textContent = '';
    if (!entries.length) return;
    const q = $('filter').value;
    const type = $('type').value;
    const needle = q ? new TextEncoder().encode(q) : null;
    const hits = [];
    let total = 0;
    for (const e of entries) {
      if (type && e.type !== type) continue;
      if (needle && !contains(e.key, needle)) continue;
      total++;
      if (hits.length < 200) hits.push(e);
    }
    box.append(el('p', { class: 'muted small', text: total > hits.length ? `${fmt(total)} keys match. Showing the first ${hits.length}.` : `${plural(total, 'key matches', 'keys match')}.` }));
    const rows = hits.map((e) => {
      const tr = el('tr', { class: 'pick' + (e === picked ? ' on' : '') }, [
        el('td', { class: 'key', text: R.showKey(e.key) }), el('td', { text: e.type }),
        el('td', { class: 'num', text: e.length === null ? '' : fmt(e.length) }), el('td', { class: 'num', text: sizeText(e.size) }),
        el('td', { text: ttlText(e.expire, now) }), el('td', { class: 'num', text: e.db })
      ]);
      tr.addEventListener('click', () => { showValue(e); for (const r of box.querySelectorAll('tr.on')) r.classList.remove('on'); tr.classList.add('on'); });
      return tr;
    });
    box.append(table(['Key', 'Type', 'Length', 'In the file', 'Expires', 'DB'], rows, [2, 3, 5]));
  }
  function contains(hay, needle) {
    outer: for (let i = 0; i + needle.length <= hay.length; i++) {
      for (let k = 0; k < needle.length; k++) if (hay[i + k] !== needle[k]) continue outer;
      return true;
    }
    return false;
  }

  function showValue(e) {
    picked = e;
    const box = $('value');
    box.textContent = '';
    box.append(el('h3', { class: 'mono', text: R.showKey(e.key) }));
    const facts = el('dl', { class: 'facts' });
    const fact = (k, v) => { if (v !== '' && v !== null && v !== undefined) facts.append(el('dt', { text: k }), el('dd', { text: String(v) })); };
    fact('Type', e.type);
    fact('Encoding', e.encoding + (e.detail ? ', ' + e.detail : ''));
    fact(e.type === 'string' ? 'Length' : 'Elements', e.length === null ? '' : fmt(e.length) + (e.type === 'string' ? ' bytes' : ''));
    fact('In the file', sizeText(e.size) + ' at byte ' + fmt(e.offset));
    fact('Database', e.db);
    fact('Expires', e.expire === null ? 'never' : R.fmtTime(e.expire) + (now ? ' (' + ttlText(e.expire, now) + ' when written)' : ''));
    if (e.idle !== null) fact('Idle', fmt(e.idle) + ' s');
    if (e.freq !== null) fact('LFU counter', e.freq);
    if (e.fieldTtls) fact('Fields with a TTL', fmt(e.fieldTtls));
    box.append(facts);
    if (e.type === 'module') { box.append(el('p', { class: 'muted', text: 'Module values are written in the module’s own format, which only the module can read.' })); return; }
    try {
      const value = R.readValueAt(bytes, e, info);
      box.append(el('div', { class: 'out', text: R.show(e, value, 1000) }));
    } catch (err) { box.append(verdict('bad', 'This value could not be read', err.message)); }
  }

  // ---- DUMP payloads ----
  function readDump() {
    const out = $('dump-result');
    out.textContent = '';
    const text = $('dump').value;
    if (!text.trim()) return;
    let d;
    try { d = R.readDump(R.bytesFromText(text).bytes); }
    catch (err) { out.append(verdict('bad', 'This payload could not be read', err.message)); return; }
    const head = `${d.type}, ${d.encoding}${d.detail ? ' (' + d.detail + ')' : ''}${d.length === null ? '' : ', ' + fmt(d.length) + (d.type === 'string' ? ' bytes' : ' elements')}`;
    out.append(verdict(d.checksum === 'mismatch' ? 'warn' : 'ok', head,
      [`RDB version ${d.version}${d.flavor === 'valkey' ? ', Valkey format' : d.flavor === 'redis' ? ', Redis format' : ''}. Checksum ${d.checksum === 'ok' ? 'correct' : d.checksum === 'off' ? 'not written' : 'WRONG: the payload may be damaged'}.` + (d.extra ? ` ${fmt(d.extra)} extra bytes after the value.` : '')]));
    if (d.type !== 'module') out.append(el('div', { class: 'out', text: R.show(d, d.value, 1000) }));
  }

  // ---- Inputs ----
  $('file').addEventListener('change', (ev) => {
    const f = ev.target.files[0];
    if (!f) return;
    f.arrayBuffer().then((buf) => readFile(buf, f.name));
    ev.target.value = '';
  });
  const drop = $('drop');
  drop.addEventListener('dragover', (ev) => { ev.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (ev) => {
    ev.preventDefault();
    drop.classList.remove('over');
    const f = ev.dataTransfer.files[0];
    if (f) f.arrayBuffer().then((buf) => readFile(buf, f.name));
  });
  $('example').addEventListener('click', () => {
    const bin = atob(window.KV_EXAMPLE_RDB);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    readFile(buf.buffer, 'example.rdb');
  });
  let t;
  $('filter').addEventListener('input', () => { clearTimeout(t); t = setTimeout(filterKeys, 200); });
  $('type').addEventListener('change', filterKeys);
  $('dump').addEventListener('input', () => { clearTimeout(t); t = setTimeout(readDump, 250); });
  $('dump-example').addEventListener('click', () => {
    $('dump').value = "\"\\x10??\\x00\\x00\\x00\\b\\x00\\x84name\\x05\\x83Ana\\x04\\x84plan\\x05\\x83pro\\x04\\x85email\\x06\\x8fana@example.com\\x10\\x86visits\\a\\x11\\x01\\xffP\\x00\\xad\\x16\\xfbv\\x1cA,\\xa5\"";
    readDump();
  });
})();
