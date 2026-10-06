// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Page logic for the Config Checker. Everything the servers do lives in
// ../config.js; this file reads the form and draws the answers.

(function () {
  'use strict';
  const C = window.KVConfig;
  const $ = (id) => document.getElementById(id);
  // The checker reads files and pasted text up to 1 MiB, about eight times
  // the default redis.conf, so that a file opened by mistake can't hang the page.
  const MAX_SIZE = 1024 * 1024;
  // The most rows a table or list draws; a note counts the rest.
  const MAX_ROWS = 500;
  const HINT = 'The file never leaves your browser.';
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
  // A verdict box. It has no live role: the summary in #announce is what a
  // screen reader hears, once, when it changes.
  function verdict(kind, title, body) {
    const box = el('div', { class: 'verdict ' + kind });
    box.innerHTML = ICONS[kind];
    const p = el('div');
    p.append(el('p', null, [el('strong', { text: title })]));
    for (const line of [].concat(body || [])) if (line) p.append(el('p', null, [line]));
    box.append(p);
    return box;
  }
  // A table. A header given as { sr: 'Status' } has text only for screen readers.
  function table(headers, rows, cls) {
    const wrap = el('div', { class: 'table-wrap' });
    const t = el('table', { class: cls || '' });
    const tr = el('tr');
    for (const h of headers) tr.append(el('th', { scope: 'col' }, [typeof h === 'string' ? h : el('span', { class: 'sr-only', text: h.sr })]));
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
  const count = (n) => n.toLocaleString('en-US');
  const plural = (n, one, many) => count(n) + ' ' + (n === 1 ? one : many);
  // Bytes to show: control bytes, characters that don't show (a byte order
  // mark, say) and bytes that aren't UTF-8 come out as \xHH.
  const show = (s, keep) => C.visible(s, keep);
  const shown = (s) => (show(s) === '' ? '""' : show(s));
  const size = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MiB' : n >= 10240 ? Math.round(n / 1024) + ' KiB' : plural(n, 'byte', 'bytes'));
  // At most MAX_ROWS of a list, and a note on the rest.
  function capped(list, what) {
    if (list.length <= MAX_ROWS) return { list: list, note: null };
    return { list: list.slice(0, MAX_ROWS), note: el('p', { class: 'small muted', text: plural(list.length - MAX_ROWS, 'more ' + what + ' isn\'t', 'more ' + what + 's aren\'t') + ' shown here. The JSON report has them all.' }) };
  }
  function download(name, text, type) {
    const a = el('a', { href: URL.createObjectURL(new Blob([text], { type: type })), download: name });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  // One short summary for screen readers, said only when it changes.
  const said = { file: null, get: null };
  function announce(part, text) {
    if (said[part] === text) return;
    said[part] = text;
    if (text) $('announce').textContent = text;
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

  const has = (id, kind) => C.getVersion(id).defs.some((c) => c.build === kind);
  // The build the boxes describe. It applies to every version in the table,
  // so the table and the details always agree; the boxes show only for the
  // version picked, when it has such a build.
  function options() {
    const id = $('version').value;
    $('tls-box').classList.toggle('hidden', !has(id, 'tls'));
    $('compression-box').classList.toggle('hidden', !has(id, 'compression'));
    return { tls: $('tls').checked, compression: $('compression').checked };
  }
  // What a build of a version is, when it isn't the usual one.
  function buildOf(id, tls, compression) {
    const parts = [];
    if (!tls && has(id, 'tls')) parts.push('without TLS');
    if (compression && has(id, 'compression')) parts.push('with BUILD_COMPRESSION=yes');
    return parts.length ? 'built ' + parts.join(' and ') : '';
  }
  const input = () => (fileBytes || $('conf').value);

  // ---- drawing ----
  function where(lines) {
    if (!lines || !lines.length) return 'at startup';
    if (lines.length === 1) return 'line ' + lines[0];
    if (lines.length <= 8) return 'lines ' + lines.join(', ');
    return 'lines ' + lines.slice(0, 5).join(', ') + ' and ' + count(lines.length - 6) + ' more, up to ' + lines[lines.length - 1];
  }
  const BOM = '\xef\xbb\xbf';

  function renderStops(r, label, out) {
    const e = r.error;
    const why = [];
    // A byte order mark is invisible in an editor, so say what it is.
    if (r.lines.length && r.lines[0].text.startsWith(BOM) && r.lines[0].status !== 'ok') {
      why.push('Line 1 starts with a byte order mark, the bytes \\xef\\xbb\\xbf that some editors put at the start of a UTF-8 file. The server reads them as part of the line. Save the file without it.');
    }
    if (e.startup && e.line) {
      out.append(verdict('bad', label + ' stops at line ' + e.line, [show(e.message)].concat(why, ['What it logs:'])));
    } else if (e.startup) {
      out.append(verdict('bad', label + ' reads the file, then stops while starting', [show(e.message)].concat(why, ['What it logs:'])));
    } else {
      out.append(verdict('bad', label + ' stops at ' + (e.line === null ? 'the end of the file' : 'line ' + e.line), why.concat(['It prints this and exits:'])));
    }
    // The server's own words, with odd bytes shown. A long log is cut short.
    let printed = show(e.output, '\n').replace(/^\n/, '');
    const lines = printed.split('\n');
    if (lines.length > 60) printed = lines.slice(0, 50).join('\n') + '\n... and ' + count(lines.length - 51) + ' more lines\n';
    out.append(el('pre', { class: 'printed', text: printed }));
    const later = r.problems.filter((p) => p !== e);
    if (later.length) {
      out.append(el('h3', { text: 'Then it would stop at' }));
      out.append(el('p', { class: 'small muted', text: 'Each as if the lines before it were fixed, so you can fix them all at once.' }));
      const c = capped(later, 'line');
      out.append(table(['Line', 'Error', 'The line'], c.list.map((p) => [p.line === null ? (p.startup ? 'startup' : 'end') : String(p.line), show(p.message), td('val', p.text ? show(p.text) : '')])));
      if (c.note) out.append(c.note);
    }
  }

  // The verdict of one version, for the table.
  function versionWords(r) {
    let what;
    if (r.ok) return 'starts';
    if (r.error.startup) what = 'stops ' + (r.error.line ? 'at line ' + r.error.line : 'while starting') + ': ' + show(r.error.short || r.error.message);
    else what = 'stops at ' + (r.error.line === null ? 'the end' : 'line ' + r.error.line) + ': ' + show(r.error.message);
    return what.length > 200 ? what.slice(0, 197) + '...' : what;
  }
  // The table of versions. The picked version's row is filled now; the
  // others fill in one at a time, in the background, by fill().
  function renderVersions(results, current, opt, out) {
    out.append(el('h3', { text: 'With every version' }));
    const cells = new Map();
    const rows = C.versions().map((v) => {
      const pick = el('button', { type: 'button', class: 'linkish', text: v.label });
      pick.addEventListener('click', () => { $('version').value = v.id; run(); $('h-out').scrollIntoView({ behavior: 'smooth' }); });
      const cell = el('td', { class: 'muted', text: 'checking...' });
      cells.set(v.id, cell);
      return { cls: v.id === current ? 'on' : '', cells: [pick, { td: cell }] };
    });
    out.append(table(['Version', 'With this file'], rows, 'versions-table'));
    const builds = [];
    if (!opt.tls) builds.push('Redis 6.2 and 7.0 as built without TLS');
    if (opt.compression) builds.push('Redis 8.10 as built with BUILD_COMPRESSION=yes');
    if (builds.length) out.append(el('p', { class: 'small muted', text: builds.join('; ') + ', as the boxes above say.' }));
    const fill = (id) => {
      const r = results.get(id);
      const cell = cells.get(id);
      if (!r || !cell) return;
      cell.className = r.ok ? 'starts' : 'stops';
      cell.textContent = versionWords(r);
    };
    for (const id of results.keys()) fill(id);
    return fill;
  }

  function renderSettings(r, out) {
    // In the order of the file; settings the server adjusts on its own go last.
    const first = (name) => (r.setBy.has(name) ? r.setBy.get(name)[0] : Infinity);
    const changed = [];
    for (const [name, value] of r.values) if (r.setBy.has(name) || value !== r.defaults.get(name)) changed.push([name, value]);
    changed.sort((a, b) => first(a[0]) - first(b[0]));
    out.append(el('h3', { text: changed.length ? 'Settings the file sets (' + changed.length + ')' + (r.ok ? '' : ', once the lines it stops at are fixed') : 'Settings' }));
    if (!changed.length) { out.append(el('p', { class: 'muted', text: 'The file changes no settings: everything has its default.' })); return; }
    out.append(el('p', { class: 'small muted', text: 'Values as CONFIG GET would report them: sizes in bytes, under the current names.' }));
    out.append(table(['Setting', 'Value', 'Default', 'Set by'], changed.map(([name, value]) => {
      const d = r.defaults.get(name);
      return [td('val', name), td('val', shown(value)), td('val', value === d ? '(the same)' : shown(d)), where(r.setBy.get(name))];
    })));
  }

  function renderFindings(r, out) {
    const findings = C.advise(r);
    out.append(el('h3', { text: 'What to look at' }));
    if (!findings.length) { out.append(el('p', { class: 'muted', text: 'Nothing stands out.' })); return; }
    const box = el('div', { class: 'finding' });
    const c = capped(findings, 'finding');
    for (const f of c.list) box.append(verdict(f.level === 'bad' ? 'bad' : f.level === 'warn' ? 'warn' : 'info', show(C.toBinary(f.title)), show(C.toBinary(f.text))));
    out.append(box);
    if (c.note) out.append(c.note);
  }

  function renderNotes(r, out) {
    if (!r.notes.length && !r.unchecked.length) return;
    out.append(el('h3', { text: 'Notes' }));
    const ul = el('ul');
    const items = r.notes.map((n) => show(n.message)).concat(r.unchecked.map((u) => (u.line ? 'Line ' + u.line + ': ' : '') + show(u.message)));
    const c = capped(items, 'note');
    for (const text of c.list) ul.append(el('li', { text: text }));
    out.append(ul);
    if (c.note) out.append(c.note);
  }

  function renderLines(r, out) {
    const lines = r.lines.filter((l) => l.kind !== 'blank' && l.kind !== 'comment');
    if (!lines.length) return;
    const d = el('details');
    d.append(el('summary', { text: 'The file line by line (' + plural(lines.length, 'line', 'lines') + ' with something on them)' }));
    const label = { ok: 'ok', error: 'stops', ignored: 'ignored', unchecked: 'not checked' };
    const c = capped(lines, 'line');
    d.append(table(['Line', { sr: 'Status' }, 'Text', 'What the server does'], c.list.map((l) => {
      let what = l.message ? show(l.message) : '';
      if (!what && l.kind === 'config') what = l.alias ? 'Sets ' + l.name + ' (an old name for it).' : 'Sets ' + show(l.name) + '.';
      if (!what && l.kind === 'rename-command') what = 'Renames a command.';
      if (!what && l.kind === 'sentinel') what = 'Nothing outside Sentinel mode.';
      return { cls: l.status, cells: [td('num', String(l.line)), td('status ' + l.status, label[l.status] || l.status), td('text', show(l.text)), what] };
    }), 'lines-table'));
    if (c.note) d.append(c.note);
    out.append(d);
  }

  // Results for the text in the box, by version, while the text and the
  // build stay the same: picking another version doesn't check it again.
  let cache = { input: null, tls: null, compression: null, results: new Map() };
  // Each run gets a number; background work from an older run stops.
  let generation = 0;
  let timer = null;
  function stop() { generation++; clearTimeout(timer); }

  function run() {
    stop();
    const gen = generation;
    const out = $('result');
    out.textContent = '';
    const text = input();
    const opt = options();
    const id = $('version').value;
    if (typeof text === 'string' && !text.trim()) {
      out.append(verdict('info', 'Paste a config file above', 'Or open one, or try an example.'));
      announce('file', '');
      return;
    }
    if (text.length > MAX_SIZE) {
      out.append(verdict('warn', 'This is too big for a config file', 'It is ' + size(text.length) + '. The checker reads up to 1 MiB, about eight times the size of the default redis.conf.'));
      announce('file', 'Too big to check.');
      return;
    }
    if (cache.input !== text || cache.tls !== opt.tls || cache.compression !== opt.compression) {
      cache = { input: text, tls: opt.tls, compression: opt.compression, results: new Map() };
    }
    const results = cache.results;
    let r = results.get(id);
    try {
      if (!r) { r = C.check(text, id, opt); results.set(id, r); }
    } catch (e) {
      out.append(verdict('warn', 'The checker couldn\'t read this', e.message));
      announce('file', 'The checker couldn\'t read this.');
      return;
    }
    const label = r.label + (buildOf(id, opt.tls, opt.compression) ? ' ' + buildOf(id, opt.tls, opt.compression) : '');
    if (r.ok) {
      const n = r.lines.filter((l) => l.kind && l.kind !== 'blank' && l.kind !== 'comment').length;
      out.append(verdict('ok', label + ' starts with this file', plural(n, 'line', 'lines') + ' read, ' + plural(r.setBy.size, 'setting', 'settings') + ' set.'));
      announce('file', label + ' starts with this file.');
    } else {
      renderStops(r, label, out);
      const e = r.error;
      announce('file', label + (e.startup && !e.line ? ' stops while starting.' : ' stops at ' + (e.line === null ? 'the end of the file.' : 'line ' + e.line + '.')));
    }
    renderNotes(r, out);
    renderFindings(r, out);
    renderSettings(r, out);
    renderLines(r, out);
    const fill = renderVersions(results, id, opt, out);
    const buttons = el('div', { class: 'row' });
    const short = el('button', { type: 'button', class: 'btn', text: 'Download the short file' });
    short.addEventListener('click', () => download(fileName.replace(/(\.conf)?$/, '.short.conf'),
      '# The settings of ' + show(C.toBinary(fileName)) + ' that differ from the defaults of ' + label + '.\n' + C.minimal(r).join('\n') + '\n', 'text/plain'));
    const json = el('button', { type: 'button', class: 'btn', text: 'Download the report as JSON' });
    json.addEventListener('click', () => download('config-report.json', JSON.stringify(report(r, text, opt, results), null, 2) + '\n', 'application/json'));
    buttons.append(short, json);
    out.append(buttons);
    if (!r.ok) out.append(el('p', { class: 'small muted', text: 'The short file keeps the lines the server stops at as comments, each with the reason, so you can see what to fix.' }));
    // The other versions, one at a time, so the page answers between them.
    const todo = C.versions().map((v) => v.id).filter((x) => !results.has(x));
    const step = () => {
      if (gen !== generation || !todo.length) return;
      const next = todo.shift();
      try { results.set(next, C.check(text, next, opt)); } catch (e) { return; }
      fill(next);
      timer = setTimeout(step, 0);
    };
    timer = setTimeout(step, 0);
  }

  // The report as JSON: everything the page shows, the table of versions included.
  function report(r, text, opt, results) {
    const out = C.report(r);
    out.versions = C.versions().map((v) => {
      let x = results.get(v.id);
      if (!x) { x = C.check(text, v.id, opt); results.set(v.id, x); }
      return { version: x.version, label: x.label, starts: x.ok, line: x.error ? x.error.line : null,
        message: x.error ? C.fromBinary(x.error.short || x.error.message) : null };
    });
    return out;
  }

  // ---- CONFIG GET ----
  function runGet() {
    const out = $('get-result');
    out.textContent = '';
    $('get-guess').textContent = '';
    const text = $('get-text').value;
    if (!text.trim()) { announce('get', ''); return; }
    if (text.length > MAX_SIZE) {
      out.append(verdict('warn', 'This is too big for CONFIG GET output', 'It is ' + size(text.length) + '. The output of CONFIG GET * is usually under 20 KiB.'));
      announce('get', 'Too big to compare.');
      return;
    }
    const choice = $('get-version').value;
    const g = C.readConfigGet(text, choice === 'guess' ? null : choice);
    if (g.kind === 'none' || g.kind === 'other' || g.kind === 'config-file') {
      let title, body;
      if (g.kind === 'config-file') {
        title = 'This looks like a config file';
        const move = el('button', { type: 'button', class: 'linkish', text: 'Check it as a config file' });
        move.addEventListener('click', () => {
          fileBytes = null;
          fileName = 'redis.conf';
          $('conf').value = text;
          $('conf-hint').textContent = HINT;
          $('get-text').value = '';
          runGet();
          run();
          $('h-file').scrollIntoView({ behavior: 'smooth' });
        });
        body = ['This box takes the output of CONFIG GET *. A config file goes in the box at the top of the page.', move];
      } else if (g.kind === 'none') {
        title = 'No settings found';
        body = 'Paste the output of CONFIG GET * as redis-cli prints it.';
      } else {
        title = 'This doesn\'t look like CONFIG GET output';
        body = (g.known ? 'Only ' + count(g.known) + ' of its ' + count(g.settings) + ' names are settings of ' + g.label + '.' : 'None of its names are settings of Redis or Valkey.') + ' Paste the output of CONFIG GET * as redis-cli prints it.';
      }
      out.append(verdict('warn', title, body));
      announce('get', title + '.');
      return;
    }
    const label = g.label + (buildOf(g.version, g.tls, g.compression) ? ' ' + buildOf(g.version, g.tls, g.compression) : '');
    const notes = [];
    if (g.guessed) notes.push(g.sure ? 'The names match ' + g.label + ' best.' : 'Too few settings to tell the version: compared with ' + g.label + '. Pick the version to compare with another.');
    if (!g.tls && has(g.version, 'tls')) notes.push('Compared with a build without TLS, since the output has no TLS settings.');
    if (g.compression && has(g.version, 'compression')) notes.push('Compared with a build with BUILD_COMPRESSION=yes, since the output has its settings.');
    $('get-guess').textContent = notes.join(' ');
    const changed = g.changed;
    let title;
    if (changed.length) title = plural(changed.length, 'setting differs', 'settings differ') + ' from the defaults of ' + label;
    else if (g.kind === 'full') title = 'Every setting has the default of ' + label;
    else title = (g.settings === 1 ? 'This setting has its default' : 'These ' + count(g.settings) + ' settings have their defaults') + ' in ' + label;
    out.append(verdict(changed.length ? 'info' : 'ok', title, plural(g.settings, 'setting', 'settings') + ' in the output' + (g.kind === 'partial' ? ', only some of them, so nothing is said about the rest.' : '.')));
    announce('get', title + '.');
    if (changed.length) {
      out.append(table(['Setting', 'Value', 'Default'], changed.map((x) => [td('val', x.name), td('val', shown(C.toBinary(x.value))), td('val', shown(x.default))])));
    }
    const list = (names) => names.slice(0, 50).map((n) => show(C.toBinary(n))).join(', ') + (names.length > 50 ? ' and ' + count(names.length - 50) + ' more' : '');
    if (g.missing.length) out.append(el('p', { class: 'small muted', text: 'Not in the output, which suggests another version: ' + list(g.missing.map((x) => x.name)) + '.' }));
    if (g.unknown.length) out.append(el('p', { class: 'small muted', text: 'Not settings of this version: ' + list(g.unknown) + '.' }));
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
    reading++;
    fileBytes = null;
    fileName = 'redis.conf';
    $('conf-hint').textContent = HINT;
    $('conf').value = EXAMPLES[name].join('\n');
    if (version) $('version').value = version;
    run();
  }
  $('ex-typical').addEventListener('click', () => example('typical'));
  $('ex-mistakes').addEventListener('click', () => example('mistakes'));
  $('ex-upgrade').addEventListener('click', () => example('upgrade', 'valkey-9.1.2'));

  // ---- files ----
  // Each read gets a number, so a slow read can't overwrite a later one.
  let reading = 0;
  // A file that can't be checked: say why in place of the results.
  function refuse(title, body) {
    stop();
    $('result').textContent = '';
    $('result').append(verdict('warn', title, body));
    announce('file', title + '.');
    $('h-out').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  const fileLabel = (f) => show(C.toBinary(f.name || 'The file'));
  function openFile(f) {
    if (!f) return;
    const n = ++reading;
    if (f.size > MAX_SIZE) {
      refuse(fileLabel(f) + ' is too big for a config file', 'It is ' + size(f.size) + '. The checker reads files up to 1 MiB, about eight times the size of the default redis.conf.');
      return;
    }
    f.arrayBuffer().then((buf) => {
      if (n !== reading) return;
      const bytes = new Uint8Array(buf);
      const what = C.sniff(bytes);
      if (what) { refuse(fileLabel(f) + ' looks like ' + what + ', not a config file', 'Open a redis.conf or valkey.conf, or paste one.'); return; }
      fileBytes = bytes;
      fileName = f.name || 'redis.conf';
      // ignoreBOM keeps a byte order mark in the text, so editing the text
      // gives the same verdict as the file's own bytes.
      $('conf').value = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
      let hint = fileLabel(f) + ', ' + plural(bytes.length, 'byte', 'bytes') + '. ' + HINT;
      try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (e) {
        hint += ' Some of its bytes aren\'t UTF-8, and editing it here changes them.';
      }
      $('conf-hint').textContent = hint;
      run();
    }).catch((e) => {
      if (n === reading) refuse('Couldn\'t read ' + fileLabel(f), e && e.message ? e.message : String(e));
    });
  }
  // CONFIG GET output dropped on its box: read as text.
  function openGetFile(f) {
    if (!f) return;
    if (f.size > MAX_SIZE) {
      $('get-result').textContent = '';
      $('get-result').append(verdict('warn', fileLabel(f) + ' is too big for CONFIG GET output', 'It is ' + size(f.size) + '.'));
      return;
    }
    f.text().then((text) => { $('get-text').value = text; runGet(); }).catch((e) => {
      $('get-result').textContent = '';
      $('get-result').append(verdict('warn', 'Couldn\'t read ' + fileLabel(f), e && e.message ? e.message : String(e)));
    });
  }
  $('open').addEventListener('click', () => $('file').click());
  $('file').addEventListener('change', () => {
    const f = $('file').files[0];
    // Cleared, so that choosing the same file again opens it again.
    $('file').value = '';
    openFile(f);
  });
  // Files can be dropped anywhere on the page: on the CONFIG GET box for
  // that box, anywhere else for the config file. Dropping text into a box
  // works as usual.
  const conf = $('conf');
  const carriesFiles = (e) => !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  const boxFor = (e) => ($('get-text').contains(e.target) ? $('get-text') : conf);
  const unmark = () => { conf.classList.remove('over'); $('get-text').classList.remove('over'); };
  window.addEventListener('dragover', (e) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const box = boxFor(e);
    if (!box.classList.contains('over')) { unmark(); box.classList.add('over'); }
  });
  window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) unmark(); });
  window.addEventListener('dragend', unmark);
  window.addEventListener('drop', (e) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    unmark();
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (boxFor(e) === conf) openFile(f);
    else openGetFile(f);
  });

  const later = debounce(run, 250);
  conf.addEventListener('input', () => { reading++; fileBytes = null; $('conf-hint').textContent = HINT; later(); });
  for (const id of ['version', 'tls', 'compression']) $(id).addEventListener('change', run);
  $('get-text').addEventListener('input', debounce(runGet, 250));
  $('get-version').addEventListener('change', runGet);

  example('typical');
})();
