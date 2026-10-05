// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Page logic for the Mass Insert Builder. The protocol work lives in
// ../pipe.js; this file reads the inputs and shows the result.

(function () {
  'use strict';
  const P = window.KVPipe;
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => Number(n).toLocaleString('en-US');
  const plural = (n, one, many) => fmt(n) + ' ' + (n === 1 ? one : many);
  const decoderLatin = new TextDecoder('latin1');

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
  function sizeText(n) {
    if (n < 1024) return plural(n, 'byte', 'bytes');
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }
  function debounce(fn, ms) { let t; return function () { clearTimeout(t); t = setTimeout(fn, ms); }; }
  function download(name, bytes, type) {
    const url = URL.createObjectURL(new Blob([bytes], { type: type || 'application/octet-stream' }));
    const a = el('a', { href: url, download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  // The first bytes of the file, with the line endings made visible.
  function protocolPreview(bytes) {
    const head = bytes.subarray(0, 700);
    let s = decoderLatin.decode(head).replace(/\r\n/g, '\\r\\n\n');
    if (bytes.length > head.length) s += '…';
    return s;
  }

  // ---- building ----

  let columns = [];
  const srcType = () => document.querySelector('input[name="src"]:checked').value;

  function fillSelect(sel, options, preferred) {
    const old = sel.value;
    sel.textContent = '';
    for (const [value, label] of options) sel.append(el('option', { value: value, text: label }));
    const values = options.map((o) => o[0]);
    sel.value = values.includes(old) ? old : (values.includes(preferred) ? preferred : (values[0] || ''));
  }

  function showFields() {
    const type = $('type').value;
    const isCmd = srcType() === 'commands';
    $('mapping').hidden = isCmd;
    $('header-wrap').hidden = srcType() !== 'csv';
    $('value-wrap').hidden = !(type === 'string' || type === 'list' || type === 'set');
    $('score-wrap').hidden = $('member-wrap').hidden = type !== 'zset';
    $('fields-wrap').hidden = type !== 'hash';
  }

  function updateColumns(cols) {
    const same = cols.length === columns.length && cols.every((c, i) => c === columns[i]);
    columns = cols;
    if (!same) {
      const box = $('columns');
      box.textContent = '';
      if (cols.length) box.append(el('span', { class: 'hint', text: 'Fields:' }));
      for (const c of cols.slice(0, 40)) {
        const b = el('button', { type: 'button', class: 'btn', text: '${' + c + '}', title: 'Add ${' + c + '} to the key' });
        b.style.padding = '5px 9px';
        b.style.fontFamily = 'var(--mono)';
        b.addEventListener('click', () => { const k = $('key'); k.value += '${' + c + '}'; k.focus(); build(); });
        box.append(b);
      }
    }
    const opts = cols.map((c) => [c, c]);
    const keyFields = P.compileTemplate($('key').value).fields;
    const firstFree = cols.find((c) => !keyFields.includes(c)) || cols[0];
    fillSelect($('value'), (($('type').value === 'string') ? [['__whole__', 'The whole record, as JSON']] : []).concat(opts), firstFree);
    fillSelect($('score'), opts, cols.find((c) => /score|points|rank|weight/i.test(c)) || cols[1]);
    fillSelect($('member'), opts, firstFree);
  }

  function build() {
    showFields();
    const out = $('result');
    out.textContent = '';
    const src = $('in').value;
    if (!src.trim()) { updateColumns([]); return; }
    let result;
    try {
      if (srcType() === 'commands') result = P.buildFromCommands(src);
      else {
        const parsed = srcType() === 'csv' ? P.csvRecords(src, { header: $('header').checked }) : P.jsonRecords(src);
        updateColumns(parsed.columns);
        if (!parsed.records.length) { out.append(verdict('info', 'No records yet', 'Add at least one line of data under the header.')); return; }
        const type = $('type').value;
        const opt = {
          key: $('key').value, type: type,
          value: $('value').value === '__whole__' ? undefined : $('value').value,
          wholeRow: type === 'string' && $('value').value === '__whole__',
          score: $('score').value, member: $('member').value,
          fields: $('fields').value.split(',').map((s) => s.trim()).filter(Boolean),
          ttl: $('ttl').value, db: $('db').value, fresh: $('fresh').checked
        };
        result = P.build(parsed.records, parsed.columns, opt);
        result.records = parsed.records.length;
      }
    } catch (e) {
      out.append(verdict('bad', 'The file could not be built', e.message));
      return;
    }
    const bytes = result.output.bytes();
    const figs = [figure(fmt(result.output.commands), 'Commands'), figure(sizeText(bytes.length), 'File size')];
    if (result.keys !== undefined) figs.push(figure(fmt(result.keys), 'Keys'));
    if (result.skipped && result.skipped.length) figs.push(figure(fmt(result.skipped.length), 'Records skipped'));
    out.append(el('div', { class: 'figures' }, figs));
    if (result.skipped && result.skipped.length) {
      const list = result.skipped.slice(0, 5).map((s) => `record ${s.record}: ${s.reason}`).join('; ');
      out.append(verdict('warn', plural(result.skipped.length, 'record was skipped', 'records were skipped'), list + (result.skipped.length > 5 ? '; and more' : '') + '.'));
    }
    const row = el('div', { class: 'row' });
    const btn = el('button', { type: 'button', class: 'btn primary', text: 'Download data.resp' });
    btn.addEventListener('click', () => download('data.resp', bytes));
    row.append(btn);
    out.append(row);
    out.append(el('p', null, ['Load it with: ', el('code', { text: 'redis-cli -h HOST -p PORT --pipe < data.resp' })]));
    out.append(el('p', { class: 'muted small', text: 'valkey-cli takes the same flags. At the end the client prints how many replies came back and how many were errors.' }));
    const readable = P.decode(bytes, 25).values.map((v) => P.asCommand(v)).join('\n');
    out.append(el('h3', { text: 'The first commands' }));
    out.append(el('div', { class: 'out', text: readable + (result.output.commands > 25 ? '\n…' : '') }));
    out.append(el('h3', { text: 'The first bytes of the file' }));
    out.append(el('div', { class: 'out', text: protocolPreview(bytes) }));
  }

  const EXAMPLES = {
    csv: 'id,name,email,city,plan\n1001,Ana Silva,ana@example.com,Lisbon,pro\n1002,Ben Okafor,ben@example.com,Lagos,free\n1003,"Chen, Wei",wei@example.com,Taipei,pro\n1004,Dana Levi,dana@example.com,Haifa,team\n1005,Émile Roux,emile@example.com,Lyon,free\n',
    json: '{"order": 9001, "customer": 1001, "total": 149.90, "items": ["mug", "kettle"]}\n{"order": 9002, "customer": 1002, "total": 12.50, "items": ["tea"]}\n{"order": 9003, "customer": 1001, "total": 75.00, "items": ["pan"]}\n',
    commands: '# Settings for the new release\nSET config:release "2026.10"\nHSET feature:dark-mode enabled 1 rollout 25\nSADD beta:users 1001 1003 1004\nSET greeting "Hello, \\"world\\"\\n"\nEXPIRE greeting 86400\n'
  };
  const EXAMPLE_MAPPINGS = {
    csv: { key: 'user:${id}', type: 'hash' },
    json: { key: 'order:${order}', type: 'string', value: '__whole__' }
  };

  const later = debounce(build, 250);
  $('in').addEventListener('input', later);
  for (const id of ['key', 'fields', 'ttl', 'db']) $(id).addEventListener('input', later);
  for (const id of ['type', 'value', 'score', 'member', 'fresh', 'header']) $(id).addEventListener('change', () => { if (id === 'type') updateColumns(columns); build(); });
  for (const r of document.querySelectorAll('input[name="src"]')) r.addEventListener('change', build);
  $('example').addEventListener('click', () => {
    const t = srcType();
    $('in').value = EXAMPLES[t];
    const m = EXAMPLE_MAPPINGS[t];
    if (m) {
      $('key').value = m.key; $('type').value = m.type;
      updateColumns(t === 'csv' ? P.csvRecords(EXAMPLES[t]).columns : P.jsonRecords(EXAMPLES[t]).columns);
      if (m.value) $('value').value = m.value;
    }
    build();
  });
  $('clear').addEventListener('click', () => { $('in').value = ''; build(); });
  $('in-file').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    f.text().then((t) => {
      $('in').value = t;
      const name = f.name.toLowerCase();
      const pick = /\.jsonl?$/.test(name) ? 'json' : (/\.(csv|tsv)$/.test(name) ? 'csv' : null);
      if (pick) document.querySelector('input[name="src"][value="' + pick + '"]').checked = true;
      build();
    });
    e.target.value = '';
  });

  // ---- reading ----

  let rawBytes = null;
  function read() {
    const out = $('raw-result');
    out.textContent = '';
    let bytes, form = 'file';
    if (rawBytes) bytes = rawBytes;
    else {
      const t = $('raw').value;
      if (!t.trim()) return;
      const r = P.bytesFromText(t);
      bytes = r.bytes; form = r.form;
    }
    let d;
    try { d = P.decode(bytes, 2000); }
    catch (e) { out.append(verdict('bad', 'These bytes could not be read', e.message)); return; }
    const s = P.summarize(d.values);
    const counts = Object.keys(s.counts).sort((a, b) => s.counts[b] - s.counts[a]).slice(0, 8).map((k) => k + ' ' + fmt(s.counts[k])).join(', ');
    const how = { hex: 'Read as a hex dump.', escaped: 'Read with \\r\\n and other escapes turned back into bytes.', text: '', file: '' }[form];
    out.append(verdict('ok', `${plural(s.commands, 'command', 'commands')} and ${plural(s.replies, 'reply', 'replies')}`,
      [(counts ? 'Commands: ' + counts + '. ' : '') + how + (d.lfOnly ? ' Some lines ended in \\n alone, which servers do not send; they were read anyway.' : '')]));
    if (!d.complete) out.append(verdict('info', 'Showing the first 2,000 values', 'The rest of the data was not read.'));
    out.append(el('div', { class: 'out', text: d.values.map((v) => { const c = P.asCommand(v); return c !== null ? c : P.show(v); }).join('\n') }));
  }
  $('raw').addEventListener('input', debounce(() => { rawBytes = null; read(); }, 250));
  $('raw-file').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    f.arrayBuffer().then((buf) => { rawBytes = new Uint8Array(buf); $('raw').value = ''; read(); });
    e.target.value = '';
  });
  $('raw-example').addEventListener('click', () => {
    rawBytes = null;
    $('raw').value = '*3\\r\\n$3\\r\\nSET\\r\\n$9\\r\\nuser:1001\\r\\n$9\\r\\nAna Silva\\r\\n+OK\\r\\n*2\\r\\n$3\\r\\nGET\\r\\n$9\\r\\nuser:1001\\r\\n$9\\r\\nAna Silva\\r\\n*4\\r\\n$4\\r\\nHSET\\r\\n$9\\r\\nplan:1001\\r\\n$4\\r\\ntier\\r\\n$3\\r\\npro\\r\\n:1\\r\\n';
    read();
  });

  showFields();
})();
