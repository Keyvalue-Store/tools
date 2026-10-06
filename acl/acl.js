// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// ACL Builder. Applies ACL rules the way each Redis and Valkey version does:
// ACL SETUSER with its exact errors, the line ACL LIST prints, user lines in
// a config file and an ACL file. Then checks whether a user may run a
// command, with the reply ACL DRYRUN gives and the NOPERM error the command
// would get, explains a user in plain words, and drafts least-privilege
// users from what a MONITOR capture shows clients doing. One file, no
// dependencies; servers.js holds the facts about each version. In a browser
// it defines KVAcl; in Node, require() returns the same functions.

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KVAcl = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---- the version data ----

  let DATA = null;
  function data() {
    if (DATA) return DATA;
    if (typeof globalThis !== 'undefined' && globalThis.KVAclServers) DATA = globalThis.KVAclServers;
    else if (typeof module === 'object' && typeof require === 'function') DATA = require('./servers.js');
    if (!DATA) throw new Error('servers.js is not loaded.');
    return DATA;
  }

  function versions() {
    return data().versions.map((v) => ({ id: v.id, server: v.server, version: v.version, label: v.label }));
  }
  // 'valkey 9.1', 'Redis 7.2.16', 'redis-8.10.2', '8' → the newest matching
  // version. A patch release it doesn't know gets the newest of the same
  // minor version.
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

  // Key spec flags, in the order COMMAND prints them.
  const KEY_FLAGS = ['RO', 'RW', 'OW', 'RM', 'access', 'update', 'insert', 'delete', 'not_key', 'incomplete', 'variable_flags'];
  const K = {};
  KEY_FLAGS.forEach((name, i) => { K[name] = 1 << i; });
  const keyFlagBits = (s) => s.split(' ').filter(Boolean).reduce((a, n) => a | (K[n] || 0), 0);
  const keyFlagNames = (bits) => KEY_FLAGS.filter((n) => bits & K[n]);

  // What changed between versions, as the code of each one does it.
  function features(server, num) {
    const R = server === 'redis', V = server === 'valkey';
    const is = (a, b) => num[0] === a && num[1] === b;
    const ge = (a, b) => num[0] > a || (num[0] === a && num[1] >= b);
    return {
      // 6: one set of permissions per user; 70: selectors, ACL LIST works the
      // rules out from the command bitmap; 72: the rules are kept as written.
      fam: R && is(6, 2) ? 6 : R && is(7, 0) ? 70 : 72,
      // skip-sanitize-payload and sanitize-payload are user flags (Valkey 8
      // still accepts them and ignores them).
      sanitize: !(V && ge(8, 0)),
      newUserSanitize: (R && ge(7, 2)) || (V && is(7, 2)),
      // Valkey 9.1: db=, alldbs and resetdbs.
      dbPerms: V && ge(9, 1),
      // How the text inside (...) splits into rules.
      split: V && ge(9, 0) ? 'parsearg-loose' : V && ge(8, 1) ? 'parsearg-strict' : 'classic',
      // Redis 7.0 takes %~pattern (no R or W) and crashes when it prints it.
      pct70: R && is(7, 0),
      merge70: R && is(7, 0),
      nesting: !(R && is(7, 0)),
      // How key specs count keys after a "numkeys" argument.
      keynum: R ? (is(7, 0) ? 'int' : ge(8, 4) ? 'step' : 'long') : (ge(9, 1) ? 'step-int' : 'int'),
      // SORT ... STORE skips the key after STORE when it looks for more options.
      sortSkip: R && !is(7, 0) && !is(8, 0),
      // GEORADIUS and XREAD report flags with their keys.
      georadiusFlags: !(R && (is(7, 0) || is(8, 0))) && !(V && is(7, 2)),
      xreadFlags: R && !is(7, 0) && !is(8, 0) && !is(6, 2),
      xreadOptions: R && ge(8, 10) ? ['block', 'count', 'maxcount', 'maxsize', 'claim'] : R && ge(8, 4) ? ['block', 'count', 'claim'] : ['block', 'count'],
      setKeys: R && ge(8, 4) ? 2 : 1,
      // Redis 8.8 and later skip ACL file lines that start with #.
      aclFileComments: R && ge(8, 8)
    };
  }

  const vcache = new Map();
  // A version, with its commands looked up by name.
  function getVersion(id) {
    if (vcache.has(id)) return vcache.get(id);
    const d = data();
    const raw = d.versions.find((x) => x.id === id);
    if (!raw) throw new Error('Unknown version ' + id + '.');
    const num = raw.version.split('.').map(Number);
    const v = {
      id: raw.id, server: raw.server, version: raw.version, label: raw.label, num: num,
      f: features(raw.server, num), cats: raw.categories, messages: raw.messages, userFlags: raw.userFlags,
      pubsubDefault: raw.pubsubDefault, newUserLine: raw.newUser, defaultUserLine: raw.defaultUser,
      cmds: [], top: new Map(), allDbs: new Set(raw.allDbs || []), dbidArgs: raw.dbidArgs || {}
    };
    const channelSpecs = new Map((raw.channels || []).map(([proc, flags, start, count]) => [proc, { flags: flags, start: start, count: count }]));
    const add = (i, parent) => {
      const [name, arity, flags, first, last, step, cats, specs, subs] = d.commands[i];
      const c = {
        id: v.cmds.length, name: parent ? name.slice(parent.name.length + 1) : name, fullname: name, parent: parent || null,
        arity: arity, flags: new Set(flags.split(' ').filter(Boolean)), first: first, last: last, step: step,
        cats: new Set(cats.split(' ').filter(Boolean)), subs: null,
        specs: specs.map(([f, bs, fk]) => ({ flags: keyFlagBits(f), bs: bs, fk: fk })),
        getkeys: raw.getkeys[name] || null
      };
      c.noAuth = c.flags.has('no_auth');
      c.channels = v.f.fam === 6 ? null : (channelSpecs.get(name) || null);
      // Module commands (Redis 8's vector sets) keep the case they were
      // registered with; lookups ignore case.
      c.module = c.flags.has('module');
      v.cmds.push(c);
      if (subs.length) {
        c.subs = new Map();
        for (const j of subs) { const s = add(j, c); c.subs.set(lower(s.name), s); }
      }
      return c;
    };
    for (const i of raw.commands) { const c = add(i, null); v.top.set(lower(c.name), c); }
    v.catIndex = new Map(v.cats.map((c, i) => [c, i]));
    // Each category's commands, subcommands included.
    v.members = v.cats.map((cat) => v.cmds.filter((c) => c.cats.has(cat)));
    vcache.set(id, v);
    return v;
  }

  // ---- bytes ----
  // Rules and command arguments are bytes. Text here is a "binary string",
  // one character per byte.

  const utf8 = new TextEncoder();
  const fromUtf8 = new TextDecoder('utf-8', { ignoreBOM: true });
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
  // A string written so redis-cli reads it back as the same bytes.
  function quote(s) {
    if (s.length && !/[\x00-\x20"'\\\x7f-\xff]/.test(s)) return s;
    let out = '"';
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (s[i] === '"' || s[i] === '\\') out += '\\' + s[i];
      else if (s[i] === '\n') out += '\\n';
      else if (s[i] === '\r') out += '\\r';
      else if (s[i] === '\t') out += '\\t';
      else if (c < 0x20 || c >= 0x7f) out += '\\x' + c.toString(16).padStart(2, '0');
      else out += s[i];
    }
    return out + '"';
  }

  // ---- C, as the servers' code uses it ----

  // The C string a function sees: up to the first NUL.
  const cstr = (s) => { const i = s.indexOf('\0'); return i < 0 ? s : s.slice(0, i); };
  const isspace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\v' || c === '\f' || c === '\r';
  const lower = (s) => (/[A-Z]/.test(s) ? s.replace(/[A-Z]+/g, (x) => x.toLowerCase()) : s);
  // strcasecmp() == 0
  const eqi = (a, b) => lower(cstr(a)) === lower(cstr(b));
  // A byte as C's signed char.
  const signedChar = (c) => { const x = c.charCodeAt(0); return x >= 128 ? x - 256 : x; };
  // ACLStringHasSpaces: a space of any kind or a NUL byte.
  function hasSpaces(s) {
    for (let i = 0; i < s.length; i++) if (isspace(s[i]) || s[i] === '\0') return true;
    return false;
  }
  // sdstrim: drops the characters in cset from both ends.
  function trimSet(s, cset) {
    let a = 0, b = s.length;
    while (a < b && cset.includes(s[a])) a++;
    while (b > a && cset.includes(s[b - 1])) b--;
    return s.slice(a, b);
  }
  // string2ll: strict; no sign but '-', no leading zeros, no spaces.
  function string2ll(s) {
    if (s.length === 0 || s.length >= 21) return null;
    if (s === '0') return 0n;
    let p = 0, neg = false;
    if (s[0] === '-') { neg = true; p = 1; if (s.length === 1) return null; }
    if (!(s[p] >= '1' && s[p] <= '9')) return null;
    let x = 0n;
    for (; p < s.length; p++) {
      if (!(s[p] >= '0' && s[p] <= '9')) return null;
      x = x * 10n + BigInt(s.charCodeAt(p) - 48);
      if (x > 18446744073709551615n) return null;
    }
    if (neg) return x > 9223372036854775808n ? null : -x;
    return x > 9223372036854775807n ? null : x;
  }
  // atoi(): leading blanks, a sign, digits; anything else ends it. As C's int.
  function atoi(s) {
    s = cstr(s);
    let i = 0;
    while (i < s.length && isspace(s[i])) i++;
    let neg = false;
    if (s[i] === '+' || s[i] === '-') { neg = s[i] === '-'; i++; }
    let v = 0n;
    for (; i < s.length && s[i] >= '0' && s[i] <= '9'; i++) {
      v = v * 10n + BigInt(s.charCodeAt(i) - 48);
      if (v > 9223372036854775808n) v = 9223372036854775808n;
    }
    if (neg) v = -v;
    if (v > 9223372036854775807n) v = 9223372036854775807n;
    // strtol clamps to the long range, then the int cast keeps the low 32 bits.
    v = ((v % 4294967296n) + 4294967296n) % 4294967296n;
    return Number(v >= 2147483648n ? v - 4294967296n : v);
  }

  // sdssplitargs, as each version has it: spaces separate arguments; "double
  // quotes" take \n \r \t \b \a \xHH and \<char>; 'single quotes' take \'.
  // The classic one wants a space or the end after a closing quote; Valkey
  // 8.1's parses each argument on its own, which drops 0xff bytes (they read
  // as -1, its "no character" mark), and from 9.0 a closing quote no longer
  // ends the argument. Returns null for unbalanced quotes.
  function splitArgs(line, kind) {
    line = cstr(line);
    const classic = !kind || kind === 'classic';
    if (!line.includes('"') && !line.includes('\'') && (classic || !line.includes('\xff'))) return splitPlain(line);
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
            ch = e === 'n' ? 10 : e === 'r' ? 13 : e === 't' ? 9 : e === 'b' ? 8 : e === 'a' ? 7 : (classic ? e.charCodeAt(0) : signedChar(e));
            p += 2;
          } else if (c === '"') {
            if (loose) inq = false;
            else { if (p + 1 < n && !isspace(line[p + 1])) return null; done = true; }
            p++;
          } else if (c === '') return null;
          else { ch = classic ? c.charCodeAt(0) : signedChar(c); p++; }
        } else if (insq) {
          if (c === '\\' && line[p + 1] === '\'') { ch = 39; p += 2; }
          else if (c === '\'') {
            if (loose) insq = false;
            else { if (p + 1 < n && !isspace(line[p + 1])) return null; done = true; }
            p++;
          } else if (c === '') return null;
          else { ch = classic ? c.charCodeAt(0) : signedChar(c); p++; }
        } else {
          if (c === '' || c === ' ' || c === '\n' || c === '\r' || c === '\t') done = true;
          else if (c === '"') inq = true;
          else if (c === '\'') insq = true;
          else ch = classic ? c.charCodeAt(0) : signedChar(c);
          if (c !== '') p++;
        }
        if (ch !== -1) cur += String.fromCharCode(ch & 0xff);
      }
      out.push(cur);
    }
  }
  // A line with no quotes splits the same way in every version: arguments end
  // at a space, tab, CR or LF; the blanks C's isspace knows (\v and \f too)
  // are skipped before each argument.
  function splitPlain(line) {
    const out = [];
    for (const t of line.split(/[ \n\r\t]+/)) {
      const u = t.replace(/^[\v\f]+/, '');
      if (u !== '') out.push(u);
    }
    return out;
  }

  // ---- SHA-256, for passwords ----

  const KS = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
  // The SHA-256 of a binary string, as 64 lowercase hex digits.
  function sha256hex(s) {
    const data = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) data[i] = s.charCodeAt(i) & 0xff;
    const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const w = new Uint32Array(64);
    const n = data.length;
    const total = Math.ceil((n + 9) / 64) * 64;
    const tail = new Uint8Array(total - Math.floor(n / 64) * 64);
    tail.set(data.subarray(Math.floor(n / 64) * 64));
    tail[n % 64] = 0x80;
    const bits = n * 8;
    const dv = new DataView(tail.buffer);
    dv.setUint32(tail.length - 8, Math.floor(bits / 4294967296));
    dv.setUint32(tail.length - 4, bits >>> 0);
    const block = (b, o) => {
      for (let i = 0; i < 16; i++) w[i] = (b[o + 4 * i] << 24) | (b[o + 4 * i + 1] << 16) | (b[o + 4 * i + 2] << 8) | b[o + 4 * i + 3];
      for (let i = 16; i < 64; i++) {
        const s0 = ((w[i - 15] >>> 7) | (w[i - 15] << 25)) ^ ((w[i - 15] >>> 18) | (w[i - 15] << 14)) ^ (w[i - 15] >>> 3);
        const s1 = ((w[i - 2] >>> 17) | (w[i - 2] << 15)) ^ ((w[i - 2] >>> 19) | (w[i - 2] << 13)) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      let a = h[0], bb = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
      for (let i = 0; i < 64; i++) {
        const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        const t1 = (hh + S1 + ((e & f) ^ (~e & g)) + KS[i] + w[i]) | 0;
        const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        const t2 = (S0 + ((a & bb) ^ (a & c) ^ (bb & c))) | 0;
        hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = bb; bb = a; a = (t1 + t2) | 0;
      }
      h[0] += a; h[1] += bb; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
    };
    const full = Math.floor(n / 64) * 64;
    for (let o = 0; o < full; o += 64) block(data, o);
    for (let o = 0; o < tail.length; o += 64) block(tail, o);
    let out = '';
    for (let i = 0; i < 8; i++) out += h[i].toString(16).padStart(8, '0');
    return out;
  }
  // A password hash ACL takes: 64 lowercase hex digits.
  const isHash = (s) => s.length === 64 && /^[0-9a-f]*$/.test(s);

  // ---- glob patterns, as stringmatchlen() matches them ----

  // Keys and channels against ACL patterns: case-sensitive, byte by byte.
  // The servers call stringmatchlen_impl() again for what follows each *.
  // This takes the same steps with a stack of its own, so a deep pattern
  // can't overflow JavaScript's. The servers give up (no match) past 1000
  // levels, except Redis 7.0: it has no limit, and past about 87,000
  // levels (with the usual 8 MB stack) it runs out of stack and crashes,
  // which throws a Crash here.
  const CRASH_DEPTH = 87000;
  function globMatch(pattern, string, nesting) {
    const p = pattern, s = string, n = p.length;
    const at = (i) => (i < n ? p[i] : '\0');
    let skip = false, result = false;
    // For each * that is trying the rest of the pattern: where it is, where
    // the string is, and how deep.
    const stack = [];
    let pi = 0, plen = n, si = 0, slen = s.length, depth = 0;
    next: for (;;) {
      // One call: it ends with a result, or starts the next call at a *.
      call: {
        if (nesting ? depth > 1000 : depth > CRASH_DEPTH) {
          if (!nesting) throw new Crash('a stack overflow while it matches a key or channel against a pattern with more than ' + CRASH_DEPTH + ' levels of *');
          result = false;
          break call;
        }
        while (plen && slen) {
          const c = at(pi);
          if (c === '*') {
            while (plen && at(pi + 1) === '*') { pi++; plen--; }
            if (plen === 1) { result = true; break call; }
            stack.push(pi, plen, si, slen, depth);
            pi++; plen--; depth++;
            continue next;
          } else if (c === '?') {
            si++; slen--;
          } else if (c === '[') {
            pi++; plen--;
            const not = at(pi) === '^';
            if (not) { pi++; plen--; }
            let match = false;
            for (;;) {
              if (at(pi) === '\\' && plen >= 2) {
                pi++; plen--;
                if (at(pi) === s[si]) match = true;
              } else if (at(pi) === ']') {
                break;
              } else if (plen === 0) {
                pi--; plen++;
                break;
              } else if (plen >= 3 && at(pi + 1) === '-') {
                let start = signedChar(at(pi)), end = signedChar(at(pi + 2));
                const ch = signedChar(s[si]);
                if (start > end) { const t = start; start = end; end = t; }
                pi += 2; plen -= 2;
                if (ch >= start && ch <= end) match = true;
              } else if (at(pi) === s[si]) {
                match = true;
              }
              pi++; plen--;
            }
            if (not) match = !match;
            if (!match) { result = false; break call; }
            si++; slen--;
          } else {
            if (c === '\\' && plen >= 2) { pi++; plen--; }
            if (at(pi) !== s[si]) { result = false; break call; }
            si++; slen--;
          }
          pi++; plen--;
          if (slen === 0) {
            while (at(pi) === '*') { pi++; plen--; }
            break;
          }
        }
        result = plen === 0 && slen === 0;
      }
      // Back at the * that started the call: a match ends it; otherwise it
      // tries one byte further on, until the string runs out or an earlier
      // try showed that no later one can match.
      while (stack.length) {
        const top = stack.length - 5;
        if (result || skip) { stack.length = top; continue; }
        stack[top + 2]++;
        stack[top + 3]--;
        if (stack[top + 3]) {
          pi = stack[top] + 1; plen = stack[top + 1] - 1; si = stack[top + 2]; slen = stack[top + 3]; depth = stack[top + 4] + 1;
          continue next;
        }
        skip = true;
        stack.length = top;
      }
      return result;
    }
  }
  // A pattern that matches this exact string and nothing else.
  const globEscape = (s) => s.replace(/[*?[\]\\]/g, (c) => '\\' + c);
  // The one string a pattern matches when it has no wildcard (*, ? or [;
  // a backslash only makes the byte after it plain), or null.
  function literalOf(p) {
    if (!/[*?[\\]/.test(p)) return p;
    let out = '';
    for (let i = 0; i < p.length; i++) {
      const c = p[i];
      if (c === '*' || c === '?' || c === '[') return null;
      if (c === '\\' && i + 1 < p.length) i++;
      out += p[i];
    }
    return out;
  }

  // ---- users ----
  // A user is flags, password hashes and a list of selectors; the first,
  // the root selector, holds the rules written outside parentheses. A
  // selector is a command bitmap (one entry per command and subcommand,
  // and the bit for commands a module adds later), first arguments allowed
  // on commands that are otherwise off, key patterns with read and write
  // permissions, channel patterns, the rules as written (7.2 and later) and,
  // in Valkey 9.1, the databases.

  const R_PERM = 1, W_PERM = 2;

  // Indexes of a selector's key patterns and channels, so that adding one
  // or checking a name doesn't read the whole list each time. Patterns
  // with no wildcard are found by the one name each matches; the others
  // stay in their order, with their place in the list. An index belongs to
  // one list: a list that's replaced or copied gets a new one.
  const INDEXES = new WeakMap();
  function patternIndex(list) {
    let ix = INDEXES.get(list);
    if (!ix || ix.n !== list.length) {
      ix = { n: 0, byPattern: new Map(), exact: new Map(), globs: [] };
      INDEXES.set(list, ix);
      for (const e of list) indexPattern(ix, e);
    }
    return ix;
  }
  // e: { p, f } for a key pattern, or a channel pattern's text.
  function indexPattern(ix, e) {
    const at = ix.n++;
    const p = typeof e === 'string' ? e : e.p;
    if (!ix.byPattern.has(p)) ix.byPattern.set(p, e);
    const lit = literalOf(p);
    if (lit === null) ix.globs.push({ e: e, p: p, at: at });
    else if (ix.exact.has(lit)) ix.exact.get(lit).push({ e: e, at: at });
    else ix.exact.set(lit, [{ e: e, at: at }]);
  }
  function addPattern(list, e) {
    const ix = patternIndex(list);
    list.push(e);
    indexPattern(ix, e);
  }

  // Everything about one check: the version and the server settings ACL
  // depends on (acl-pubsub-default and databases).
  function context(versionId, opts) {
    const v = typeof versionId === 'object' ? versionId : getVersion(versionId);
    opts = opts || {};
    const pubsub = opts.pubsubDefault || v.pubsubDefault;
    return { v: v, f: v.f, allChannels: pubsub === 'allchannels', databases: opts.databases == null ? 16 : opts.databases, noModules: !!opts.noModules };
  }

  function newSelector(ctx, isRoot) {
    return {
      root: !!isRoot, allkeys: false, allchannels: ctx.allChannels, allcommands: false, alldbs: ctx.f.dbPerms,
      bits: new Uint8Array(ctx.v.cmds.length), future: false, firstargs: null,
      patterns: [], channels: [], rules: '', dbs: []
    };
  }
  function copySelector(s) {
    const c = Object.assign({}, s);
    c.bits = s.bits.slice();
    c.firstargs = s.firstargs ? new Map([...s.firstargs].map(([k, l]) => [k, l.slice()])) : null;
    c.patterns = s.patterns.map((p) => ({ p: p.p, f: p.f }));
    c.channels = s.channels.slice();
    c.dbs = s.dbs.slice();
    return c;
  }
  function createUser(ctx, name) {
    return {
      name: name, enabled: false, disabled: true, nopass: false,
      sanitize: ctx.f.newUserSanitize, skipSanitize: false, passwords: [], selectors: [newSelector(ctx, true)]
    };
  }
  function copyUser(u, name) {
    const c = Object.assign({}, u);
    c.name = name === undefined ? u.name : name;
    c.passwords = u.passwords.slice();
    c.selectors = u.selectors.map(copySelector);
    return c;
  }
  // The default user as the server creates it.
  function defaultUser(versionId, opts) {
    const ctx = context(versionId, opts);
    const u = createUser(ctx, 'default');
    for (const op of ['+@all', '~*', '&*', 'on', 'nopass'].concat(ctx.f.dbPerms ? ['alldbs'] : [])) setUserOp(ctx, u, op, -1);
    return u;
  }
  // A user as ACL SETUSER creates it, before any rule.
  function newUser(versionId, name, opts) {
    return createUser(context(versionId, opts), name == null ? 'user' : name);
  }

  // ACLLookupCommand: a command, or "container|subcommand", by name, as the
  // ACL code finds them in the original command table.
  // noModules: while the server reads its config file, no module (Redis 8's
  // vector sets included) has added its commands yet.
  function lookupAcl(v, name, noModules) {
    name = cstr(name);
    if (v.f.fam === 6) return name.includes('|') ? null : (v.top.get(lower(name)) || null);
    if (name === '') return null;
    const parts = name.split('|');
    if (parts.length > 2) return null;
    const base = v.top.get(lower(parts[0]));
    if (noModules && base && base.module) return null;
    if (parts.length === 1) return base || null;
    if (!base || !base.subs) return null;
    return base.subs.get(lower(parts[1])) || null;
  }
  // A category, case-insensitive; -1 if there's no such category.
  function catIndex(v, name) {
    name = lower(cstr(name));
    for (let i = 0; i < v.cats.length; i++) if (v.cats[i] === name) return i;
    return -1;
  }

  function setBit(s, id, on) {
    s.bits[id] = on ? 1 : 0;
    if (!on) s.allcommands = false;
  }
  function resetFirstArgs(s, id) {
    if (s.firstargs) s.firstargs.delete(id);
  }
  // ACLChangeSelectorPerm: a command and, from 7.0, all its subcommands.
  function changePerm(s, cmd, on) {
    setBit(s, cmd.id, on);
    resetFirstArgs(s, cmd.id);
    if (cmd.subs) for (const sub of cmd.subs.values()) setBit(s, sub.id, on);
  }
  function setCategory(ctx, s, ci, on) {
    for (const cmd of ctx.v.members[ci]) {
      if (ctx.f.fam === 6) { setBit(s, cmd.id, on); resetFirstArgs(s, cmd.id); } else changePerm(s, cmd, on);
    }
  }
  function addFirstArg(s, id, sub) {
    if (!s.firstargs) s.firstargs = new Map();
    const list = s.firstargs.get(id) || [];
    if (list.some((x) => eqi(x, sub))) return;
    list.push(sub);
    s.firstargs.set(id, list);
  }
  // ACLSelectorRemoveCommandRule: drops earlier rules for the same command
  // (and, for a command, the rules for its subcommands and first arguments).
  function removeRule(rules, rule) {
    let s = rules, pos = 0;
    while (pos < s.length) {
      let copyPos = pos;
      const start = pos + 1;
      let end = s.indexOf(' ', start);
      if (end < 0) {
        end = s.length;
        if (copyPos !== 0) copyPos -= 1;
      }
      let copyEnd = end;
      if (s[copyEnd] === ' ') copyEnd++;
      const len = end - start;
      const n = Math.min(len, rule.length);
      if (s.substr(start, n) === rule.substr(0, n) && (len === rule.length || (len > rule.length && s[start + rule.length] === '|'))) {
        s = s.slice(0, copyPos) + s.slice(copyEnd);
        pos = copyPos;
        continue;
      }
      pos = copyEnd;
    }
    return s;
  }
  function updateRules(s, rule, on) {
    const r = lower(rule);
    s.rules = removeRule(s.rules, r);
    if (s.rules.length) s.rules += ' ';
    s.rules += (on ? '+' : '-') + r;
  }
  // Valkey 9.1's db=0,3,5
  function setDatabases(s, list) {
    s.alldbs = false;
    if (list === '' || list[0] === ',' || list[list.length - 1] === ',') return 'EINVAL';
    const dbs = new Set();
    for (const t of list.split(',')) {
      if (t === '') return 'EINVAL';
      // strtoll: leading blanks and a sign are fine; anything after the digits isn't.
      const m = /^[ \t\n\v\f\r]*([+-]?)([0-9]+)$/.exec(t);
      if (!m) return 'EINVAL';
      const n = BigInt(m[2]) * (m[1] === '-' ? -1n : 1n);
      if (n < 0n || n > 2147483647n) return 'ERANGE';
      dbs.add(Number(n));
    }
    s.dbs = [...dbs].sort((a, b) => a - b);
    return null;
  }

  // ACLSetSelector: one rule for a selector. Returns null, or the error
  // code the server sets. oplen Infinity is how ACL LIST replays the rules
  // it kept: with no length, so any key or channel pattern fails.
  function setSelector(ctx, s, op, oplen) {
    const v = ctx.v, f = ctx.f;
    const cs = cstr(op);
    const c0 = op.length ? op[0] : '\0', c1 = cs.length > 1 ? cs[1] : '\0';
    if (eqi(cs, 'allkeys') || eqi(cs, '~*')) { s.allkeys = true; s.patterns = []; }
    else if (eqi(cs, 'resetkeys')) { s.allkeys = false; s.patterns = []; }
    else if (eqi(cs, 'allchannels') || eqi(cs, '&*')) { s.allchannels = true; s.channels = []; }
    else if (eqi(cs, 'resetchannels')) { s.allchannels = false; s.channels = []; }
    else if (f.dbPerms && eqi(cs, 'alldbs')) { s.alldbs = true; s.dbs = []; }
    else if (f.dbPerms && eqi(cs, 'resetdbs')) { s.alldbs = false; s.dbs = []; }
    else if (f.dbPerms && lower(cs.slice(0, 3)) === 'db=') { const e = setDatabases(s, cs.slice(3)); if (e) return e; }
    else if (eqi(cs, 'allcommands') || eqi(cs, '+@all')) {
      s.bits.fill(1); s.future = true; s.allcommands = true; s.rules = ''; s.firstargs = null;
    } else if (eqi(cs, 'nocommands') || eqi(cs, '-@all')) {
      s.bits.fill(0); s.future = false; s.allcommands = false; s.rules = ''; s.firstargs = null;
    } else if (c0 === '~' || c0 === '%') {
      if (s.allkeys) return 'EEXIST';
      let flags = 0, offset = 1;
      if (c0 === '%') {
        let ok = true;
        for (; offset < oplen; offset++) {
          const ch = offset < op.length ? op[offset] : '\0';
          const up = ch === 'r' ? 'R' : ch === 'w' ? 'W' : ch;
          if (up === 'R' && !(flags & R_PERM)) flags |= R_PERM;
          else if (up === 'W' && !(flags & W_PERM)) flags |= W_PERM;
          else if (ch === '~') { offset++; break; }
          else { if (f.pct70) return 'EINVAL'; ok = false; break; }
        }
        if ((!flags && !f.pct70) || !ok) return 'EINVAL';
      } else flags = R_PERM | W_PERM;
      if (oplen === Infinity) return 'EINVAL';
      const pat = op.slice(offset, oplen);
      if (hasSpaces(pat)) return 'EINVAL';
      const have = patternIndex(s.patterns).byPattern.get(pat);
      if (have) have.f |= flags; else addPattern(s.patterns, { p: pat, f: flags });
      s.allkeys = false;
    } else if (c0 === '&') {
      if (s.allchannels) return 'EISDIR';
      if (oplen === Infinity) return 'EINVAL';
      const pat = op.slice(1, oplen);
      if (hasSpaces(pat)) return 'EINVAL';
      if (!patternIndex(s.channels).byPattern.has(pat)) addPattern(s.channels, pat);
      s.allchannels = false;
    } else if (c0 === '+' && c1 !== '@') {
      const name = cs.slice(1);
      const bar = name.lastIndexOf('|');
      if (bar < 0) {
        const cmd = lookupAcl(v, name, ctx.noModules);
        if (!cmd) return 'ENOENT';
        changePerm(s, cmd, true);
        if (f.fam === 72) updateRules(s, cmd.fullname, true);
      } else {
        const base = name.slice(0, bar), sub = name.slice(bar + 1);
        let cmd = lookupAcl(v, base, ctx.noModules);
        if (!cmd) return 'ENOENT';
        if (cmd.parent) return 'ECHILD';
        if (sub === '') return 'EINVAL';
        if (cmd.subs) {
          cmd = lookupAcl(v, name, ctx.noModules);
          if (!cmd) return 'ENOENT';
          changePerm(s, cmd, true);
        } else addFirstArg(s, cmd.id, sub);
        if (f.fam === 72) updateRules(s, name, true);
      }
    } else if (c0 === '-' && c1 !== '@') {
      const cmd = lookupAcl(v, cs.slice(1), ctx.noModules);
      if (!cmd) return 'ENOENT';
      changePerm(s, cmd, false);
      if (f.fam === 72) updateRules(s, cmd.fullname, false);
    } else if ((c0 === '+' || c0 === '-') && c1 === '@') {
      const ci = catIndex(v, cs.slice(2));
      if (ci < 0) return 'ENOENT';
      if (f.fam === 72) updateRules(s, cs.slice(1), c0 === '+');
      setCategory(ctx, s, ci, c0 === '+');
    } else return 'EINVAL';
    return null;
  }

  // Redis 6.2's ACLSetUser: one set of permissions, kept on the user.
  function setUserOp62(ctx, u, op, oplen) {
    if (oplen === -1) { op = cstr(op); oplen = op.length; }
    if (oplen === 0) return null;
    const v = ctx.v, s = u.selectors[0];
    const cs = cstr(op);
    const c0 = op[0], c1 = cs.length > 1 ? cs[1] : '\0';
    if (eqi(cs, 'on')) { u.enabled = true; u.disabled = false; }
    else if (eqi(cs, 'off')) { u.disabled = true; u.enabled = false; }
    else if (eqi(cs, 'skip-sanitize-payload')) { u.skipSanitize = true; u.sanitize = false; }
    else if (eqi(cs, 'sanitize-payload')) { u.skipSanitize = false; u.sanitize = true; }
    else if (eqi(cs, 'allkeys') || eqi(cs, '~*')) { s.allkeys = true; s.patterns = []; }
    else if (eqi(cs, 'resetkeys')) { s.allkeys = false; s.patterns = []; }
    else if (eqi(cs, 'allchannels') || eqi(cs, '&*')) { s.allchannels = true; s.channels = []; }
    else if (eqi(cs, 'resetchannels')) { s.allchannels = false; s.channels = []; }
    else if (eqi(cs, 'allcommands') || eqi(cs, '+@all')) { s.bits.fill(1); s.future = true; s.allcommands = true; s.firstargs = null; }
    else if (eqi(cs, 'nocommands') || eqi(cs, '-@all')) { s.bits.fill(0); s.future = false; s.allcommands = false; s.firstargs = null; }
    else if (eqi(cs, 'nopass')) { u.nopass = true; u.passwords = []; }
    else if (eqi(cs, 'resetpass')) { u.nopass = false; u.passwords = []; }
    else if (c0 === '>' || c0 === '#') return addPassword(u, op);
    else if (c0 === '<' || c0 === '!') return removePassword(u, op);
    else if (c0 === '~') {
      if (s.allkeys) return 'EEXIST';
      const pat = op.slice(1, oplen);
      if (hasSpaces(pat)) return 'EINVAL';
      if (!patternIndex(s.patterns).byPattern.has(pat)) addPattern(s.patterns, { p: pat, f: R_PERM | W_PERM });
      s.allkeys = false;
    } else if (c0 === '&') {
      if (s.allchannels) return 'EISDIR';
      const pat = op.slice(1, oplen);
      if (hasSpaces(pat)) return 'EINVAL';
      if (!patternIndex(s.channels).byPattern.has(pat)) addPattern(s.channels, pat);
      s.allchannels = false;
    } else if (c0 === '+' && c1 !== '@') {
      const name = cs.slice(1);
      const bar = name.indexOf('|');
      if (bar < 0) {
        const cmd = lookupAcl(v, name);
        if (!cmd) return 'ENOENT';
        setBit(s, cmd.id, true);
        resetFirstArgs(s, cmd.id);
      } else {
        const cmd = lookupAcl(v, name.slice(0, bar));
        if (!cmd) return 'ENOENT';
        const sub = name.slice(bar + 1);
        if (sub === '') return 'EINVAL';
        if (!s.bits[cmd.id]) addFirstArg(s, cmd.id, sub);
      }
    } else if (c0 === '-' && c1 !== '@') {
      const cmd = lookupAcl(v, cs.slice(1));
      if (!cmd) return 'ENOENT';
      setBit(s, cmd.id, false);
      resetFirstArgs(s, cmd.id);
    } else if ((c0 === '+' || c0 === '-') && c1 === '@') {
      const ci = catIndex(v, cs.slice(2));
      if (ci < 0) return 'ENOENT';
      setCategory(ctx, s, ci, c0 === '+');
    } else if (eqi(cs, 'reset')) {
      for (const r of ['resetpass', 'resetkeys', 'resetchannels'].concat(ctx.allChannels ? ['allchannels'] : [], ['off', 'sanitize-payload', '-@all'])) setUserOp62(ctx, u, r, -1);
    } else return 'EINVAL';
    return null;
  }
  function addPassword(u, op) {
    let p;
    if (op[0] === '>') p = sha256hex(op.slice(1));
    else {
      p = op.slice(1);
      if (!isHash(p)) return 'EBADMSG';
    }
    if (!u.passwords.includes(p)) u.passwords.push(p);
    u.nopass = false;
    return null;
  }
  function removePassword(u, op) {
    let p;
    if (op[0] === '<') p = sha256hex(op.slice(1));
    else {
      p = op.slice(1);
      if (!isHash(p)) return 'EBADMSG';
    }
    const i = u.passwords.indexOf(p);
    if (i < 0) return 'ENODEV';
    u.passwords.splice(i, 1);
    return null;
  }

  // ACLSetUser, 7.0 and later: a user flag or password, a selector in
  // parentheses, or a rule for the root selector.
  function setUserOp(ctx, u, op, oplen) {
    if (ctx.f.fam === 6) return setUserOp62(ctx, u, op, oplen);
    if (oplen === -1) { op = cstr(op); oplen = op.length; }
    if (oplen === 0) return null;
    const f = ctx.f;
    const cs = cstr(op);
    if (eqi(cs, 'on')) { u.enabled = true; u.disabled = false; }
    else if (eqi(cs, 'off')) { u.disabled = true; u.enabled = false; }
    else if (eqi(cs, 'skip-sanitize-payload')) { if (f.sanitize) { u.skipSanitize = true; u.sanitize = false; } }
    else if (eqi(cs, 'sanitize-payload')) { if (f.sanitize) { u.skipSanitize = false; u.sanitize = true; } }
    else if (eqi(cs, 'nopass')) { u.nopass = true; u.passwords = []; }
    else if (eqi(cs, 'resetpass')) { u.nopass = false; u.passwords = []; }
    else if (op[0] === '>' || op[0] === '#') return addPassword(u, op);
    else if (op[0] === '<' || op[0] === '!') return removePassword(u, op);
    else if (op[0] === '(' && op[oplen - 1] === ')') {
      const s = newSelector(ctx, false);
      const argv = splitArgs(op.slice(1, oplen - 1), f.split) || [];
      for (const a of argv) {
        const e = setSelector(ctx, s, a, a.length);
        if (e) return e;
      }
      u.selectors.push(s);
    } else if (eqi(cs, 'clearselectors')) {
      u.selectors = [u.selectors[0]];
    } else if (eqi(cs, 'reset')) {
      const steps = ['resetpass', 'resetkeys', 'resetchannels'].concat(ctx.allChannels ? ['allchannels'] : [], f.dbPerms ? ['alldbs'] : [], ['off'],
        f.sanitize ? ['sanitize-payload'] : [], ['clearselectors', '-@all']);
      for (const r of steps) setUserOp(ctx, u, r, -1);
    } else return setSelector(ctx, u.selectors[0], op, oplen);
    return null;
  }

  // The text the server gives for an error code (ACLSetUserStringError).
  function errorText(v, code) {
    return (code && v.messages[code]) || v.messages.default;
  }

  // ACLMergeSelectorArguments: "(+get" "~a)" becomes one rule "(+get ~a)".
  // Returns { args } or { open: index of the unmatched "(" argument, count }.
  function mergeSelectors(f, args) {
    const out = [];
    let open = -1, sel = null;
    for (let j = 0; j < args.length; j++) {
      const op = args[j];
      const first = op.length ? op[0] : '\0';
      // An empty string's last byte is the sds header in front of it: never ')'.
      const last = op.length ? op[op.length - 1] : '\x01';
      if ((open === -1 || f.merge70) && first === '(' && last !== ')') {
        sel = op;
        open = j;
        continue;
      }
      if (open !== -1) {
        sel += ' ' + cstr(op);
        if (last === ')') { open = -1; out.push(sel); }
        continue;
      }
      out.push(op);
    }
    if (open !== -1) return { open: open, count: out.length };
    return { args: out };
  }
  // The reply's text on one line: the server turns CR and LF into spaces.
  const oneLine = (s) => s.replace(/[\r\n]/g, ' ');

  // ACL SETUSER name rule ...: all the rules or none. user is the user as
  // it is now (null for a new one). Returns { ok: true, user } or
  // { ok: false, error } with the server's error text.
  function setUser(user, name, args, versionId, opts) {
    const ctx = context(versionId, opts);
    if (hasSpaces(name)) return { ok: false, error: 'Usernames can\'t contain spaces or null characters' };
    let rules = args;
    if (ctx.f.fam !== 6) {
      const m = mergeSelectors(ctx.f, args);
      if (!m.args) return { ok: false, error: oneLine('Unmatched parenthesis in acl selector starting at \'' + cstr(args[m.open]) + '\'.') };
      rules = m.args;
    }
    const u = user ? copyUser(user, name) : createUser(ctx, name);
    for (const r of rules) {
      const e = setUserOp(ctx, u, r, r.length);
      if (e) return { ok: false, error: oneLine('Error in ACL SETUSER modifier \'' + cstr(r) + '\': ' + errorText(ctx.v, e)), code: e, rule: r };
    }
    return { ok: true, user: u };
  }

  // ---- what ACL LIST prints ----

  // Throws this when the server would crash printing a user.
  function Crash(message) { this.crash = message; }

  function patternString(p) {
    if (p.f === (R_PERM | W_PERM)) return '~' + p.p;
    if (p.f === R_PERM) return '%R~' + p.p;
    if (p.f === W_PERM) return '%W~' + p.p;
    throw new Crash('Invalid key pattern flag detected');
  }
  function describeSelector(ctx, s) {
    let res = '';
    if (s.allkeys) res += '~* ';
    else for (const p of s.patterns) res += patternString(p) + ' ';
    if (s.allchannels) res += '&* ';
    else {
      res += 'resetchannels ';
      for (const c of s.channels) res += '&' + c + ' ';
    }
    if (ctx.f.dbPerms && !s.alldbs) res += s.dbs.length ? 'db=' + s.dbs.join(',') + ' ' : 'resetdbs ';
    return res + (ctx.f.fam === 72 ? describeRules(ctx, s) : describeBitmap(ctx, s));
  }
  // 7.2 and later: the rules as written, after +@all or -@all. The server
  // replays them on a blank selector and crashes if the result differs.
  function describeRules(ctx, s) {
    let rules = s.future ? '+@all ' : '-@all ';
    const fake = newSelector(ctx, false);
    setSelector(ctx, fake, s.future ? '+@all' : '-@all', Infinity);
    const argv = splitArgs(s.rules, ctx.f.split);
    if (argv === null) throw new Crash('argv != NULL');
    for (const a of argv) {
      if (setSelector(ctx, fake, a, Infinity)) throw new Crash('res == C_OK');
    }
    if (s.rules.length) rules += s.rules + ' ';
    rules = rules.slice(0, -1);
    if (fake.future !== s.future || !sameBits(fake.bits, s.bits)) throw new Crash('No bitmap match in ACLDescribeSelectorCommandRules()');
    return rules;
  }
  function sameBits(a, b) {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  // 6.2 and 7.0: worked out from the bitmap. Categories that fit best come
  // first, then single commands to make up the difference. The servers list
  // those in hash table order, which changes each time they start; here
  // they're in alphabetical order.
  function describeBitmap(ctx, s) {
    const v = ctx.v, fam = ctx.f.fam;
    const additive = !s.future;
    let rules = additive ? '-@all ' : '+@all ';
    const fake = newSelector(ctx, false);
    fake.bits.fill(additive ? 0 : 1);
    const temp = newSelector(ctx, false);
    temp.bits = s.bits.slice();
    const applied = new Array(v.cats.length).fill(false);
    for (;;) {
      let best = -1, mindiff = 2147483647, maxsame = 0;
      for (let j = 0; j < v.cats.length; j++) {
        if (applied[j]) continue;
        let on = 0, off = 0;
        for (const cmd of v.members[j]) if (temp.bits[cmd.id]) on++; else off++;
        const diff = additive ? off : on, same = additive ? on : off;
        if (same > diff && (diff < mindiff || (diff === mindiff && same > maxsame))) { best = j; mindiff = diff; maxsame = same; }
      }
      if (best === -1) break;
      setCategory(ctx, fake, best, additive);
      setCategory(ctx, temp, best, !additive);
      rules += (additive ? '+@' : '-@') + v.cats[best] + ' ';
      applied[best] = true;
    }
    const byName = (a, b) => (a.fullname < b.fullname ? -1 : a.fullname > b.fullname ? 1 : 0);
    const single = (cmd) => {
      const ub = s.bits[cmd.id], fb = fake.bits[cmd.id];
      if (ub !== fb) {
        rules += (ub ? '+' : '-') + cmd.fullname + ' ';
        if (fam === 6) fake.bits[cmd.id] = ub; else changePerm(fake, cmd, ub === 1);
      }
      if (cmd.subs) for (const sub of [...cmd.subs.values()].sort(byName)) single(sub);
      if (!ub && s.firstargs && s.firstargs.has(cmd.id)) for (const a of s.firstargs.get(cmd.id)) rules += '+' + cmd.fullname + '|' + a + ' ';
    };
    for (const cmd of [...v.top.values()].sort(byName)) single(cmd);
    rules = rules.slice(0, -1);
    if (!sameBits(fake.bits, s.bits)) throw new Crash('No bitmap match in ACLDescribeUserCommandRules()');
    return rules;
  }
  // The rules ACL LIST prints after the user's name. Throws Crash.
  function describeUserRaw(ctx, u) {
    const f = ctx.f;
    let res = '';
    if (u.enabled) res += 'on ';
    if (u.disabled) res += 'off ';
    if (u.nopass) res += 'nopass ';
    if (f.sanitize && u.skipSanitize) res += 'skip-sanitize-payload ';
    if (f.sanitize && u.sanitize) res += 'sanitize-payload ';
    for (const p of u.passwords) res += '#' + p + ' ';
    u.selectors.forEach((s, i) => {
      const d = describeSelector(ctx, s);
      res += i === 0 ? d : ' (' + d + ')';
    });
    return res;
  }
  // ACL LIST's line for a user: { line } or { crash } when listing it
  // brings the server down.
  function listLine(user, versionId, opts) {
    const ctx = context(versionId, opts);
    try {
      return { line: 'user ' + user.name + ' ' + describeUserRaw(ctx, user) };
    } catch (e) {
      if (e instanceof Crash) return { crash: e.crash };
      throw e;
    }
  }

  // ---- users in a config file and in an ACL file ----

  // A user line in redis.conf, as the server checks it while reading the
  // file: null, or the error it stops with. Unknown commands and categories
  // pass here (a module may add them later); startupUsers() catches them.
  // From 7.0 the server names the wrong argument by its place among the
  // rules but looks it up in the whole line, so it names an earlier word.
  // opts.state, an object kept from line to line of one file, carries the
  // error code the last tolerated failure left behind.
  function checkUserLine(argv, versionId, opts) {
    opts = opts || {};
    const ctx = context(versionId, Object.assign({}, opts, { noModules: true }));
    const f = ctx.f;
    const state = opts.state || {};
    const fail = (arg, code) => ('Error in user declaration \'' + cstr(arg) + '\': ' + errorText(ctx.v, code)).slice(0, 1023);
    const u = createUser(ctx, '__fakeuser:0__');
    const rules = f.fam === 6 ? argv.slice(2) : null;
    if (f.fam === 6) {
      for (let j = 2; j < argv.length; j++) {
        const e = setUserOp(ctx, u, argv[j], argv[j].length);
        if (e === 'ENOENT') state.errno = e;
        else if (e) return fail(argv[j], e);
      }
      return null;
    }
    void rules;
    const m = mergeSelectors(f, argv.slice(2));
    // Nothing sets the error code on this path; the server prints whatever
    // the last failed call left in it.
    if (!m.args) return fail(argv[m.open], state.errno || null);
    for (let j = 0; j < m.args.length; j++) {
      const e = setUserOp(ctx, u, m.args[j], m.args[j].length);
      if (e === 'ENOENT') state.errno = e;
      else if (e) return fail(argv[j], e);
    }
    return null;
  }

  // The users of a config file's user lines (those that passed
  // checkUserLine), created when the server starts. Returns { users } or
  // { log, message } with what the server logs before it exits.
  function startupUsers(lines, versionId, opts) {
    const ctx = context(versionId, opts);
    const users = new Map([['default', defaultUser(ctx.v.id, opts)]]);
    const stop = (lines) => ({ log: lines.concat('Critical error while loading ACLs. Exiting.').map((l) => l.slice(0, 1023)), message: lines[0] });
    for (const argv of lines) {
      const name = argv[1];
      if (hasSpaces(name)) return stop(['Spaces not allowed in ACL usernames']);
      let rules = argv.slice(2);
      if (ctx.f.fam !== 6) rules = mergeSelectors(ctx.f, rules).args || [];
      let u = users.get(name);
      if (u) setUserOp(ctx, u, 'reset', -1);
      else { u = createUser(ctx, name); users.set(name, u); }
      for (const r of rules) {
        const e = setUserOp(ctx, u, r, r.length);
        if (e) return stop(['Error loading ACL rule \'' + cstr(r) + '\' for the user named \'' + cstr(name) + '\': ' + errorText(ctx.v, e)]);
      }
    }
    return { users: users };
  }

  // A file as the server reads it: fgets() a piece at a time (up to a line,
  // and at most 1023 bytes for an ACL file, 1024 for a config file), each
  // piece appended as a C string, so a NUL byte drops the rest of its piece.
  function readFile(s, size) {
    if (!s.includes('\0')) return s;
    let out = '';
    // The next newline at or after p; s.length when there's none.
    let nl = -1;
    for (let p = 0; p < s.length;) {
      if (nl < p) { nl = s.indexOf('\n', p); if (nl < 0) nl = s.length; }
      const end = Math.min(p + size, nl < s.length ? nl + 1 : s.length);
      const piece = s.slice(p, end);
      const nul = piece.indexOf('\0');
      out += nul < 0 ? piece : piece.slice(0, nul);
      p = end;
    }
    return out;
  }

  // ACL LOAD: an ACL file, all of it or nothing. text: the file's bytes, or
  // a binary string. Returns { ok: true, users, declared } (a Map by name,
  // the default user included, and the names the file's lines declare, in
  // their order), or { ok: false, error, where } with the error
  // ACL LOAD replies and the lines it names ([{ line, text }]), or { crash }
  // where the server crashes. opts.filename is the aclfile setting as the
  // server has it.
  function loadFile(text, versionId, opts) {
    const ctx = context(versionId, opts);
    const v = ctx.v, f = ctx.f;
    const fname = cstr((opts && opts.filename) || 'users.acl');
    const acls = readFile(typeof text === 'string' ? text : toBinary(text), 1023);
    const lines = acls === '' ? [] : acls.split('\n');
    const users = new Map();
    let errors = '';
    const where = [], declared = [], declaring = new Set();
    const named = (linenum, line) => { if (!where.length || where[where.length - 1].line !== linenum) where.push({ line: linenum, text: line }); };
    if (f.fam === 6) {
      users.set('default', defaultUser(v.id, opts));
      const fake = createUser(ctx, '__fakeuser:0__');
      lines.forEach((raw, i) => {
        const line = trimSet(raw, ' \t\r\n');
        if (line === '') return;
        const argv = line.split(' ');
        const linenum = i + 1;
        if (argv[0] !== 'user' || argv.length < 2) { errors += fname + ':' + linenum + ' should start with user keyword followed by the username. '; named(linenum, line); return; }
        if (hasSpaces(argv[1])) { errors += '\'' + fname + ':' + linenum + ': username \'' + cstr(argv[1]) + '\' contains invalid characters. '; named(linenum, line); return; }
        setUserOp(ctx, fake, 'reset', -1);
        const rules = argv.slice(2).map((a) => trimSet(a, '\t\r\n'));
        for (const r of rules) {
          const e = setUserOp(ctx, fake, r, r.length);
          if (e) { errors += fname + ':' + linenum + ': ' + errorText(v, e) + '. '; named(linenum, line); }
        }
        if (errors !== '') return;
        if (!declaring.has(argv[1])) { declaring.add(argv[1]); declared.push(argv[1]); }
        let u = users.get(argv[1]);
        if (u) setUserOp(ctx, u, 'reset', -1);
        else { u = createUser(ctx, argv[1]); users.set(argv[1], u); }
        for (const r of rules) setUserOp(ctx, u, r, r.length);
      });
    } else {
      for (let i = 0; i < lines.length; i++) {
        const line = trimSet(lines[i], ' \t\r\n');
        if (line === '' || (f.aclFileComments && line[0] === '#')) continue;
        const argv = line.split(' ');
        const linenum = i + 1;
        if (argv[0] !== 'user' || argv.length < 2) { errors += fname + ':' + linenum + ' should start with user keyword followed by the username. '; named(linenum, line); continue; }
        if (hasSpaces(argv[1])) { errors += '\'' + fname + ':' + linenum + ': username \'' + cstr(argv[1]) + '\' contains invalid characters. '; named(linenum, line); continue; }
        if (users.has(argv[1])) { errors += 'WARNING: Duplicate user \'' + cstr(argv[1]) + '\' found on line ' + linenum + '. '; named(linenum, line); continue; }
        const u = createUser(ctx, argv[1]);
        users.set(argv[1], u);
        declared.push(argv[1]);
        const m = mergeSelectors(f, argv.slice(2));
        if (!m.args) {
          errors += fname + ':' + linenum + ': Unmatched parenthesis in selector definition.';
          named(linenum, line);
          // The rules before the "(" were counted but the list is gone.
          if (m.count) return { crash: 'unmatched parenthesis after other rules (a NULL pointer)' };
          continue;
        }
        let syntax = false;
        for (let r of m.args) {
          r = trimSet(r, '\t\r\n');
          const e = setUserOp(ctx, u, r, r.length);
          if (!e) continue;
          if (e === 'ENOENT') { errors += fname + ':' + linenum + ': Error in applying operation \'' + cstr(r) + '\': ' + errorText(v, e) + '. '; named(linenum, line); }
          else if (!syntax) { errors += fname + ':' + linenum + ': ' + errorText(v, e) + '. '; syntax = true; named(linenum, line); }
        }
      }
      if (errors === '' && !users.has('default')) users.set('default', defaultUser(v.id, opts));
    }
    if (errors !== '') return { ok: false, error: errors + 'WARNING: ACL errors detected, no change to the previously active ACL rules was performed', where: where };
    return { ok: true, users: users, declared: declared };
  }

  // The ACL part of a config file, read the way the server reads the file:
  // line by line, user lines checked as it reads them, acl-pubsub-default
  // counting from the line that sets it, aclfile noted, then the users
  // created when it starts. A line the server can't split (unbalanced
  // quotes) stops it wherever it is; other settings aren't checked here
  // (the Config Checker does that). text: the file's bytes, or a binary
  // string. opts: pubsubDefault (before the file sets it), databases.
  // Returns {
  //   users: one per user the lines declare, in their order,
  //   all: every user once it has started (a Map by name, default included),
  //   lines: the user lines [{ line, argv }], pubsubDefault, aclfile,
  //   fatal: { line, text, message }: where the server stops reading the file,
  //   startup: { log, message }: what it logs when it stops while starting
  // } with fatal and startup null when it starts.
  function loadConfig(text, versionId, opts) {
    opts = opts || {};
    const v = getVersion(versionId), f = v.f;
    const conf = readFile(typeof text === 'string' ? text : toBinary(text), 1024);
    let pubsub = opts.pubsubDefault || v.pubsubDefault, aclfile = null;
    const lines = [], seen = new Set(), state = {};
    const result = (more) => Object.assign({ users: [], all: null, lines: lines, pubsubDefault: pubsub, aclfile: aclfile, fatal: null, startup: null }, more);
    const raw = conf.split('\n');
    for (let i = 0; i < raw.length; i++) {
      const line = trimSet(raw[i], ' \t\r\n');
      if (line === '' || line[0] === '#') continue;
      const stop = (message) => result({ fatal: { line: i + 1, text: line, message: message } });
      const argv = splitArgs(line, f.split);
      if (argv === null) return stop('Unbalanced quotes in configuration line');
      if (!argv.length) continue;
      const name = lower(argv[0]);
      if (name === 'acl-pubsub-default') {
        if (argv.length !== 2) return stop('wrong number of arguments');
        const val = ['allchannels', 'resetchannels'].find((x) => eqi(argv[1], x));
        if (!val) return stop((f.fam === 6 ? 'argument must' : 'argument(s) must') + ' be one of the following: allchannels, resetchannels');
        pubsub = val;
      } else if (name === 'aclfile') {
        if (argv.length !== 2) return stop('wrong number of arguments');
        aclfile = argv[1];
      } else if (cstr(name) === 'user') {
        if (argv.length < 2) return stop('Bad directive or wrong number of arguments');
        // 7.0 and later take one line per user.
        if (f.fam !== 6 && seen.has(argv[1])) return stop('Error in user declaration \'' + cstr(argv[1]) + '\': ' + errorText(v, 'EALREADY'));
        const e = checkUserLine(argv, v.id, Object.assign({}, opts, { pubsubDefault: pubsub, state: state }));
        if (e) return stop(e);
        seen.add(argv[1]);
        lines.push({ line: i + 1, argv: argv });
      } else if ((name === '' || /[^\x21-\x7e]/.test(name)) && (f.fam === 6 || !name.includes('.'))) {
        // No setting has a name like this one, such as a byte order mark
        // in front of "user".
        return stop('Bad directive or wrong number of arguments');
      }
    }
    if (lines.length && aclfile !== null && cstr(aclfile) !== '') {
      const [title, file] = v.server === 'valkey' && v.num[0] >= 8 ? ['Valkey', 'valkey.conf'] : ['Redis', 'redis.conf'];
      const message = 'Configuring ' + title + ' with users defined in ' + file + ' and at the same setting an ACL file path is invalid. This setup is very likely to lead to configuration errors and security holes, please define either an ACL file or declare users directly in your ' + file + ', but not both.';
      return result({ startup: { log: [message], message: message } });
    }
    const r = startupUsers(lines.map((l) => l.argv), v.id, Object.assign({}, opts, { pubsubDefault: pubsub }));
    if (r.log) return result({ startup: { log: r.log, message: r.message } });
    const users = [], names = new Set();
    for (const l of lines) if (!names.has(l.argv[1])) { names.add(l.argv[1]); users.push(r.users.get(l.argv[1])); }
    return result({ users: users, all: r.users });
  }


  // ---- commands, keys and channels ----

  // lookupCommand: the command argv[0] names and, for a container command,
  // its subcommand argv[1]. Case doesn't matter.
  function lookupCommand(v, argv) {
    const base = v.top.get(lower(argv[0]));
    if (!base) return null;
    if (argv.length === 1 || !base.subs) return base;
    return base.subs.get(lower(argv[1])) || null;
  }
  const arityOk = (cmd, argc) => !((cmd.arity > 0 && cmd.arity !== argc) || argc < -cmd.arity);

  // Key spec flags that ask for the read or the write permission.
  function aclKeyFlags(flags) {
    let f = 0;
    if (flags & K.access) f |= R_PERM;
    if (flags & (K.insert | K.delete | K.update)) f |= W_PERM;
    return f;
  }

  // genericGetKeys: [destkey] numkeys key ... as atoi() reads numkeys.
  function genericKeys(store, countAt, firstAt, step, argv) {
    const argc = argv.length;
    if (countAt >= argc) return [];
    const num = atoi(argv[countAt]);
    if (num < 1 || num > Math.trunc((argc - firstAt) / step)) return [];
    const out = [];
    for (let i = 0; i < num; i++) out.push({ pos: firstAt + i * step, flags: 0 });
    if (store) out.push({ pos: store, flags: 0 });
    return out;
  }

  // A command's own function for finding its keys.
  function keyFunction(ctx, cmd, argv) {
    const f = ctx.f, argc = argv.length;
    const fl = (x) => (f.fam === 6 ? 0 : x);
    switch (cmd.getkeys) {
      case 'zunionInterDiffStoreGetKeys': return genericKeys(1, 2, 3, 1, argv);
      case 'zunionInterDiffGetKeys': case 'lmpopGetKeys': case 'zmpopGetKeys': case 'sintercardGetKeys':
      case 'sdiffcardGetKeys': case 'sunioncardGetKeys': return genericKeys(0, 1, 2, 1, argv);
      case 'evalGetKeys': case 'functionGetKeys': case 'blmpopGetKeys': case 'bzmpopGetKeys': return genericKeys(0, 2, 3, 1, argv);
      case 'sortROGetKeys': return [{ pos: 1, flags: K.RO | K.access }];
      case 'sortGetKeys': {
        const out = [{ pos: 1, flags: fl(K.RO | K.access) }];
        const skip = [['limit', 2], ['get', 1], ['by', 1]];
        for (let i = 2; i < argc; i++) {
          for (const [name, n] of skip) {
            if (eqi(argv[i], name)) { i += n; break; }
            if (eqi(argv[i], 'store') && i + 1 < argc) {
              out[1] = { pos: i + 1, flags: fl(K.OW | K.update) };
              if (f.sortSkip) i++;
              break;
            }
          }
        }
        return out;
      }
      case 'migrateGetKeys': {
        let first = 3, num = 1;
        if (argc > 6) {
          for (let i = 6; i < argc; i++) {
            if (f.fam === 6) {
              if (eqi(argv[i], 'keys') && argv[3].length === 0) { first = i + 1; num = argc - first; break; }
              continue;
            }
            if (eqi(argv[i], 'keys')) {
              if (argv[3].length > 0) num = 0;
              else { first = i + 1; num = argc - first; }
              break;
            }
            for (const [name, n] of [['copy', 0], ['replace', 0], ['auth', 1], ['auth2', 2]]) {
              if (eqi(argv[i], name)) { i += n; break; }
            }
          }
        }
        const out = [];
        for (let i = 0; i < num; i++) out.push({ pos: first + i, flags: fl(K.RW | K.access | K.delete) });
        return out;
      }
      case 'georadiusGetKeys': {
        let stored = -1;
        for (let i = 5; i < argc; i++) {
          if ((eqi(argv[i], 'store') || eqi(argv[i], 'storedist')) && i + 1 < argc) { stored = i + 1; i++; }
        }
        const g = f.georadiusFlags;
        const out = [{ pos: 1, flags: g ? K.RO | K.access : 0 }];
        if (stored >= 0) out.push({ pos: stored, flags: g ? K.OW | K.update : 0 });
        return out;
      }
      case 'xreadGetKeys': {
        let streams = -1;
        for (let i = 1; i < argc; i++) {
          const a = argv[i];
          if (f.xreadOptions.some((o) => eqi(a, o))) i++;
          else if (eqi(a, 'group')) i += 2;
          else if (eqi(a, 'noack')) { /* nothing */ }
          else if (eqi(a, 'streams')) { streams = i; break; }
          else break;
        }
        let num = streams !== -1 ? argc - streams - 1 : 0;
        if (streams === -1 || num === 0 || num % 2 !== 0) return [];
        num /= 2;
        const out = [];
        for (let i = streams + 1; i < argc - num; i++) out.push({ pos: i, flags: f.xreadFlags ? K.RO | K.access : 0 });
        return out;
      }
      case 'setGetKeys': {
        if (f.setKeys === 1) {
          for (let i = 3; i < argc; i++) if (eqi(argv[i], 'get')) return [{ pos: 1, flags: K.RW | K.access | K.update }];
          return [{ pos: 1, flags: K.OW | K.update }];
        }
        let actual = K.OW, logical = K.update;
        for (let i = 3; i < argc; i++) {
          if (eqi(argv[i], 'get')) { actual = K.RW; logical |= K.access; }
          else if (['ifeq', 'ifne', 'ifdeq', 'ifdne'].some((o) => eqi(argv[i], o))) actual = K.RW;
        }
        return [{ pos: 1, flags: actual | logical }];
      }
      case 'bitfieldGetKeys': {
        let readonly = true;
        for (let i = 2; i < argc; i++) {
          const rem = argc - i - 1;
          if (eqi(argv[i], 'get') && rem >= 2) i += 2;
          else if ((eqi(argv[i], 'set') || eqi(argv[i], 'incrby')) && rem >= 3) { readonly = false; i += 3; break; }
          else if (eqi(argv[i], 'overflow') && rem >= 1) i += 1;
          else { readonly = false; break; }
        }
        return [{ pos: 1, flags: readonly ? K.RO | K.access : K.RW | K.access | K.update }];
      }
      case 'delexGetKeys': {
        let actual = K.RM;
        for (let i = 2; i < argc; i++) if (['ifeq', 'ifne', 'ifdeq', 'ifdne'].some((o) => eqi(argv[i], o))) actual = K.RW;
        return [{ pos: 1, flags: actual | K.delete }];
      }
      case 'pfmergeGetKeys': {
        const out = [{ pos: 1, flags: K.RW | K.access | K.insert }];
        for (let i = 2; i < argc; i++) out.push({ pos: i, flags: K.RO | K.access });
        return out;
      }
      case 'lcsGetKeys':
        for (let i = 1; i < argc; i++) {
          if (eqi(argv[i], 'strings')) break;
          if (eqi(argv[i], 'keys') && argc - 1 - i >= 2) return [{ pos: i + 1, flags: 0 }, { pos: i + 2, flags: 0 }];
        }
        return [];
      case 'memoryGetKeys':
        return argc >= 3 && eqi(argv[1], 'usage') ? [{ pos: 2, flags: 0 }] : [];
      default:
        return [];
    }
  }

  // getKeysUsingKeySpecs: the keys COMMAND's key specs find, or null when a
  // spec can't say (the command's own function takes over).
  function keysFromSpecs(ctx, cmd, argv) {
    const f = ctx.f, argc = argv.length;
    const out = [];
    for (const spec of cmd.specs) {
      if (spec.flags & K.not_key) continue;
      let first = 0, last, step;
      const bs = spec.bs, fk = spec.fk;
      if (bs[0] === 'index') first = bs[1];
      else if (bs[0] === 'keyword') {
        const from = bs[2];
        const start = from > 0 ? from : argc + from;
        const end = from > 0 ? argc - 1 : 1;
        for (let i = start; i !== end; i = start <= end ? i + 1 : i - 1) {
          if (i >= argc || i < 1) break;
          if (eqi(argv[i], bs[1])) { first = i + 1; break; }
        }
        if (!first) continue;
      } else return null;
      if (fk[0] === 'range') {
        const [, lastkey, keystep, limit] = fk;
        step = keystep;
        if (lastkey >= 0) last = first + lastkey;
        else if (!limit) last = argc + lastkey;
        else last = first + (Math.trunc((argc - first) / limit) + lastkey);
      } else if (fk[0] === 'keynum') {
        const [, keynumidx, firstkey, keystep] = fk;
        step = keystep;
        const at = first + keynumidx;
        if (f.keynum === 'int') { if (keynumidx >= argc || at >= argc) return null; }
        else if (at >= argc || at < 0) return null;
        const n = string2ll(argv[at]);
        if (n === null || n < 0n) return null;
        first += firstkey;
        if (f.keynum === 'int') {
          let x = Number(BigInt.asIntN(32, n));
          last = first + x - 1;
        } else if (f.keynum === 'long') last = Number(BigInt(first) + n - 1n);
        else {
          const t = BigInt(first) + (n - 1n) * BigInt(step);
          if (f.keynum === 'step-int' && (t > 2147483647n || t < -2147483648n)) return null;
          last = Number(t);
        }
      } else return null;
      if (last >= argc || last < first || first >= argc) return null;
      for (let i = first; i <= last; i += step) out.push({ pos: i, flags: spec.flags });
      if (spec.flags & K.incomplete) return null;
    }
    return out;
  }

  // The keys a command line names, with their flags, as the ACL check and
  // COMMAND GETKEYSANDFLAGS find them.
  function keysOf(ctx, cmd, argv) {
    if (ctx.f.fam === 6) {
      if (cmd.getkeys) return keyFunction(ctx, cmd, argv);
      if (!cmd.first) return [];
      const last = cmd.last < 0 ? argv.length + cmd.last : cmd.last;
      const out = [];
      for (let j = cmd.first; j <= last; j += cmd.step) {
        if (j >= argv.length) return [];
        out.push({ pos: j, flags: 0 });
      }
      return out;
    }
    const keyspec = cmd.specs.some((s) => !(s.flags & K.not_key));
    const varflags = cmd.specs.some((s) => s.flags & K.variable_flags);
    if (keyspec && !varflags) {
      const r = keysFromSpecs(ctx, cmd, argv);
      if (r) return r;
    }
    return cmd.getkeys ? keyFunction(ctx, cmd, argv) : [];
  }
  function hasKeys(ctx, cmd) {
    if (ctx.f.fam === 6) return !!(cmd.getkeys || cmd.first);
    return !!cmd.getkeys || cmd.specs.some((s) => !(s.flags & K.not_key));
  }
  // The Pub/Sub channels a command line names: [{ pos, pattern, kind }].
  function channelsOf(ctx, cmd, argv) {
    const argc = argv.length;
    if (ctx.f.fam === 6) {
      const n = cmd.name;
      if (n === 'publish') return [{ pos: 1, pattern: false, kind: 'publish' }];
      if (n === 'subscribe' || n === 'psubscribe') {
        const out = [];
        for (let i = 1; i < argc; i++) out.push({ pos: i, pattern: n === 'psubscribe', kind: 'subscribe' });
        return out;
      }
      return [];
    }
    const spec = cmd.channels;
    if (!spec) return [];
    const stop = spec.count === -1 ? argc : Math.min(spec.start + spec.count, argc);
    const out = [];
    const kind = spec.flags.includes('publish') ? 'publish' : spec.flags.includes('subscribe') ? 'subscribe' : 'unsubscribe';
    for (let i = spec.start; i < stop; i++) out.push({ pos: i, pattern: spec.flags.includes('pattern'), kind: kind });
    return out;
  }

  // ---- the permission check ----

  // The server tries the patterns in order and stops at the first match.
  // Here a pattern with no wildcard is found by name; the patterns with
  // wildcards before it in the list are still tried first, as the server
  // would (with Redis 7.0 one of them can crash it).
  function keyAllowed(ctx, s, key, flags) {
    if (s.allkeys) return true;
    const need = ctx.f.fam === 6 ? 0 : aclKeyFlags(flags);
    const ix = patternIndex(s.patterns);
    let first = Infinity;
    for (const x of ix.exact.get(key) || []) if ((x.e.f & need) === need) { first = x.at; break; }
    for (const g of ix.globs) {
      if (g.at > first) break;
      if ((g.e.f & need) !== need) continue;
      if (globMatch(g.p, key, ctx.f.nesting)) return true;
    }
    return first !== Infinity;
  }
  function channelAllowed(ctx, s, channel, pattern) {
    const ix = patternIndex(s.channels);
    // PSUBSCRIBE: the pattern itself has to be in the list.
    if (pattern) return ix.byPattern.has(ctx.f.fam === 6 ? channel : cstr(channel));
    const same = ix.exact.get(channel);
    const first = same ? same[0].at : Infinity;
    for (const g of ix.globs) {
      if (g.at > first) break;
      if (globMatch(g.p, channel, ctx.f.nesting)) return true;
    }
    return first !== Infinity;
  }
  function dbAllowed(ctx, s, db) {
    if (s.alldbs) return true;
    if (db < 0 || db >= ctx.databases) return false;
    return s.dbs.includes(db);
  }
  // getLongLongFromObject on an argument the server already checked.
  const asLong = (s) => { const n = string2ll(s); return n === null ? null : Number(BigInt.asIntN(32, n)); };
  // Valkey 9.1: where a command names databases.
  function databaseArgs(ctx, cmd, argv) {
    const argc = argv.length, n = ctx.databases;
    const ok = (s) => { const x = string2ll(s); return x !== null && x >= 0n && x < BigInt(n); };
    switch (ctx.v.dbidArgs[cmd.fullname]) {
      case 'selectDbIdArgs': return argc >= 2 && ok(argv[1]) ? [1] : null;
      case 'swapdbDbIdArgs': return argc >= 3 && ok(argv[1]) && ok(argv[2]) ? [1, 2] : null;
      case 'moveDbIdArgs': return argc >= 3 && ok(argv[2]) ? [2] : null;
      case 'copyDbIdArgs': {
        if (argc < 5) return null;
        const at = [];
        for (let j = 3; j < argc; j++) {
          if (eqi(argv[j], 'replace')) continue;
          if (eqi(argv[j], 'db') && argc - j - 1 >= 1) {
            if (!ok(argv[j + 1])) return null;
            at.push(j + 1);
            j++;
          } else return null;
        }
        return at.length ? at : null;
      }
      default: return null;
    }
  }
  const restricted = (ctx, cmd) => cmd.cats.has('keyspace') || cmd.cats.has('read') || cmd.cats.has('write') || hasKeys(ctx, cmd);

  // ACLSelectorCheckCmd: { result: 'ok' | 'db' | 'command' | 'key' |
  // 'channel', index } for one selector.
  function selectorCheck(ctx, s, cmd, argv, cache, db) {
    const f = ctx.f;
    if (f.dbPerms) {
      if (ctx.v.dbidArgs[cmd.fullname]) {
        const at = databaseArgs(ctx, cmd, argv);
        if (at) for (const p of at) if (!dbAllowed(ctx, s, asLong(argv[p]))) return { result: 'db', index: p };
        if (hasKeys(ctx, cmd) && !dbAllowed(ctx, s, db)) return { result: 'db', index: 0 };
      } else if (ctx.v.allDbs.has(cmd.fullname) && !s.alldbs) {
        for (let i = 0; i < ctx.databases; i++) if (!dbAllowed(ctx, s, i)) return { result: 'db', index: 0 };
      } else if (restricted(ctx, cmd) && !dbAllowed(ctx, s, db)) return { result: 'db', index: 0 };
    }
    if (!s.allcommands && !cmd.noAuth && !s.bits[cmd.id]) {
      const list = s.firstargs && s.firstargs.get(cmd.id);
      if (argv.length < 2 || !list) return { result: 'command' };
      const arg = argv[cmd.parent ? 2 : 1];
      if (!list.some((a) => eqi(arg, a))) return { result: 'command' };
    }
    if (!s.allkeys && hasKeys(ctx, cmd)) {
      if (!cache.keys) cache.keys = keysOf(ctx, cmd, argv);
      for (const k of cache.keys) if (!keyAllowed(ctx, s, argv[k.pos], k.flags)) return { result: 'key', index: k.pos };
    }
    if (!s.allchannels) {
      for (const c of channelsOf(ctx, cmd, argv)) {
        if (c.kind === 'unsubscribe') continue;
        if (!channelAllowed(ctx, s, argv[c.pos], c.pattern)) return { result: 'channel', index: c.pos };
      }
    }
    return { result: 'ok' };
  }
  const RANK = { ok: 0, db: 1, command: 2, key: 3, channel: 4 };
  // ACLCheckAllUserCommandPerm: OK if any selector allows the command;
  // otherwise the most telling reason: a channel over a key over the
  // command (over the database), and the last argument among equals.
  function userCheck(ctx, u, cmd, argv, db) {
    const cache = {};
    let relevant = ctx.f.dbPerms ? 'db' : 'command', last = 0, local = 0;
    const each = [];
    for (let i = 0; i < u.selectors.length; i++) {
      const r = selectorCheck(ctx, u.selectors[i], cmd, argv, cache, db);
      each.push(r);
      if (r.result === 'ok') return { result: 'ok', selector: i, selectors: each, keys: cache.keys };
      if (r.index !== undefined) local = r.index;
      if (RANK[r.result] > RANK[relevant] || (r.result === relevant && local > last)) { relevant = r.result; last = local; }
    }
    return { result: relevant, index: last, selectors: each, keys: cache.keys };
  }

  // The messages: ACL DRYRUN's reply, and the NOPERM error the command gets.
  function dryrunText(ctx, u, cmd, r, argv) {
    const v = ctx.v;
    const arg = argv[r.index || 0];
    if (ctx.f.fam === 70) {
      if (r.result === 'command') return 'This user has no permissions to run the \'' + cmd.fullname + '\' command';
      return 'This user has no permissions to access the \'' + cstr(arg) + '\' ' + r.result;
    }
    if (r.result === 'command') return 'User ' + u.name + ' has no permissions to run the \'' + cmd.fullname + '\' command';
    if (r.result === 'db') return 'User ' + cstr(u.name) + ' has no permissions to access database ' + cstr(arg);
    return 'User ' + u.name + ' has no permissions to access the \'' + arg + '\' ' + r.result;
  }
  function nopermText(ctx, u, cmd, r) {
    const fam = ctx.f.fam;
    if (fam === 6 || fam === 70) {
      if (r.result === 'command') return 'NOPERM this user has no permissions to run the \'' + cmd.fullname + '\' command' + (fam === 6 ? ' or its subcommand' : '');
      return 'NOPERM this user has no permissions to access one of the ' + (r.result === 'key' ? 'keys' : 'channels') + ' used as arguments';
    }
    if (r.result === 'command') return oneLine('NOPERM User ' + cstr(u.name) + ' has no permissions to run the \'' + cmd.fullname + '\' command');
    if (r.result === 'db') return 'NOPERM No permissions to access database';
    return 'NOPERM No permissions to access a ' + r.result;
  }

  // The error a command line gets before ACL looks at it: unknown command or
  // subcommand, wrong number of arguments, DEBUG and MODULE switched off.
  function preCheck(ctx, argv, cmd, opts) {
    const v = ctx.v, f = ctx.f;
    const R = v.server === 'redis';
    if (!cmd) {
      const base = v.top.get(lower(argv[0]));
      if (f.fam !== 6 && base && base.subs && argv.length >= 2) {
        return 'ERR ' + oneLine('unknown subcommand \'' + cstr(argv[1]).slice(0, 128) + '\'. Try ' + cstr(argv[0]).toUpperCase() + ' HELP.');
      }
      let args = '';
      for (let i = 1; i < argv.length && args.length < 128; i++) {
        const a = cstr(argv[i]).slice(0, 128 - args.length);
        args += f.fam === 6 ? '`' + a + '`, ' : '\'' + a + '\' ';
      }
      if (f.fam === 6) return 'ERR ' + oneLine('unknown command `' + cstr(argv[0]) + '`, with args beginning with: ' + args);
      const name = cstr(argv[0]).slice(0, 128);
      if (R && compareVersions(v.version, '8.6.0') >= 0) return 'ERR ' + oneLine('unknown command \'' + name + '\'' + (argv.length >= 2 ? ', with args beginning with: ' + args : ''));
      return 'ERR ' + oneLine('unknown command \'' + name + '\', with args beginning with: ' + args);
    }
    if (!arityOk(cmd, argv.length)) return 'ERR wrong number of arguments for \'' + cmd.fullname + '\' command';
    if ((cmd.fullname === 'debug' && opts.enableDebugCommand !== 'yes') || (/^module\|(load|loadex|unload)$/.test(cmd.fullname) && opts.enableModuleCommand !== 'yes')) {
      if (f.fam !== 6) {
        const debug = cmd.fullname === 'debug';
        return 'ERR ' + (debug ? 'DEBUG' : 'MODULE') + ' command not allowed. If the ' + (debug ? 'enable-debug-command' : 'enable-module-command') +
          ' option is set to "local", you can run it from a local connection, otherwise you need to set this option in the configuration file, and then restart the server.';
      }
    }
    if (opts.multi && cmd.flags.has('no_multi')) {
      return 'ERR ' + (v.server === 'valkey' && compareVersions(v.version, '9.0.0') >= 0 ? 'Command \'' + cmd.fullname + '\' not allowed inside a transaction' : 'Command not allowed inside a transaction');
    }
    return null;
  }

  // Can this user run this command line? argv: the command and its
  // arguments (binary strings). opts: db (the client's current database,
  // Valkey 9.1), multi (inside MULTI), enableDebugCommand and
  // enableModuleCommand ('no' by default), databases, pubsubDefault.
  // Returns {
  //   allowed, reason: null | 'command' | 'key' | 'channel' | 'db', index,
  //   command (its full name, or null), keys [{ index, key, flags }],
  //   channels [{ index, channel, pattern }], selector (the one that allows it),
  //   dryrun: what ACL DRYRUN replies: { reply } or { error } (7.0 and later),
  //   reply: what the command itself gets before it runs: { error } or null,
  //   selectors: each selector's answer,
  //   crash: when checking the command crashes the server (reason 'crash',
  //     and dryrun and reply are { crash })
  // }
  function check(user, argv, versionId, opts) {
    opts = opts || {};
    const ctx = context(versionId, opts);
    const v = ctx.v;
    const db = opts.db || 0;
    const cmd = argv.length ? lookupCommand(v, argv) : null;
    const out = { allowed: false, reason: null, index: null, command: cmd ? cmd.fullname : null, keys: [], channels: [], selector: null, dryrun: null, reply: null, selectors: [] };
    if (!argv.length) return out;
    // ACL DRYRUN
    if (ctx.f.fam !== 6) {
      if (!cmd) out.dryrun = { error: oneLine('Command \'' + cstr(argv[0]) + '\' not found') };
      else if (!arityOk(cmd, argv.length)) out.dryrun = { error: 'wrong number of arguments for \'' + cmd.fullname + '\' command' };
    }
    const pre = preCheck(ctx, argv, cmd, opts);
    if (!cmd || !arityOk(cmd, argv.length)) { out.reply = { error: pre }; return out; }
    let r;
    try {
      r = userCheck(ctx, user, cmd, argv, db);
    } catch (e) {
      if (!(e instanceof Crash)) throw e;
      out.reason = 'crash';
      out.crash = e.crash;
      out.dryrun = ctx.f.fam === 6 ? null : { crash: e.crash };
      out.reply = { crash: e.crash };
      return out;
    }
    out.selectors = r.selectors;
    if (hasKeys(ctx, cmd)) {
      const keys = r.keys || keysOf(ctx, cmd, argv);
      out.keys = keys.map((k) => ({ index: k.pos, key: argv[k.pos], flags: keyFlagNames(k.flags) }));
    }
    out.channels = channelsOf(ctx, cmd, argv).map((c) => ({ index: c.pos, channel: argv[c.pos], pattern: c.pattern, kind: c.kind }));
    if (r.result === 'ok') {
      out.allowed = true;
      out.selector = r.selector;
      if (ctx.f.fam !== 6) out.dryrun = { reply: 'OK' };
      out.reply = pre ? { error: pre } : null;
      return out;
    }
    out.reason = r.result;
    out.index = r.result === 'command' ? 0 : r.index;
    if (r.result === 'db') out.database = r.index ? asLong(argv[r.index]) : v.allDbs.has(cmd.fullname) ? 'all' : db;
    if (ctx.f.fam !== 6) out.dryrun = { reply: dryrunText(ctx, user, cmd, r, argv) };
    out.reply = { error: pre || nopermText(ctx, user, cmd, r) };
    return out;
  }

  // COMMAND GETKEYSANDFLAGS (GETKEYS in 6.2): { keys: [[key, flags]] } or { error }.
  function getKeys(argv, versionId, opts) {
    const ctx = context(versionId, opts);
    const cmd = lookupCommand(ctx.v, argv);
    if (!cmd) return { error: 'Invalid command specified' };
    if (!hasKeys(ctx, cmd)) return { error: 'The command has no key arguments' };
    if (!arityOk(cmd, argv.length)) return { error: 'Invalid number of arguments specified for command' };
    const keys = keysOf(ctx, cmd, argv);
    if (!keys.length) {
      if (ctx.f.fam !== 6 && cmd.flags.has('no_mandatory_keys')) return { keys: [] };
      return { error: 'Invalid arguments specified for command' };
    }
    return { keys: keys.map((k) => [argv[k.pos], keyFlagNames(k.flags)]) };
  }


  // ---- reading rules people write ----

  // Rules as text: one or more "user name rules..." lines (an ACL file or
  // config lines), or the arguments of ACL SETUSER, with or without "ACL
  // SETUSER name" in front. text: a string of text, or bytes. Returns {
  // kind, users: [{ name, args, line }], error, text }. kind: 'aclfile'
  // (split at spaces, as ACL LOAD does), 'config' (split with quotes, as
  // redis.conf is) or 'setuser' (as redis-cli splits a command line). text,
  // for an ACL file or config lines: the file to give loadFile() or
  // loadConfig(), as a binary string.
  function readRules(text, versionId, kind) {
    const v = getVersion(versionId);
    const bin = toBinary(text);
    // ACL LIST as redis-cli prints it: 1) "user app on ...".
    let unwrapped = false;
    const lines = bin.split('\n').map((l) => {
      l = trimSet(l, ' \t\r\n');
      const m = /^\d+\)\s+(".*")$/.exec(l);
      if (m) { const q = splitArgs(m[1], 'classic'); if (q && q.length === 1) { unwrapped = true; return q[0]; } }
      return l;
    });
    // # starts a comment, except in a password hash (#<64 hex digits>), a rule.
    const comment = (l) => l[0] === '#' && !/^#[0-9a-fA-F]{64}(\s|$)/.test(l);
    const meaningful = lines.filter((l) => l !== '' && !comment(l));
    if (!kind) {
      // A byte order mark in front doesn't change what the text is meant to be.
      const bare = (l) => (l.startsWith('\xef\xbb\xbf') ? l.slice(3) : l);
      const userLine = (l) => /^user\s/i.test(bare(l));
      const setting = (l) => /^(acl-pubsub-default|aclfile)(\s|$)/i.test(bare(l));
      if (meaningful.some(userLine) && meaningful.every((l) => userLine(l) || setting(l))) kind = meaningful.some((l) => setting(l) || /["']/.test(l)) ? 'config' : 'aclfile';
      else kind = 'setuser';
    }
    const users = [];
    if (kind === 'setuser') {
      const argv = splitArgs(meaningful.join(' '), 'classic');
      if (argv === null) return { kind: kind, users: [], error: 'Unbalanced quotes' };
      let name = 'user', args = argv;
      if (argv.length >= 3 && eqi(argv[0], 'acl') && eqi(argv[1], 'setuser')) { name = argv[2]; args = argv.slice(3); }
      else if (argv.length >= 2 && eqi(argv[0], 'setuser')) { name = argv[1]; args = argv.slice(2); }
      else if (argv.length >= 2 && eqi(argv[0], 'user')) { name = argv[1]; args = argv.slice(2); }
      users.push({ name: name, args: args, line: 1 });
      return { kind: kind, users: users, error: null };
    }
    lines.forEach((l, i) => {
      if (l === '' || l[0] === '#') return;
      const argv = kind === 'aclfile' ? l.split(' ') : splitArgs(l, v.f.split);
      if (!argv) { users.push({ name: null, args: [], line: i + 1, error: 'Unbalanced quotes' }); return; }
      if (argv.length < 2 || !eqi(argv[0], 'user')) { users.push({ name: null, args: [], line: i + 1, error: 'Not a user line' }); return; }
      users.push({ name: argv[1], args: argv.slice(2), line: i + 1 });
    });
    // The file as it was, unless lines of ACL LIST had to be unwrapped.
    return { kind: kind, users: users, error: null, text: unwrapped ? lines.join('\n') + '\n' : bin };
  }

  // ---- in plain words ----

  const CATEGORY_TEXT = {
    keyspace: 'commands that work on keys of any type, such as DEL, EXPIRE, RENAME and TYPE',
    read: 'commands that read data',
    write: 'commands that change data',
    set: 'set commands', sortedset: 'sorted set commands', list: 'list commands', hash: 'hash commands',
    string: 'string commands', bitmap: 'bitmap commands', hyperloglog: 'HyperLogLog commands', geo: 'geospatial commands',
    stream: 'stream commands', pubsub: 'Pub/Sub commands',
    admin: 'administration commands, such as CONFIG, ACL, DEBUG and REPLICAOF',
    fast: 'commands that take constant or logarithmic time',
    slow: 'commands that aren\'t fast',
    blocking: 'commands that can wait for data, such as BLPOP and XREAD BLOCK',
    dangerous: 'commands that can hurt the server or its data, such as FLUSHALL, KEYS, CONFIG and SHUTDOWN',
    connection: 'commands about the connection, such as PING, SELECT and CLIENT',
    transaction: 'MULTI, EXEC, DISCARD, WATCH and UNWATCH',
    scripting: 'Lua scripts and functions, such as EVAL and FCALL'
  };
  const upper = (s) => s.replace(/[a-z]+/g, (x) => x.toUpperCase());
  // A command's name the way people write it: CONFIG GET.
  const display = (fullname) => upper(fullname.replace('|', ' '));

  // The commands a person can run: plain commands and subcommands (a
  // container such as CONFIG does nothing on its own).
  // Commands every user may run (AUTH, HELLO and a few more) don't count.
  function runnable(v) {
    if (!v.runnable) v.runnable = v.cmds.filter((c) => !c.subs && !c.noAuth);
    return v.runnable;
  }
  function allowedCommands(ctx, s) {
    return runnable(ctx.v).filter((c) => s.allcommands || s.bits[c.id]);
  }
  // Commands allowed only with certain first arguments (+select|0).
  function firstArgCommands(ctx, s) {
    return runnable(ctx.v).filter((c) => !(s.allcommands || s.bits[c.id]) && s.firstargs && s.firstargs.has(c.id));
  }

  // One rule of a selector's command rules, explained.
  function ruleText(ctx, tok) {
    const v = ctx.v;
    if (tok === '+@all') return 'Every command, also the ones a module adds later.';
    if (tok === '-@all') return 'Starts from no commands.';
    const m = /^([+-])@(.*)$/.exec(tok);
    if (m) {
      const ci = catIndex(v, m[2]);
      const n = ci < 0 ? 0 : v.members[ci].filter((c) => !c.subs).length;
      const what = CATEGORY_TEXT[m[2]] || 'the commands of this category';
      return (m[1] === '+' ? 'Adds' : 'Takes away') + ' @' + m[2] + ': ' + what + ' (' + n + ').';
    }
    const sign = tok[0], name = tok.slice(1);
    const bar = name.lastIndexOf('|');
    const cmd = lookupAcl(v, name);
    if (cmd) {
      const extra = cmd.subs ? ' and its ' + cmd.subs.size + ' subcommands' : '';
      return (sign === '+' ? 'Adds ' : 'Takes away ') + display(cmd.fullname) + extra + '.';
    }
    if (bar > 0) {
      const base = lookupAcl(v, name.slice(0, bar));
      if (base) return 'Allows ' + display(base.fullname) + ' only when its first argument is ' + name.slice(bar + 1) + '. Deprecated: the server warns that this may stop working.';
    }
    return tok;
  }

  function keysText(s) {
    if (s.allkeys) return [{ pattern: '*', access: 'read and write', text: 'Any key.' }];
    return s.patterns.map((p) => {
      const access = p.f === 3 ? 'read and write' : p.f === 1 ? 'read' : p.f === 2 ? 'write' : 'none';
      return { pattern: p.p, access: access, text: (access === 'none' ? 'Keys matching ' : (access === 'read and write' ? 'Read and write keys matching ' : access === 'read' ? 'Read keys matching ' : 'Write keys matching ')) + (p.p === '' ? 'nothing but the empty name' : p.p) + '.' };
    });
  }

  // Explains a user: who can log in, and for each set of rules (the root
  // and each selector) which commands, keys, channels and databases it
  // allows. warnings: things worth a second look.
  function explain(user, versionId, opts) {
    const ctx = context(versionId, opts);
    const v = ctx.v, f = ctx.f;
    const ll = listLine(user, v.id, opts);
    const out = { name: user.name, line: ll.line || null, crash: ll.crash || null, login: null, selectors: [], warnings: [],
      everyone: v.cmds.filter((c) => c.noAuth).map((c) => display(c.fullname)) };
    const warn = (level, code, title, text) => out.warnings.push({ level: level, code: code, title: title, text: text });
    if (user.disabled || !user.enabled) out.login = { state: 'off', text: 'Off: nobody can log in as this user. Connections already logged in as it keep working.' };
    else if (user.nopass) out.login = { state: 'nopass', text: 'On, with no password: any password logs in, or none at all for the default user.' };
    else if (!user.passwords.length) out.login = { state: 'locked', text: 'On, but there is no password yet, so nobody can log in.' };
    else out.login = { state: 'on', text: 'On, with ' + (user.passwords.length === 1 ? 'a password' : user.passwords.length + ' passwords') + '.' };
    const total = runnable(v).length;
    const danger = new Set((v.members[catIndex(v, 'dangerous')] || []).filter((c) => !c.subs).map((c) => c.fullname));
    let anyAll = false, anyDanger = new Set(), anyFirstArgs = false;
    user.selectors.forEach((s, i) => {
      let tokens = [];
      try {
        const d = describeSelector(ctx, s);
        const at = d.search(/(^| )[+-]@all( |$)/);
        tokens = d.slice(at < 0 ? 0 : at).trim().split(' ');
      } catch (e) {
        if (!(e instanceof Crash)) throw e;
        tokens = (s.future ? ['+@all'] : ['-@all']).concat(s.rules ? s.rules.split(' ') : []);
      }
      const allowed = allowedCommands(ctx, s);
      const dangerous = allowed.filter((c) => danger.has(c.fullname)).map((c) => display(c.fullname));
      dangerous.forEach((d) => anyDanger.add(d));
      if (s.allcommands || s.future) anyAll = true;
      if (s.firstargs && s.firstargs.size) anyFirstArgs = true;
      const partly = firstArgCommands(ctx, s).map((c) => ({ command: display(c.fullname), args: s.firstargs.get(c.id).slice() }));
      const sel = {
        title: i === 0 ? 'Rules' : 'Selector ' + i,
        rules: tokens.filter(Boolean).map((t) => ({ rule: t, text: ruleText(ctx, t) })),
        commands: { allowed: allowed.length, total: total, list: allowed.map((c) => display(c.fullname)), dangerous: dangerous, firstArgs: partly,
          text: (allowed.length === total ? 'All ' + total + ' commands.' : allowed.length === 0 ? 'No commands.' : allowed.length + ' of ' + total + ' commands.') +
            partly.map((p) => ' ' + p.command + ' only with ' + (p.args.length === 1 ? 'the first argument ' : 'the first arguments ') + p.args.join(', ') + '.').join('') },
        keys: keysText(s),
        channels: s.allchannels ? [{ pattern: '*', text: 'Any channel.' }] : s.channels.map((c) => ({ pattern: c, text: 'Channels matching ' + c + ', and the pattern ' + c + ' itself for PSUBSCRIBE.' })),
        databases: f.dbPerms ? (s.alldbs ? { all: true, text: 'Every database.' } : { all: false, list: s.dbs.slice(), text: s.dbs.length ? 'Databases ' + s.dbs.join(', ') + ' only.' : 'No database.' }) : null
      };
      if (!s.allkeys && !s.patterns.length) sel.keysText = 'No keys: any command that names a key is refused.';
      if (!s.allchannels && !s.channels.length) sel.channelsText = 'No channels: PUBLISH, SUBSCRIBE and the like are refused.';
      out.selectors.push(sel);
    });
    if (out.crash) warn('bad', 'crash', 'Listing this user crashes the server', 'ACL LIST, ACL GETUSER, ACL SAVE and CONFIG REWRITE replay the rules the server kept, and one of them doesn\'t replay (' + out.crash + '). A first argument with a space or a quote in it does this.');
    const loginOk = out.login.state === 'on' || out.login.state === 'nopass';
    if (out.login.state === 'nopass' && (anyAll || anyDanger.size)) warn('bad', 'nopass', 'No password, and wide rights', 'Anyone who can reach the server can log in as this user and run ' + (anyAll ? 'every command' : anyDanger.size + ' dangerous commands') + '.');
    else if (out.login.state === 'nopass') warn('warn', 'nopass', 'No password', 'Anyone who can reach the server can log in as this user.');
    if (anyAll && loginOk) warn('warn', 'all', 'Every command', 'The rules start from +@all, so commands added later, by an upgrade or a module, are allowed too.');
    if (anyDanger.size && !anyAll && loginOk) warn('warn', 'dangerous', anyDanger.size === 1 ? 'A command from @dangerous' : anyDanger.size + ' commands from @dangerous', 'It may run ' + [...anyDanger].sort().join(', ') + '.');
    const selfEdit = ['acl|setuser', 'acl|load', 'config|set', 'module|load', 'debug', 'eval', 'fcall'];
    const grants = new Set();
    for (const s of user.selectors) for (const c of allowedCommands(ctx, s)) if (['acl|setuser', 'acl|load', 'config|set', 'module|load', 'module|loadex'].includes(c.fullname)) grants.add(display(c.fullname));
    if (grants.size && loginOk && !anyAll) warn('bad', 'escalate', 'It can give itself more rights', [...grants].sort().join(' and ') + ' can change users, settings or load code.');
    void selfEdit;
    if (anyFirstArgs) warn('warn', 'firstarg', 'Allowing a first argument is deprecated', 'Rules such as +select|0 still work, but the server logs a deprecation warning for each and they may stop working in a later version.');
    if (user.selectors.some((s) => !s.allkeys && !s.patterns.length && allowedCommands(ctx, s).some((c) => hasKeys(ctx, c))) && loginOk) {
      warn('info', 'nokeys', 'Commands with keys, and no keys', 'Some allowed commands take keys, but no key pattern lets them through.');
    }
    if (v.server === 'redis' && f.fam === 6 && user.selectors[0].allchannels && ctx.allChannels) warn('info', 'channels62', 'Every channel, by default', 'Redis 6.2 lets new users use every channel. From 7.0 they start with none (acl-pubsub-default resetchannels).');
    return out;
  }

  // ---- drafting users from what clients did ----

  // Reads MONITOR output: '1700000000.123456 [0 127.0.0.1:52000] "SET" "k" "v"'.
  // The client is an address (IPv6 ones in brackets: [::1]:52000),
  // unix:<socket path>, or lua for the commands a script ran. Plain command
  // lines ("SET k v") work too. text: a string of text, or bytes. Returns
  // [{ argv, db, client, line }].
  function parseMonitor(text) {
    const out = [];
    const lines = toBinary(text).split('\n');
    lines.forEach((raw, i) => {
      const line = trimSet(raw, ' \t\r\n\v\f');
      if (!line || /^\+?OK$/.test(line)) return;
      const m = /^\+?(\d+(?:\.\d+)?) \[(\d+) /.exec(line);
      if (m) {
        // The client ends at the first '] "' after which the arguments read.
        for (let k = line.indexOf('] "', m[0].length); k >= 0; k = line.indexOf('] "', k + 1)) {
          const argv = parseQuoted(line.slice(k + 2));
          if (argv && argv.length) { out.push({ argv: argv, db: Number(m[2]), client: line.slice(m[0].length, k), line: i + 1 }); return; }
        }
      }
      const argv = splitArgs(line, 'classic');
      if (argv && argv.length) out.push({ argv: argv, db: null, client: null, line: i + 1 });
    });
    return out;
  }
  // MONITOR's quoting (sdscatrepr): "..." with \" \\ \n \r \t \a \b \xHH,
  // read from a binary string.
  function parseQuoted(s) {
    const out = [];
    let i = 0;
    while (i < s.length) {
      while (s[i] === ' ') i++;
      if (i >= s.length) break;
      if (s[i] !== '"') return null;
      i++;
      let cur = '';
      for (;;) {
        if (i >= s.length) return null;
        const c = s[i];
        if (c === '"') { i++; break; }
        if (c === '\\') {
          const e = s[i + 1];
          if (e === 'x' && /^[0-9a-fA-F]{2}$/.test(s.substr(i + 2, 2))) { cur += String.fromCharCode(parseInt(s.substr(i + 2, 2), 16)); i += 4; continue; }
          cur += e === 'n' ? '\n' : e === 'r' ? '\r' : e === 't' ? '\t' : e === 'a' ? '\x07' : e === 'b' ? '\b' : e;
          i += 2;
          continue;
        }
        cur += c;
        i++;
      }
      out.push(cur);
    }
    return out;
  }

  // Where a key splits into a prefix and a name: after the last separator.
  const SEPARATORS = ':/.|#_-';
  // A glob pattern for a group of keys or channels: the exact name for one,
  // the longest common prefix up to a separator, then *, for several. ACL
  // patterns can't hold spaces or NUL bytes; ? stands in for them.
  function patternFor(names) {
    const safe = (s) => globEscape(s).replace(/[\s\0]/g, '?');
    if (names.length === 1) return safe(names[0]);
    let lcp = names[0];
    for (const n of names) { let k = 0; while (k < lcp.length && k < n.length && lcp[k] === n[k]) k++; lcp = lcp.slice(0, k); }
    let cut = -1;
    for (let k = lcp.length - 1; k >= 0; k--) if (SEPARATORS.includes(lcp[k])) { cut = k; break; }
    const prefix = cut >= 0 ? lcp.slice(0, cut + 1) : lcp;
    return safe(prefix) + '*';
  }
  // Groups names by their first part (up to the first separator).
  function groupNames(names, exact) {
    const groups = new Map();
    for (const n of names) {
      let at = -1;
      for (let k = 0; k < n.length; k++) if (SEPARATORS.includes(n[k])) { at = k; break; }
      const head = exact || at < 0 ? '\0' + n : n.slice(0, at + 1);
      if (!groups.has(head)) groups.set(head, []);
      groups.get(head).push(n);
    }
    return [...groups.values()];
  }

  // The commands that run a script, which MONITOR shows right before the
  // commands the script runs (client lua).
  const SCRIPT_CALLS = new Set(['eval', 'evalsha', 'eval_ro', 'evalsha_ro', 'fcall', 'fcall_ro']);
  // The placeholder in the ACL file line for a password the draft doesn't
  // know: ACL LOAD refuses it.
  const HASH_PLACEHOLDER = '#<sha256-of-your-password>';
  // Past this many key and channel patterns the draft says it's too many:
  // the server tries them one by one for each name a command uses.
  const MANY_PATTERNS = 1000;

  // Drafts the least a client needs: the commands it ran, read or write
  // patterns for the keys it touched, the channels it used and (Valkey
  // 9.1) the databases. entries: parseMonitor() output, or a list of argv.
  // opts: name, password (else a placeholder), keys: 'prefix' (default) or
  // 'exact', client (only entries from this client, and the commands its
  // scripts ran). Returns { name, args (ACL SETUSER arguments), setuser
  // (the command), aclfile (the ACL file line, with a placeholder ACL LOAD
  // refuses when there's no password: placeholder true), commands
  // [{ command, count }], keys, channels, skipped [{ line, argv, reason }],
  // check (every entry rechecked), error, lines (how many entries it read),
  // approximate (names with spaces), manyPatterns (the count, past 1000) }.
  function build(entries, versionId, opts) {
    opts = opts || {};
    const ctx = context(versionId, opts);
    const v = ctx.v, f = ctx.f;
    const all = entries.map((e) => (Array.isArray(e) ? { argv: e, db: null, client: null, line: null } : e));
    let list = all;
    if (opts.client) {
      // A script's commands go with the client that ran the script.
      list = [];
      let caller = null;
      for (const e of all) {
        if (e.client === 'lua') { if (caller === opts.client) list.push(e); continue; }
        if (e.argv.length && SCRIPT_CALLS.has(lower(e.argv[0]))) caller = e.client;
        if (e.client === opts.client) list.push(e);
      }
    }
    const used = new Map(), skipped = [], keys = new Map(), channels = new Map(), patterns = new Set(), dbs = new Set();
    let current = null, allDbs = false;
    for (const e of list) {
      const cmd = lookupCommand(v, e.argv);
      if (!cmd) { skipped.push({ line: e.line, argv: e.argv, reason: 'unknown command' }); continue; }
      if (!arityOk(cmd, e.argv.length)) { skipped.push({ line: e.line, argv: e.argv, reason: 'wrong number of arguments' }); continue; }
      if (e.db !== null && e.db !== undefined) dbs.add(e.db);
      else dbs.add(current === null ? 0 : current);
      if (cmd.fullname === 'select' && string2ll(e.argv[1]) !== null) current = Number(string2ll(e.argv[1]));
      if (f.dbPerms) {
        for (const p of databaseArgs(ctx, cmd, e.argv) || []) dbs.add(asLong(e.argv[p]));
        if (v.allDbs.has(cmd.fullname)) allDbs = true;
      }
      used.set(cmd.fullname, (used.get(cmd.fullname) || 0) + 1);
      if (hasKeys(ctx, cmd)) {
        for (const k of keysOf(ctx, cmd, e.argv)) {
          const name = e.argv[k.pos];
          const need = f.fam === 6 ? 3 : aclKeyFlags(k.flags) || 3;
          keys.set(name, (keys.get(name) || 0) | need);
        }
      }
      for (const c of channelsOf(ctx, cmd, e.argv)) {
        if (c.kind === 'unsubscribe') continue;
        if (c.pattern) patterns.add(f.fam === 6 ? e.argv[c.pos] : cstr(e.argv[c.pos]));
        else channels.set(e.argv[c.pos], true);
      }
    }
    const args = ['reset', 'on'];
    const placeholder = opts.password == null;
    args.push(placeholder ? '>CHANGE-ME' : '>' + opts.password);
    // Key patterns: read-only groups get %R~, write-only %W~ (7.0 and later).
    const keyRules = [];
    for (const group of groupNames([...keys.keys()].sort(), opts.keys === 'exact')) {
      let need = 0;
      for (const k of group) need |= keys.get(k);
      const pat = patternFor(group);
      keyRules.push(f.fam === 6 || need === 3 ? '~' + pat : need === 1 ? '%R~' + pat : '%W~' + pat);
    }
    for (const r of keyRules) args.push(r);
    args.push('resetchannels');
    const chanRules = [];
    for (const group of groupNames([...channels.keys()].sort(), opts.keys === 'exact')) chanRules.push('&' + patternFor(group));
    const have = new Set(chanRules);
    for (const p of [...patterns].sort()) if (!have.has('&' + p) && !hasSpaces(p)) { chanRules.push('&' + p); have.add('&' + p); }
    for (const r of chanRules) args.push(r);
    if (f.dbPerms && !allDbs && dbs.size && dbs.size < ctx.databases) args.push('db=' + [...dbs].sort((a, b) => a - b).join(','));
    args.push('-@all');
    const names = [...used.keys()].filter((n) => !lookupAcl(v, n).noAuth).sort();
    for (const n of names) args.push('+' + n);
    const name = opts.name || 'app';
    // Every entry, checked against the draft (the ones left out above aren't).
    const made = setUser(null, name, args, v.id, opts);
    const checked = [];
    if (made.ok) {
      let db = 0;
      for (const e of list) {
        const cmd = lookupCommand(v, e.argv);
        if (!cmd || !arityOk(cmd, e.argv.length)) continue;
        const r = check(made.user, e.argv, v.id, Object.assign({}, opts, { db: e.db != null ? e.db : db }));
        if (cmd.fullname === 'select' && string2ll(e.argv[1]) !== null) db = Number(string2ll(e.argv[1]));
        checked.push({ line: e.line, argv: e.argv, allowed: r.allowed, reason: r.reason });
      }
    }
    const quoted = args.map((a) => quote(a));
    const fileArgs = args.slice(1).map((a) => (a[0] !== '>' ? a : placeholder ? HASH_PLACEHOLDER : '#' + sha256hex(a.slice(1))));
    const count = keyRules.length + chanRules.length;
    return {
      name: name, args: args, setuser: 'ACL SETUSER ' + quote(name) + ' ' + quoted.join(' '),
      aclfile: 'user ' + name + ' ' + fileArgs.join(' '), placeholder: placeholder,
      commands: names.map((n) => ({ command: display(n), count: used.get(n) })),
      keys: keyRules, channels: chanRules, skipped: skipped, check: checked,
      error: made.ok ? null : made.error, lines: list.length,
      approximate: [...keys.keys()].some((k) => hasSpaces(k)) || [...channels.keys()].some((c) => hasSpaces(c)),
      manyPatterns: count > MANY_PATTERNS ? count : 0
    };
  }

  // Bytes as text to show a person: UTF-8 reads as text, and what would
  // hide or move text on a screen shows as \xHH: control characters, a
  // byte order mark, marks that change the direction of text, and bytes
  // that aren't UTF-8. So the cause of an error shows, and a crafted file
  // can't send escape sequences to a terminal.
  function readable(s) {
    let out = '';
    const esc = (from, to) => { for (let k = from; k < to; k++) out += '\\x' + s.charCodeAt(k).toString(16).padStart(2, '0'); };
    for (let i = 0; i < s.length;) {
      const c = s.charCodeAt(i);
      if (c < 0x80) {
        if (c < 0x20 || c === 0x7f) esc(i, i + 1); else out += s[i];
        i++;
        continue;
      }
      const n = c >= 0xc2 && c <= 0xdf ? 1 : c >= 0xe0 && c <= 0xef ? 2 : c >= 0xf0 && c <= 0xf4 ? 3 : 0;
      let cp = n === 1 ? c & 0x1f : n === 2 ? c & 0x0f : c & 0x07;
      let ok = n > 0 && i + n < s.length;
      for (let k = 1; ok && k <= n; k++) {
        const d = s.charCodeAt(i + k);
        if ((d & 0xc0) !== 0x80) ok = false;
        else cp = (cp << 6) | (d & 0x3f);
      }
      if (ok && (cp < [0, 0x80, 0x800, 0x10000][n] || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff))) ok = false;
      if (!ok) { esc(i, i + 1); i++; continue; }
      if (hiddenChar(cp)) esc(i, i + n + 1); else out += String.fromCodePoint(cp);
      i += n + 1;
    }
    return out;
  }
  const hiddenChar = (cp) => (cp >= 0x80 && cp <= 0x9f) || cp === 0xad || cp === 0x61c || cp === 0x180e || (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x2028 && cp <= 0x202e) || (cp >= 0x2060 && cp <= 0x206f) || cp === 0xfeff || (cp >= 0xfff9 && cp <= 0xfffb) ||
    (cp & 0xfffe) === 0xfffe || (cp >= 0xe0000 && cp <= 0xe007f);

  // ---- exports (more below as the file grows) ----
  return {
    versions: versions, findVersion: findVersion, getVersion: getVersion,
    newUser: newUser, defaultUser: defaultUser, setUser: setUser, listLine: listLine, copyUser: copyUser,
    checkUserLine: checkUserLine, startupUsers: startupUsers, loadFile: loadFile, loadConfig: loadConfig,
    check: check, getKeys: getKeys, lookupCommand: (argv, id) => lookupCommand(getVersion(id), argv),
    readRules: readRules, explain: explain, parseMonitor: parseMonitor, build: build,
    splitArgs: splitArgs, toBinary: toBinary, fromBinary: fromBinary, printable: printable, readable: readable, quote: quote,
    sha256hex: sha256hex, globMatch: globMatch, globEscape: globEscape, errorText: errorText,
    _internal: { context: context, setUserOp: setUserOp, setSelector: setSelector, lookupAcl: lookupAcl, mergeSelectors: mergeSelectors, cstr: cstr, keysOf: keysOf }
  };
});
