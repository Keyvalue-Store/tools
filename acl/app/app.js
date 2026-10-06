// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Page logic for the ACL Builder. Everything the servers do lives in
// ../acl.js; this file reads the form and draws the answers.

(function () {
  'use strict';
  const A = window.KVAcl;
  const $ = (id) => document.getElementById(id);
  // The users the rules section made, for the check section.
  let users = [];

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
  const show = (s) => (s === null || s === undefined ? '' : A.fromBinary(s));
  const cmdline = (argv) => argv.map((a) => show(A.quote(a))).join(' ');
  // A block of text with a button that copies it.
  function copyBlock(text) {
    const row = el('div', { class: 'copy-row' });
    const pre = el('pre', { class: 'printed', text: text });
    const b = el('button', { type: 'button', class: 'btn', text: 'Copy' });
    b.addEventListener('click', () => {
      const done = () => { b.textContent = 'Copied'; setTimeout(() => { b.textContent = 'Copy'; }, 1500); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => select(pre));
      else select(pre);
    });
    row.append(pre, b);
    return row;
  }
  function select(node) {
    const r = document.createRange();
    r.selectNodeContents(node);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }

  // ---- the version list ----
  const select$ = $('version');
  for (const server of ['redis', 'valkey']) {
    const group = el('optgroup', { label: server === 'redis' ? 'Redis' : 'Valkey' });
    for (const v of A.versions().filter((x) => x.server === server).reverse()) group.append(el('option', { value: v.id, text: v.label }));
    select$.append(group);
  }
  select$.value = 'redis-8.10.2';
  const label = (id) => A.versions().find((v) => v.id === id).label;

  // ---- applying the rules ----

  // The users the text makes with one version: { users, error, crash, kind }.
  function apply(text, id, kind) {
    const k = kind === 'auto' ? undefined : kind;
    const read = A.readRules(text, id, k);
    if (read.error) return { kind: read.kind, users: [], error: read.error };
    if (read.kind === 'setuser') {
      const u = read.users[0];
      const r = A.setUser(null, u.name, u.args, id);
      return { kind: read.kind, users: r.ok ? [r.user] : [], error: r.ok ? null : 'ERR ' + r.error, label: 'ACL SETUSER' };
    }
    if (read.kind === 'aclfile') {
      const r = A.loadFile(read.text, id, { filename: 'users.acl' });
      if (r.crash) return { kind: read.kind, users: [], crash: 'ACL LOAD crashes the server: ' + r.crash + '.' };
      if (!r.ok) return { kind: read.kind, users: [], error: 'ERR ' + r.error, label: 'ACL LOAD' };
      const named = new Set(read.users.map((u) => u.name));
      return { kind: read.kind, users: [...r.users.values()].filter((u) => named.has(u.name)) };
    }
    // Config lines: checked as the server reads the file, then created at startup.
    const state = {};
    const lines = [];
    for (const u of read.users) {
      if (!u.name) continue;
      const argv = [A.toBinary('user'), u.name].concat(u.args);
      const e = A.checkUserLine(argv, id, { state: state });
      if (e) return { kind: read.kind, users: [], error: e, label: 'Line ' + u.line + ' of the config file', fatal: true };
      lines.push(argv);
    }
    const r = A.startupUsers(lines, id);
    if (r.log) return { kind: read.kind, users: [], error: r.log.join('\n'), label: 'Startup', fatal: true };
    return { kind: read.kind, users: lines.map((argv) => r.users.get(argv[1])) };
  }

  function renderUser(u, id, out) {
    const e = A.explain(u, id);
    const block = el('div', { class: 'user-block' });
    block.append(el('h3', { text: 'User ' + show(u.name) }));
    if (e.line) {
      block.append(el('p', { class: 'small muted', text: 'ACL LIST prints:' }));
      block.append(copyBlock(show(e.line)));
    }
    const facts = el('dl', { class: 'facts' });
    facts.append(el('dt', { text: 'Login' }), el('dd', { text: e.login.text }));
    if (e.everyone.length) facts.append(el('dt', { text: 'Any user' }), el('dd', { text: 'May run ' + e.everyone.join(', ').replace(/, ([^,]*)$/, ' and $1') + ', whatever the rules say.' }));
    block.append(facts);
    e.selectors.forEach((s, i) => {
      if (e.selectors.length > 1) block.append(el('h3', { text: i === 0 ? 'Rules outside parentheses' : 'Selector ' + i + ': a second set of rules; a command may run if any set allows it' }));
      block.append(table(['Rule', 'What it does'], s.rules.map((r) => [td('rule', show(r.rule)), r.text])));
      const f = el('dl', { class: 'facts' });
      f.append(el('dt', { text: 'Commands' }), el('dd', null, [commandList(s)]));
      f.append(el('dt', { text: 'Keys' }), el('dd', { text: s.keysText || s.keys.map((k) => show(k.text)).join(' ') }));
      f.append(el('dt', { text: 'Channels' }), el('dd', { text: s.channelsText || s.channels.map((c) => show(c.text)).join(' ') }));
      if (s.databases) f.append(el('dt', { text: 'Databases' }), el('dd', { text: s.databases.text }));
      block.append(f);
    });
    if (e.warnings.length) {
      block.append(el('h3', { text: 'What to look at' }));
      for (const w of e.warnings) block.append(verdict(w.level === 'bad' ? 'bad' : w.level === 'warn' ? 'warn' : 'info', w.title, show(w.text)));
    }
    out.append(block);
  }
  function commandList(s) {
    const c = s.commands;
    const wrap = el('div');
    wrap.append(el('span', { text: c.text + (c.dangerous.length ? ' ' + plural(c.dangerous.length, 'of them is', 'of them are') + ' in @dangerous.' : '') + ' ' }));
    if (c.allowed && c.allowed < c.total) {
      const d = el('details');
      d.append(el('summary', { text: 'Which' }));
      const ul = el('ul', { class: 'cmdlist' });
      const danger = new Set(c.dangerous);
      for (const name of c.list) ul.append(el('li', { class: danger.has(name) ? 'danger' : '', text: name }));
      d.append(ul);
      wrap.append(d);
    }
    return wrap;
  }

  function runRules() {
    const out = $('rules-result');
    out.textContent = '';
    const text = $('rules').value;
    const id = select$.value;
    $('db-box').classList.toggle('hidden', !A.getVersion(id).f.dbPerms);
    users = [];
    if (!text.trim()) {
      out.append(verdict('info', 'Paste a user\'s rules above', 'Or try an example.'));
      fillUsers();
      runCheck();
      return;
    }
    let r;
    try { r = apply(text, id, $('kind').value); } catch (err) {
      out.append(verdict('warn', 'The builder couldn\'t read this', err.message));
      return;
    }
    if (r.crash) out.append(verdict('bad', label(id) + ' crashes', r.crash));
    else if (r.error) {
      out.append(verdict('bad', label(id) + (r.fatal ? ' stops' : ' refuses the rules'), r.label ? r.label + ' gets:' : null));
      out.append(el('pre', { class: 'printed', text: (r.fatal ? '' : '(error) ') + show(r.error) }));
    } else {
      const what = r.kind === 'aclfile' ? 'ACL LOAD reads the file' : r.kind === 'config' ? 'The server starts with these user lines' : 'ACL SETUSER accepts the rules';
      out.append(verdict('ok', label(id) + ': ' + what, r.users.length > 1 ? plural(r.users.length, 'user', 'users') + '.' : null));
      for (const u of r.users) renderUser(u, id, out);
      users = r.users;
    }
    renderVersions(text, id, out);
    fillUsers();
    runCheck();
  }

  function renderVersions(text, current, out) {
    out.append(el('h3', { text: 'With every version' }));
    const listed = (r, id) => (r.users ? r.users.map((u) => A.listLine(u, id)) : []);
    let here;
    try { here = listed(apply(text, current, $('kind').value), current).map((l) => l.line).join('\n'); } catch (e) { here = null; }
    const rows = A.versions().map((v) => {
      let r;
      try { r = apply(text, v.id, $('kind').value); } catch (e) { r = { error: e.message }; }
      let what;
      if (r.crash) what = td('no', 'crashes: ' + r.crash);
      else if (r.error) what = td('no', show(r.error).split('\n')[0]);
      else {
        const lines = listed(r, v.id);
        const crash = lines.find((l) => l.crash);
        const same = v.id !== current && lines.map((l) => l.line).join('\n') === here;
        what = crash ? td('no', 'accepts the rules; ACL LIST then crashes the server')
          : same ? td('yes', 'the same as ' + label(current))
          : td('yes', lines.length === 1 ? show(lines[0].line) : 'accepts them');
      }
      const pick = el('button', { type: 'button', class: 'linkish', text: v.label });
      pick.addEventListener('click', () => { select$.value = v.id; runRules(); $('h-rules').scrollIntoView({ behavior: 'smooth' }); });
      return { cls: v.id === current ? 'on' : '', cells: [pick, what] };
    });
    out.append(table(['Version', 'What it does'], rows, 'versions-table'));
  }

  let shownNames = '';
  function fillUsers() {
    const sel = $('user');
    const keep = sel.value;
    const names = users.map((u) => show(u.name)).join('\n');
    sel.textContent = '';
    users.forEach((u, i) => sel.append(el('option', { value: String(i), text: show(u.name) })));
    // The same users keep the one picked; otherwise the first that isn't default.
    const first = Math.max(0, users.findIndex((u) => show(u.name) !== 'default'));
    sel.value = names === shownNames && keep ? keep : String(first);
    shownNames = names;
    $('user-box').classList.toggle('hidden', users.length < 2);
  }

  // ---- checking commands ----
  function reasonText(r) {
    if (r.allowed) return r.selectors.length > 1 ? (r.selector > 0 ? 'Selector ' + r.selector + ' allows it.' : 'The rules outside parentheses allow it.') : 'Allowed.';
    if (r.reason === 'command') return 'The user may not run ' + r.command.replace('|', ' ').toUpperCase() + '.';
    if (r.reason === 'key') {
      const k = r.keys.find((x) => x.index === r.index);
      const need = k ? (k.flags.includes('access') ? (k.flags.some((f) => f === 'insert' || f === 'delete' || f === 'update') ? 'read and write' : 'read') : (k.flags.length ? 'write' : 'use')) : 'use';
      return 'No key pattern lets it ' + need + ' ' + show(k ? k.key : '') + '.';
    }
    if (r.reason === 'channel') return 'No channel pattern covers ' + show((r.channels.find((c) => c.index === r.index) || {}).channel || '') + '.';
    if (r.reason === 'db') return r.database === 'all' ? r.command.replace('|', ' ').toUpperCase() + ' works on every database, and the user may use only some.' : 'The user may not use database ' + r.database + '.';
    return '';
  }
  function runCheck() {
    const out = $('check-result');
    out.textContent = '';
    const text = $('commands').value;
    if (!text.trim()) return;
    const u = users[Number($('user').value) || 0];
    if (!u) { out.append(verdict('info', 'No user to check against', 'The rules above have to work first.')); return; }
    const id = select$.value;
    const entries = A.parseMonitor(text);
    const db = Number($('db').value) || 0;
    let denied = 0;
    const rows = entries.map((e) => {
      const r = A.check(u, e.argv, id, { db: e.db != null ? e.db : db });
      const bad = !r.allowed || !!r.reply;
      if (!r.allowed) denied++;
      const status = r.command === null ? td('status warn', 'unknown') : r.allowed ? (r.reply ? td('status warn', 'allowed') : td('status ok', 'allowed')) : td('status bad', 'denied');
      const dry = r.dryrun ? (r.dryrun.error ? '(error) ERR ' + show(r.dryrun.error) : show(r.dryrun.reply)) : '(6.2 has no ACL DRYRUN)';
      const reply = r.reply ? '(error) ' + show(r.reply.error) : 'runs';
      return { cls: bad && !r.allowed ? 'bad' : '', cells: [td('mono cmd', cmdline(e.argv)), status, r.command === null || (!r.allowed && !r.reason) ? '' : reasonText(r), td('mono', dry), td('mono', reply)] };
    });
    if (!entries.length) { out.append(verdict('info', 'No commands found', 'One command per line.')); return; }
    out.append(verdict(denied ? 'bad' : 'ok', denied ? plural(denied, 'command is', 'commands are') + ' refused' : (entries.length === 1 ? 'The user may run it' : 'The user may run all ' + entries.length),
      'User ' + show(u.name) + ' on ' + label(id) + '.'));
    out.append(table(['Command', '', 'Why', 'ACL DRYRUN replies', 'The command gets'], rows));
  }

  // ---- drafting a user ----
  function runBuild() {
    const out = $('build-result');
    out.textContent = '';
    const text = $('monitor').value;
    if (!text.trim()) return;
    const id = select$.value;
    const entries = A.parseMonitor(text);
    const clients = [...new Set(entries.map((e) => e.client).filter(Boolean))];
    const sel = $('client');
    const keep = sel.value;
    sel.textContent = '';
    sel.append(el('option', { value: '', text: 'All of them (' + clients.length + ')' }));
    for (const c of clients) sel.append(el('option', { value: c, text: c }));
    if (clients.includes(keep)) sel.value = keep;
    $('client-box').classList.toggle('hidden', clients.length < 2);
    if (!entries.length) { out.append(verdict('info', 'No commands found', 'Paste what MONITOR printed, or commands one per line.')); return; }
    const name = A.toBinary($('name').value.trim() || 'app');
    const b = A.build(entries, id, { name: name, keys: $('keys-mode').value, client: sel.value || null });
    if (b.error) { out.append(verdict('bad', 'The draft doesn\'t work on ' + label(id), show(b.error))); return; }
    const denied = b.check.filter((c) => !c.allowed);
    out.append(verdict(denied.length ? 'warn' : 'ok', 'A user for ' + label(id),
      (denied.length ? plural(denied.length, 'line is', 'lines are') + ' still refused.' : 'Every line it read is allowed with these rules, and nothing else.') + ' ' +
      plural(b.commands.length, 'command', 'commands') + ', ' + plural(b.keys.length, 'key pattern', 'key patterns') + ', ' + plural(b.channels.length, 'channel pattern', 'channel patterns') + '.'));
    out.append(el('p', { class: 'small muted', text: 'Run this, after you put a long random password in place of CHANGE-ME (ACL GENPASS makes one):' }));
    out.append(copyBlock(show(b.setuser)));
    out.append(el('p', { class: 'small muted', text: 'Or put this line in the ACL file. It holds the password\'s SHA-256, so make it from your own password: run the ACL SETUSER above, then copy the line ACL LIST prints.' }));
    out.append(copyBlock(show(b.aclfile)));
    const actions = el('div', { class: 'row' });
    const explain = el('button', { type: 'button', class: 'btn', text: 'Explain this user above' });
    explain.addEventListener('click', () => {
      $('rules').value = show(b.setuser);
      $('kind').value = 'auto';
      runRules();
      $('h-rules').scrollIntoView({ behavior: 'smooth' });
    });
    actions.append(explain);
    out.append(actions);
    out.append(el('h3', { text: 'What the client did' }));
    out.append(table(['Command', 'Times'], b.commands.map((c) => [td('mono', c.command), td('num', String(c.count))])));
    if (b.approximate) out.append(verdict('info', 'Some names have spaces', 'ACL patterns can\'t hold spaces, so ? stands in for each one. The pattern also matches the same name with another character there.'));
    if (denied.length) out.append(table(['Line', 'Still refused', 'Why'], denied.map((c) => [td('num', String(c.line || '')), td('mono', cmdline(c.argv)), c.reason])));
    if (b.skipped.length) {
      const d = el('details');
      d.append(el('summary', { text: plural(b.skipped.length, 'line', 'lines') + ' left out' }));
      d.append(table(['Line', 'Text', 'Why'], b.skipped.map((s) => [td('num', String(s.line || '')), td('mono', cmdline(s.argv)), s.reason])));
      out.append(d);
    }
  }

  // ---- examples ----
  const EXAMPLES = {
    app: ['ACL SETUSER app on >s3cret-but-longer ~app:* %R~config:* &events:* -@all +@read +@string +@hash -keys +del +publish'],
    file: [
      'user default off',
      'user admin on #bfd159e59e9f4f7bbe5c8694e29c7b855ced1e765c1405bf8b688d3843dc7cb1 ~* &* +@all',
      'user worker on #639898675899be31d71af2dd022b938805d03ee0e1abd5ec3b356f0eb0db9d77 ~jobs:* resetchannels -@all +@list +@connection',
      'user metrics on #a8f9a2a6a7141411f277edf675ca2d64fc75d9cc46245bdc771354521889805d resetchannels -@all +info +ping +client|list +slowlog|get'
    ],
    mistakes: ['ACL SETUSER reports on nopass ~reports:* +@read +keys +select|0 +config|set &*'],
    monitor: [
      'OK',
      '1759734012.304117 [0 10.0.0.7:52310] "AUTH" "(redacted)"',
      '1759734012.305002 [0 10.0.0.7:52310] "GET" "user:42:profile"',
      '1759734012.305391 [0 10.0.0.7:52310] "HGETALL" "session:9f2c1e"',
      '1759734012.306118 [0 10.0.0.7:52310] "EXPIRE" "session:9f2c1e" "1800"',
      '1759734012.307550 [0 10.0.0.7:52310] "GET" "user:77:profile"',
      '1759734012.308001 [0 10.0.0.7:52310] "INCR" "stats:logins"',
      '1759734012.309322 [0 10.0.0.7:52310] "PUBLISH" "events:login" "42"',
      '1759734012.401220 [0 10.0.0.9:41002] "LPUSH" "jobs:email" "{\\"to\\":42}"',
      '1759734012.512881 [0 10.0.0.9:41002] "BRPOP" "jobs:email" "jobs:sms" "5"',
      '1759734012.600114 [0 lua] "SET" "user:42:last_seen" "1759734012"'
    ]
  };
  function example(name) {
    if (name === 'monitor') { $('monitor').value = EXAMPLES.monitor.join('\n'); runBuild(); return; }
    $('rules').value = EXAMPLES[name].join('\n');
    $('kind').value = 'auto';
    if (name === 'file' && !$('commands').value.trim()) $('commands').value = 'LPUSH jobs:email x\nGET jobs:email\nCONFIG GET maxmemory';
    runRules();
  }
  $('ex-app').addEventListener('click', () => example('app'));
  $('ex-file').addEventListener('click', () => example('file'));
  $('ex-mistakes').addEventListener('click', () => example('mistakes'));
  $('ex-monitor').addEventListener('click', () => example('monitor'));

  // ---- files ----
  function openInto(input, f, then) {
    if (!f) return;
    if (f.size > 32 * 1024 * 1024) return;
    f.text().then((t) => { input.value = t; then(); });
  }
  function dropTarget(area, then) {
    area.addEventListener('dragover', (e) => { e.preventDefault(); area.classList.add('over'); });
    area.addEventListener('dragleave', () => area.classList.remove('over'));
    area.addEventListener('drop', (e) => {
      e.preventDefault();
      area.classList.remove('over');
      if (e.dataTransfer.files && e.dataTransfer.files[0]) openInto(area, e.dataTransfer.files[0], then);
    });
  }
  $('open-rules').addEventListener('click', () => $('file-rules').click());
  $('file-rules').addEventListener('change', () => openInto($('rules'), $('file-rules').files[0], runRules));
  $('open-monitor').addEventListener('click', () => $('file-monitor').click());
  $('file-monitor').addEventListener('change', () => openInto($('monitor'), $('file-monitor').files[0], runBuild));
  dropTarget($('rules'), runRules);
  dropTarget($('monitor'), runBuild);

  $('rules').addEventListener('input', debounce(runRules, 250));
  $('commands').addEventListener('input', debounce(runCheck, 250));
  $('monitor').addEventListener('input', debounce(runBuild, 300));
  for (const id of ['name', 'keys-mode', 'client']) $(id).addEventListener(id === 'name' ? 'input' : 'change', debounce(runBuild, 200));
  select$.addEventListener('change', () => { runRules(); runBuild(); });
  $('kind').addEventListener('change', runRules);
  $('user').addEventListener('change', runCheck);
  $('db').addEventListener('input', debounce(runCheck, 200));

  $('commands').value = 'GET app:42\nSET app:42 hello\nGET config:theme\nSET config:theme dark\nKEYS *\nPUBLISH events:signup 42\nFLUSHALL';
  example('app');
  example('monitor');
})();
