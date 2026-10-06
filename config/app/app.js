// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Page logic for the Config Checker. Everything the servers do lives in
// ../config.js; this file reads the form and draws the answers.

(function () {
  'use strict';
  const C = window.KVConfig;
  const $ = (id) => document.getElementById(id);
  // The bytes of an opened file, kept until the text is edited, so odd bytes stay as they were.
  let fileBytes = null;
  let fileName = 'redis.conf';

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
    for (const line of [].concat(body || [])) if (line) p.append(el('p', null, [line]));
    box.append(p);
    return box;
  }
  function table(headers, rows, cls) {
    const wrap = el('div', { class: 'table-wrap' });
    const t = el('table', { class: cls || '' });
    const tr = el('tr');
    for (const h of headers) tr.append(el('th', { scope: 'col', text: h }));
    t.append(el('thead', null, [tr]));
    const body = el('tbody');
    for (const r of rows) {
      const row = el('tr', r.cls ? { class: r.cls } : null);
      for (const c of r.cells || r) row.append(c && c.td ? c.td : el('td', null, [c]));
      body.append(row);
    }
    t.append(body);
    wrap.append(t);
    return wrap;
  }
  const td = (cls, content) => ({ td: el('td', { class: cls }, [content]) });
  function debounce(fn, ms) { let t; return function () { clearTimeout(t); t = setTimeout(fn, ms); }; }
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
  const show = (s) => (s === null || s === undefined ? '' : C.fromBinary(s));
  function download(name, text, type) {
    const a = el('a', { href: URL.createObjectURL(new Blob([text], { type: type })), download: name });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // ---- the version lists ----
  function fillVersions(select, withGuess) {
    select.textContent = '';
    if (withGuess) select.append(el('option', { value: 'guess', text: 'Work it out from the names' }));
    const all = C.versions();
    for (const server of ['redis', 'valkey']) {
      const group = el('optgroup', { label: server === 'redis' ? 'Redis' : 'Valkey' });
      for (const v of all.filter((x) => x.server === server).reverse()) group.append(el('option', { value: v.id, text: v.label }));
      select.append(group);
    }
  }
  fillVersions($('version'), false);
  fillVersions($('get-version'), true);
  $('version').value = 'redis-8.10.2';

  function options() {
    const id = $('version').value;
    const v = C.getVersion(id);
    const hasTls = v.defs.some((c) => c.build === 'tls'), hasCompression = v.defs.some((c) => c.build === 'compression');
    $('tls-box').classList.toggle('hidden', !hasTls);
    $('compression-box').classList.toggle('hidden', !hasCompression);
    return { tls: !hasTls || $('tls').checked, compression: hasCompression && $('compression').checked };
  }
  const input = () => (fileBytes || $('conf').value);

  // ---- drawing ----
  function where(lines) { return lines && lines.length ? (lines.length === 1 ? 'line ' + lines[0] : 'lines ' + lines.join(', ')) : 'at startup'; }

  function renderStops(r, out) {
    const e = r.error;
    if (e.startup && e.line) {
      out.append(verdict('bad', r.label + ' stops at line ' + e.line, [show(e.message), 'What it logs:']));
    } else if (e.startup) {
      out.append(verdict('bad', r.label + ' reads the file, then stops while starting', [show(e.message), 'What it logs:']));
    } else {
      out.append(verdict('bad', r.label + ' stops at ' + (e.line === null ? 'the end of the file' : 'line ' + e.line), 'It prints this and exits:'));
    }
    out.append(el('pre', { class: 'printed', text: show(e.output).replace(/^\n/, '') }));
    const later = r.problems.filter((p) => p !== e);
    if (later.length) {
      out.append(el('h3', { text: 'Then it would stop at' }));
      out.append(el('p', { class: 'small muted', text: 'Each as if the lines before it were fixed, so you can fix them all at once.' }));
      out.append(table(['Line', 'Error', 'The line'], later.map((p) => [p.line === null ? (p.startup ? 'startup' : 'end') : String(p.line), show(p.message), td('val', p.text ? show(p.text) : '')])));
    }
  }

  function renderVersions(results, current, out) {
    out.append(el('h3', { text: 'With every version' }));
    const rows = results.map((r) => {
      let what;
      if (r.ok) what = td('starts', 'starts');
      else if (r.error.startup) what = td('stops', 'stops ' + (r.error.line ? 'at line ' + r.error.line : 'while starting') + ': ' + show(r.error.short || r.error.message));
      else what = td('stops', 'stops at ' + (r.error.line === null ? 'the end' : 'line ' + r.error.line) + ': ' + show(r.error.message));
      const pick = el('button', { type: 'button', class: 'linkish', text: r.label });
      pick.addEventListener('click', () => { $('version').value = r.version; run(); $('h-out').scrollIntoView({ behavior: 'smooth' }); });
      return { cls: r.version === current ? 'on' : '', cells: [pick, what] };
    });
    out.append(table(['Version', 'With this file'], rows, 'versions-table'));
  }

  function renderSettings(r, out) {
    // In the order of the file; settings the server adjusts on its own go last.
    const first = (name) => (r.setBy.has(name) ? r.setBy.get(name)[0] : Infinity);
    const changed = [...r.values].filter(([name, value]) => r.setBy.has(name) || value !== r.defaults.get(name))
      .sort((a, b) => first(a[0]) - first(b[0]));
    out.append(el('h3', { text: changed.length ? 'Settings the file sets (' + changed.length + ')' + (r.ok ? '' : ', once the lines it stops at are fixed') : 'Settings' }));
    if (!changed.length) { out.append(el('p', { class: 'muted', text: 'The file changes no settings: everything has its default.' })); return; }
    out.append(el('p', { class: 'small muted', text: 'Values as CONFIG GET would report them: sizes in bytes, under the current names.' }));
    out.append(table(['Setting', 'Value', 'Default', 'Set by'], changed.map(([name, value]) => {
      const d = r.defaults.get(name);
      return [td('val', name), td('val', show(value) === '' ? '""' : show(value)), td('val', value === d ? '(the same)' : show(d) === '' ? '""' : show(d)), where(r.setBy.get(name))];
    })));
  }

  function renderFindings(r, out) {
    const findings = C.advise(r);
    out.append(el('h3', { text: 'What to look at' }));
    if (!findings.length) { out.append(el('p', { class: 'muted', text: 'Nothing stands out.' })); return; }
    const box = el('div', { class: 'finding' });
    for (const f of findings) box.append(verdict(f.level === 'bad' ? 'bad' : f.level === 'warn' ? 'warn' : 'info', f.title, f.text));
    out.append(box);
  }

  function renderNotes(r, out) {
    if (!r.notes.length && !r.unchecked.length) return;
    out.append(el('h3', { text: 'Notes' }));
    const ul = el('ul');
    for (const n of r.notes) ul.append(el('li', { text: show(n.message) }));
    for (const u of r.unchecked) ul.append(el('li', { text: (u.line ? 'Line ' + u.line + ': ' : '') + show(u.message) }));
    out.append(ul);
  }

  function renderLines(r, out) {
    const lines = r.lines.filter((l) => l.kind !== 'blank' && l.kind !== 'comment');
    if (!lines.length) return;
    const d = el('details');
    d.append(el('summary', { text: 'The file line by line (' + plural(lines.length, 'line', 'lines') + ' with something on them)' }));
    const label = { ok: 'ok', error: 'stops', ignored: 'ignored', unchecked: 'not checked' };
    d.append(table(['Line', '', 'Text', 'What the server does'], lines.map((l) => {
      let what = l.message ? show(l.message) : '';
      if (!what && l.kind === 'config') what = l.alias ? 'Sets ' + l.name + ' (an old name for it).' : 'Sets ' + l.name + '.';
      if (!what && l.kind === 'rename-command') what = 'Renames a command.';
      if (!what && l.kind === 'sentinel') what = 'Nothing outside Sentinel mode.';
      return { cls: l.status, cells: [td('num', String(l.line)), td('status ' + l.status, label[l.status] || l.status), td('text', show(l.text)), what] };
    }), 'lines-table'));
    out.append(d);
  }

  function run() {
    const out = $('result');
    out.textContent = '';
    const text = input();
    const opt = options();
    const id = $('version').value;
    if (typeof text === 'string' && !text.trim()) {
      out.append(verdict('info', 'Paste a config file above', 'Or open one, or try an example.'));
      return;
    }
    let r, results;
    try {
      r = C.check(text, id, opt);
      results = C.versions().map((v) => (v.id === id ? r : C.check(text, v.id, { tls: true, compression: false })));
    } catch (e) {
      out.append(verdict('warn', 'The checker couldn\'t read this', e.message));
      return;
    }
    if (r.ok) {
      const n = r.lines.filter((l) => l.kind && l.kind !== 'blank' && l.kind !== 'comment').length;
      out.append(verdict('ok', r.label + ' starts with this file', plural(n, 'line', 'lines') + ' read, ' + plural(r.setBy.size, 'setting', 'settings') + ' set.'));
    } else renderStops(r, out);
    renderNotes(r, out);
    renderFindings(r, out);
    renderSettings(r, out);
    renderLines(r, out);
    renderVersions(results, id, out);
    const buttons = el('div', { class: 'row' });
    const short = el('button', { type: 'button', class: 'btn', text: 'Download the short file' });
    short.addEventListener('click', () => download(fileName.replace(/(\.conf)?$/, '.short.conf'), '# The settings of ' + fileName + ' that differ from the defaults of ' + r.label + '.\n' + C.minimal(r).join('\n') + '\n', 'text/plain'));
    const json = el('button', { type: 'button', class: 'btn', text: 'Download the report as JSON' });
    json.addEventListener('click', () => download('config-report.json', JSON.stringify(report(r), null, 2) + '\n', 'application/json'));
    buttons.append(short, json);
    out.append(buttons);
  }

  function report(r) {
    return {
      version: r.version, label: r.label, starts: r.ok,
      error: r.error ? { line: r.error.line, text: r.error.text ? show(r.error.text) : null, message: show(r.error.message), output: show(r.error.output), startup: !!r.error.startup } : null,
      problems: r.problems.map((p) => ({ line: p.line, text: p.text ? show(p.text) : null, message: show(p.message) })),
      notes: r.notes.map((n) => show(n.message)).concat(r.unchecked.map((u) => show(u.message))),
      findings: C.advise(r),
      settings: Object.fromEntries([...r.values].filter(([name, value]) => r.setBy.has(name) || value !== r.defaults.get(name))
        .map(([name, value]) => [name, { value: show(value), default: show(r.defaults.get(name)), lines: r.setBy.get(name) || [] }])),
      values: Object.fromEntries([...r.values].map(([k, v]) => [k, show(v)]))
    };
  }

  // ---- CONFIG GET ----
  function runGet() {
    const out = $('get-result');
    out.textContent = '';
    $('get-guess').textContent = '';
    const text = $('get-text').value;
    if (!text.trim()) return;
    const map = C.parseConfigGet(text);
    if (!map.size) { out.append(verdict('warn', 'No settings found', 'Paste the output of CONFIG GET * as redis-cli prints it.')); return; }
    let id = $('get-version').value;
    if (id === 'guess') {
      id = C.guessVersion(map);
      $('get-guess').textContent = 'The names match ' + C.versions().find((v) => v.id === id).label + ' best.';
    }
    const cmp = C.compareConfigGet(map, id);
    const changed = cmp.rows.filter((x) => x.changed);
    const missing = cmp.rows.filter((x) => x.value === null && !x.hidden);
    out.append(verdict(changed.length ? 'info' : 'ok', changed.length ? plural(changed.length, 'setting differs', 'settings differ') + ' from the defaults' : 'Every setting has its default',
      plural(map.size, 'setting', 'settings') + ' in the output.'));
    if (changed.length) out.append(table(['Setting', 'Value', 'Default'], changed.map((x) => [td('val', x.name), td('val', x.value === '' ? '""' : x.value), td('val', show(x.default) === '' ? '""' : show(x.default))])));
    if (missing.length) out.append(el('p', { class: 'small muted', text: 'Not in the output, which suggests another version: ' + missing.map((x) => x.name).join(', ') + '.' }));
    if (cmp.unknown.length) out.append(el('p', { class: 'small muted', text: 'Not settings of this version: ' + cmp.unknown.join(', ') + '.' }));
  }

  // ---- examples ----
  const EXAMPLES = {
    typical: [
      '# Session store',
      'bind 127.0.0.1 10.0.0.5',
      'protected-mode yes',
      'port 6379',
      'tcp-keepalive 300',
      'supervised systemd',
      'loglevel notice',
      '',
      'save 900 1',
      'save 300 10',
      'save 60 10000',
      'dbfilename dump.rdb',
      'appendonly yes',
      'appendfsync everysec',
      '',
      'requirepass "correct horse battery staple 42"',
      'maxmemory 2gb',
      'maxmemory-policy allkeys-lru',
      'lazyfree-lazy-eviction yes',
      'slave-read-only yes',
      'notify-keyspace-events Ex',
      'rename-command FLUSHALL ""',
      ''
    ],
    mistakes: [
      '# Typed in a hurry',
      'maxmemory 2 gb',
      'maxmemory-policy lru',
      'save 900',
      'appendfsync everysecond',
      'timeout -5',
      'hz 1000',
      'requirepass "secret',
      'tcp-backlog 511 # the default',
      ''
    ],
    upgrade: [
      '# Written for Redis 6.2 a few years ago',
      'bind 127.0.0.1',
      'port 6379',
      'gopher-enabled no',
      'slaveof 10.0.0.2 6379',
      'slave-read-only yes',
      'list-max-ziplist-size -2',
      'hash-max-ziplist-entries 512',
      'maxmemory 4gb',
      'maxmemory-policy volatile-lru',
      ''
    ]
  };
  function example(name, version) {
    fileBytes = null;
    fileName = 'redis.conf';
    $('conf').value = EXAMPLES[name].join('\n');
    if (version) $('version').value = version;
    run();
  }
  $('ex-typical').addEventListener('click', () => example('typical'));
  $('ex-mistakes').addEventListener('click', () => example('mistakes'));
  $('ex-upgrade').addEventListener('click', () => example('upgrade', 'valkey-9.1.2'));

  // ---- files ----
  function openFile(f) {
    if (!f) return;
    if (f.size > 16 * 1024 * 1024) { $('result').textContent = ''; $('result').append(verdict('warn', 'That file is too big for a config file', 'It is ' + Math.round(f.size / 1048576) + ' MiB.')); return; }
    f.arrayBuffer().then((buf) => {
      fileBytes = new Uint8Array(buf);
      fileName = f.name || 'redis.conf';
      $('conf').value = new TextDecoder('utf-8').decode(fileBytes);
      $('conf-label').textContent = fileName + ', ' + plural(fileBytes.length, 'byte', 'bytes') + '. The file never leaves your browser.';
      run();
    });
  }
  $('open').addEventListener('click', () => $('file').click());
  $('file').addEventListener('change', () => openFile($('file').files[0]));
  const conf = $('conf');
  conf.addEventListener('dragover', (e) => { e.preventDefault(); conf.classList.add('over'); });
  conf.addEventListener('dragleave', () => conf.classList.remove('over'));
  conf.addEventListener('drop', (e) => {
    e.preventDefault();
    conf.classList.remove('over');
    if (e.dataTransfer.files && e.dataTransfer.files[0]) openFile(e.dataTransfer.files[0]);
  });

  const later = debounce(run, 250);
  conf.addEventListener('input', () => { fileBytes = null; $('conf-label').textContent = 'The file never leaves your browser.'; later(); });
  for (const id of ['version', 'tls', 'compression']) $(id).addEventListener('change', run);
  $('get-text').addEventListener('input', debounce(runGet, 250));
  $('get-version').addEventListener('change', runGet);

  example('typical');
})();
