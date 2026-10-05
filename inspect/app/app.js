// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Page logic for the Value Inspector. The decoding lives in ../inspect.js;
// this file reads what was pasted or loaded and shows the result.

(function () {
  'use strict';
  const I = window.KVInspect;
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
    bad: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="9" fill="currentColor" opacity=".15"/><path d="M6.5 6.5l7 7M13.5 6.5l-7 7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
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
  const size = (n) => (n < 1024 ? fmt(n) + ' bytes' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB');
  function button(text, onClick) { const b = el('button', { type: 'button', class: 'btn', text: text }); b.addEventListener('click', onClick); return b; }
  function download(name, bytes) {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
    const a = el('a', { href: url, download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  let imageUrl = null;

  function show(bytes, inputNote) {
    const out = $('result');
    out.textContent = '';
    if (imageUrl) { URL.revokeObjectURL(imageUrl); imageUrl = null; }
    if (!bytes) return;
    let a;
    try { a = I.analyze(bytes); } catch (e) { out.append(verdict('bad', 'Could not read the value', e.message)); return; }
    const r = a.result;
    out.append(el('h3', { text: r.name }));
    out.append(el('p', { class: 'form-note', text: inputNote }));

    // The layers, outside in, when there's anything wrapped around the value.
    const chain = el('div', { class: 'chain', 'aria-label': 'Layers, from the outside in' });
    for (const l of a.layers) {
      const check = l.check === 'ok' ? ', checksum ok' : l.check === 'size ok' ? ', size matches' : l.check === 'mismatch' ? ', checksum wrong' : '';
      chain.append(el('div', { class: 'step' }, [el('strong', { text: l.name }), el('span', { text: size(l.size) + ' to ' + size(l.out) + check })]), el('span', { class: 'arrow', 'aria-hidden': 'true', text: '›' }));
    }
    chain.append(el('div', { class: 'step final' }, [el('strong', { text: r.name }), el('span', { text: size(a.bytes.length) })]));
    if (a.layers.length) out.append(chain);
    for (const l of a.layers) {
      if (l.check === 'mismatch') out.append(verdict('warn', `The ${l.name} checksum doesn't match`, 'The data may be damaged or cut short, so what follows may be wrong or incomplete.'));
      for (const f of l.facts) out.append(el('p', { class: 'small muted', text: l.name + ': ' + f }));
    }
    for (const n of r.notes || []) out.append(el('p', { class: 'small', text: n }));

    if (r.image && r.image.mime) {
      imageUrl = URL.createObjectURL(new Blob([a.bytes], { type: r.image.mime }));
      out.append(el('div', { class: 'preview' }, [el('img', { src: imageUrl, alt: r.image.name })]));
    }

    if (r.value) {
      const text = I.show(r.value);
      let json = null;
      const pre = el('pre', { class: 'out value', tabindex: '0', text: text });
      out.append(pre);
      const row = el('div', { class: 'row' });
      const toggle = button('Show as JSON', () => {
        if (pre.dataset.json) { pre.textContent = text; delete pre.dataset.json; toggle.textContent = 'Show as JSON'; }
        else { if (json === null) json = JSON.stringify(I.plain(r.value), null, 2); pre.textContent = json; pre.dataset.json = '1'; toggle.textContent = 'Show as text'; }
      });
      const copy = button('Copy', () => {
        const done = () => { copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = 'Copy'; }, 1500); };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(pre.textContent).then(done, () => selectAll(pre));
        else selectAll(pre);
      });
      row.append(toggle, copy);
      if (a.layers.length) row.append(button('Download the decoded bytes', () => download('decoded.bin', a.bytes)));
      out.append(row);
    }
    for (const x of r.alternatives || []) {
      const d = el('details', { class: 'more' }, [el('summary', { text: (r.id === 'binary' ? 'It might be ' : 'It also reads as ') + x.name })]);
      d.append(el('pre', { class: 'out', text: I.show(x.value) }));
      out.append(d);
    }
    const bytesBox = el('details', { class: 'more' }, [el('summary', { text: a.layers.length ? 'The decoded bytes' : 'The bytes' })]);
    bytesBox.append(el('pre', { class: 'out', text: I.hexdump(a.bytes) }));
    out.append(bytesBox);
  }
  function selectAll(node) {
    const range = document.createRange();
    range.selectNodeContents(node);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function inspectText() {
    const text = $('value').value;
    if (!text.trim()) { show(null); return; }
    const r = I.fromInput(text);
    const note = r.form === 'quoted' ? `Read as redis-cli's quoted form: ${fmt(r.bytes.length)} bytes.`
      : r.form === 'hex' ? `Read as hex: ${fmt(r.bytes.length)} bytes.`
        : `Read as text: ${fmt(r.bytes.length)} bytes of UTF-8.`;
    show(r.bytes, note);
  }

  let timer = null;
  $('value').addEventListener('input', () => { clearTimeout(timer); if ($('value').value.length < 300000) timer = setTimeout(inspectText, 300); });
  $('inspect').addEventListener('click', inspectText);
  $('clear').addEventListener('click', () => { $('value').value = ''; show(null); $('value').focus(); });
  $('file').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    f.arrayBuffer().then((buf) => { $('value').value = ''; show(new Uint8Array(buf), `Read ${f.name}: ${fmt(f.size)} bytes.`); });
  });
  const box = $('examples');
  for (const ex of window.KVInspectExamples || []) {
    box.append(button(ex.label, () => { $('value').value = ex.value; inspectText(); }));
  }
})();
