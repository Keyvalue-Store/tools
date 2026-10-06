// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Config Checker. Reads a redis.conf or valkey.conf the way the chosen
// server version reads it at startup: the same tokenizing, the same checks,
// the same error message at the same line. Then shows each setting's value
// as CONFIG GET would report it, what differs from the defaults, and the
// settings that deserve a second look. It can also read the output of
// CONFIG GET *. One file, no dependencies; servers.js holds the facts about
// each version. In a browser it defines KVConfig; in Node, require()
// returns the same functions.

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KVConfig = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---- the version data ----

  let DATA = null;
  function data() {
    if (DATA) return DATA;
    if (typeof globalThis !== 'undefined' && globalThis.KVConfigServers) DATA = globalThis.KVConfigServers;
    else if (typeof module === 'object' && typeof require === 'function') DATA = require('./servers.js');
    if (!DATA) throw new Error('servers.js is not loaded.');
    return DATA;
  }

  const cache = new Map();
  // A version, with its configs looked up by name and alias.
  function getVersion(id) {
    if (cache.has(id)) return cache.get(id);
    const d = data();
    const raw = d.versions.find((v) => v.id === id);
    if (!raw) throw new Error('Unknown version ' + id + '.');
    const v = Object.assign({}, raw);
    v.defs = raw.configs.map((i) => {
      const [name, alias, type, flags, info, dflt, build] = d.defs[i];
      const c = { name: name, alias: alias || null, type: type, flags: flags, dflt: dflt, build: build || null, multi: flags.includes('A') };
      if (type === 'bool') c.valid = info[0] || null;
      else if (type === 'string' || type === 'sds') { c.emptyToNull = info[0] === 1; c.valid = info[1] || null; }
      else if (type === 'enum') { c.enumName = info[0]; c.enum = raw.enums[info[0]]; c.valid = info[1] || null; c.bitflags = c.multi; }
      else if (type === 'numeric') {
        c.ctype = info[0]; c.lower = BigInt(info[1]); c.upper = BigInt(info[2]);
        c.memory = info[3].includes('m'); c.percent = info[3].includes('p'); c.octal = info[3].includes('o');
        c.unsigned = info[3].includes('u'); c.signedMemory = info[3].includes('s'); c.anyNumFlag = info[3].length > 0; c.valid = info[4] || null;
      } else if (type === 'special') c.set = info[0];
      return c;
    });
    v.byName = new Map();
    for (const c of v.defs) {
      v.byName.set(c.name, c);
      if (c.alias) v.byName.set(c.alias, c);
    }
    v.commandSet = new Set(d.commands.filter((_, i) => raw.commands[i] === '1'));
    v.subcommandSet = new Set(d.subcommands.filter((_, i) => (raw.subcommands || '')[i] === '1'));
    v.f = raw.features;
    cache.set(id, v);
    return v;
  }

  // Every version, oldest first within each server.
  function versions() {
    return data().versions.map((v) => ({ id: v.id, server: v.server, version: v.version, label: v.label }));
  }
  // 'valkey 9.1', 'Redis 7.2.16', 'redis-8.10.2', '8' → the newest matching
  // version. A patch release it doesn't know, such as 7.2.4, gets the newest
  // of the same minor version, whose config code is the same or close to it.
  function findVersion(spec) {
    const m = /^\s*(redis|valkey)?[\s-]*v?(\d+(?:\.\d+){0,2})\s*$/i.exec(String(spec || ''));
    if (!m) return null;
    const server = m[1] ? m[1].toLowerCase() : null;
    const want = m[2].split('.').map(Number);
    const pick = (parts) => {
      let best = null;
      for (const v of versions()) {
        if (server && v.server !== server) continue;
        const have = v.version.split('.').map(Number);
        if (parts.every((x, i) => have[i] === x) && (!best || compareVersions(v.version, best.version) > 0)) best = v;
      }
      return best;
    };
    const best = pick(want) || (want.length === 3 ? pick(want.slice(0, 2)) : null);
    return best ? best.id : null;
  }
  function compareVersions(a, b) {
    const x = a.split('.').map(Number), y = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
    return 0;
  }

  // ---- bytes ----
  // Config files are bytes; the servers compare and print bytes. Text here
  // is a "binary string", one character per byte.

  const utf8 = new TextEncoder();
  const fromUtf8 = new TextDecoder('utf-8', { ignoreBOM: true });
  // Text is written out as UTF-8; the bytes of a file (Uint8Array or
  // ArrayBuffer) are taken as they are.
  function toBinary(text) {
    let b;
    if (typeof text === 'string') b = utf8.encode(text);
    else if (text instanceof ArrayBuffer) b = new Uint8Array(text);
    else b = text;
    let s = '';
    for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, b.subarray(i, i + 8192));
    return s;
  }
  function fromBinary(s) {
    const b = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
    return fromUtf8.decode(b);
  }
  // Escapes bytes that aren't printable, for showing a token.
  function printable(s) {
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      out += c >= 0x20 && c < 0x7f ? s[i] : '\\x' + c.toString(16).padStart(2, '0');
    }
    return out;
  }

  // ---- C, as the servers' code uses it ----

  const isspace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\v' || c === '\f' || c === '\r';
  const isdigit = (c) => c >= '0' && c <= '9';
  const lower = (s) => (/[A-Z]/.test(s) ? s.replace(/[A-Z]+/g, (x) => x.toLowerCase()) : s);
  const eqi = (a, b) => lower(a) === lower(b);
  const ULL = 2n ** 64n, LL = 2n ** 63n;
  const u64 = (x) => ((x % ULL) + ULL) % ULL;
  const s64 = (x) => { x = u64(x); return x >= LL ? x - ULL : x; };
  const s32 = (x) => { x = ((x % 4294967296n) + 4294967296n) % 4294967296n; return x >= 2147483648n ? x - 4294967296n : x; };
  const u32 = (x) => ((x % 4294967296n) + 4294967296n) % 4294967296n;

  // strtoll / strtoull: leading space, a sign, digits in the base; stops at
  // the first other character. Clamps on overflow and says so (erange).
  function strtoll(s, base, unsigned) {
    let i = 0;
    while (i < s.length && isspace(s[i])) i++;
    let neg = false;
    if (s[i] === '+' || s[i] === '-') { neg = s[i] === '-'; i++; }
    if ((base === 16 || base === 0) && s[i] === '0' && (s[i + 1] === 'x' || s[i + 1] === 'X') && /[0-9a-fA-F]/.test(s[i + 2] || '')) { i += 2; base = 16; }
    else if (base === 0) base = s[i] === '0' ? 8 : 10;
    const start = i;
    let v = 0n;
    const B = BigInt(base);
    for (; i < s.length; i++) {
      const d = parseInt(s[i], 36);
      if (Number.isNaN(d) || d >= base) break;
      v = v * B + BigInt(d);
    }
    if (i === start) return { value: 0n, end: 0, erange: false, digits: false };
    let erange = false;
    if (unsigned) {
      if (v > ULL - 1n) { v = ULL - 1n; erange = true; }
      else if (neg) v = u64(-v);
    } else {
      if (!neg && v > LL - 1n) { v = LL - 1n; erange = true; }
      else if (neg && v > LL) { v = -LL; erange = true; }
      else if (neg) v = -v;
    }
    return { value: v, end: i, erange: erange, digits: true };
  }
  // atoi: strtol without the checks, as an int.
  const atoi = (s) => s32(strtoll(s, 10).value);

  // string2ll: strict; no sign but '-', no leading zeros, no spaces.
  function string2ll(s, v) {
    if (s.length === 0 || (v.f.string2llMaxLen && s.length >= 21)) return null;
    if (s === '0') return 0n;
    let p = 0, neg = false;
    if (s[0] === '-') { neg = true; p = 1; if (s.length === 1) return null; }
    if (!(s[p] >= '1' && s[p] <= '9')) return null;
    let x = 0n;
    for (; p < s.length; p++) {
      if (!isdigit(s[p])) return null;
      x = x * 10n + BigInt(s.charCodeAt(p) - 48);
      if (x > ULL - 1n) return null;
    }
    if (neg) { if (x > LL) return null; return -x; }
    if (x > LL - 1n) return null;
    return x;
  }
  function string2ull(s, v) {
    const ll = string2ll(s, v);
    if (ll !== null) return ll < 0n ? null : ll;
    if (!s.length) return null;
    const r = strtoll(s, 10, true);
    if (r.erange || !r.digits || r.end !== s.length) return null;
    return r.value;
  }
  // memtoull: digits, then b, k, kb, m, mb, g or gb in any case.
  const UNITS = { '': 1n, b: 1n, k: 1000n, kb: 1024n, m: 1000000n, mb: 1048576n, g: 1000000000n, gb: 1073741824n };
  function memtoull(s, v) {
    if (s[0] === '-') return null;
    let u = 0;
    while (u < s.length && isdigit(s[u])) u++;
    const unit = lower(s.slice(u));
    if (!(unit in UNITS)) return null;
    if (u >= 128) return null;
    const digits = s.slice(0, u);
    let val = 0n;
    for (const d of digits) val = val * 10n + BigInt(d.charCodeAt(0) - 48);
    const mul = UNITS[unit];
    if (val > ULL - 1n) {
      if (v.f.memtoull === 'erange') return null;
      val = ULL - 1n;
      if (v.f.memtoull === 'clamp') return ULL - 1n;
      return u64(val * mul);
    }
    if (v.f.memtoull === 'clamp' && val > (ULL - 1n) / mul) return ULL - 1n;
    return u64(val * mul);
  }
  // Redis 6.2's memtoll: a sign is allowed; errors give 0.
  function memtoll(s) {
    let u = 0;
    if (s[0] === '-') u++;
    while (u < s.length && isdigit(s[u])) u++;
    const unit = lower(s.slice(u));
    if (!(unit in UNITS)) return { value: 0n, err: true };
    if (u >= 128) return { value: 0n, err: true };
    const r = strtoll(s.slice(0, u), 10);
    if (r.end !== u) return { value: 0n, err: true };
    return { value: s64(r.value * UNITS[unit]), err: false };
  }
  // strtod and the faster parsers newer versions use, for latency
  // percentiles: a finite number, written in full, or null.
  function string2d(s, v) {
    if (!s.length || isspace(s[0])) return null;
    const dec = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
    const word = /^[+-]?(?:inf|infinity|nan)$/i;
    const hex = /^[+-]?0[xX](?:[0-9a-fA-F]+\.?[0-9a-fA-F]*|\.[0-9a-fA-F]+)(?:[pP][+-]?\d+)?$/;
    let x;
    // Redis's fast parsers fall back to strtod for anything they don't take
    // whole, hexadecimal included; Valkey's (ffc) has no fallback.
    if (dec.test(s)) x = Number(s);
    else if (word.test(s)) x = /nan/i.test(s) ? NaN : (s[0] === '-' ? -Infinity : Infinity);
    else if (hex.test(s) && v.f.string2d !== 'ffc') x = parseHexFloat(s);
    else return null;
    if (Number.isNaN(x)) return null;
    if (!Number.isFinite(x) && dec.test(s)) return null; // overflow
    if (x === 0 && dec.test(s) && /[1-9]/.test(s.replace(/[eE].*$/, ''))) return null; // underflow
    return x;
  }
  function parseHexFloat(s) {
    const m = /^([+-]?)0[xX]([0-9a-fA-F]*)\.?([0-9a-fA-F]*)(?:[pP]([+-]?\d+))?$/.exec(s);
    let x = 0;
    for (const d of m[2]) x = x * 16 + parseInt(d, 16);
    let f = 1 / 16;
    for (const d of m[3]) { x += parseInt(d, 16) * f; f /= 16; }
    x *= Math.pow(2, Number(m[4] || 0));
    return m[1] === '-' ? -x : x;
  }
  // printf("%f") then trimDoubleString: "99.900000" -> "99.9".
  function fmtPercentile(x) {
    let s = (Object.is(x, -0) ? '-' : '') + x.toFixed(6);
    if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return s;
  }
  const yesnotoi = (s) => (eqi(s, 'yes') ? 1 : eqi(s, 'no') ? 0 : -1);

  // Splits a line into arguments the way the version does. kind 'classic'
  // is sdssplitargs; Valkey 8.1 and later parse each argument with
  // sdsparsearg, which drops 0xff bytes (they read as -1, its "no character"
  // mark), and from 9.0 a closing quote no longer ends the argument.
  function splitArgsFor(line, kind) {
    const classic = !kind || kind === 'classic';
    if (!line.includes('"') && !line.includes('\'') && (classic || !line.includes('\xff'))) return splitPlain(line);
    if (classic) return splitArgs(line);
    const out = [];
    const n = line.length;
    const hexd = (c) => /[0-9a-fA-F]/.test(c || '');
    const loose = kind === 'parsearg-loose';
    let p = 0;
    for (;;) {
      while (p < n && isspace(line[p])) p++;
      if (p >= n) return out;
      let cur = '', inq = false, insq = false, done = false;
      while (!done) {
        let ch = -1;
        const c = p < n ? line[p] : '';
        if (inq) {
          if (c === '\\' && line[p + 1] === 'x' && hexd(line[p + 2]) && hexd(line[p + 3])) { ch = parseInt(line.substr(p + 2, 2), 16); p += 4; }
          else if (c === '\\' && p + 1 < n) {
            const e = line[p + 1];
            ch = e === 'n' ? 10 : e === 'r' ? 13 : e === 't' ? 9 : e === 'b' ? 8 : e === 'a' ? 7 : signedChar(e);
            p += 2;
          } else if (c === '"') {
            if (loose) inq = false;
            else { if (p + 1 < n && !isspace(line[p + 1])) return null; done = true; }
            p++;
          } else if (c === '') return null;
          else { ch = signedChar(c); p++; }
        } else if (insq) {
          if (c === '\\' && line[p + 1] === '\'') { ch = 39; p += 2; }
          else if (c === '\'') {
            if (loose) insq = false;
            else { if (p + 1 < n && !isspace(line[p + 1])) return null; done = true; }
            p++;
          } else if (c === '') return null;
          else { ch = signedChar(c); p++; }
        } else {
          if (c === '' || c === ' ' || c === '\n' || c === '\r' || c === '\t') done = true;
          else if (c === '"') inq = true;
          else if (c === '\'') insq = true;
          else ch = signedChar(c);
          if (c !== '') p++;
        }
        if (ch !== -1) cur += String.fromCharCode(ch & 0xff);
      }
      out.push(cur);
    }
  }
  // A line with no quotes splits the same way in every version: arguments end
  // at a space, tab, CR or LF; blanks that C's isspace knows (\v and \f too)
  // are skipped before each argument.
  function splitPlain(line) {
    const out = [];
    for (const t of line.split(/[ \n\r\t]+/)) {
      const u = t.replace(/^[\v\f]+/, '');
      if (u !== '') out.push(u);
    }
    return out;
  }
  // A byte as C's (signed) char.
  const signedChar = (c) => { const x = c.charCodeAt(0); return x >= 128 ? x - 256 : x; };

  // sdssplitargs: spaces separate arguments; "double quotes" take \n \r \t
  // \b \a \xHH and \<char>; 'single quotes' take \'; a closing quote must
  // be followed by a space or the end. Returns null for unbalanced quotes.
  function splitArgs(line) {
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    const out = [];
    let p = 0;
    const n = line.length;
    const hexd = (c) => /[0-9a-fA-F]/.test(c || '');
    for (;;) {
      while (p < n && isspace(line[p])) p++;
      if (p >= n) return out;
      let cur = '', inq = false, insq = false, done = false;
      while (!done) {
        const c = line[p];
        if (inq) {
          if (c === '\\' && line[p + 1] === 'x' && hexd(line[p + 2]) && hexd(line[p + 3])) { cur += String.fromCharCode(parseInt(line.substr(p + 2, 2), 16)); p += 3; }
          else if (c === '\\' && p + 1 < n) {
            p++;
            const e = line[p];
            cur += e === 'n' ? '\n' : e === 'r' ? '\r' : e === 't' ? '\t' : e === 'b' ? '\b' : e === 'a' ? '\x07' : e;
          } else if (c === '"') {
            if (p + 1 < n && !isspace(line[p + 1])) return null;
            done = true;
          } else if (p >= n) return null;
          else cur += c;
        } else if (insq) {
          if (c === '\\' && line[p + 1] === '\'') { p++; cur += '\''; }
          else if (c === '\'') {
            if (p + 1 < n && !isspace(line[p + 1])) return null;
            done = true;
          } else if (p >= n) return null;
          else cur += c;
        } else if (p >= n || c === ' ' || c === '\n' || c === '\r' || c === '\t') done = true;
        else if (c === '"') inq = true;
        else if (c === '\'') insq = true;
        else cur += c;
        if (p < n) p++;
      }
      out.push(cur);
    }
  }
  // sdstrim with " \t\r\n".
  const trim = (s) => s.replace(/^[ \t\r\n]+/, '').replace(/[ \t\r\n]+$/, '');
  // The servers read the file with fgets, up to a line break or 1024 bytes at
  // a time, and append each piece as a C string: a NUL byte drops the rest of
  // its piece, line break included.
  function readFile(s) {
    if (!s.includes('\0')) return s;
    let out = '';
    for (let p = 0; p < s.length;) {
      const nl = s.indexOf('\n', p);
      const end = Math.min(p + 1024, nl < 0 ? s.length : nl + 1);
      const piece = s.slice(p, end);
      const nul = piece.indexOf('\0');
      out += nul < 0 ? piece : piece.slice(0, nul);
      p = end;
    }
    return out;
  }

  // ---- checks some configs make ----

  const pathIsBaseName = (s) => !s.includes('/') && !s.includes('\\');
  // isValidAuxChar, for node names: a NUL is never allowed (strchr finds
  // the end of its list), bytes over 0x7f always are.
  function auxChar(c, kind) {
    const code = c.charCodeAt(0);
    if (code === 0) return false;
    if (kind === 'valkey') return !(code <= 0x2c || code === 0x7f) && !';<=>?@[]^{|}~\\'.includes(c);
    if (/[0-9A-Za-z]/.test(c)) return true;
    if (kind === 'cntrl') return !(code < 0x20 || code === 0x7f) && !'!#$%&()*+:;<>?@[]^{|}~,= "\'\\'.includes(c);
    return !'!#$%&()*+:;<>?@[]^{|}~'.includes(c);
  }
  // glibc's inet_pton for AF_INET: four decimal parts up to 255, no leading zeros.
  function ipv4(s) {
    let sawDigit = false, octets = 0, cur = 0;
    for (const ch of s) {
      if (ch >= '0' && ch <= '9') {
        const next = cur * 10 + (ch.charCodeAt(0) - 48);
        if (sawDigit && cur === 0) return false;
        if (next > 255) return false;
        cur = next;
        if (!sawDigit) { if (++octets > 4) return false; sawDigit = true; }
      } else if (ch === '.' && sawDigit) {
        if (octets === 4) return false;
        cur = 0; sawDigit = false;
      } else return false;
    }
    return octets >= 4;
  }
  // glibc's inet_pton for AF_INET6, byte for byte.
  function ipv6(s) {
    let i = 0;
    const n = s.length;
    if (n === 0) return false;
    if (s[0] === ':') { i++; if (i === n || s[i] !== ':') return false; }
    let tp = 0, colonp = -1, xdigits = 0, val = 0, curtok = i;
    while (i < n) {
      const ch = s[i++];
      const digit = /[0-9a-fA-F]/.test(ch) ? parseInt(ch, 16) : -1;
      if (digit >= 0) {
        if (xdigits === 4) return false;
        val = (val << 4) | digit;
        if (val > 0xffff) return false;
        xdigits++;
        continue;
      }
      if (ch === ':') {
        curtok = i;
        if (xdigits === 0) {
          if (colonp >= 0) return false;
          colonp = tp;
          continue;
        } else if (i === n) return false;
        if (tp + 2 > 16) return false;
        tp += 2; xdigits = 0; val = 0;
        continue;
      }
      if (ch === '.' && tp + 4 <= 16 && ipv4(s.slice(curtok))) { tp += 4; xdigits = 0; break; }
      return false;
    }
    if (xdigits > 0) { if (tp + 2 > 16) return false; tp += 2; }
    if (colonp >= 0) { if (tp === 16) return false; tp = 16; }
    return tp === 16;
  }
  // The process title template, expanded as sdstemplate does with the
  // title empty: {name} must be one of the variables, {{ is a brace, a lone
  // } is just a character, and something other than spaces must be left.
  // What the variables give depends on settings read earlier in the file.
  function procTitleOk(t, st) {
    const nul = t.indexOf('\0');
    if (nul >= 0) t = t.slice(0, nul);
    const vars = {
      title: '', 'listen-addr': 'x', 'config-file': 'x', port: 'x', 'tls-port': 'x',
      'server-mode': st && st.vals.has('cluster-enabled') && st.vals.get('cluster-enabled').v ? '[cluster]' : '',
      unixsocket: st && st.vals.has('unixsocket') ? cstr(st.vals.get('unixsocket').v || '') : ''
    };
    let res = '', p = 0;
    while (p < t.length) {
      const sv = t.indexOf('{', p);
      if (sv < 0) { res += t.slice(p); break; }
      res += t.slice(p, sv);
      const q = sv + 1;
      if (q >= t.length) return false;
      if (t[q] === '{') { res += '{'; p = q + 1; continue; }
      const ev = t.indexOf('}', q);
      if (ev < 0) return false;
      const name = t.slice(q, ev);
      if (!Object.prototype.hasOwnProperty.call(vars, name)) return false;
      res += vars[name];
      p = ev + 1;
    }
    return res.replace(/^ +| +$/g, '').length > 0;
  }
  // A C string ends at its first NUL.
  const cstr = (s) => { const i = s.indexOf('\0'); return i < 0 ? s : s.slice(0, i); };
  // Each validator: value -> error message, or null when it's fine. String
  // validators get the argument's bytes; most read it as a C string, which
  // ends at the first NUL, and some use its whole length.
  function validator(name, v, st) {
    const k = v.consts;
    switch (name) {
      case 'isValidActiveDefrag': return () => null; // builds use jemalloc
      case 'isValidMptcp': return () => null; // depends on the platform: noted as unchecked
      case 'isValidShutdownOnSigFlags': return (x) => ((x & 1) && (x & 2) ? 'shutdown options SAVE and NOSAVE can\'t be used simultaneously' : null);
      case 'isValidDBfilename': return (raw) => {
        const s = cstr(raw);
        return v.f.dbfilenameEmpty && s === '' ? 'dbfilename can\'t be empty' : !pathIsBaseName(s) ? 'dbfilename can\'t be a path, just a filename' : null;
      };
      case 'isValidAOFfilename': return (raw) => {
        const s = cstr(raw);
        return v.f.aofFilenameEmpty && s === '' ? 'appendfilename can\'t be empty' : !pathIsBaseName(s) ? 'appendfilename can\'t be a path, just a filename' : null;
      };
      case 'isValidAOFdirname': return (raw) => { const s = cstr(raw); return s === '' ? 'appenddirname can\'t be empty' : !pathIsBaseName(s) ? 'appenddirname can\'t be a path, just a dirname' : null; };
      case 'isValidBackupdirname': return (raw) => { const s = cstr(raw); return s === '' ? 'backupdirname can\'t be empty' : !pathIsBaseName(s) ? 'backupdirname can\'t be a path, just a dirname' : null; };
      case 'isValidProcTitleTemplate': return (raw) => (procTitleOk(cstr(raw), st) ? null : 'template format is invalid or contains unknown variables');
      case 'isValidAnnouncedHostname': return (raw) => {
        const s = cstr(raw);
        return s.length >= k.NET_HOST_STR_LEN ? 'Hostnames must be less than ' + k.NET_HOST_STR_LEN + ' characters' : hostnameChars(s);
      };
      case 'isValidAnnouncedNodename': return (raw) => ([...raw].every((c) => auxChar(c, v.f.auxChar)) ? null : 'Announced human node name contained invalid character');
      case 'isValidAnnouncedIp': return (raw) => (raw.length >= k.NET_IP_STR_LEN ? 'cluster-announce-ip is too long'
        : [...raw].every((c) => auxChar(c, v.f.auxChar)) ? null : 'cluster-announce-ip contains invalid character');
      case 'isValidClusterAnnounceIp': return (raw) => {
        const s = cstr(raw);
        if (s === '' || ipv4(s) || ipv6(s)) return null;
        if (!v.f.announceIpHostnames) return 'Cluster announce IP must be a valid IPv4 or IPv6 address';
        if (s.length >= k.NET_IP_STR_LEN) return 'Hostnames for cluster-announce-ip must be less than ' + k.NET_IP_STR_LEN + ' characters';
        return hostnameChars(s);
      };
      case 'isValidIpV4': return (raw) => { const s = cstr(raw); return s !== '' && !ipv4(s) ? 'Invalid IPv4 address' : null; };
      case 'isValidIpV6': return (raw) => { const s = cstr(raw); return s !== '' && !ipv6(s) ? 'Invalid IPv6 address' : null; };
      case 'isValidClusterConfigFile': return (raw) => (cstr(raw) === '' ? 'cluster-config-file can\'t be empty' : null);
      case 'isValidDbHashSeed': return (raw) => (raw.length > k.HASH_SEED_MAX_LEN ? 'hash-seed must be less than or equal to ' + k.HASH_SEED_MAX_LEN + ' characters' : null);
      case 'isValidArraySliceSize': return (x) => (x <= 0n || (x & (x - 1n)) !== 0n ? 'array-slice-size must be a power of two' : null);
      case 'isValidArraySparseKmax': return (x) => (x > 0n && u32(x) <= st.num('array-sparse-kmin') ? 'array-sparse-kmax must be greater than array-sparse-kmin when non-zero' : null);
      case 'isValidArraySparseKmin': return (x) => (st.num('array-sparse-kmax') > 0n && u32(x) >= st.num('array-sparse-kmax') ? 'array-sparse-kmin must be less than array-sparse-kmax' : null);
      case 'isValidPreloadFile': return (raw) => {
        // The argument is never NULL here, so "" fails the prefix test too.
        const s = cstr(raw);
        if (!s.startsWith('aof:/') && !s.startsWith('rdb:/')) return 'argument must be in the format \'[aof|rdb]:[filename]\'';
        if (s.slice(5).split('/').some((p) => p === '' || p === '.' || p === '..')) return 'preload-file path must be a normalized absolute file path';
        const dot = s.lastIndexOf('.');
        if (dot < 0 || dot === s.length - 1) return 'preload-file must end with an extension';
        return null;
      };
      case 'isValidTlsExpectedPeerName': return (raw) => {
        const s = cstr(raw);
        if (s === '') return null;
        if (/[\t\n\v\f\r]/.test(s)) return 'tls-expected-peer-name must not contain whitespace other than spaces separating names; use an empty string to disable it';
        if (!s.replace(/ /g, '')) return 'tls-expected-peer-name contains no usable name; use an empty string to disable it';
        return null;
      };
    }
    throw new Error('No check for ' + name);
  }
  function hostnameChars(s) {
    return /^[A-Za-z0-9.-]*$/.test(s) ? null : 'Hostnames may only contain alphanumeric characters, hyphens or dots';
  }

  // ---- the server's settings while it reads a file ----

  // Client classes in client-output-buffer-limit, in CONFIG GET's order.
  const CLASSES = ['normal', 'slave', 'pubsub'];
  function classIndex(name, v) {
    const n = lower(name);
    if (n === 'normal') return 0;
    if (n === 'slave' || n === 'replica') return 1;
    if (n === 'pubsub') return 2;
    if (n === 'master' || (v.f.primaryWords && n === 'primary')) return 'master';
    return -1;
  }

  class State {
    constructor(v) {
      this.v = v;
      // The defaults are worked out once per version and copied after that.
      if (!v.initialVals) {
        v.initialVals = new Map();
        for (const c of v.defs) v.initialVals.set(c.name, initial(c, v));
        if (v.f.legacy) for (const [name, value] of Object.entries(v.legacy)) v.initialVals.set(name, legacyInitial(name, value));
      }
      this.vals = new Map();
      for (const [name, x] of v.initialVals) this.vals.set(name, { v: clone(x.v) });
    }
    num(name) { const x = this.vals.get(name); return x ? x.v : 0n; }
  }
  function initial(c, v) {
    const d = c.dflt === null ? null : c.dflt;
    switch (c.type) {
      case 'bool': return { v: d === 'yes' ? 1 : 0 };
      case 'string': case 'sds': return { v: c.emptyToNull && !d ? null : (d || '') };
      case 'enum': {
        let x = 0;
        for (const word of String(d).split(' ')) { const e = c.enum.find((p) => p[0] === word); if (e) x |= e[1]; }
        return { v: x };
      }
      case 'numeric': {
        let x;
        if (d.endsWith('%')) x = -BigInt(d.slice(0, -1));
        else if (c.octal) x = BigInt(parseInt(d, 8));
        else x = BigInt(d);
        return { v: store(c, x) };
      }
      case 'special': return specialInitial(c.name, d);
    }
    return { v: d };
  }
  function specialInitial(name, d) {
    switch (name) {
      case 'save': return { v: parsePairs(d) };
      case 'client-output-buffer-limit': {
        const w = d.split(' ');
        const out = [];
        for (let i = 0; i < w.length; i += 4) out.push({ hard: BigInt(w[i + 1]), soft: BigInt(w[i + 2]), secs: BigInt(w[i + 3]) });
        return { v: out };
      }
      case 'oom-score-adj-values': return { v: d.split(' ').map((x) => BigInt(x)) };
      case 'notify-keyspace-events': return { v: 0 };
      case 'bind': case 'rdma-bind': return { v: d ? d.split(' ') : [] };
      case 'replicaof': case 'slaveof': return { v: null };
      case 'dir': return { v: null };
      case 'latency-tracking-info-percentiles': return { v: d ? d.split(' ').map(Number) : [] };
    }
    return { v: d };
  }
  function legacyInitial(name, d) {
    if (name === 'unixsocketperm') return { v: BigInt(parseInt(d, 8)) };
    // logfile is a string; watchdog-period only CONFIG SET changes.
    if (name === 'logfile' || name === 'watchdog-period') return { v: d };
    return specialInitial(name, d);
  }
  const parsePairs = (d) => {
    const w = d ? d.split(' ') : [];
    const out = [];
    for (let i = 0; i + 1 < w.length; i += 2) out.push([BigInt(w[i]), BigInt(w[i + 1])]);
    return out;
  };
  // A long long as the C variable the config lives in holds it.
  function store(c, x) {
    switch (c.ctype) {
      case 'int': return s32(x);
      case 'uint': return u32(x);
      case 'ulong': case 'ulonglong': case 'size_t': return u64(x);
      default: return s64(x);
    }
  }
  const asLongLong = (c, stored) => s64(stored);

  // ---- setting a config, as each set function does ----

  // Returns an error message, or null.
  function setConfig(st, c, args) {
    const v = st.v;
    switch (c.type) {
      case 'bool': {
        const yn = yesnotoi(args[0]);
        if (yn === -1) return 'argument must be \'yes\' or \'no\'';
        if (c.valid) { const e = validator(c.valid, v, st)(yn); if (e) return e; }
        st.vals.get(c.name).v = yn;
        return null;
      }
      case 'string': case 'sds': {
        // A string config keeps a C string, which ends at the first NUL; an sds keeps every byte.
        const x = c.type === 'string' ? cstr(args[0]) : args[0];
        if (c.valid) { const e = validator(c.valid, v, st)(args[0]); if (e) return e; }
        st.vals.get(c.name).v = c.emptyToNull && x === '' ? null : x;
        return null;
      }
      case 'enum': {
        let val;
        if (v.f.legacy) {
          const e = c.enum.find((p) => eqi(p[0], args[0]));
          val = e ? e[1] : null;
        } else val = enumValue(c, args);
        if (val === null) {
          const msg = v.f.enumPrefix + c.enum.map((p) => p[0]).join(', ');
          return msg.slice(0, 255);
        }
        if (c.valid) { const e = validator(c.valid, v, st)(val); if (e) return e; }
        st.vals.get(c.name).v = val;
        return null;
      }
      case 'numeric': return setNumeric(st, c, args[0]);
      case 'special': return setSpecial(st, c.set, c.name, args);
    }
    return null;
  }
  function enumValue(c, args) {
    if (args.length === 0 || (!c.bitflags && args.length !== 1)) return null;
    let values = 0;
    for (const a of args) {
      let matched = false;
      for (const [name, val] of c.enum) if (eqi(a, name)) { values |= val; matched = true; }
      if (!matched) return null;
    }
    return values;
  }
  function setNumeric(st, c, value) {
    const v = st.v;
    let ll = null;
    if (v.f.legacy) {
      if (c.memory) {
        const r = memtoll(value);
        if (r.err || r.value < 0n) return 'argument must be a memory value';
        ll = r.value;
      } else {
        ll = string2ll(value, v);
        if (ll === null) return 'argument couldn\'t be parsed into an integer';
      }
    } else {
      if (c.memory) {
        const r = memtoull(value, v);
        if (r !== null) ll = s64(r);
        else if (c.signedMemory) ll = string2ll(value, v);
      }
      if (ll === null && c.percent && value.length > 1 && value.endsWith('%')) {
        const p = string2ll(value.slice(0, -1), v);
        if (p !== null && p >= 0n) ll = -p;
      }
      if (ll === null && c.octal) {
        // With no digits strtoll leaves the end at the start, which is the end only for "".
        const r = strtoll(value, 8);
        if (r.digits ? r.end === value.length && !r.erange : value === '') ll = r.value;
      }
      if (ll === null && c.unsigned) { const r = string2ull(value, v); if (r !== null) ll = s64(r); }
      if (ll === null && !c.anyNumFlag) ll = string2ll(value, v);
      if (ll === null) {
        if (c.memory && c.percent) return 'argument must be a memory or percent value';
        if (c.memory) return 'argument must be a memory value';
        if (c.octal) return 'argument couldn\'t be parsed as an octal number';
        if (c.unsigned) return 'argument couldn\'t be parsed as an unsigned number';
        return 'argument couldn\'t be parsed into an integer';
      }
    }
    // The bounds, as the long longs the config table keeps them in.
    const lo = s64(c.lower), hi = s64(c.upper);
    const unsignedType = c.ctype === 'ulonglong' || c.ctype === 'uint' || c.ctype === 'size_t' || (c.ctype === 'ulong' && v.f.ulongUnsigned);
    if (unsignedType) {
      if (v.f.unsignedNegCheck && ll < 0n) return 'argument must be greater or equal to 0';
      const ull = u64(ll), ulo = u64(lo), uhi = u64(hi);
      if (ull > uhi || ull < ulo) {
        if (c.octal) return 'argument must be between ' + ulo.toString(8) + ' and ' + uhi.toString(8) + ' inclusive';
        return 'argument must be between ' + ulo + ' and ' + uhi + ' inclusive';
      }
    } else if (!v.f.legacy && c.percent && ll < 0n) {
      if (ll < lo) return 'percentage argument must be less or equal to ' + (-lo);
    } else if (ll > hi || ll < lo) return 'argument must be between ' + lo + ' and ' + hi + ' inclusive';
    if (c.valid) { const e = validator(c.valid, v, st)(ll); if (e) return e; }
    st.vals.get(c.name).v = store(c, ll);
    return null;
  }
  function setSpecial(st, set, name, args) {
    const v = st.v;
    const val = st.vals.get(name);
    switch (set) {
      case 'setConfigSaveOption': {
        let a = args;
        // A single "" empties the list, before anything is checked.
        if (a.length === 1 && a[0] === '') { val.v = []; a = []; }
        if (a.length & 1) return 'Invalid save parameters';
        for (let j = 0; j < a.length; j++) {
          // strtoll must use the whole argument; with no digits it uses none of it.
          const r = strtoll(a[j], 10);
          const whole = r.digits ? r.end === a[j].length : a[j] === '';
          if (!whole || ((j & 1) === 0 && r.value < 1n) || ((j & 1) === 1 && r.value < 0n)) return 'Invalid save parameters';
        }
        if (!st.saveLoaded) { st.saveLoaded = true; val.v = []; }
        for (let j = 0; j < a.length; j += 2) val.v.push([strtoll(a[j], 10).value, s32(strtoll(a[j + 1], 10).value)]);
        return null;
      }
      case 'setConfigClientOutputBufferLimitOption': {
        if (args.length % 4) return 'Wrong number of arguments in buffer limit configuration.';
        const next = {};
        for (let j = 0; j < args.length; j += 4) {
          const cls = classIndex(args[j], v);
          if (cls === -1 || cls === 'master') return 'Invalid client class specified in buffer limit configuration.';
          const hard = memtoull(args[j + 1], v), soft = memtoull(args[j + 2], v);
          const secs = strtoll(args[j + 3], 10);
          const secsInt = s32(secs.value);
          const whole = secs.digits ? secs.end === args[j + 3].length : /^[\t\n\v\f\r ]*[+-]?$/.test(args[j + 3]) && !/[^\t\n\v\f\r +-]/.test(args[j + 3]) && args[j + 3].replace(/[\t\n\v\f\r ]/g, '').length <= 1 && (args[j + 3].trim() === '' || false);
          if (hard === null || soft === null || secsInt < 0n || !(secs.digits ? secs.end === args[j + 3].length : args[j + 3] === '')) return 'Error in hard, soft or soft_seconds setting in buffer limit configuration.';
          void whole;
          next[cls] = { hard: hard, soft: soft, secs: secsInt };
        }
        for (const k of Object.keys(next)) val.v[k] = next[k];
        return null;
      }
      case 'setConfigOOMScoreAdjValuesOption': {
        if (args.length !== 3) return 'wrong number of arguments';
        const out = [];
        for (const a of args) {
          const r = strtoll(a, 10);
          if (!(r.digits ? r.end === a.length : a === '') || r.value < -2000n || r.value > 2000n) return 'Invalid oom-score-adj-values, elements must be between -2000 and 2000.';
          out.push(s32(r.value));
        }
        if (out[1] < out[0] || out[2] < out[1]) st.notes.push({ name: name, message: 'The oom-score-adj-values configuration may not work for non-privileged processes! Please consult the documentation.' });
        val.v = out;
        return null;
      }
      case 'setConfigNotifyKeyspaceEventsOption': {
        if (args.length !== 1) return 'wrong number of arguments';
        const flags = notifyFlags(args[0], v);
        if (flags === null) return v.notify.message;
        val.v = flags;
        return null;
      }
      case 'setConfigBindOption': case 'setConfigSocketBindOption': case 'setConfigRdmaBindOption': {
        if (args.length > 16) return 'Too many bind addresses specified.';
        val.v = args.length === 1 && args[0] === '' ? [] : args.slice();
        return null;
      }
      case 'setConfigReplicaOfOption': {
        if (args.length !== 2) return 'wrong number of arguments';
        val.v = null;
        if (eqi(args[0], 'no') && eqi(args[1], 'one')) return null;
        // strtol's long goes into an int, so 4294967297 is port 1.
        const r = strtoll(args[1], 10);
        const port = s32(r.value);
        if (port < 0n || port > 65535n || !(r.digits ? r.end === args[1].length : args[1] === '')) return v.f.primaryWords ? 'Invalid primary port' : 'Invalid master port';
        val.v = { host: args[0], port: port };
        return null;
      }
      case 'setConfigDirOption': {
        if (args.length !== 1) return 'wrong number of arguments';
        if (v.f.dirEmptyCheck && args[0] === '') return 'dir can\'t be empty';
        if (args[0] === '') return 'No such file or directory';
        val.v = args[0];
        st.unchecked.push({ name: 'dir', message: 'The server changes to this folder when it starts; it stops if the folder is missing.' });
        return null;
      }
      case 'setConfigLatencyTrackingInfoPercentilesOutputOption': {
        const list = args.length === 1 && args[0] === '' ? [] : args;
        const out = [];
        for (const a of list) {
          const d = string2d(a, v);
          if (d === null) { val.v = []; return 'Invalid latency-tracking-info-percentiles parameters'; }
          if (d > 100 || d < 0) { val.v = []; return 'latency-tracking-info-percentiles parameters should sit between [0.0,100.0]'; }
          out.push(d);
        }
        val.v = out;
        return null;
      }
    }
    throw new Error('No set function ' + set);
  }
  function notifyFlags(s, v) {
    let flags = 0;
    for (const ch of s) {
      const e = v.notify.chars.find((p) => p[0] === ch);
      if (!e) return null;
      flags |= e[1];
    }
    return flags;
  }
  function notifyString(flags, v) {
    let out = '';
    if ((flags & v.notify.all) === v.notify.all) out = 'A';
    else for (const [bit, ch] of v.notify.inner) if (flags & bit) out += ch;
    for (const [bit, ch] of v.notify.after) if (flags & bit) out += ch;
    return out;
  }

  // ---- what CONFIG GET says ----

  function getValue(st, c) {
    const v = st.v;
    const x = st.vals.get(c.name).v;
    switch (c.type) {
      case 'bool': return x ? 'yes' : 'no';
      case 'string': case 'sds': return x === null ? '' : x;
      case 'enum': {
        if (v.f.legacy) { const e = c.enum.find((p) => p[1] === x); return e ? e[0] : ''; }
        return enumName(c, x);
      }
      case 'numeric': {
        const ll = asLongLong(c, x);
        if (v.f.legacy) return ll.toString();
        if (c.percent && ll < 0n) return (-ll) + '%';
        if (c.signedMemory && ll < 0n) return ll.toString();
        if (c.memory) return u64(ll).toString();
        if (c.octal) return u64(ll).toString(8);
        if (c.unsigned) return u64(ll).toString();
        return ll.toString();
      }
      case 'special': return specialValue(st, c.name, x);
    }
    return '';
  }
  function enumName(c, values) {
    let names = null, unmatched = values;
    for (const [name, val] of c.enum) {
      if (values === val) return name;
      if (c.bitflags && val && val === (unmatched & val)) { names = names ? names + ' ' + name : name; unmatched &= ~val; }
    }
    return !names || unmatched ? 'unknown' : names;
  }
  function specialValue(st, name, x) {
    const v = st.v;
    switch (name) {
      case 'save': return x.map((p) => p[0] + ' ' + p[1]).join(' ');
      case 'client-output-buffer-limit': return x.map((l, i) => CLASSES[i] + ' ' + l.hard + ' ' + l.soft + ' ' + l.secs).join(' ');
      case 'oom-score-adj-values': return x.join(' ');
      case 'notify-keyspace-events': return notifyString(x, v);
      case 'bind': case 'rdma-bind': return x.join(' ');
      case 'replicaof': case 'slaveof': return x ? x.host + ' ' + x.port : '';
      case 'dir': return x === null ? '' : x;
      case 'latency-tracking-info-percentiles': return x.map(fmtPercentile).join(' ');
      case 'unixsocketperm': return x.toString(8);
      case 'logfile': case 'watchdog-period': return x;
    }
    return String(x);
  }

  // ---- reading a file ----

  // Copies a setting's value, and gives a function that puts it back.
  const clone = (x) => (Array.isArray(x) ? x.map(clone) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, y]) => [k, clone(y)])) : x);
  function keep(st, name) {
    const entry = name ? st.vals.get(name) : null;
    const value = entry ? clone(entry.v) : null;
    const saveLoaded = st.saveLoaded;
    return () => { if (entry) entry.v = value; st.saveLoaded = saveLoaded; };
  }
  // The setting each of Redis 6.2's own directives changes.
  const LEGACY_ENTRY = {
    bind: 'bind', unixsocketperm: 'unixsocketperm', save: 'save', slaveof: 'slaveof', replicaof: 'slaveof', logfile: 'logfile',
    'client-output-buffer-limit': 'client-output-buffer-limit',
    'oom-score-adj-values': 'oom-score-adj-values', 'notify-keyspace-events': 'notify-keyspace-events'
  };

  // Reads a config file as the version would: text, or the file's bytes.
  // error is where the server stops, with what it prints; problems lists
  // every line it would stop at, each as if the ones before were fixed.
  // options.tls: for Redis 6.2 and 7.0, whether the build has TLS (default
  // true; the TLS settings don't exist in builds without it).
  // options.compression: for Redis 8.10, whether it was built with
  // BUILD_COMPRESSION=yes (default false).
  function check(text, versionId, options) {
    const opt = options || {};
    const v = getVersion(versionId);
    const st = new State(v);
    st.notes = [];
    st.unchecked = [];
    st.internal = new Map();
    st.saveLoaded = false;
    st.renamed = new Map();
    const commands = new Set(v.commandSet);
    const tls = opt.tls !== false;
    const binary = readFile(toBinary(text));
    const rawLines = binary.split('\n');
    const lines = [];
    const problems = [];
    let fatal = null;
    const moduleQueue = new Map();
    const users = new Set();
    let replicaofLine = 0;
    const setLines = new Map();

    const fail = (rec, message) => {
      rec.status = 'error';
      rec.message = message;
      const p = { line: rec.line, text: rec.text, message: message };
      problems.push(p);
      if (!fatal) fatal = p;
    };
    // A line that stops the server some other way than the loader's error:
    // what it logs instead of the FATAL CONFIG FILE ERROR block.
    const stopAt = (rec, message, log) => {
      rec.status = 'error';
      rec.message = message;
      const p = { line: rec.line, text: rec.text, message: message, startup: true, log: log };
      problems.push(p);
      if (!fatal) fatal = p;
    };
    st.stopAt = stopAt;
    const legacy = v.f.legacy;
    for (let i = 0; i < rawLines.length; i++) {
      const linenum = i + 1;
      const text = trim(rawLines[i]);
      const rec = { line: linenum, text: text, argv: null, name: null, kind: null, status: 'ok', message: null };
      lines.push(rec);
      if (text[0] === '#' || text === '') { rec.kind = text ? 'comment' : 'blank'; continue; }
      const argv = splitArgsFor(text, v.f.splitArgs);
      if (argv === null) { rec.kind = 'bad'; fail(rec, 'Unbalanced quotes in configuration line'); continue; }
      if (argv.length === 0) { rec.kind = 'blank'; continue; }
      argv[0] = lower(argv[0]);
      rec.argv = argv;
      let c = v.byName.get(argv[0]);
      if (c && ((c.build === 'tls' && !tls) || (c.build === 'compression' && !opt.compression))) c = null;
      if (c && !(legacy && c.type === 'special')) {
        rec.kind = 'config';
        rec.name = c.name;
        rec.alias = argv[0] !== c.name;
        if (legacy) {
          if (argv.length !== 2) { fail(rec, 'wrong number of arguments'); continue; }
        } else if (!c.multi && argv.length !== 2) { fail(rec, 'wrong number of arguments'); continue; }
        let args = argv.slice(1);
        if (c.multi && argv.length === 2 && argv[1].length) args = splitArgsFor(cstr(argv[1]), v.f.splitArgs) || [];
        // A line the server stops at changes nothing here, so the lines after it
        // read as they would once it's fixed or gone.
        const undo = keep(st, c.name);
        const err = setConfig(st, c, args);
        if (err) { undo(); fail(rec, err); continue; }
        if (!setLines.has(c.name)) setLines.set(c.name, []);
        setLines.get(c.name).push(linenum);
        if (c.name === 'replicaof') replicaofLine = linenum;
        continue;
      }
      if (!legacy) {
        const dep = v.deprecated.find((d) => eqi(d[0], argv[0]) && d[1] <= argv.length && argv.length <= d[2]);
        if (dep) { rec.kind = 'deprecated'; rec.status = 'ignored'; rec.message = 'An old setting this version accepts and ignores.'; continue; }
      }
      const a0 = argv[0], n = argv.length;
      if (a0 === 'include' && n === 2) {
        rec.kind = 'include'; rec.status = 'unchecked'; rec.message = 'The server reads this file here; it isn\'t checked.';
        st.unchecked.push({ line: linenum, message: 'include ' + argv[1] });
        continue;
      }
      if (a0 === 'rename-command' && n === 3) {
        rec.kind = 'rename-command';
        const from = lower(argv[1]);
        // 7.0 and later look up "container|subcommand" too, find it, then fail to
        // delete it from the command table, which trips an assertion.
        if (!commands.has(from) && v.subcommandSet.has(from) && !legacy) {
          const [where, expr] = v.f.renameAssert;
          stopAt(rec, 'The server crashes: rename-command can\'t rename a subcommand.', ['=== ASSERTION FAILED ===', '==> ' + where + ' \'' + expr + '\' is not true']);
          continue;
        }
        if (!commands.has(from)) { fail(rec, 'No such command in rename-command'); continue; }
        // The old name goes first, so a command can be renamed to itself.
        const to = lower(argv[2]);
        if (argv[2].length && to !== from && commands.has(to)) { fail(rec, 'Target command name already exists'); continue; }
        commands.delete(from);
        if (argv[2].length) commands.add(to);
        st.renamed.set(from, argv[2]);
        continue;
      }
      if (a0 === 'user' && n >= 2) {
        rec.kind = 'user';
        // 7.0 and later refuse a second user line for the same name.
        if (!legacy && users.has(argv[1])) {
          fail(rec, 'Error in user declaration \'' + argv[1] + '\': Duplicate user found. A user can only be defined once in config files');
          continue;
        }
        const acl = aclLibrary();
        if (acl) {
          const e = acl.checkUserLine(argv, v.id);
          if (e) { fail(rec, e); continue; }
        } else { rec.status = 'unchecked'; rec.message = 'An ACL user. The ACL Builder checks its rules.'; }
        users.add(argv[1]);
        continue;
      }
      if (a0 === 'loadmodule' && n >= 2) {
        rec.kind = 'loadmodule'; rec.status = 'unchecked'; rec.message = 'The server loads this module when it starts and stops if it can\'t.';
        st.modules = (st.modules || 0) + 1;
        continue;
      }
      if (a0 === 'sentinel') {
        rec.kind = 'sentinel';
        if (n !== 1) fail(rec, 'sentinel directive while not in sentinel mode');
        continue;
      }
      if (legacy) {
        const undo = keep(st, LEGACY_ENTRY[a0]);
        if (legacyDirective(st, rec, argv, fail)) {
          if (rec.status === 'error') undo();
          if (rec.status === 'ok' && rec.name) {
            if (!setLines.has(rec.name)) setLines.set(rec.name, []);
            setLines.get(rec.name).push(linenum);
            if (rec.name === 'slaveof') replicaofLine = linenum;
          }
          continue;
        }
        rec.kind = 'bad';
        fail(rec, 'Bad directive or wrong number of arguments');
        continue;
      }
      if (v.f.moduleDotConfig && a0.includes('.')) {
        rec.kind = 'module';
        if (n < 2) { fail(rec, 'Module config specified without value'); continue; }
        moduleQueue.set(a0, rec);
        continue;
      }
      if (v.f.unknownAsModuleConfig) {
        rec.kind = 'module';
        if (n < 2) { rec.kind = 'bad'; fail(rec, 'Bad directive or wrong number of arguments'); continue; }
        moduleQueue.set(a0, rec);
        continue;
      }
      rec.kind = 'bad';
      fail(rec, 'Bad directive or wrong number of arguments');
    }

    // After the last line: the checks the loader makes once it has read everything.
    const val = (name) => (st.vals.has(name) ? st.vals.get(name).v : null);
    const finish = [];
    const replica = legacy ? val('slaveof') : val('replicaof');
    if (val('cluster-enabled') && replica) {
      const p = legacy
        ? { line: replicaofLine, text: lines[replicaofLine - 1].text, message: 'replicaof directive not allowed in cluster mode' }
        : { line: null, text: null, message: 'replicaof directive not allowed in cluster mode' };
      if (legacy) lines[replicaofLine - 1].status = 'error';
      problems.push(p);
      if (!fatal) fatal = p;
    }
    const clamp = (name, lo, hi, why) => {
      const c = v.byName.get(name);
      if (!c) return;
      const x = asLongLong(c, val(name));
      if (x < lo) { st.vals.get(name).v = store(c, lo); finish.push({ name: name, message: why + ' ' + lo + '.' }); }
      if (x > hi) { st.vals.get(name).v = store(c, hi); finish.push({ name: name, message: why + ' ' + hi + '.' }); }
    };
    // These run whether or not a line failed, so the values shown are the ones
    // the server would have once the failing lines are fixed.
    if (v.f.dbnumClusterFix && val('cluster-enabled') && asLongLong(v.byName.get('databases'), val('databases')) > 1n) {
      const was = asLongLong(v.byName.get('databases'), val('databases'));
      st.vals.get('databases').v = 1n;
      finish.push({ name: 'databases', message: 'In cluster mode there is one database, so the server sets databases to 1.',
        log: 'WARNING: Changing databases number from ' + s32(was) + ' to 1 since we are in cluster mode' });
    }
    clamp('hz', BigInt(v.consts.CONFIG_MIN_HZ), BigInt(v.consts.CONFIG_MAX_HZ), 'hz must be between ' + v.consts.CONFIG_MIN_HZ + ' and ' + v.consts.CONFIG_MAX_HZ + '; the server uses');
    if (v.f.ioThreadsClamp) clamp('io-threads', 1n, BigInt(v.consts.IO_THREADS_MAX_NUM), 'io-threads is at most ' + v.consts.IO_THREADS_MAX_NUM + '; the server uses');
    // Module settings wait for their module. Modules built into the server
    // take theirs first; a value they refuse makes their loading fail, and the
    // server trips an assertion. Anything left with no module loaded stops it.
    let startup = null;
    const internal = v.f.internalModules;
    if (internal) {
      for (const [name, type] of internal.configs) {
        const rec = moduleQueue.get(name);
        if (!rec) continue;
        moduleQueue.delete(name);
        rec.kind = 'config'; rec.name = name; rec.status = 'ok'; rec.message = null;
        const value = cstr(rec.argv.slice(1).join(' '));
        const err = type === 'bool' && yesnotoi(value) === -1 ? 'argument must be \'yes\' or \'no\'' : null;
        if (err) {
          rec.status = 'error'; rec.message = err;
          const log = ['Issue during loading of configuration ' + name + ' : ' + err];
          if (internal.configError) log.push('<' + internal.module + '> ' + internal.configError);
          log.push('Module (null) initialization failed. Module not loaded', '=== ASSERTION FAILED ===', '==> ' + internal.assert + ' \'retval == C_OK\' is not true');
          const crashed = { line: rec.line, text: rec.text, message: 'The server crashes: ' + name + ' ' + err + '.', startup: true, log: log };
          problems.push(crashed);
          if (!startup) startup = crashed;
        } else {
          st.internal.set(name, yesnotoi(value) ? 'yes' : 'no');
          if (!setLines.has(name)) setLines.set(name, []);
          setLines.get(name).push(rec.line);
        }
      }
    }
    if (moduleQueue.size && !st.modules) {
      const message = 'Module Configuration detected without loadmodule directive or no ApplyConfig call: aborting';
      const log = [];
      if (v.f.moduleLog === 'unresolved') {
        log.push('Unresolved Configuration(s) Detected:');
        for (const [name, rec] of moduleQueue) log.push('>>> \'' + cstr(name) + ' ' + cstr(rec.argv.slice(1).join(' ')) + '\'');
      } else if (v.f.moduleLog === 'unused') for (const name of moduleQueue.keys()) log.push('Unused Module Configuration: ' + cstr(name));
      log.push(message);
      const stop = { line: null, text: null, message: message, startup: true, log: log,
        short: 'no module takes ' + [...moduleQueue.keys()].map(cstr).join(', ') };
      if (!startup) startup = stop;
      for (const rec of moduleQueue.values()) { rec.status = 'error'; rec.message = v.f.unknownAsModuleConfig && !rec.argv[0].includes('.') ? 'Not a setting of this version. It would have to belong to a module, and no module is loaded.' : 'A module\'s setting, and no module is loaded.'; }
      problems.push(stop);
    } else if (moduleQueue.size) {
      for (const rec of moduleQueue.values()) { rec.status = 'unchecked'; rec.message = 'A module\'s setting; the module checks it when it loads.'; }
    }
    // Users in the file and an ACL file: the server refuses to choose.
    if (users.size && val('aclfile')) {
      const stop = { line: null, text: null, message: v.f.aclConflict, startup: true, log: [v.f.aclConflict], short: 'users in the file and an aclfile' };
      if (!startup) startup = stop;
      problems.push(stop);
    }
    // At startup the watchdog period becomes at least twice the timer period.
    if (v.f.watchdogClamp && st.vals.has('watchdog-period')) {
      const wp = s32(val('watchdog-period'));
      const hz = s32(asLongLong(v.byName.get('hz'), val('hz')));
      const min = BigInt(Math.trunc(1000 / Number(hz))) * 2n;
      if (wp !== 0n && wp < min) {
        st.vals.get('watchdog-period').v = min;
        finish.push({ name: 'watchdog-period', message: 'The server raises watchdog-period to ' + min + ' ms, twice the time between timer runs at hz ' + hz + '.' });
      }
    }
    environmentNotes(st, v, tls);

    // Effective values, as CONFIG GET would report them.
    const values = new Map();
    for (const c of v.defs) {
      if ((c.build === 'tls' && !tls) || (c.build === 'compression' && !opt.compression)) continue;
      values.set(c.name, getValue(st, c));
    }
    if (legacy) for (const name of Object.keys(v.legacy)) values.set(name, specialValue(st, name, st.vals.get(name).v));
    if (internal) for (const [name, , dflt] of internal.configs) values.set(name, st.internal.has(name) ? st.internal.get(name) : dflt);
    const defaults = defaultValues(v, tls, !!opt.compression);
    // The error is the first problem itself, with what the server prints added.
    const error = fatal || startup;
    if (error) error.output = error.log ? error.log.join('\n') + '\n' : fatalText(v, error);
    return {
      version: v.id, label: v.label, ok: !error, error: error || null,
      problems: problems, notes: st.notes.concat(finish), unchecked: st.unchecked, lines: lines, values: values, defaults: defaults,
      setBy: setLines, renamed: st.renamed
    };
  }
  // Each version's defaults as CONFIG GET reports them, worked out once.
  const defaultsCache = new Map();
  function defaultValues(v, tls, compression) {
    const key = v.id + (tls ? '+tls' : '') + (compression ? '+compression' : '');
    if (defaultsCache.has(key)) return new Map(defaultsCache.get(key));
    const fresh = new State(v);
    const out = new Map();
    for (const c of v.defs) {
      if ((c.build === 'tls' && !tls) || (c.build === 'compression' && !compression)) continue;
      out.set(c.name, getValue(fresh, c));
    }
    if (v.f.legacy) for (const name of Object.keys(v.legacy)) out.set(name, specialValue(fresh, name, fresh.vals.get(name).v));
    if (v.f.internalModules) for (const [name, , dflt] of v.f.internalModules.configs) out.set(name, dflt);
    defaultsCache.set(key, out);
    return new Map(out);
  }

  // What the server prints when it stops.
  function fatalText(v, e) {
    if (e.startup) return e.message + '\n';
    let out = '\n*** FATAL CONFIG FILE ERROR (' + v.f.fatalLabel + ' ' + v.version + ') ***\n';
    if (e.line) out += 'Reading the configuration file, at line ' + e.line + '\n>>> \'' + e.text + '\'\n';
    return out + e.message + '\n';
  }

  // Settings the loader accepts that can still stop the server, depending
  // on the machine or the build.
  function environmentNotes(st, v, tls) {
    const val = (name) => (st.vals.has(name) ? st.vals.get(name).v : null);
    const db = val('dbfilename');
    if (db === '.' || db === '..') st.notes.push({ name: 'dbfilename', message: 'dbfilename ' + db + ' is a folder, not a file: the server fails to load it at startup and stops.' });
    else if (typeof db === 'string' && db.length > 255) st.notes.push({ name: 'dbfilename', message: 'dbfilename is longer than a file name may be (255 bytes): the server can\'t open it and stops.' });
    if (val('appendonly') && val('appendfilename') === '') st.notes.push({ name: 'appendfilename', message: 'appendfilename is empty, so the server can\'t open the append-only file and stops at startup.' });
    // Redis 8's I/O threads each take three file descriptors from a pool of
    // maxclients + 128, which the server's own dozen or so share; too many
    // threads for the pool stop it. Measured: with maxclients 1 it stops at
    // 41 threads, with 200 at 107.
    if (v.f.ioThreadFds && st.vals.has('io-threads')) {
      const threads = Number(s32(val('io-threads'))), maxclients = Number(u32(val('maxclients')));
      if (threads > 1 && 3 * (threads - 1) + 10 >= maxclients + v.consts.CONFIG_FDSET_INCR) {
        st.notes.push({ name: 'io-threads', message: 'io-threads ' + threads + ' needs about ' + (3 * (threads - 1)) + ' file descriptors from a pool that maxclients ' + maxclients + ' makes too small: the server would stop at startup with "Can\'t register file event for IO thread notifications".' });
      }
    }
    if (st.vals.has('mptcp') && (val('mptcp') || val('repl-mptcp'))) st.unchecked.push({ name: 'mptcp', message: 'Multipath TCP needs a Linux kernel that supports it; the server checks when it reads the line.' });
    if (st.vals.has('unixsocketgroup') && val('unixsocketgroup')) st.unchecked.push({ name: 'unixsocketgroup', message: 'The server stops if the machine has no group called ' + cstr(val('unixsocketgroup')) + '.' });
    if (st.vals.has('preload-file') && val('preload-file')) st.unchecked.push({ name: 'preload-file', message: 'The server loads ' + cstr(val('preload-file')).slice(4) + ' at startup and stops if it can\'t.' });
    const loc = val('locale-collate');
    if (loc && loc !== 'C' && loc !== 'POSIX') st.unchecked.push({ name: 'locale-collate', message: 'The server stops if the machine has no locale called ' + loc + '.' });
    if (st.vals.has('tls-port') && (val('tls-port') || val('tls-replication') || val('tls-cluster'))) st.unchecked.push({ name: 'tls-port', message: 'TLS needs a server built with TLS, and the certificate and key files; without them it stops at startup.' });
  }

  // The ACL Builder's library, when it's loaded, checks user lines.
  function aclLibrary() {
    if (typeof globalThis !== 'undefined' && globalThis.KVAcl && globalThis.KVAcl.checkUserLine) return globalThis.KVAcl;
    return null;
  }

  // Redis 6.2 reads these itself, outside its table.
  function legacyDirective(st, rec, argv, fail) {
    const v = st.v, a0 = argv[0], n = argv.length;
    const val = (name) => st.vals.get(name);
    rec.kind = 'config';
    if (a0 === 'bind' && n >= 2) {
      rec.name = 'bind';
      if (n - 1 > 16) { fail(rec, 'Too many bind addresses specified'); return true; }
      val('bind').v = argv.slice(1);
      return true;
    }
    if (a0 === 'unixsocketperm' && n === 2) {
      rec.name = 'unixsocketperm';
      const r = strtoll(argv[1], 8);
      if (r.erange || u32(r.value) > 0o777n) { fail(rec, 'Invalid socket file permissions'); return true; }
      val('unixsocketperm').v = u32(r.value);
      return true;
    }
    if (a0 === 'save') {
      rec.name = 'save';
      if (!st.saveLoaded) { st.saveLoaded = true; val('save').v = []; }
      if (n === 3) {
        const seconds = atoi(argv[1]), changes = atoi(argv[2]);
        if (seconds < 1n || changes < 0n) { fail(rec, 'Invalid save parameters'); return true; }
        val('save').v.push([seconds, changes]);
      } else if (n === 2 && argv[1] === '') val('save').v = [];
      else { rec.status = 'ignored'; rec.message = 'Redis 6.2 ignores a save line that isn\'t "save <seconds> <changes>" or "save \\"\\"", after it has cleared the defaults.'; }
      return true;
    }
    if (a0 === 'dir' && n === 2) {
      rec.name = 'dir';
      // 6.2 changes folder as it reads the line, and stops right there if it can't.
      if (argv[1] === '') { st.stopAt(rec, 'The server stops: there is no folder called "".', ['Can\'t chdir to \'\': No such file or directory']); return true; }
      st.unchecked.push({ name: 'dir', message: 'The server changes to this folder as it reads the file; it stops if the folder is missing.' });
      return true;
    }
    if (a0 === 'logfile' && n === 2) {
      rec.name = 'logfile';
      val('logfile').v = argv[1];
      if (argv[1] !== '') st.unchecked.push({ name: 'logfile', message: 'The server opens the log file as it reads the file and stops if it can\'t.' });
      return true;
    }
    if ((a0 === 'slaveof' || a0 === 'replicaof') && n === 3) {
      rec.name = 'slaveof';
      if (eqi(argv[1], 'no') && eqi(argv[2], 'one')) { val('slaveof').v = null; return true; }
      const r = strtoll(argv[2], 10);
      const port = s32(r.value);
      val('slaveof').v = { host: argv[1], port: port };
      if (port < 0n || port > 65535n || !(r.digits ? r.end === argv[2].length : argv[2] === '')) { fail(rec, 'Invalid master port'); return true; }
      return true;
    }
    if ((a0 === 'list-max-ziplist-entries' || a0 === 'list-max-ziplist-value') && n === 2) {
      rec.kind = 'deprecated'; rec.status = 'ignored'; rec.message = 'An old setting Redis 6.2 accepts and ignores.';
      return true;
    }
    if (a0 === 'cluster-config-file' && n === 2) { rec.name = 'cluster-config-file'; st.clusterConfigFile = argv[1]; return true; }
    if (a0 === 'client-output-buffer-limit' && n === 5) {
      rec.name = 'client-output-buffer-limit';
      const cls = classIndex(argv[1], v);
      if (cls === -1 || cls === 'master') { fail(rec, 'Unrecognized client limit class: the user specified an invalid one, or \'master\' which has no buffer limits.'); return true; }
      const secs = atoi(argv[4]);
      if (secs < 0n) { fail(rec, 'Negative number of seconds in soft limit is invalid'); return true; }
      val('client-output-buffer-limit').v[cls] = { hard: u64(memtoll(argv[2]).value), soft: u64(memtoll(argv[3]).value), secs: secs };
      return true;
    }
    if (a0 === 'oom-score-adj-values' && n === 4) {
      rec.name = 'oom-score-adj-values';
      const e = setSpecial(st, 'setConfigOOMScoreAdjValuesOption', 'oom-score-adj-values', argv.slice(1));
      if (e) fail(rec, e);
      return true;
    }
    if (a0 === 'notify-keyspace-events' && n === 2) {
      rec.name = 'notify-keyspace-events';
      const flags = notifyFlags(argv[1], v);
      if (flags === null) { fail(rec, v.notify.message); return true; }
      val('notify-keyspace-events').v = flags;
      return true;
    }
    rec.kind = null;
    return false;
  }

  // ---- reading CONFIG GET output ----

  // The output of CONFIG GET * from redis-cli or valkey-cli: with --raw, one
  // name or value a line, where an empty line is an empty value; or the
  // numbered kind, 1) "name" 2) "value". Returns a Map.
  function parseConfigGet(text) {
    const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
    const numbered = lines.some((l) => /^\s*\d+\)\s/.test(l));
    const items = [];
    if (numbered) {
      for (const raw of lines) {
        const m = /^\s*\d+\)\s?(.*)$/.exec(raw);
        if (!m) continue;
        let s = m[1];
        if (s === '(empty array)') continue;
        if (/^".*"$/.test(s)) s = unquote(s);
        items.push(s);
      }
    } else {
      // The last line break ends the output rather than starting an empty value.
      if (lines.length && lines[lines.length - 1] === '') lines.pop();
      while (lines.length && lines[0].trim() === '') lines.shift();
      items.push(...lines);
    }
    const out = new Map();
    for (let i = 0; i + 1 < items.length; i += 2) out.set(items[i], items[i + 1]);
    return out;
  }
  function unquote(s) {
    const r = splitArgs(toBinary(s));
    return r && r.length === 1 ? fromBinary(r[0]) : s.slice(1, -1);
  }

  // Compares CONFIG GET output with a version's defaults. Each row: name,
  // value (null when the output doesn't have it), default, changed, and
  // hidden for settings CONFIG GET * leaves out.
  // options.tls and options.compression as for check().
  function compareConfigGet(map, versionId, options) {
    const opt = options || {};
    const v = getVersion(versionId);
    const fresh = new State(v);
    const rows = [];
    const known = new Set();
    for (const c of v.defs) {
      if ((c.build === 'tls' && opt.tls === false) || (c.build === 'compression' && !opt.compression)) continue;
      known.add(c.name);
      if (c.alias) known.add(c.alias);
      const dflt = c.name === 'dir' ? null : getValue(fresh, c);
      const has = map.has(c.name);
      rows.push({ name: c.name, value: has ? map.get(c.name) : null, default: dflt, hidden: c.flags.includes('H'),
        changed: has && dflt !== null && map.get(c.name) !== fromBinary(dflt) && !envDependent(c.name) });
    }
    if (v.f.legacy) for (const name of Object.keys(v.legacy)) {
      known.add(name);
      const dflt = specialValue(fresh, name, fresh.vals.get(name).v);
      rows.push({ name: name, value: map.has(name) ? map.get(name) : null, default: dflt, hidden: false,
        changed: map.has(name) && map.get(name) !== fromBinary(dflt) && !envDependent(name) });
    }
    if (v.f.internalModules) for (const [name, , dflt] of v.f.internalModules.configs) {
      known.add(name);
      rows.push({ name: name, value: map.has(name) ? map.get(name) : null, default: dflt, hidden: false, changed: map.has(name) && map.get(name) !== dflt });
    }
    const unknown = [...map.keys()].filter((k) => !known.has(k));
    return { version: v.id, rows: rows, unknown: unknown };
  }
  // The version whose settings best match the names in CONFIG GET output.
  function guessVersion(map) {
    let best = null, bestScore = -Infinity;
    for (const { id } of versions()) {
      const v = getVersion(id);
      const names = new Set();
      for (const c of v.defs) {
        if (c.flags.includes('H')) continue;
        names.add(c.name);
        if (c.alias) names.add(c.alias);
      }
      if (v.f.legacy) for (const name of Object.keys(v.legacy)) names.add(name);
      if (v.f.internalModules) for (const [name] of v.f.internalModules.configs) names.add(name);
      let score = 0;
      for (const n of names) score += map.has(n) ? 1 : -1;
      for (const n of map.keys()) if (!names.has(n)) score -= 1;
      if (score >= bestScore) { best = id; bestScore = score; }
    }
    return best;
  }
  // Values that depend on where and how the server runs, not on the file.
  const envDependent = (name) => ['dir', 'pidfile', 'port', 'unixsocket', 'logfile'].includes(name);

  // ---- what deserves a second look ----

  const AFFIRM = (x) => x === 'yes';
  // Findings about a checked file, worst first: { level, code, title, text, names }.
  function advise(result) {
    const v = getVersion(result.version);
    const val = (n) => (result.values.has(n) ? fromBinary(result.values.get(n)) : null);
    const set = (n) => result.setBy.has(n);
    const out = [];
    const add = (level, code, title, text, names) => out.push({ level: level, code: code, title: title, text: text, names: names || [] });
    const users = result.lines.some((l) => l.kind === 'user');
    const pass = val('requirepass');
    const bind = val('bind') || '';
    const open = !bind || /(^|\s)(\*|0\.0\.0\.0|::\*?|-::\*)(\s|$)/.test(bind);
    if (val('protected-mode') === 'no' && !pass && !users) {
      add('bad', 'open', 'No password and protected mode off', open
        ? 'Anyone who can reach the port can read, change or delete every key and run any command. Set requirepass or ACL users, or bind to a private address.'
        : 'Anyone who can reach the addresses in bind can run any command. Set requirepass or ACL users.', ['protected-mode', 'requirepass', 'bind']);
    } else if (!pass && !users && open) {
      add('info', 'no-password', 'No password is set', 'Protected mode lets only local connections in while there is none. Remote clients need requirepass or ACL users.', ['requirepass']);
    }
    if (pass && pass.length < 16) add('warn', 'short-password', 'The password is short', 'A key-value store answers thousands of guesses a second. Use a long random password, or ACL users with their own.', ['requirepass']);
    for (const n of ['enable-debug-command', 'enable-module-command', 'enable-protected-configs']) {
      if (val(n) && val(n) !== 'no') add('warn', n, n + ' is ' + val(n), 'Clients can use ' + (n === 'enable-debug-command' ? 'DEBUG, which can crash or stall the server' : n === 'enable-module-command' ? 'MODULE LOAD, which runs native code inside the server' : 'CONFIG SET on dir and dbfilename, which can write files where the server can') + (val(n) === 'local' ? ', from local connections.' : '.'), [n]);
    }
    const aof = val('appendonly') === 'yes';
    const save = val('save');
    if (!aof && save === '') add('warn', 'no-persistence', 'Nothing is saved to disk', 'With save "" and appendonly no, a restart loses every key. That suits a cache and nothing else.', ['save', 'appendonly']);
    if (aof && val('appendfsync') === 'no') add('info', 'appendfsync-no', 'appendfsync is no', 'The operating system decides when the log reaches the disk, often every 30 seconds, so a crash can lose that much. everysec loses at most about a second.', ['appendfsync']);
    if (val('stop-writes-on-bgsave-error') === 'no' && save) add('info', 'bgsave-errors', 'Writes go on when saving fails', 'A full disk or a failed fork stops snapshots without stopping writes, so nobody finds out until a restart loses data.', ['stop-writes-on-bgsave-error']);
    const maxmemory = val('maxmemory');
    const policy = val('maxmemory-policy');
    if (maxmemory === '0') add('info', 'no-maxmemory', 'No memory limit', 'The server grows until the machine runs out of memory and the kernel stops it. Set maxmemory below the memory the server may use, leaving room for forks and buffers.', ['maxmemory']);
    else if (maxmemory && policy === 'noeviction') add('info', 'noeviction', 'At the memory limit, writes fail', 'With noeviction, commands that need more memory return an OOM error. For a cache, allkeys-lru or allkeys-lfu evict keys instead.', ['maxmemory-policy']);
    else if (maxmemory && policy && policy.startsWith('volatile')) add('info', 'volatile', 'Only keys with a TTL are evicted', policy + ' evicts only keys that have an expiry. If few do, writes still fail at the limit.', ['maxmemory-policy']);
    if (val('tcp-keepalive') === '0') add('info', 'keepalive', 'TCP keepalive is off', 'Dead clients and half-open connections are never noticed. The default is 300 seconds.', ['tcp-keepalive']);
    if (val('replica-read-only') === 'no' || val('slave-read-only') === 'no') add('warn', 'replica-writes', 'Replicas take writes', 'Writes to a replica stay on that replica and vanish at the next full sync.', ['replica-read-only']);
    const slow = val('slowlog-log-slower-than');
    if (slow === '0') add('info', 'slowlog-all', 'The slow log records every command', 'slowlog-log-slower-than 0 logs everything, which costs time on a busy server and pushes out the slow commands you want to see.', ['slowlog-log-slower-than']);
    if (slow && slow.startsWith('-')) add('info', 'slowlog-off', 'The slow log is off', 'A negative slowlog-log-slower-than turns it off.', ['slowlog-log-slower-than']);
    const io = Number(val('io-threads') || 1);
    if (io > 8) add('info', 'io-threads', 'Many I/O threads', io + ' I/O threads. More than about 8 rarely help, and they need as many free cores.', ['io-threads']);
    const hz = Number(val('hz') || 10);
    if (hz > 100) add('info', 'hz', 'hz is ' + hz, 'Background tasks run ' + hz + ' times a second, which costs CPU even when idle. The default is 10.', ['hz']);
    if (result.renamed.size) add('info', 'renamed', [...result.renamed.keys()].length + (result.renamed.size === 1 ? ' command is renamed or removed' : ' commands are renamed or removed'), 'rename-command hides commands from every client, and replicas and AOF files must use the same names. ACL users can deny commands per user instead.', []);
    // Old names, and lines that set the same thing again.
    for (const l of result.lines) {
      if (l.kind === 'config' && l.alias && l.status === 'ok') add('info', 'alias', fromBinary(l.argv[0]) + ' is an old name', 'Line ' + l.line + ' uses the old name for ' + l.name + '. Both work in ' + v.label + '.', [l.name]);
      if (l.kind === 'deprecated') add('info', 'deprecated', fromBinary(l.argv[0]) + ' does nothing', 'Line ' + l.line + ': ' + v.label + ' accepts this old setting and ignores it.', []);
    }
    for (const [name, list] of result.setBy) {
      if (list.length > 1 && !['save', 'client-output-buffer-limit'].includes(name)) add('info', 'repeated', name + ' is set ' + list.length + ' times', 'Lines ' + list.join(', ') + '. The last one wins.', [name]);
    }
    const rank = { bad: 0, warn: 1, info: 2 };
    return out.map((f, i) => [f, i]).sort((a, b) => rank[a[0].level] - rank[b[0].level] || a[1] - b[1]).map((x) => x[0]);
  }

  // The settings that differ from the defaults, as config file lines with
  // their current names. A good starting point for a short config file.
  function minimal(result) {
    const out = [];
    const first = (name) => (result.setBy.has(name) ? result.setBy.get(name)[0] : Infinity);
    for (const [name, value] of [...result.values].sort((a, b) => first(a[0]) - first(b[0]))) {
      if (envDependent(name) && !result.setBy.has(name)) continue;
      if (value === result.defaults.get(name) && !(name === 'dir' && result.setBy.has('dir'))) continue;
      if (!result.setBy.has(name) && !['databases', 'hz', 'io-threads'].includes(name)) continue;
      out.push(name + ' ' + quote(fromBinary(value)));
    }
    for (const l of result.lines) if (['include', 'rename-command', 'user', 'loadmodule'].includes(l.kind) && l.status !== 'error') out.push(fromBinary(l.text));
    return out;
  }
  // An argument as a config file needs it written.
  function quote(s) {
    if (s === '') return '""';
    if (!/[\s"'\\]/.test(s) && !/[^\x20-\x7e\u00a0-\uffff]/.test(s)) return s;
    return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"';
  }

  return {
    versions: versions, findVersion: findVersion, check: check, advise: advise, minimal: minimal, parseConfigGet: parseConfigGet,
    compareConfigGet: compareConfigGet, guessVersion: guessVersion, splitArgs: splitArgs, toBinary: toBinary, fromBinary: fromBinary, printable: printable,
    getVersion: getVersion, quote: quote
  };
});
