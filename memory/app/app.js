// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Page logic for the Memory Calculator. Everything about the servers lives
// in ../memory.js; this file reads the form and draws the answers.

(function () {
  'use strict';
  const M = window.KVMemory;
  const $ = (id) => document.getElementById(id);

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
    warn: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2l9 16H1z" fill="currentColor" opacity=".15"/><path d="M10 8v4.5M10 15.2v.3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    info: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="9" fill="currentColor" opacity=".15"/><path d="M10 9v5M10 6v.3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
  };
  function verdict(kind, title, body) {
    const box = el('div', { class: 'verdict ' + kind });
    box.innerHTML = ICONS[kind];
    const p = el('div');
    p.append(el('p', null, [el('strong', { text: title })]));
    for (const line of [].concat(body || [])) if (line) p.append(el('p', null, [line]));
    box.append(p);
    return box;
  }
  // A header is text, or { sr: 'text' } for one only screen readers need.
  function table(headers, rows, cls) {
    const wrap = el('div', { class: 'table-wrap' });
    const t = el('table', { class: cls || '' });
    const tr = el('tr');
    headers.forEach((h, i) => {
      const th = el('th', { scope: 'col' });
      if (h && typeof h === 'object') th.append(el('span', { class: 'sr-only', text: h.sr }));
      else {
        th.textContent = h;
        if (i && /^(Per key|Total|Share|Memory|Saved|Hashes|used_memory|Compared)$/.test(h)) th.className = 'num';
      }
      tr.append(th);
    });
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
  function figure(value, label) {
    return el('div', { class: 'figure' }, [el('span', { class: 'value', text: value }), el('span', { class: 'label', text: label })]);
  }
  function debounce(fn, ms) { let t; return function () { clearTimeout(t); t = setTimeout(fn, ms); }; }
  function bytes(n) {
    const u = ['bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let i = 0, x = n;
    while (Math.abs(x) >= 1024 && i < u.length - 1) { x /= 1024; i++; }
    return (i ? x.toFixed(x < 10 ? 2 : x < 100 ? 1 : 0) : String(Math.round(x))) + ' ' + u[i];
  }
  const num = (n) => Math.round(n).toLocaleString('en-US');
  const share = (part, total) => (total > 0 ? (100 * part / total).toFixed(1) + '%' : '-');
  const label = (id) => M.versions().find((v) => v.id === id).label;
  // A number in plain decimals, never 1e-7.
  function plain(x) {
    const s = String(x);
    const m = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(s);
    if (!m) return s;
    const digits = m[2] + (m[3] || ''), e = Number(m[4]);
    return e < 0 ? m[1] + '0.' + '0'.repeat(-e - 1) + digits : m[1] + digits + '0'.repeat(Math.max(0, e - digits.length + 1));
  }
  const percent = (part) => plain(Number((part * 100).toPrecision(15)));
  // The one line a screen reader reads out when the answer changes.
  function announce(text) {
    if ($('summary').textContent !== text) $('summary').textContent = text;
  }

  // ---- the versions ----
  (function fillVersions() {
    const select = $('version');
    const all = M.versions();
    for (const server of ['redis', 'valkey']) {
      const group = el('optgroup', { label: server === 'redis' ? 'Redis' : 'Valkey' });
      for (const v of all.filter((x) => x.server === server).reverse()) group.append(el('option', { value: v.id, text: v.label }));
      select.append(group);
    }
    select.value = all.filter((v) => v.server === 'redis').pop().id;
  })();

  // ---- the form ----
  // Each row keeps what was typed; toGroup() turns it into what memory.js takes.
  const TYPES = [['string', 'Strings'], ['hash', 'Hashes'], ['set', 'Sets'], ['zset', 'Sorted sets'], ['list', 'Lists']];
  const COUNT_LABEL = { hash: 'Fields per hash', set: 'Members per set', zset: 'Members per set', list: 'Items per list' };
  const ELEM = { string: [['value', 'Value']], hash: [['field', 'Field names'], ['value', 'Values']], set: [['member', 'Members']], zset: [['member', 'Members']], list: [['item', 'Items']] };
  const COUNT_NAME = { hash: 'fields', set: 'members', zset: 'members', list: 'items' };
  const DISTINCT = { field: true, member: true };
  const MAX_LEN = 536870912;
  let rows = [];

  function rowFromGroup(g) {
    const counted = g.ttlCount !== undefined && g.ttlCount !== null;
    const r = {
      type: g.type, count: String(g.count), key: String(g.key),
      // A number of keys with a TTL stays one until the TTL or the count is edited.
      ttl: counted ? (g.count ? percent(g.ttlCount / g.count) : '0') : percent(g.ttl || 0),
      ttlCount: counted ? g.ttlCount : undefined,
      writes: g.writes || 'once', score: g.score === undefined || g.score === null ? '0' : String(g.score)
    };
    for (const t of Object.keys(COUNT_NAME)) if (g.type === t) r.n = String(g[COUNT_NAME[t]]);
    for (const [name] of ELEM[g.type]) {
      const e = g[name];
      r[name] = e.int !== undefined ? { kind: 'number', text: String(e.int) } : { kind: 'text', text: String(e.len) };
    }
    return r;
  }
  function blankRow(type) {
    const d = { string: '1m strings key=20 value=100', hash: '10000 hashes key=20 fields=10 field=8 value=20', set: '10000 sets key=20 members=10 member=10', zset: '1000 zsets key=20 members=100 member=10 score=1', list: '1000 lists key=20 items=100 item=20' };
    return rowFromGroup(M.parse(d[type]).groups[0]);
  }
  function utf8Length(t) {
    let n = 0;
    for (const ch of t) { const c = ch.codePointAt(0); n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; }
    return n;
  }
  function count(text, name, max) {
    const n = M.parseCount(String(text || ''));
    if (n === null) throw new Error(name + ': a whole number, such as 2500, 2,500 or 2.5m.');
    if (n > max) throw new Error(name + ': at most ' + num(max) + '.');
    return n;
  }
  // A length, or an example whose bytes are counted: digits are a length,
  // anything else an example, and so are digits in quotes.
  function length(text, title) {
    const t = String(text);
    if (!t.trim()) throw new Error(title + ': a length in bytes, or an example.');
    if (/^\s*\d+\s*$/.test(t)) {
      const n = Number(t);
      if (n > MAX_LEN) throw new Error(title + ': at most ' + num(MAX_LEN) + ' bytes (512 MB).');
      return { len: n, example: false };
    }
    const q = /^\s*"(.*)"\s*$/.exec(t) || /^\s*'(.*)'\s*$/.exec(t);
    const n = utf8Length(q ? q[1] : t.trim());
    if (n > MAX_LEN) throw new Error(title + ': at most 512 MB.');
    return { len: n, example: true };
  }
  function elemOf(r, name, title) {
    const e = r[name];
    if (e.kind === 'number') {
      const t = e.text.trim();
      if (!/^(0|-?[1-9][0-9]*)$/.test(t) || t.length > 20 || BigInt(t) > 9223372036854775807n || BigInt(t) < -9223372036854775808n) {
        throw new Error(title + ': a whole number without leading zeros, within 64 bits.');
      }
      return { int: t };
    }
    return { len: length(e.text, title).len };
  }
  function toGroup(r) {
    const g = { type: r.type, count: count(r.count, 'How many keys', 1e15), key: length(r.key, 'Key name').len };
    if (r.ttlCount !== undefined) g.ttlCount = r.ttlCount;
    else {
      const t = Number(r.ttl === '' ? '0' : r.ttl);
      if (r.ttlBad || !(t >= 0 && t <= 100)) throw new Error('With a TTL: a percentage from 0 to 100.');
      if (t) g.ttl = t / 100;
    }
    if (r.type !== 'string') {
      g[COUNT_NAME[r.type]] = count(r.n, COUNT_LABEL[r.type], 4294967295);
      if (g[COUNT_NAME[r.type]] < 1) throw new Error(COUNT_LABEL[r.type] + ': at least 1.');
      g.writes = r.writes;
    }
    for (const [name, title] of ELEM[r.type]) g[name] = elemOf(r, name, title);
    if (r.type === 'zset') g.score = r.score.trim() || '0';
    return M.checkGroup(g);
  }

  function field(labelText, control, hint) {
    const id = 'f' + Math.random().toString(36).slice(2, 9);
    control.id = id;
    const f = el('div', { class: 'field' }, [el('label', { for: id, text: labelText }), control]);
    if (hint) f.append(hint);
    return f;
  }
  function input(value, onInput, cls) {
    const i = el('input', { type: 'text', value: value, spellcheck: 'false', autocomplete: 'off' });
    if (cls) i.className = cls;
    i.addEventListener('input', () => onInput(i.value));
    return i;
  }
  function select(options, value, onChange, aria) {
    const s = el('select', aria ? { 'aria-label': aria } : null);
    for (const [v, t] of options) s.append(el('option', { value: v, text: t }));
    s.value = value;
    s.addEventListener('change', () => onChange(s.value));
    return s;
  }

  // focus: { index, what: 'type' | 'heading' } puts the focus back where
  // it was after the cards are drawn again.
  function drawGroups(focus) {
    const box = $('groups');
    box.textContent = '';
    rows.forEach((r, i) => {
      const card = el('div', { class: 'group' });
      const head = el('div', { class: 'group-head' });
      head.append(el('h3', { text: 'Keys ' + (i + 1), tabindex: '-1' }));
      const rm = el('button', { type: 'button', class: 'remove', text: 'Remove', 'aria-label': 'Remove keys ' + (i + 1) });
      rm.addEventListener('click', () => { rows.splice(i, 1); drawGroups({ index: i, what: 'heading' }); changed(); });
      if (rows.length > 1) head.append(rm);
      card.append(head);
      const note = el('p', { class: 'note' });
      const showNote = () => {
        const d = describe(r);
        note.textContent = d.text;
        note.className = 'note' + (d.error ? ' error' : '');
      };
      const update = () => { showNote(); changed(); };
      const top = el('div', { class: 'row' });
      const type = select(TYPES, r.type, (v) => {
        const fresh = blankRow(v);
        rows[i] = Object.assign(fresh, { count: r.count, key: r.key, ttl: r.ttl, ttlCount: r.ttlCount });
        drawGroups({ index: i, what: 'type' });
        changed();
      });
      type.className = 'type';
      top.append(field('Type', type));
      top.append(field('How many keys', input(r.count, (v) => { r.count = v; r.ttlCount = undefined; update(); })));
      top.append(field('Key name, bytes', input(r.key, (v) => { r.key = v; update(); }), el('span', { class: 'hint', text: 'or an example' })));
      const ttl = el('input', { type: 'number', min: '0', max: '100', step: 'any', value: r.ttl });
      ttl.addEventListener('input', () => { r.ttl = ttl.value; r.ttlBad = ttl.validity.badInput; r.ttlCount = undefined; update(); });
      top.append(field('With a TTL, %', ttl));
      card.append(top);
      const second = el('div', { class: 'row' });
      if (r.type !== 'string') second.append(field(COUNT_LABEL[r.type], input(r.n, (v) => { r.n = v; update(); })));
      for (const [name, title] of ELEM[r.type]) {
        const e = r[name];
        const kinds = DISTINCT[name] ? [['text', 'Text'], ['number', 'Numbers from']] : [['text', 'Text'], ['number', 'A number']];
        const box2 = el('div', { class: 'pair' });
        const inp = input(e.text, (v) => { e.text = v; update(); });
        box2.append(select(kinds, e.kind, (v) => {
          e.kind = v;
          if (v === 'number' && !/^-?\d+$/.test(e.text.trim())) e.text = DISTINCT[name] ? '1' : '42';
          if (v === 'text' && !/^\d+$/.test(e.text.trim())) e.text = '10';
          inp.value = e.text;
          update();
        }, title + ': text, or ' + (DISTINCT[name] ? 'numbers counting up' : 'a number')), inp);
        const id = 'f' + Math.random().toString(36).slice(2, 9);
        inp.id = id;
        second.append(el('div', { class: 'field' }, [el('label', { for: id, text: title }), box2]));
      }
      if (r.type === 'zset') second.append(field('Scores like', input(r.score, (v) => { r.score = v; update(); })));
      if (r.type !== 'string') {
        second.append(field('Written', select([['once', 'One command per key'], ['each', 'One element at a time']], r.writes, (v) => { r.writes = v; update(); })));
      }
      card.append(second);
      showNote();
      card.append(note);
      box.append(card);
    });
    if (focus) {
      const cards = box.querySelectorAll('.group');
      const card = cards[Math.min(focus.index, cards.length - 1)];
      const target = !card ? $('add') : focus.what === 'type' ? card.querySelector('select.type') : card.querySelector('h3');
      if (target) target.focus();
    }
  }

  // A line under each group: the bytes of examples, or what's wrong.
  function describe(r) {
    try {
      const g = toGroup(r);
      const bits = [], warn = [];
      if (length(r.key, 'Key name').example) bits.push('key names of ' + num(g.key) + ' bytes');
      else if (g.key > 1000) warn.push('Digits here are a length: key names of ' + num(g.key) + ' bytes. For an example name made of digits, put it in quotes.');
      for (const [name, title] of ELEM[r.type]) {
        const e = r[name];
        if (e.kind === 'text' && length(e.text, title).example) bits.push(title.toLowerCase() + ' of ' + num(g[name].len) + ' bytes');
        if (e.kind === 'number' && DISTINCT[name]) bits.push(title.toLowerCase() + ' ' + g[name].int + ', ' + (BigInt(g[name].int) + 1n) + ' and so on');
      }
      return { text: (bits.length ? 'That is ' + bits.join(', ') + '. ' : '') + warn.join(' '), error: false };
    } catch (e) {
      return { text: e.message, error: true };
    }
  }

  function groupsOrErrors() {
    const groups = [], errors = [];
    rows.forEach((r, i) => {
      try { groups.push(toGroup(r)); } catch (e) { errors.push('Keys ' + (i + 1) + ': ' + e.message); }
    });
    return { groups: groups, errors: errors };
  }

  // ---- settings ----
  const SETTINGS = ['hashMaxListpackEntries', 'hashMaxListpackValue', 'setMaxIntsetEntries', 'setMaxListpackEntries',
    'setMaxListpackValue', 'zsetMaxListpackEntries', 'zsetMaxListpackValue', 'listMaxListpackSize'];
  const settings = Object.assign({}, M.defaults);
  const settingLabels = {};
  (function drawSettings() {
    const box = $('settings');
    for (const key of SETTINGS) {
      const i = el('input', { type: 'number', value: String(M.defaults[key]), step: '1' });
      if (key !== 'listMaxListpackSize') i.min = '0';
      i.addEventListener('input', () => {
        // An entry that isn't a number makes the setting wrong rather than
        // quietly the default; an empty one is the default.
        settings[key] = i.validity.badInput ? NaN : i.value === '' ? M.defaults[key] : Number(i.value);
        changed();
      });
      const f = field(M.settingNames[key], i);
      settingLabels[key] = f.querySelector('label');
      box.append(f);
    }
    const policy = select(M.policies.map((p) => [p, /lrm$/.test(p) ? p + ' (Redis 8.6+)' : p]), 'noeviction', (v) => { settings.maxmemoryPolicy = v; changed(); });
    box.append(field('maxmemory-policy', policy, el('span', { class: 'hint', text: 'With maxmemory set' })));
  })();
  // The settings by the names the chosen version gives them.
  function nameSettings(id) {
    for (const key of SETTINGS) {
      const n = M.settingName(key, id);
      settingLabels[key].textContent = n || M.settingNames[key] + ' (not in ' + label(id) + ')';
    }
  }

  // ---- text ----
  // The text box follows the form, except while it holds a line with an
  // error, which the form must not overwrite.
  let fromText = false, textHeld = false;
  function syncText(groups) {
    if (fromText || textHeld) return;
    $('text').value = M.format(groups);
  }
  $('text').addEventListener('input', debounce(() => {
    const p = M.parse($('text').value);
    $('text-errors').textContent = p.errors.map((e) => 'Line ' + e.line + ': ' + e.message).join(' ');
    textHeld = p.errors.length > 0;
    if (p.errors.length || !p.groups.length) return;
    rows = p.groups.map(rowFromGroup);
    fromText = true;
    try {
      drawGroups();
      run();
    } finally {
      fromText = false;
    }
  }, 250));

  // ---- results ----
  const TYPE_WORDS = { string: ['string', 'strings'], hash: ['hash', 'hashes'], set: ['set', 'sets'], zset: ['sorted set', 'sorted sets'], list: ['list', 'lists'] };
  const ENCODING = {
    int: 'number in the object', embstr: 'with the key', raw: 'apart', listpack: 'listpack', ziplist: 'ziplist', intset: 'intset',
    hashtable: 'hash table', skiplist: 'skiplist', quicklist: 'quicklist'
  };
  function groupLabel(g) {
    return num(g.count) + ' ' + TYPE_WORDS[g.type][g.count === 1 ? 0 : 1];
  }

  // What raising a limit would do for a group stored in its big form, with
  // the settings named the way the version names them.
  function advice(groups, i, id, r) {
    const g = groups[i], out = r.groups[i];
    const name = (key) => M.settingName(key, id);
    const compact = M.features(id).ziplist ? 'ziplist' : 'listpack';
    const tryWith = (change, why, text) => {
      if (!why.length) return null;
      const alt = M.estimate([g], id, Object.assign({}, settings, change)).groups[0];
      if (alt.encoding !== out.encoding && alt.bytes < out.bytes) {
        return text + ' With ' + why.join(' and ') + ', they would be ' + alt.encoding + 's: ' + bytes(alt.bytes) + ' instead of ' + bytes(out.bytes) + ', ' +
          Math.round(100 * (1 - alt.bytes / out.bytes)) + '% less. Bigger ' + compact + 's are slower to search, so raise it with care.';
      }
      return null;
    };
    const words = TYPE_WORDS[g.type][1];
    if (g.type === 'hash' && out.encoding === 'hashtable') {
      const longest = Math.max(M.longest(g.field, g.fields), M.longest(g.value, 1));
      const change = {}, why = [];
      if (g.fields > settings.hashMaxListpackEntries) { change.hashMaxListpackEntries = g.fields; why.push(name('hashMaxListpackEntries') + ' ' + g.fields); }
      if (longest > settings.hashMaxListpackValue) { change.hashMaxListpackValue = longest; why.push(name('hashMaxListpackValue') + ' ' + longest); }
      return tryWith(change, why, 'These ' + words + ' are past a ' + compact + '\'s limits.');
    }
    if (g.type === 'set' && out.encoding === 'hashtable') {
      const change = {}, why = [];
      if (g.member.int !== undefined && g.members > settings.setMaxIntsetEntries) {
        change.setMaxIntsetEntries = g.members;
        why.push(name('setMaxIntsetEntries') + ' ' + g.members);
      } else if (g.member.int === undefined && name('setMaxListpackEntries')) {
        if (g.members > settings.setMaxListpackEntries) { change.setMaxListpackEntries = g.members; why.push(name('setMaxListpackEntries') + ' ' + g.members); }
        if (g.member.len > settings.setMaxListpackValue) { change.setMaxListpackValue = g.member.len; why.push(name('setMaxListpackValue') + ' ' + g.member.len); }
      }
      return tryWith(change, why, 'These ' + words + ' are past their compact form\'s limits.');
    }
    if (g.type === 'zset' && out.encoding === 'skiplist') {
      const longest = M.longest(g.member, g.members);
      const change = {}, why = [];
      if (g.members > settings.zsetMaxListpackEntries) { change.zsetMaxListpackEntries = g.members; why.push(name('zsetMaxListpackEntries') + ' ' + g.members); }
      if (longest > settings.zsetMaxListpackValue) { change.zsetMaxListpackValue = longest; why.push(name('zsetMaxListpackValue') + ' ' + longest); }
      return tryWith(change, why, 'These ' + words + ' are past a ' + compact + '\'s limits.');
    }
    return null;
  }

  function drawResult(groups, id, r) {
    const out = $('result');
    out.textContent = '';
    const figs = el('div', { class: 'figures' });
    figs.append(figure(bytes(r.total), 'used_memory grows by'));
    figs.append(figure(r.keys ? num(r.total / r.keys) + ' bytes' : '-', 'per key, all in'));
    figs.append(figure(num(r.keys), 'keys'));
    if (r.ttlKeys) figs.append(figure(num(r.ttlKeys), 'with a TTL'));
    out.append(figs);
    const body = [num(r.total) + ' bytes on ' + label(id) + ', counting the size classes of its allocator, as INFO memory reports used_memory.'];
    if (r.sd >= 1 && r.sd / r.total > 0.0005) {
      body.push('Chance decides about ' + bytes(r.sd) + ' of it either way: how the keys land in the buckets of the hash tables' +
        (r.groups.some((g) => g.encoding === 'skiplist') ? ' and how many levels each skiplist node gets.' : '.'));
    }
    out.append(verdict('info', 'These keys take ' + bytes(r.total), body));
    const rowsOut = r.groups.map((g) => {
      const enc = ENCODING[g.encoding] || g.encoding;
      const encTtl = g.ttlKeys && g.encodingTtl !== g.encoding ? ' (' + (ENCODING[g.encodingTtl] || g.encodingTtl) + ' with a TTL)' : '';
      return [groupLabel(g), enc + encTtl, td('num', g.count ? num(g.perKey) + ' bytes' : '-'), td('num', bytes(g.bytes)), td('num', share(g.bytes, r.total))];
    });
    const t = r.tables;
    rowsOut.push(['The keyspace\'s hash table', num(t.keys.buckets) + ' ' + (t.keys.kind === 'buckets' ? 'buckets of 7' : 'slots'), '', td('num', bytes(t.keys.bytes)), td('num', share(t.keys.bytes, r.total))]);
    if (r.ttlKeys) rowsOut.push(['The expiry times\' hash table', num(t.expires.buckets) + ' ' + (t.expires.kind === 'buckets' ? 'buckets of 7' : 'slots'), '', td('num', bytes(t.expires.bytes)), td('num', share(t.expires.bytes, r.total))]);
    if (t.database) rowsOut.push(['The database\'s own structs', 'made with its first key', '', td('num', bytes(t.database)), td('num', share(t.database, r.total))]);
    out.append(table(['Keys', 'Stored as', 'Per key', 'Total', 'Share'], rowsOut));
    // What each key pays, and what could be smaller.
    const notes = [];
    r.groups.forEach((g, i) => {
      const a = advice(groups, i, id, r);
      if (a) notes.push(verdict('warn', groupLabel(g), a));
    });
    if (r.ttlKeys) {
      const per = r.groups.reduce((a, g) => a + g.ttlKeys * (g.keyBytesTtl - g.keyBytes), 0) + t.expires.bytes;
      notes.push(verdict('info', 'A TTL costs ' + Math.round(per / r.ttlKeys) + ' bytes a key here', 'That counts the expiry time, the entry or bigger object that holds it, and the expires table, which only keys with a TTL are in.'));
    }
    for (const n of notes) out.append(n);
  }

  function drawVersions(groups, id, results) {
    const out = $('versions');
    out.textContent = '';
    const max = Math.max(...results.map((r) => r.total));
    const base = results.find((r) => r.version === id);
    const rowsOut = results.map((r) => {
      const pick = el('button', { type: 'button', class: 'linkish', text: label(r.version) });
      pick.addEventListener('click', () => { $('version').value = r.version; run(); $('h-result').scrollIntoView({ behavior: 'smooth' }); });
      const d = base.total ? (r.total - base.total) / base.total * 100 : 0;
      const bar = el('span', { class: 'bar' + (r.version === id ? ' hi' : '') });
      bar.style.width = (max > 0 ? Math.max(1, 100 * r.total / max) : 0).toFixed(1) + '%';
      return {
        cls: r.version === id ? 'on' : '',
        cells: [pick, td('num', bytes(r.total)), td('num', num(r.total / Math.max(1, r.keys)) + ' bytes'),
          td('num', r.version === id ? 'chosen' : Math.abs(d) < 0.05 ? 'the same' : (d > 0 ? '+' : '') + d.toFixed(1) + '%'), td('barcell', bar)]
      };
    });
    out.append(table(['Version', 'used_memory', 'Per key', 'Compared', { sr: 'Size' }], rowsOut));
  }

  const PACK_SIZES = [64, 100, 128, 256, 500, 512, 1000];
  function drawPack(groups, id) {
    const sec = $('pack-section');
    const out = $('pack');
    out.textContent = '';
    const strings = groups.filter((g) => g.type === 'string' && g.count >= 2);
    sec.classList.toggle('hidden', !strings.length);
    if (!strings.length) return;
    const total = M.estimate(strings, id, settings).total;
    const vl = Math.max(...strings.map((g) => M.longest(g.value, 1)));
    const rowsOut = PACK_SIZES.map((n) => {
      const packed = strings.flatMap((g) => M.pack(g, n));
      const need = {};
      if (n > settings.hashMaxListpackEntries) need.hashMaxListpackEntries = n;
      if (vl > settings.hashMaxListpackValue) need.hashMaxListpackValue = vl;
      const after = M.estimate(packed, id, Object.assign({}, settings, need));
      const saved = total - after.total;
      const what = Object.keys(need).map((k) => M.settingName(k, id) + ' ' + need[k]).join(', ');
      return [String(n), td('num', num(packed.reduce((a, g) => a + g.count, 0))), td('num', bytes(after.total)),
        td('num', total > 0 ? Math.round(100 * Math.abs(saved) / total) + '%' + (saved >= 0 ? ' less' : ' more') : '-'), what || 'the defaults'];
    });
    out.append(el('p', null, ['The strings take ' + bytes(total) + ' as they are, on ' + label(id) + '.']));
    out.append(table(['Fields per hash', 'Hashes', 'Memory', 'Saved', 'Settings it needs'], rowsOut));
    const ttl = strings.some((g) => g.ttl || g.ttlCount);
    out.append(el('p', { class: 'small muted', text: 'The field is the end of the key, a number. A hash keeps one TTL for all its fields' +
      (ttl ? ', so the strings\' own TTLs don\'t carry over.' : '.') + ' Each read and write names the hash and the field: HGET user:12345 67.' }));
  }

  // Memory of a server with nothing in it, as measured right after start.
  function drawPlan(id, r) {
    const out = $('plan');
    out.textContent = '';
    const empty = M.emptyServer(id);
    const used = empty + r.total;
    const frag = Math.max(1, Number($('frag').value) || 1);
    const cow = Math.min(100, Math.max(0, Number($('cow').value) || 0)) / 100;
    const backlog = Math.max(0, Number($('backlog').value) || 0) * 1048576;
    const rss = used * frag;
    const peak = rss + r.total * cow * frag + backlog;
    out.append(table(['Figure', 'Memory', 'What it counts'], [
      ['used_memory', td('num', bytes(used)), 'The keys plus ' + bytes(empty) + ' an empty ' + label(id) + ' uses. Set maxmemory above this, with room to grow.'],
      ['The process (RSS)', td('num', bytes(rss)), 'used_memory times ' + frag + ': what the allocator holds but can\'t use.'],
      ['During a snapshot', td('num', bytes(peak)), 'A save or AOF rewrite forks the server; pages written meanwhile are copied (' + Math.round(cow * 100) + '%), plus the backlog.']
    ]));
  }

  // ---- run ----
  function run() {
    const id = $('version').value;
    nameSettings(id);
    const { groups, errors } = groupsOrErrors();
    const fail = (title, body) => {
      $('result').textContent = '';
      $('result').append(verdict('warn', title, body));
      for (const x of ['versions', 'pack', 'plan']) $(x).textContent = '';
      $('pack-section').classList.add('hidden');
      announce(title + ': ' + [].concat(body).join(' '));
    };
    if (errors.length) return fail('Something to fix first', errors);
    if (!groups.length) return fail('Add some keys', 'Use the form above, or try an example.');
    if (groups.every((g) => g.count === 0)) return fail('No keys yet', 'Every group has 0 keys.');
    try {
      syncText(groups);
      const r = M.estimate(groups, id, settings);
      const all = M.compare(groups, settings);
      drawResult(groups, id, r);
      drawVersions(groups, id, all);
      drawPack(groups, id);
      drawPlan(id, r);
      announce('These keys take ' + bytes(r.total) + ' on ' + label(id) + ', ' + num(r.total / Math.max(1, r.keys)) + ' bytes a key.');
    } catch (e) {
      fail('The calculator couldn\'t work this out', e.message);
    }
  }
  const changed = debounce(run, 150);
  $('version').addEventListener('change', run);
  for (const x of ['frag', 'cow', 'backlog']) $(x).addEventListener('input', changed);

  // A new dataset from the examples: the form and the text start over.
  function load(text) {
    rows = M.parse(text).groups.map(rowFromGroup);
    textHeld = false;
    $('text-errors').textContent = '';
    drawGroups();
    run();
  }
  $('add').addEventListener('click', () => { rows.push(blankRow('hash')); drawGroups({ index: rows.length - 1, what: 'heading' }); run(); });
  const EXAMPLES = {
    'ex-sessions': '2m strings key="session:8f14e45fceea167a5a36dedd4bea2543" value=420 ttl=100%',
    'ex-profiles': '500k hashes key="user:1234567" fields=12 field=10 value=24\n500k strings key="user:1234567:avatar" value=int:1759734012',
    'ex-leaderboard': '50 zsets key="board:2026-10" members=100k member=int:1000000 score=1759734012.5 writes=each',
    'ex-queue': '20 lists key="queue:emails" items=50k item=300 writes=each\n200k strings key="job:1234567:lock" value=int:1 ttl=100%'
  };
  for (const [btn, text] of Object.entries(EXAMPLES)) $(btn).addEventListener('click', () => load(text));

  load(EXAMPLES['ex-profiles']);
})();
