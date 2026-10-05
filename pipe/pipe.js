// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Mass Insert Builder. Turns CSV, JSON or plain command lines into a file in
// the Redis protocol (RESP), ready for `redis-cli --pipe` or `valkey-cli
// --pipe`, the fast way to load a lot of data. It also decodes protocol bytes
// back into readable commands and replies. One file, no dependencies. In a
// browser it defines KVPipe; in Node, require() returns the same functions.

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KVPipe = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const strictDecoder = new TextDecoder('utf-8', { fatal: true });

  function toBytes(v) {
    if (v instanceof Uint8Array) return v;
    return encoder.encode(String(v));
  }

  // ---- writing the protocol ----

  // Collects encoded commands as a list of byte chunks.
  class Output {
    constructor() { this.chunks = []; this.size = 0; this.commands = 0; this.counts = Object.create(null); }
    add(args) {
      const parts = [encoder.encode('*' + args.length + '\r\n')];
      for (const a of args) {
        const b = toBytes(a);
        parts.push(encoder.encode('$' + b.length + '\r\n'), b, CRLF);
      }
      for (const p of parts) { this.chunks.push(p); this.size += p.length; }
      this.commands++;
      const name = String(args[0]).toUpperCase();
      this.counts[name] = (this.counts[name] || 0) + 1;
    }
    bytes() {
      const out = new Uint8Array(this.size);
      let o = 0;
      for (const c of this.chunks) { out.set(c, o); o += c.length; }
      return out;
    }
  }
  const CRLF = new Uint8Array([13, 10]);

  function encodeCommand(args) { const o = new Output(); o.add(args); return o.bytes(); }

  // ---- reading CSV ----

  function guessDelimiter(text) {
    const firstLine = text.split(/\r?\n/, 1)[0] || '';
    let best = ',', bestCount = 0;
    for (const d of [',', '\t', ';', '|']) {
      let count = 0, inq = false;
      for (const c of firstLine) { if (c === '"') inq = !inq; else if (c === d && !inq) count++; }
      if (count > bestCount) { best = d; bestCount = count; }
    }
    return best;
  }

  // RFC 4180 CSV: quoted fields may hold the delimiter, quotes ("") and line breaks.
  function parseCSV(text, delimiter) {
    const s = String(text).replace(/^\uFEFF/, '');
    const d = delimiter || guessDelimiter(s);
    const rows = [];
    let row = [], field = '', i = 0, inq = false, quoted = false;
    while (i < s.length) {
      const c = s[i];
      if (inq) {
        if (c === '"') {
          if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
          inq = false; i++; continue;
        }
        field += c; i++; continue;
      }
      if (c === '"' && field === '' && !quoted) { inq = true; quoted = true; i++; continue; }
      if (c === d) { row.push(field); field = ''; quoted = false; i++; continue; }
      if (c === '\r' || c === '\n') {
        row.push(field); field = ''; quoted = false;
        rows.push(row); row = [];
        if (c === '\r' && s[i + 1] === '\n') i++;
        i++; continue;
      }
      field += c; i++;
    }
    if (inq) throw new Error('A quoted field is not closed');
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return { rows: rows.filter((r) => !(r.length === 1 && r[0] === '')), delimiter: d };
  }

  // CSV rows to records: objects keyed by the header, or by column number.
  function csvRecords(text, opt) {
    const { rows, delimiter } = parseCSV(text, opt && opt.delimiter);
    if (!rows.length) return { records: [], columns: [], delimiter: delimiter };
    let columns;
    let body = rows;
    if (!opt || opt.header !== false) { columns = rows[0].map((c, i) => c.trim() || 'column' + (i + 1)); body = rows.slice(1); }
    else columns = rows[0].map((_, i) => 'column' + (i + 1));
    const records = body.map((r) => {
      const o = Object.create(null);
      columns.forEach((c, i) => { o[c] = r[i] === undefined ? '' : r[i]; });
      return o;
    });
    return { records: records, columns: columns, delimiter: delimiter };
  }

  // ---- reading JSON, keeping numbers as written ----

  // A number kept as its exact text, so a 20-digit ID stays the same ID.
  class Num { constructor(text) { this.text = text; } toString() { return this.text; } }

  function parseJSON(text) {
    let i = 0;
    const s = String(text);
    const fail = (msg) => { throw new Error(msg + ' at character ' + (i + 1)); };
    const ws = () => { while (i < s.length && ' \t\n\r'.includes(s[i])) i++; };
    function value() {
      ws();
      const c = s[i];
      if (c === '{') {
        i++; const o = Object.create(null); ws();
        if (s[i] === '}') { i++; return o; }
        while (true) {
          ws(); if (s[i] !== '"') fail('Expected a name in quotes');
          const k = str(); ws(); if (s[i] !== ':') fail('Expected :'); i++;
          o[k] = value(); ws();
          if (s[i] === ',') { i++; continue; }
          if (s[i] === '}') { i++; return o; }
          fail('Expected , or }');
        }
      }
      if (c === '[') {
        i++; const a = []; ws();
        if (s[i] === ']') { i++; return a; }
        while (true) {
          a.push(value()); ws();
          if (s[i] === ',') { i++; continue; }
          if (s[i] === ']') { i++; return a; }
          fail('Expected , or ]');
        }
      }
      if (c === '"') return str();
      for (const [w, v] of [['true', true], ['false', false], ['null', null]]) if (s.startsWith(w, i)) { i += w.length; return v; }
      const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(s.slice(i, i + 400));
      if (m) { i += m[0].length; return new Num(m[0]); }
      fail(c === undefined ? 'The JSON ends too early' : 'Unexpected character ' + JSON.stringify(c));
    }
    function str() {
      i++; let out = '', start = i;
      while (true) {
        if (i >= s.length) fail('A string is not closed');
        const c = s.charCodeAt(i);
        if (c === 34) { out += s.slice(start, i); i++; return out; }
        if (c === 92) {
          out += s.slice(start, i);
          const n = s[i + 1];
          const map = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (n === 'u' && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 2, i + 6))) { out += String.fromCharCode(parseInt(s.slice(i + 2, i + 6), 16)); i += 6; }
          else if (map[n] !== undefined) { out += map[n]; i += 2; }
          else fail('Unknown escape');
          start = i; continue;
        }
        if (c < 0x20) fail('A string contains a raw control character');
        i++;
      }
    }
    const v = value(); ws();
    if (i < s.length) fail('Extra text after the JSON');
    return v;
  }

  // Compact JSON, numbers written exactly as they were read.
  function stringifyJSON(v) {
    if (v === null || v === undefined) return 'null';
    if (v instanceof Num) return v.text;
    if (typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(stringifyJSON).join(',') + ']';
    return '{' + Object.keys(v).map((k) => JSON.stringify(k) + ':' + stringifyJSON(v[k])).join(',') + '}';
  }

  // JSON: an array of objects, or one object per line.
  function jsonRecords(text) {
    const src = String(text).trim();
    if (!src) return { records: [], columns: [] };
    let records;
    try {
      const v = parseJSON(src);
      records = Array.isArray(v) ? v : [v];
    } catch (e) {
      const lines = src.split('\n').filter((l) => l.trim());
      if (lines.length < 2) throw new Error('This is not valid JSON: ' + e.message);
      records = [];
      const all = src.split('\n');
      for (let n = 0; n < all.length; n++) {
        if (!all[n].trim()) continue;
        try { records.push(parseJSON(all[n])); }
        catch (err) { throw new Error('Line ' + (n + 1) + ' is not valid JSON: ' + err.message); }
      }
    }
    const columns = [];
    const seen = new Set();
    records.forEach((r, n) => {
      if (!r || typeof r !== 'object' || Array.isArray(r) || r instanceof Num) throw new Error('Record ' + (n + 1) + ' is not an object');
      for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); columns.push(k); }
    });
    return { records: records, columns: columns };
  }

  // A field value as the text stored in Redis or Valkey.
  function valueText(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return v;
    if (v instanceof Num) return v.text;
    if (typeof v === 'object') return stringifyJSON(v);
    return String(v);
  }

  // Key templates use ${field}: "user:${id}", or "cart:{${user}}:items" for a hash tag.
  function compileTemplate(tpl, columns) {
    const parts = [];
    const re = /\$\{([^}]*)\}/g;
    let last = 0, m;
    const missing = [];
    while ((m = re.exec(tpl))) {
      parts.push({ text: tpl.slice(last, m.index) });
      const name = m[1];
      if (columns && !columns.includes(name)) missing.push(name);
      parts.push({ field: name });
      last = re.lastIndex;
    }
    parts.push({ text: tpl.slice(last) });
    const fields = parts.filter((p) => p.field !== undefined).map((p) => p.field);
    return {
      fields: fields,
      missing: missing,
      render: (rec) => parts.map((p) => p.field !== undefined ? valueText(rec[p.field]) : p.text).join('')
    };
  }

  // Build the protocol file from records.
  // opt: { key, type: 'string'|'hash'|'list'|'set'|'zset', value, fields, score, member,
  //        wholeRow, ttl, fresh, db, includeKeyFields }
  function build(records, columns, opt) {
    const out = new Output();
    const warnings = [];
    const skipped = [];
    const tpl = compileTemplate(opt.key || '', columns);
    if (!opt.key) throw new Error('Set a key template, such as user:${id}');
    if (tpl.missing.length) throw new Error('The key template uses ' + tpl.missing.map((f) => '${' + f + '}').join(', ') + ', which ' + (tpl.missing.length === 1 ? 'is not a column' : 'are not columns') + '. The columns are: ' + columns.join(', '));
    const type = opt.type || 'string';
    const need = (name, what) => {
      if (!name) throw new Error('Choose the ' + what + ' column');
      if (columns && !columns.includes(name)) throw new Error('There is no column called ' + name + '. The columns are: ' + columns.join(', '));
    };
    if (type === 'string' && !opt.wholeRow) need(opt.value, 'value');
    if (type === 'list' || type === 'set') need(opt.value, 'value');
    if (type === 'zset') { need(opt.score, 'score'); need(opt.member, 'member'); }
    let hashFields = null;
    if (type === 'hash') {
      hashFields = opt.fields && opt.fields.length ? opt.fields.slice()
        : columns.filter((c) => opt.includeKeyFields || !tpl.fields.includes(c));
      for (const f of hashFields) need(f, 'field');
      if (!hashFields.length) throw new Error('A hash needs at least one field besides the ones in the key');
    }
    const ttl = opt.ttl ? parseInt(opt.ttl, 10) : 0;
    if (opt.ttl && !(ttl > 0)) throw new Error('The expiry must be a whole number of seconds above 0');
    if (opt.db !== undefined && opt.db !== '' && opt.db !== null) {
      const db = parseInt(opt.db, 10);
      if (!(db >= 0)) throw new Error('The database number must be 0 or more');
      out.add(['SELECT', String(db)]);
    }
    const seen = new Set();
    const expireLater = [];
    records.forEach((rec, n) => {
      const key = tpl.render(rec);
      if (!key) { skipped.push({ record: n + 1, reason: 'the key is empty' }); return; }
      const fresh = !seen.has(key);
      if (fresh) seen.add(key);
      if (opt.fresh && fresh && type !== 'string') out.add(['DEL', key]);
      switch (type) {
        case 'string': {
          const value = opt.wholeRow ? stringifyJSON(rec) : valueText(rec[opt.value]);
          const args = ['SET', key, value];
          if (ttl) args.push('EX', String(ttl));
          out.add(args);
          return;
        }
        case 'hash': {
          const args = ['HSET', key];
          for (const f of hashFields) args.push(f, valueText(rec[f]));
          out.add(args);
          if (ttl) out.add(['EXPIRE', key, String(ttl)]);
          return;
        }
        case 'list':
          out.add(['RPUSH', key, valueText(rec[opt.value])]);
          break;
        case 'set':
          out.add(['SADD', key, valueText(rec[opt.value])]);
          break;
        case 'zset': {
          const score = valueText(rec[opt.score]).trim();
          if (!/^[+-]?((\d+\.?\d*|\.\d+)([eE][+-]?\d+)?|inf|infinity)$/i.test(score)) {
            skipped.push({ record: n + 1, reason: 'the score "' + score + '" is not a number' });
            return;
          }
          out.add(['ZADD', key, score, valueText(rec[opt.member])]);
          break;
        }
        default: throw new Error('Unknown data type ' + type);
      }
      if (ttl && fresh) expireLater.push(key);
    });
    for (const k of expireLater) out.add(['EXPIRE', k, String(ttl)]);
    if (skipped.length) warnings.push(skipped.length + (skipped.length === 1 ? ' record was' : ' records were') + ' skipped');
    return { output: out, keys: seen.size, skipped: skipped, warnings: warnings };
  }

  // ---- command lines, with the same quoting rules as redis-cli ----

  const isHex = (c) => c !== undefined && /^[0-9a-fA-F]$/.test(c);

  function splitArgs(line) {
    const args = [];
    let i = 0;
    const s = Array.from(String(line));
    const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\v' || c === '\f';
    while (true) {
      while (i < s.length && isSpace(s[i])) i++;
      if (i >= s.length) return args;
      const cur = [];
      let inq = false, insq = false, done = false;
      while (!done) {
        if (inq) {
          if (i >= s.length) throw new Error('A double quote is not closed');
          const c = s[i];
          if (c === '\\' && s[i + 1] === 'x' && isHex(s[i + 2]) && isHex(s[i + 3])) {
            cur.push(parseInt(s[i + 2] + s[i + 3], 16)); i += 3;
          } else if (c === '\\' && i + 1 < s.length) {
            const n = s[i + 1];
            const map = { n: 10, r: 13, t: 9, b: 8, a: 7 };
            if (Object.prototype.hasOwnProperty.call(map, n)) cur.push(map[n]);
            else for (const b of encoder.encode(n)) cur.push(b);
            i += 1;
          } else if (c === '"') {
            if (i + 1 < s.length && !isSpace(s[i + 1])) throw new Error('A closing quote must be followed by a space');
            done = true;
          } else for (const b of encoder.encode(c)) cur.push(b);
        } else if (insq) {
          if (i >= s.length) throw new Error('A single quote is not closed');
          const c = s[i];
          if (c === '\\' && s[i + 1] === "'") { cur.push(39); i += 1; }
          else if (c === "'") {
            if (i + 1 < s.length && !isSpace(s[i + 1])) throw new Error('A closing quote must be followed by a space');
            done = true;
          } else for (const b of encoder.encode(c)) cur.push(b);
        } else {
          if (i >= s.length) { done = true; break; }
          const c = s[i];
          if (isSpace(c)) done = true;
          else if (c === '"') inq = true;
          else if (c === "'") insq = true;
          else for (const b of encoder.encode(c)) cur.push(b);
        }
        if (i < s.length) i++;
      }
      args.push(new Uint8Array(cur));
    }
  }

  // One command per line. Blank lines and lines starting with # are skipped.
  function buildFromCommands(text) {
    const out = new Output();
    const lines = String(text).split('\n');
    for (let n = 0; n < lines.length; n++) {
      const line = lines[n].replace(/\r$/, '');
      if (!line.trim() || line.trim().startsWith('#')) continue;
      let args;
      try { args = splitArgs(line); }
      catch (e) { throw new Error('Line ' + (n + 1) + ': ' + e.message); }
      if (args.length) out.add(args.map((a, i) => i === 0 ? decoder.decode(a) : a));
    }
    return { output: out };
  }

  // ---- reading the protocol back ----

  // Pasted protocol often arrives as text: with \r\n written out, as hex, as
  // a hex dump with offsets, or with the carriage returns lost. This turns
  // any of those back into bytes.
  function bytesFromText(text) {
    const t = String(text);
    const dump = bytesFromDump(t);
    if (dump) return { bytes: dump.bytes, form: 'dump', replies: dump.replies };
    const compact = t.replace(/\s+/g, '');
    if (compact.length >= 4 && compact.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(compact) && /^(2a|24|2b|2d|3a|5f|2c|23|21|3d|28|25|7e|3e|7c)/i.test(compact)) {
      const out = new Uint8Array(compact.length / 2);
      for (let i = 0; i < out.length; i++) out[i] = parseInt(compact.substr(i * 2, 2), 16);
      return { bytes: out, form: 'hex' };
    }
    if (!/\r/.test(t) && /\\r\\n/.test(t)) {
      const out = [];
      const s = Array.from(t.replace(/\n/g, ''));
      for (let i = 0; i < s.length; i++) {
        if (s[i] === '\\' && i + 1 < s.length) {
          const n = s[i + 1];
          if (n === 'r') { out.push(13); i++; continue; }
          if (n === 'n') { out.push(10); i++; continue; }
          if (n === 't') { out.push(9); i++; continue; }
          if (n === '\\') { out.push(92); i++; continue; }
          if (n === '"') { out.push(34); i++; continue; }
          if (n === 'x' && isHex(s[i + 2]) && isHex(s[i + 3])) { out.push(parseInt(s[i + 2] + s[i + 3], 16)); i += 3; continue; }
        }
        for (const b of encoder.encode(s[i])) out.push(b);
      }
      return { bytes: new Uint8Array(out), form: 'escaped' };
    }
    return { bytes: encoder.encode(t), form: 'text' };
  }

  // A hex dump with an offset at the start of every line, as hexdump -C, xxd,
  // od and Wireshark print them, usually with the bytes repeated as text at
  // the end of the line. Wireshark's Follow TCP Stream indents the server's
  // side; both sides are kept, in the order they appear, and the server's
  // byte ranges come back as replies so its values read as replies. Returns
  // null if the text is not such a dump, or its offsets don't add up.
  function bytesFromDump(text) {
    const rows = [];
    for (const line of String(text).split(/\r?\n/)) {
      const s = line.trim();
      if (!s || /^=+$/.test(s) || /^(Follow|Filter|Node \d+):/.test(s)) continue;
      if (s === '*') { rows.push({ star: true }); continue; }
      const m = /^(\s*)(?:0x)?([0-9a-fA-F]{4,16}):?(?=\s|$)(.*)$/.exec(line);
      if (!m) return null;
      const bytes = dumpRow(m[3]);
      if (!bytes) return null;
      rows.push({ side: m[1] ? 1 : 0, offset: m[2], bytes: bytes });
    }
    const data = rows.filter((r) => r.bytes && r.bytes.length);
    if (!data.length) return null;
    if (data.length === 1 && parseInt(data[0].offset, 16) !== 0) return null;
    // Offsets are hex, except od's default: seven octal digits.
    const lines = rows.filter((r) => !r.star);
    const octal = lines.every((r) => /^[0-7]{7}$/.test(r.offset));
    const octalDigits = lines.every((r) => /^[0-7]+$/.test(r.offset));
    const joined = octal ? (joinRows(rows, 8) || joinRows(rows, 16))
      : (joinRows(rows, 16) || (octalDigits ? joinRows(rows, 8) : null));
    if (!joined) return null;
    let replies = null;
    if (new Set(lines.map((r) => r.side)).size === 2) {
      replies = [];
      for (const [a, b, side] of joined.runs) {
        if (side !== 1 || a === b) continue;
        const last = replies[replies.length - 1];
        if (last && last[1] === a) last[1] = b; else replies.push([a, b]);
      }
    }
    return { bytes: new Uint8Array(joined.out), replies: replies };
  }

  // The bytes of one dump line, after its offset: hex in groups of one or
  // more bytes, then optionally the same bytes as text, which is left out.
  // hexdump -C starts the text with |, od -t x1z with >; neither is hex.
  function dumpRow(rest) {
    const out = [];
    const re = /(\s+)(\S+)/g;
    let m;
    while ((m = re.exec(rest))) {
      if (out.length && m[1].length >= 2 && sameAsText(rest.slice(m.index), out)) break;
      if (!/^(?:[0-9a-fA-F]{2})+$/.test(m[2])) {
        if (!out.length) return null;
        break;
      }
      for (let i = 0; i < m[2].length; i += 2) out.push(parseInt(m[2].substr(i, 2), 16));
    }
    return out;
  }

  // The text column shows each printable byte as itself and the rest as dots.
  function sameAsText(rest, bytes) {
    let t = '';
    for (const b of bytes) t += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.';
    return rest.replace(/\s+/g, '') === t.replace(/ /g, '');
  }

  function joinRows(rows, base) {
    const next = [null, null];     // the offset each side should continue at
    const out = [];
    const runs = [];               // [start, end, side] for each stretch of bytes
    let prev = null, star = false;
    for (const r of rows) {
      if (r.star) { if (!prev) return null; star = true; continue; }
      const off = parseInt(r.offset, base);
      if (next[r.side] === null) next[r.side] = off;
      const start = out.length;
      if (star) {
        // hexdump and od print * in place of lines that repeat the one above.
        const gap = off - next[r.side];
        if (gap < 0 || gap % prev.length) return null;
        for (let k = 0; k < gap / prev.length; k++) for (const b of prev) out.push(b);
        next[r.side] = off;
        star = false;
      }
      if (off !== next[r.side]) return null;
      for (const b of r.bytes) out.push(b);
      next[r.side] += r.bytes.length;
      runs.push([start, out.length, r.side]);
      if (r.bytes.length) prev = r.bytes;
    }
    return out.length ? { out: out, runs: runs } : null;
  }

  // True if a value starts inside one of the byte ranges given, such as the
  // replies of a two-sided dump.
  function isReply(v, ranges) {
    if (!ranges) return false;
    for (const r of ranges) if (v.start >= r[0] && v.start < r[1]) return true;
    return false;
  }

  // Decode RESP2 and RESP3. Lenient about line endings: a lone \n also ends a
  // line, so text whose carriage returns were lost still reads.
  function decode(bytes, limit) {
    const max = limit || 100000;
    const values = [];
    let o = 0;
    let lfOnly = false;
    function lineEnd(from) {
      for (let i = from; i < bytes.length; i++) if (bytes[i] === 10) return i;
      return -1;
    }
    function readLine() {
      const e = lineEnd(o);
      if (e < 0) throw err('A line has no end');
      let end = e;
      if (end > o && bytes[end - 1] === 13) end--; else lfOnly = true;
      const text = decoder.decode(bytes.subarray(o, end));
      o = e + 1;
      return text;
    }
    function err(msg) { const e = new Error(msg + ' at byte ' + o); e.offset = o; return e; }
    function int(text, what) {
      if (!/^-?\d+$/.test(text)) throw err(what + ' "' + text + '" is not a whole number');
      return parseInt(text, 10);
    }
    function blob(n) {
      if (o + n > bytes.length) throw err('A value of ' + n + ' bytes runs past the end');
      const b = bytes.subarray(o, o + n);
      o += n;
      if (bytes[o] === 13 && bytes[o + 1] === 10) o += 2;
      else if (bytes[o] === 10) { o += 1; lfOnly = true; }
      else throw err('A value is longer than its declared length');
      return b;
    }
    function value(depth) {
      if (depth > 64) throw err('Values are nested too deeply');
      const start = o;
      const t = String.fromCharCode(bytes[o]);
      o++;
      switch (t) {
        case '+': return { type: 'simple', value: readLine(), start: start };
        case '-': return { type: 'error', value: readLine(), start: start };
        case ':': return { type: 'integer', value: readLine(), start: start };
        case '_': readLine(); return { type: 'null', start: start };
        case ',': return { type: 'double', value: readLine(), start: start };
        case '#': { const v = readLine(); return { type: 'boolean', value: v === 't', start: start }; }
        case '(': return { type: 'bignum', value: readLine(), start: start };
        case '$': case '!': case '=': {
          const n = int(readLine(), 'A length');
          if (n === -1) return { type: 'null', start: start };
          if (n < -1) throw err('A length is negative');
          const b = blob(n);
          if (t === '=') return { type: 'verbatim', format: decoder.decode(b.subarray(0, 3)), bytes: b.subarray(4), start: start };
          return { type: t === '$' ? 'bulk' : 'bulkerror', bytes: b, start: start };
        }
        case '*': case '~': case '>': case '%': case '|': {
          const n = int(readLine(), 'A count');
          if (n === -1) return { type: 'null', start: start };
          const items = [];
          const count = (t === '%' || t === '|') ? n * 2 : n;
          for (let i = 0; i < count; i++) {
            if (o >= bytes.length) throw err('A list ends early');
            items.push(value(depth + 1));
          }
          if (t === '|') {
            // Attributes describe the reply that follows them; keep them with it.
            if (o >= bytes.length) throw err('Attributes with no reply after them');
            const v = value(depth + 1);
            v.attributes = items;
            v.start = start;
            return v;
          }
          const type = { '*': 'array', '~': 'set', '>': 'push', '%': 'map' }[t];
          return { type: type, items: items, start: start };
        }
        default: {
          // An inline command, the plain form redis-cli also accepts.
          o = start;
          const line = readLine();
          return { type: 'inline', args: splitArgs(line), start: start };
        }
      }
    }
    while (o < bytes.length && values.length < max) {
      if (bytes[o] === 10 || bytes[o] === 13) { o++; continue; }
      values.push(value(0));
    }
    return { values: values, consumed: o, complete: o >= bytes.length, lfOnly: lfOnly };
  }

  // ---- showing values the way redis-cli shows them ----

  function quoteBytes(b) {
    let s = '"';
    for (const c of b) {
      if (c === 0x5c) s += '\\\\';
      else if (c === 0x22) s += '\\"';
      else if (c === 10) s += '\\n';
      else if (c === 13) s += '\\r';
      else if (c === 9) s += '\\t';
      else if (c === 7) s += '\\a';
      else if (c === 8) s += '\\b';
      else if (c >= 0x20 && c < 0x7f) s += String.fromCharCode(c);
      else s += '\\x' + c.toString(16).padStart(2, '0');
    }
    return s + '"';
  }
  // Text that is valid UTF-8 shows as text; anything else as \xHH.
  function showBytes(b) {
    try {
      const t = strictDecoder.decode(b);
      if (/^[^\x00-\x1f\x7f"\\]*$/.test(t)) return '"' + t + '"';
    } catch (e) { /* not UTF-8 */ }
    return quoteBytes(b);
  }

  // A command (an array of bulk strings) as one line.
  function asCommand(v) {
    if (v.type === 'inline') return v.args.map((a, i) => i === 0 ? decoder.decode(a) : showBytes(a)).join(' ');
    if (v.type !== 'array' || !v.items.length || !v.items.every((x) => x.type === 'bulk')) return null;
    return v.items.map((x, i) => i === 0 ? decoder.decode(x.bytes) : showBytes(x.bytes)).join(' ');
  }

  // Any value, in redis-cli's reply style.
  function show(v, indent) {
    const pad = indent || '';
    if (v.attributes) {
      const attrs = { type: 'map', items: v.attributes };
      const rest = Object.assign({}, v); delete rest.attributes;
      return '(attributes) ' + show(attrs, pad + '             ') + '\n' + pad + show(rest, pad);
    }
    switch (v.type) {
      case 'simple': return v.value;
      case 'error': return '(error) ' + v.value;
      case 'integer': return '(integer) ' + v.value;
      case 'null': return '(nil)';
      case 'double': return '(double) ' + v.value;
      case 'boolean': return v.value ? '(true)' : '(false)';
      case 'bignum': return '(big number) ' + v.value;
      case 'bulk': return showBytes(v.bytes);
      case 'bulkerror': return '(error) ' + decoder.decode(v.bytes);
      case 'verbatim': return showBytes(v.bytes);
      case 'inline': return asCommand(v);
      default: {
        if (!v.items.length) return v.type === 'map' ? '(empty hash)' : (v.type === 'set' ? '(empty set)' : '(empty array)');
        const lines = [];
        if (v.type === 'map') {
          for (let i = 0; i < v.items.length; i += 2) {
            const label = (i / 2 + 1) + '# ';
            lines.push(label + show(v.items[i], pad + ' '.repeat(label.length)) + ' => ' + show(v.items[i + 1], pad + ' '.repeat(label.length + 4)));
          }
        } else {
          const prefix = v.type === 'set' ? '~' : '';
          v.items.forEach((x, i) => {
            const label = prefix + (i + 1) + ') ';
            lines.push(label + show(x, pad + ' '.repeat(label.length)));
          });
        }
        return lines.join('\n' + pad);
      }
    }
  }

  // Summary of a decoded stream: how many of each command.
  function summarize(values, replyRanges) {
    const counts = Object.create(null);
    let commands = 0, replies = 0;
    for (const v of values) {
      const c = isReply(v, replyRanges) ? null : asCommand(v);
      if (c !== null) {
        commands++;
        const name = (v.type === 'inline' ? decoder.decode(v.args[0] || new Uint8Array()) : decoder.decode(v.items[0].bytes)).toUpperCase();
        counts[name] = (counts[name] || 0) + 1;
      } else replies++;
    }
    return { commands: commands, replies: replies, counts: counts };
  }

  return {
    Output: Output,
    encodeCommand: encodeCommand,
    parseCSV: parseCSV,
    guessDelimiter: guessDelimiter,
    csvRecords: csvRecords,
    jsonRecords: jsonRecords,
    parseJSON: parseJSON,
    stringifyJSON: stringifyJSON,
    Num: Num,
    compileTemplate: compileTemplate,
    build: build,
    splitArgs: splitArgs,
    buildFromCommands: buildFromCommands,
    bytesFromText: bytesFromText,
    bytesFromDump: bytesFromDump,
    isReply: isReply,
    decode: decode,
    asCommand: asCommand,
    show: show,
    showBytes: showBytes,
    summarize: summarize
  };
});
