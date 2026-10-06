// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Memory Calculator. Works out how much memory a Redis or Valkey server
// uses for a set of keys, the way each version stores them: the key, the
// object around the value, the encoding the value gets (listpack, intset,
// hash table, skiplist, quicklist), the hash tables that hold the keys and
// the expiry times, and the size classes of the jemalloc allocator they're
// built with. The result is the growth of INFO memory's used_memory.
// One file, no dependencies. In a browser it defines KVMemory; in Node,
// require() returns the same functions.

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KVMemory = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---- versions ----

  const VERSION_LIST = [
    ['redis', '6.2.24'], ['redis', '7.0.15'], ['redis', '7.2.16'], ['redis', '7.4.11'], ['redis', '8.0.6'],
    ['redis', '8.2.10'], ['redis', '8.4.7'], ['redis', '8.6.7'], ['redis', '8.8.3'], ['redis', '8.10.2'],
    ['valkey', '7.2.14'], ['valkey', '8.0.11'], ['valkey', '8.1.10'], ['valkey', '9.0.6'], ['valkey', '9.1.2']
  ];

  function versions() {
    return VERSION_LIST.map(([server, version]) => ({
      id: server + '-' + version, server: server, version: version,
      label: (server === 'redis' ? 'Redis ' : 'Valkey ') + version
    }));
  }

  // 'valkey 9.1', 'Redis 7.2.16', 'redis-8.10.2', '8', 'valkey' → the newest
  // matching version. A patch release it doesn't know gets the newest of the
  // same minor version.
  function findVersion(spec) {
    const m = /^\s*(redis|valkey)?[\s-]*v?(\d+(?:\.\d+){0,2})?\s*$/i.exec(String(spec || ''));
    if (!m || (!m[1] && !m[2])) return null;
    const server = m[1] ? m[1].toLowerCase() : null;
    const want = m[2] ? m[2].split('.').map(Number) : [];
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

  // What changed between versions, as the code of each one does it.
  const featureCache = new Map();
  function features(id) {
    if (featureCache.has(id)) return featureCache.get(id);
    const m = /^(redis|valkey)-(\d+)\.(\d+)\.(\d+)$/.exec(id || '');
    if (!m || !versions().some((v) => v.id === id)) throw new Error('Unknown version ' + id + '.');
    const R = m[1] === 'redis';
    const num = [Number(m[2]), Number(m[3])];
    const is = (a, b) => num[0] === a && num[1] === b;
    const ge = (a, b) => num[0] > a || (num[0] === a && num[1] >= b);
    const F = {
      id: id, R: R, V: !R,
      // sdsReqType cuts type 8 at 252 and type 16 at 65530 instead of 255
      // and 65535.
      sdsNew: R ? ge(8, 2) : ge(8, 0),
      // lpEncodeBacklen takes 2 bytes up to 16383 instead of 16382.
      backlenLE: R ? ge(8, 8) : ge(9, 1),
      // Redis 6.2 packs small hashes, sorted sets and lists in ziplists.
      ziplist: R && is(6, 2),
      dict: R && is(6, 2) ? 96 : 56,
      // How the keyspace holds a key:
      //   dict     a dict entry (24) and a copy of the key; the tables grow on insert only
      //   kvstore  the same, but serverCron also doubles a table once it's full
      //   embkey   the key inside the dict entry (Valkey 8.0)
      //   kvobj    the key inside the value object; the table points at the object
      //   meta     kvobj with the expiry before the object, no spare slot (Redis 8.6+)
      //   ht       Valkey's open hashtable of 64-byte buckets, the key inside the object
      ks: R ? (ge(8, 6) ? 'meta' : ge(8, 2) ? 'kvobj' : ge(7, 4) ? 'kvstore' : 'dict')
        : (ge(8, 1) ? 'ht' : ge(8, 0) ? 'embkey' : 'dict'),
      // How a string value is stored.
      str: R ? (ge(8, 6) ? 'k86' : ge(8, 2) ? 'k82' : 'robj')
        : (ge(9, 1) ? 'v91' : ge(9, 0) ? 'v90' : ge(8, 1) ? 'v81' : 'robj'),
      // One command with many elements sizes the new hash table for them.
      presize: R ? ge(7, 2) : true,
      setListpack: R ? ge(7, 2) : true,
      hashHT: R ? (is(6, 2) ? 'A' : is(7, 0) ? 'B' : is(7, 2) ? 'C' : ge(8, 6) ? 'F' : ge(8, 4) ? 'E' : 'D') : (ge(8, 1) ? 'G' : 'C'),
      setHT: R ? (is(6, 2) ? 'A' : is(7, 0) ? 'B' : ge(8, 4) ? 'E' : 'C') : (ge(8, 1) ? 'G' : 'C'),
      zset: R ? (is(6, 2) ? 1 : is(7, 0) ? 2 : ge(8, 6) ? 5 : ge(8, 4) ? 4 : 3) : (ge(9, 1) ? 7 : ge(8, 1) ? 6 : 3),
      // How a sorted set score that isn't a whole number is written in a listpack.
      zscore: R && is(6, 2) ? 'zl' : R && is(7, 0) ? 'g17' : 'fpconv',
      // Lists: 6.2 quicklist of ziplists, 7.0 quicklist of listpacks, 7.2+ a
      // listpack while small; plain nodes for big elements from 7.4 (Valkey 8.0).
      list: R ? (is(6, 2) ? 'zl' : is(7, 0) ? 'ql' : 'lp') : 'lp',
      plainNodes: R ? ge(7, 4) : ge(8, 0),
      quicklist: R && ge(8, 4) ? 48 : 40,
      // Valkey hashtable structs with their type's metadata.
      htHash: is(9, 1) && !R ? 96 : 80,
      htSet: 80,
      htZset: 80
    };
    featureCache.set(id, F);
    return F;
  }

  // ---- allocator ----

  // The usable size jemalloc gives for a request of n bytes. Every version
  // builds its bundled jemalloc with --with-lg-quantum=3: 8-byte steps up to
  // 64, then four size classes in each doubling (80, 96, 112, 128, 160, ...).
  function sizeClass(n) {
    if (n <= 8) return 8;
    if (n <= 64) return Math.ceil(n / 8) * 8;
    let lg = Math.floor(Math.log2(n - 1));
    if (2 ** lg > n - 1) lg--;
    else if (2 ** (lg + 1) <= n - 1) lg++;
    const step = 2 ** (lg - 2);
    return Math.ceil(n / step) * step;
  }
  const sc = sizeClass;

  // Smallest power of two ≥ x (x ≥ 1).
  function p2(x) {
    let p = 1;
    while (p < x) p *= 2;
    return p;
  }

  // ---- strings and numbers ----

  // The sds header sdsReqType picks for a string of len bytes.
  function sdsHdr(len, F) {
    if (len < 32) return 1;
    if (F.sdsNew) return len <= 252 ? 3 : len <= 65530 ? 5 : len <= 4294967286 ? 9 : 17;
    return len < 256 ? 3 : len < 65536 ? 5 : len < 4294967296 ? 9 : 17;
  }
  // sdsnewlen: an exact copy. An empty string gets type 8.
  function sdsNew(len, F) {
    return sc((len === 0 ? 3 : sdsHdr(len, F)) + len + 1);
  }
  // The header of a Redis 7.4-8.4 hash field (mstr).
  function mstr(len) {
    return sc((len < 32 ? 1 : len < 65536 ? 3 : 9) + len + 1);
  }
  // A string argument of 32 KB or more sent as the last thing in a read is
  // the query buffer itself, trimmed: a type 16 header up to 65528 bytes.
  function bigArg(len) {
    return len <= 65528 ? sc(len + 6) : sc(len + 10);
  }

  const INT64_MIN = -(2n ** 63n), INT64_MAX = 2n ** 63n - 1n;
  // A string the server stores as a number: canonical decimal, no sign
  // other than '-', no leading zeros, no '-0', within 64 bits.
  function canonicalInt(s) {
    if (typeof s !== 'string' || !/^(0|-?[1-9][0-9]*)$/.test(s) || s.length > 20) return null;
    const v = BigInt(s);
    return v < INT64_MIN || v > INT64_MAX ? null : v;
  }

  // An element: { len: L } text of L bytes that isn't a number, or
  // { int: 'N' } a number. Hash fields and set and sorted set members must
  // differ from each other, so for them { int: 'N' } means the numbers
  // N, N+1, N+2 ...
  function elemLen(e) {
    return e.int !== undefined ? e.int.length : e.len;
  }
  function elemInt(e) {
    return e.int !== undefined ? canonicalInt(e.int) : null;
  }

  // Listpack entry sizes: encoding plus back-length.
  function lpIntEnc(v) {
    if (v >= 0n && v <= 127n) return 1;
    if (v >= -4096n && v <= 4095n) return 2;
    if (v >= -32768n && v <= 32767n) return 3;
    if (v >= -8388608n && v <= 8388607n) return 4;
    if (v >= -2147483648n && v <= 2147483647n) return 5;
    return 9;
  }
  function lpBacklen(l, F) {
    if (l <= 127) return 1;
    if (F.backlenLE ? l <= 16383 : l < 16383) return 2;
    if (l < 2097151) return 3;
    if (l < 268435455) return 4;
    return 5;
  }
  function lpStrEntry(len, F) {
    const enc = len < 64 ? 1 + len : len < 4096 ? 2 + len : 5 + len;
    return enc + lpBacklen(enc, F);
  }
  function lpIntEntry(v) {
    return lpIntEnc(v) + 1;
  }
  // Ziplist entry body (encoding and payload, without the prevlen).
  function zlIntBody(v) {
    if (v >= 0n && v <= 12n) return 1;
    if (v >= -128n && v <= 127n) return 2;
    if (v >= -32768n && v <= 32767n) return 3;
    if (v >= -8388608n && v <= 8388607n) return 4;
    if (v >= -2147483648n && v <= 2147483647n) return 5;
    return 9;
  }
  function zlStrBody(len) {
    return (len <= 63 ? 1 : len <= 16383 ? 2 : 5) + len;
  }
  function intsetWidth(v) {
    if (v >= -32768n && v <= 32767n) return 2;
    if (v >= -2147483648n && v <= 2147483647n) return 4;
    return 8;
  }
  function digits(v) {
    return v.toString().length;
  }

  // The numbers start, start+1, ... start+count-1 in runs that share their
  // listpack, ziplist and intset sizes and their number of digits.
  const CUTS = (() => {
    const c = [-(2n ** 31n), -(2n ** 23n), -(2n ** 15n), -4096n, -128n, 0n, 13n, 128n, 4096n, 2n ** 15n, 2n ** 23n, 2n ** 31n];
    for (let k = 1n; k <= 18n; k++) { c.push(10n ** k); c.push(-(10n ** k) + 1n); }
    return [...new Set(c.map(String))].map(BigInt).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  })();
  function intRuns(start, count) {
    const runs = [];
    let a = start, left = BigInt(count);
    while (left > 0n) {
      let end = a + left - 1n;
      for (const c of CUTS) if (c > a && c <= end) { end = c - 1n; break; }
      const n = end - a + 1n;
      runs.push({ v: a, n: Number(n), last: end });
      a = end + 1n;
      left -= n;
    }
    return runs;
  }

  // Sum of f(element) over the count distinct elements of e.
  function sumDistinct(e, count, fInt, fStr) {
    const v = elemInt(e);
    if (v === null) return count * fStr(elemLen(e));
    let t = 0;
    for (const r of intRuns(v, count)) t += r.n * fInt(r.v);
    return t;
  }
  // Sum of f(element) for count copies of the same element.
  function sumSame(e, count, fInt, fStr) {
    const v = elemInt(e);
    return count * (v === null ? fStr(elemLen(e)) : fInt(v));
  }
  // The longest of the distinct elements.
  function maxLenDistinct(e, count) {
    const v = elemInt(e);
    if (v === null) return elemLen(e);
    let m = 0;
    for (const r of intRuns(v, count)) m = Math.max(m, digits(r.v), digits(r.last));
    return m;
  }

  // The most a listpack or ziplist grows to: a write that would take one
  // past 1 GB turns it into its big form (LISTPACK_MAX_SAFETY_SIZE).
  const SAFE_SIZE = 1073741824;

  // Ziplist bytes for pairs of entries (a hash's field and value, a sorted
  // set's member and score). Each entry starts with the size of the one
  // before it: 1 byte below 254, 5 bytes from 254. The first entries of the
  // pairs come in runs of the same body (encoding and payload); the second
  // is the same every time. Within a run the sizes settle after a pair or
  // two, so this takes time for each run, not each pair.
  function ziplistPairs(runs, second) {
    let total = 11, prev = 0;
    for (const r of runs) {
      let left = r.n, last = -1;
      while (left > 0) {
        const a = (prev < 254 ? 1 : 5) + r.body;
        const b = (a < 254 ? 1 : 5) + second;
        if (b === last) {
          total += left * (a + b);
          break;
        }
        total += a + b;
        prev = last = b;
        left--;
      }
    }
    return total;
  }
  // The ziplist bodies of distinct elements, as runs. A number is stored as
  // one when its text is shorter than 32 bytes, which a 64-bit one always is.
  function zlRuns(e, count) {
    const v = elemInt(e);
    if (v === null) return [{ body: zlStrBody(elemLen(e)), n: count }];
    return intRuns(v, count).map((r) => ({ body: zlIntBody(r.v), n: r.n }));
  }

  // ---- sorted set scores ----

  // A score as ZADD reads it (string2d): a decimal number or inf, and not
  // one so big or so small that strtod overflows to infinity or underflows
  // to zero.
  function parseScore(s) {
    const t = String(s).trim().toLowerCase();
    if (/^[+]?inf(inity)?$/.test(t)) return Infinity;
    if (/^-inf(inity)?$/.test(t)) return -Infinity;
    if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/.test(t)) return NaN;
    const d = Number(t);
    if (!Number.isFinite(d)) return NaN;
    if (d === 0 && /[1-9]/.test(t.split('e')[0])) return NaN;
    return d;
  }
  // A group's score; 0 when none is given.
  function scoreOf(g) {
    return g.score === undefined || g.score === null ? '0' : g.score;
  }
  // double2ll: a whole number within ±2^62 is kept as an integer.
  function double2ll(d) {
    if (!Number.isFinite(d) || d < -4611686018427387904 || d > 4611686018427387904 || Math.trunc(d) !== d) return null;
    return BigInt(d);
  }
  function expDigits(a, prec) {
    // a > 0; correctly rounded significant digits and the decimal exponent.
    const [m, e] = (prec === undefined ? a.toExponential() : a.toExponential(prec - 1)).split('e');
    return { d: m.replace('.', ''), x: Number(e) };
  }
  // printf("%.17g")
  function g17(d) {
    if (d === 0) return Object.is(d, -0) ? '-0' : '0';
    const neg = d < 0, { d: D, x: X } = expDigits(Math.abs(d), 17);
    let s;
    if (X < -4 || X >= 17) {
      const t = D.replace(/0+$/, '');
      s = t[0] + (t.length > 1 ? '.' + t.slice(1) : '') + 'e' + (X < 0 ? '-' : '+') + String(Math.abs(X)).padStart(2, '0');
    } else {
      let ip, fp;
      if (X >= 0) { ip = D.slice(0, X + 1); fp = D.slice(X + 1); } else { ip = '0'; fp = '0'.repeat(-X - 1) + D; }
      fp = fp.replace(/0+$/, '');
      s = ip + (fp ? '.' + fp : '');
    }
    return (neg ? '-' : '') + s;
  }
  // fpconv_dtoa, the Grisu2 printer Redis 7.2+ and Valkey use for a score
  // that isn't a whole number. Grisu2 usually finds the shortest digits but
  // now and then prints more (1.23e22 as 12300000000000001000000), and the
  // length is what counts here, so this is a port of it, from deps/fpconv in
  // the Redis and Valkey sources, under its own license:
  //
  //   Copyright (c) 2021, Redis Labs
  //   Copyright (c) 2013-2019, night-shift <as.smljk at gmail dot com>
  //   Copyright (c) 2009, Florian Loitsch < florian.loitsch at inria dot fr >
  //   All rights reserved.
  //
  //   Boost Software License - Version 1.0 - August 17th, 2003
  //
  //   Permission is hereby granted, free of charge, to any person or
  //   organization obtaining a copy of the software and accompanying
  //   documentation covered by this license (the "Software") to use,
  //   reproduce, display, distribute, execute, and transmit the Software, and
  //   to prepare derivative works of the Software, and to permit third-parties
  //   to whom the Software is furnished to do so, all subject to the
  //   following:
  //
  //   The copyright notices in the Software and this entire statement,
  //   including the above license grant, this restriction and the following
  //   disclaimer, must be included in all copies of the Software, in whole or
  //   in part, and all derivative works of the Software, unless such copies
  //   or derivative works are solely in the form of machine-executable object
  //   code generated by a source language processor.
  //
  //   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
  //   OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
  //   MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE AND
  //   NON-INFRINGEMENT. IN NO EVENT SHALL THE COPYRIGHT HOLDERS OR ANYONE
  //   DISTRIBUTING THE SOFTWARE BE LIABLE FOR ANY DAMAGES OR OTHER LIABILITY,
  //   WHETHER IN CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
  //   CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
  //   SOFTWARE.
  const GRISU_POWERS = (
    '18054884314459144840 13451937075301367670 10022474136428063862 14934650266808366570 11127181549972568877 ' +
    '16580792590934885855 12353653155963782858 18408377700990114895 13715310171984221708 10218702384817765436 ' +
    '15227053142812498563 11345038669416679861 16905424996341287883 12595523146049147757 9384396036005875287 ' +
    '13983839803942852151 10418772551374772303 15525180923007089351 11567161174868858868 17236413322193710309 ' +
    '12842128665889583758 9568131466127621947 14257626930069360058 10622759856335341974 15829145694278690180 ' +
    '11793632577567316726 17573882009934360870 13093562431584567480 9755464219737475723 14536774485912137811 ' +
    '10830740992659433045 16139061738043178685 12024538023802026127 17917957937422433684 13349918974505688015 ' +
    '9946464728195732843 14821387422376473014 11042794154864902060 16455045573212060422 12259964326927110867 ' +
    '18268770466636286478 13611294676837538539 10141204801825835212 15111572745182864684 11258999068426240000 ' +
    '16777216000000000000 12500000000000000000 9313225746154785156 13877787807814456755 10339757656912845936 ' +
    '15407439555097886824 11479437019748901445 17105694144590052135 12744735289059618216 9495567745759798747 ' +
    '14149498560666738074 10542197943230523224 15709099088952724970 11704190886730495818 17440603504673385349 ' +
    '12994262207056124023 9681479787123295682 14426529090290212157 10748601772107342003 16016664761464807395 ' +
    '11933345169920330789 17782069995880619868 13248674568444952270 9871031767461413346 14708983551653345445 ' +
    '10959046745042015199 16330252207878254650 12166986024289022870 18130221999122236476 13508068024458167312 ' +
    '10064294952495520794 14996968138956309548 11173611982879273257 16649979327439178909 12405201291620119593 ' +
    '9242595204427927429 13772540099066387757 10261342003245940623 15290591125556738113 11392378155556871081 ' +
    '16975966327722178521 12648080533535911531'
  ).split(' ').map(BigInt);
  const GRISU_EXPS = [
    -1220, -1193, -1166, -1140, -1113, -1087, -1060, -1034, -1007, -980, -954, -927, -901, -874, -847, -821,
    -794, -768, -741, -715, -688, -661, -635, -608, -582, -555, -529, -502, -475, -449, -422, -396, -369,
    -343, -316, -289, -263, -236, -210, -183, -157, -130, -103, -77, -50, -24, 3, 30, 56, 83, 109, 136, 162,
    189, 216, 242, 269, 295, 322, 348, 375, 402, 428, 455, 481, 508, 534, 561, 588, 614, 641, 667, 694, 720,
    747, 774, 800, 827, 853, 880, 907, 933, 960, 986, 1013, 1039, 1066
  ];
  const M64 = (1n << 64n) - 1n;
  const FRACMASK = 0x000FFFFFFFFFFFFFn, HIDDEN = 0x0010000000000000n;
  const TENS = [];
  for (let i = 19n; i >= 0n; i--) TENS.push(10n ** i);
  function grisuMultiply(a, b) {
    const lo = 0xFFFFFFFFn;
    const ahBl = (a.frac >> 32n) * (b.frac & lo);
    const alBh = (a.frac & lo) * (b.frac >> 32n);
    const alBl = (a.frac & lo) * (b.frac & lo);
    const ahBh = (a.frac >> 32n) * (b.frac >> 32n);
    let tmp = (ahBl & lo) + (alBh & lo) + (alBl >> 32n);
    tmp += 1n << 31n;
    return { frac: (ahBh + (ahBl >> 32n) + (alBh >> 32n) + (tmp >> 32n)) & M64, exp: a.exp + b.exp + 64 };
  }
  function grisuRound(digits, delta, rem, kappa, frac) {
    const n = digits.length;
    while (rem < frac && delta - rem >= kappa && (rem + kappa < frac || frac - rem > rem + kappa - frac)) {
      digits[n - 1]--;
      rem = (rem + kappa) & M64;
    }
  }
  // The digits and the decimal exponent K (value = digits * 10^K).
  function grisu2(d) {
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, d);
    const bits = view.getBigUint64(0);
    let w = { frac: bits & FRACMASK, exp: Number((bits >> 52n) & 0x7FFn) };
    if (w.exp) { w.frac += HIDDEN; w.exp -= 1075; } else w.exp = -1074;
    // Boundaries, from w before it is normalized.
    const upper = { frac: (w.frac << 1n) + 1n, exp: w.exp - 1 };
    while ((upper.frac & (HIDDEN << 1n)) === 0n) { upper.frac <<= 1n; upper.exp--; }
    upper.frac = (upper.frac << 10n) & M64;
    upper.exp -= 10;
    const ls = w.frac === HIDDEN ? 2 : 1;
    const lower = { frac: (w.frac << BigInt(ls)) - 1n, exp: w.exp - ls };
    lower.frac = (lower.frac << BigInt(lower.exp - upper.exp)) & M64;
    lower.exp = upper.exp;
    while ((w.frac & HIDDEN) === 0n) { w.frac <<= 1n; w.exp--; }
    w.frac = (w.frac << 11n) & M64;
    w.exp -= 11;
    // The cached power of ten.
    const approx = Math.trunc(-(upper.exp + 87) * 0.30102999566398114);
    let idx = Math.trunc((approx + 348) / 8);
    for (;;) {
      const cur = upper.exp + GRISU_EXPS[idx] + 64;
      if (cur < -60) idx++;
      else if (cur > -32) idx--;
      else break;
    }
    const k = -348 + idx * 8;
    const cp = { frac: GRISU_POWERS[idx], exp: GRISU_EXPS[idx] };
    w = grisuMultiply(w, cp);
    const up = grisuMultiply(upper, cp);
    const low = grisuMultiply(lower, cp);
    low.frac = (low.frac + 1n) & M64;
    up.frac = (up.frac - 1n) & M64;
    let K = -k;
    // generate_digits
    const wfrac = (up.frac - w.frac) & M64;
    let delta = (up.frac - low.frac) & M64;
    const shift = BigInt(-up.exp);
    const one = 1n << shift;
    let part1 = up.frac >> shift;
    let part2 = up.frac & (one - 1n);
    const digits = [];
    let kappa = 10;
    for (let i = 10; kappa > 0; i++) {
      const div = TENS[i];
      const digit = part1 / div;
      if (digit || digits.length) digits.push(Number(digit));
      part1 -= digit * div;
      kappa--;
      const tmp = ((part1 << shift) + part2) & M64;
      if (tmp <= delta) {
        K += kappa;
        grisuRound(digits, delta, tmp, (div << shift) & M64, wfrac);
        return { digits: digits, K: K };
      }
    }
    let unit = 18;
    for (;;) {
      part2 = (part2 * 10n) & M64;
      delta = (delta * 10n) & M64;
      kappa--;
      const digit = part2 >> shift;
      if (digit || digits.length) digits.push(Number(digit));
      part2 &= one - 1n;
      if (part2 < delta) {
        K += kappa;
        grisuRound(digits, delta, part2, one, (wfrac * TENS[unit]) & M64);
        return { digits: digits, K: K };
      }
      unit--;
    }
  }
  function fpconv(d) {
    const neg = d < 0 || Object.is(d, -0);
    if (d === 0) return (neg ? '-' : '') + '0';
    if (!Number.isFinite(d)) return (neg ? '-' : '') + (Number.isNaN(d) ? 'nan' : 'inf');
    const g = grisu2(Math.abs(d));
    const D = g.digits.join('');
    let nd = D.length;
    const K = g.K;
    let e = Math.abs(K + nd - 1);
    let s;
    if (K >= 0 && e < nd + 7) s = D + '0'.repeat(K);
    else if (K < 0 && (K > -7 || e < 4)) {
      const off = nd + K;
      s = off <= 0 ? '0.' + '0'.repeat(-off) + D : D.slice(0, off) + '.' + D.slice(off);
    } else {
      nd = Math.min(nd, 18 - (neg ? 1 : 0));
      s = D[0] + (nd > 1 ? '.' + D.slice(1, nd) : '') + 'e' + (K + nd - 1 < 0 ? '-' : '+');
      let cent = 0;
      if (e > 99) { cent = Math.floor(e / 100); s += cent; e -= cent * 100; }
      if (e > 9) { const dec = Math.floor(e / 10); s += dec; e -= dec * 10; } else if (cent) s += '0';
      s += e % 10;
    }
    return (neg ? '-' : '') + s;
  }

  // d2string as each version writes a score it can't keep as an integer.
  function scoreText(F, d) {
    if (Number.isNaN(d)) return 'nan';
    if (d === Infinity) return 'inf';
    if (d === -Infinity) return '-inf';
    if (d === 0) return Object.is(d, -0) ? '-0' : '0';
    if (F.zscore === 'zl') {
      if (d > -4503599627370495 && d < 4503599627370496 && Math.trunc(d) === d) return String(BigInt(d));
      return g17(d);
    }
    const ll = double2ll(d);
    if (ll !== null) return ll.toString();
    return F.zscore === 'g17' ? g17(d) : fpconv(d);
  }
  // The score as an element of the listpack (or ziplist) pair.
  function scoreElem(F, d) {
    if (!F.ziplist) {
      const ll = double2ll(d);
      if (ll !== null) return { int: ll.toString() };
    }
    const s = scoreText(F, d);
    const v = canonicalInt(s);
    return v !== null && (!F.ziplist || s.length < 32) ? { int: s } : { len: s.length };
  }

  // ---- random parts ----

  // Collisions in a Redis dict that keeps keys straight in its buckets
  // (no_value): every key after the first in a bucket needs a 16-byte
  // entry. Expected count for n keys in s buckets.
  function collisions(n, s) {
    if (n <= 0 || s <= 0) return { mean: 0, var: 0 };
    const q = Math.exp(n * Math.log1p(-1 / s));
    const mean = n - s * (1 - q);
    // Variance of the number of empty buckets.
    const q2 = Math.exp(n * Math.log1p(-2 / s));
    const v = s * q + s * (s - 1) * q2 - s * s * q * q;
    return { mean: mean, var: Math.max(0, v) };
  }
  // Child buckets of a Valkey hashtable: a bucket holds 7 entries, a chain
  // of k > 7 needs ceil((k-7)/6) more 64-byte buckets.
  function childBuckets(n, b) {
    if (n <= 0 || b <= 0) return { mean: 0, var: 0 };
    const p = 1 / b;
    if (n <= 7) return { mean: 0, var: 0 };
    let pk = Math.exp(n * Math.log1p(-p));
    const r = p / (1 - p);
    let m1 = 0, m2 = 0;
    for (let k = 0; k <= n && k < 400; k++) {
      if (k > 0) pk *= ((n - k + 1) / k) * r;
      if (k >= 8) {
        const c = Math.ceil((k - 7) / 6);
        m1 += pk * c;
        m2 += pk * c * c;
      }
    }
    const mean = b * m1;
    return { mean: mean, var: Math.max(0, b * (m2 - m1 * m1)) };
  }
  // A skiplist node has 1 + k levels with probability 0.75 * 0.25^k, at
  // most 32. Mean and variance of sizeClass(base + 16 * levels).
  const levelCache = new Map();
  function nodeSize(base) {
    if (levelCache.has(base)) return levelCache.get(base);
    let m1 = 0, m2 = 0;
    for (let l = 1; l <= 32; l++) {
      const p = l < 32 ? 0.75 * 0.25 ** (l - 1) : 0.25 ** 31;
      const c = sc(base + 16 * l);
      m1 += p * c;
      m2 += p * c * c;
    }
    const r = { mean: m1, var: m2 - m1 * m1 };
    levelCache.set(base, r);
    return r;
  }

  // ---- settings ----

  const DEFAULTS = {
    hashMaxListpackEntries: 512, hashMaxListpackValue: 64,
    setMaxIntsetEntries: 512, setMaxListpackEntries: 128, setMaxListpackValue: 64,
    zsetMaxListpackEntries: 128, zsetMaxListpackValue: 64,
    listMaxListpackSize: -2,
    maxmemoryPolicy: 'noeviction'
  };
  const SETTING_NAMES = {
    hashMaxListpackEntries: 'hash-max-listpack-entries', hashMaxListpackValue: 'hash-max-listpack-value',
    setMaxIntsetEntries: 'set-max-intset-entries', setMaxListpackEntries: 'set-max-listpack-entries',
    setMaxListpackValue: 'set-max-listpack-value', zsetMaxListpackEntries: 'zset-max-listpack-entries',
    zsetMaxListpackValue: 'zset-max-listpack-value', listMaxListpackSize: 'list-max-listpack-size',
    maxmemoryPolicy: 'maxmemory-policy'
  };
  const POLICIES = ['noeviction', 'allkeys-lru', 'volatile-lru', 'allkeys-lfu', 'volatile-lfu', 'allkeys-random',
    'volatile-random', 'volatile-ttl', 'allkeys-lrm', 'volatile-lrm'];
  // The settings, checked, with the defaults for those not given. Numbers
  // can come as text ('1024').
  function settingsOf(s) {
    if (s !== undefined && s !== null && (typeof s !== 'object' || Array.isArray(s))) throw new Error('Settings must be an object.');
    const S = Object.assign({}, DEFAULTS);
    for (const [k, v] of Object.entries(s || {})) {
      if (!Object.prototype.hasOwnProperty.call(DEFAULTS, k)) throw new Error('Unknown setting ' + k + '. Known: ' + Object.keys(DEFAULTS).join(', ') + '.');
      if (v === undefined || v === null) continue;
      if (k === 'maxmemoryPolicy') {
        const p = String(v).trim().toLowerCase();
        if (!POLICIES.includes(p)) throw new Error('maxmemory-policy is one of ' + POLICIES.join(', ') + '.');
        S[k] = p;
        continue;
      }
      const n = typeof v === 'string' && /^\s*-?\d+\s*$/.test(v) ? Number(v) : v;
      const min = k === 'listMaxListpackSize' ? -2147483648 : 0;
      if (!Number.isSafeInteger(n) || n < min || (k === 'listMaxListpackSize' && n > 2147483647)) {
        throw new Error(SETTING_NAMES[k] + (min ? ' must be a whole number: -1 to -5 for a size, or a count.' : ' must be a whole number of 0 or more.'));
      }
      S[k] = n;
    }
    // An LRU, LFU or LRM policy keeps a clock in every value object, so
    // Redis up to 8.0 and Valkey up to 8.0 stop sharing the numbers 0 to
    // 9999 (when maxmemory is set; without it the policy does nothing).
    S.sharedIntegers = !/lru|lfu|lrm/.test(S.maxmemoryPolicy);
    return S;
  }
  // The name a version gives a setting: Redis 6.2 says ziplist where later
  // versions say listpack, and neither 6.2 nor 7.0 has the set-max-listpack
  // settings (null).
  function settingName(key, id) {
    const F = features(id);
    if (!SETTING_NAMES[key]) throw new Error('Unknown setting ' + key + '.');
    if (/^setMaxListpack/.test(key) && !F.setListpack) return null;
    return F.ziplist ? SETTING_NAMES[key].replace('listpack', 'ziplist') : SETTING_NAMES[key];
  }

  // ---- tables ----

  // Bucket count of a Redis dict after n inserts, sized at least for
  // `presize` up front.
  function dictSize(n, presize) {
    if (n <= 0 && !presize) return 0;
    let s = presize ? p2(Math.max(presize, 4)) : 4;
    while (s < n) s *= 2;
    return s;
  }
  // Buckets of a Valkey hashtable after n inserts, sized for `presize`.
  function htBuckets(n, presize) {
    if (n <= 0 && !presize) return 0;
    let b = presize ? p2(Math.floor((presize * 5 - 1) / 32) + 1) : 1;
    while (7 * b < n) b *= 2;
    return b;
  }

  // The keyspace and expires tables for n keys. serverCron also doubles a
  // full table from Redis 7.4 and Valkey 8.0, and a Valkey hashtable that
  // holds exactly 7 per bucket.
  function keyTable(F, n, observed) {
    if (n <= 0) return { bytes: 0, mean: 0, var: 0, size: 0 };
    if (F.ks === 'ht') {
      let b = 1;
      while (7 * b <= n) b *= 2;
      const r = observed && observed.children !== undefined ? { mean: observed.children, var: 0 } : childBuckets(n, b);
      return { bytes: 64 * b, mean: 64 * r.mean, var: 64 * 64 * r.var, size: b };
    }
    const s = F.ks === 'dict' ? Math.max(4, p2(n)) : n <= 4 ? 4 : p2(n + 1);
    let mean = 0, v = 0;
    if (F.ks === 'kvobj' || F.ks === 'meta') {
      const r = observed && observed.collisions !== undefined ? { mean: observed.collisions, var: 0 } : collisions(n, s);
      mean = 16 * r.mean;
      v = 256 * r.var;
    }
    return { bytes: 8 * s, mean: mean, var: v, size: s };
  }

  // The structs of a database's two tables: the keys dict (with the
  // key-size histograms of Redis 8.0-8.6 in its metadata) and the expires
  // dict. Older versions make them at startup.
  function dbStructs(F) {
    const m = /^(redis|valkey)-(\d+)\.(\d+)/.exec(F.id);
    const v = [Number(m[2]), Number(m[3])];
    const ge = (a, b) => v[0] > a || (v[0] === a && v[1] >= b);
    if (F.R) {
      if (!ge(7, 4)) return { keys: 0, expires: 0 };
      if (!ge(8, 0)) return { keys: 64, expires: 64 };
      if (!ge(8, 8)) return { keys: 2560, expires: 64 };
      return { keys: 96, expires: 64 };
    }
    if (!ge(8, 0)) return { keys: 0, expires: 0 };
    if (!ge(8, 1)) return { keys: 80, expires: 80 };
    return { keys: 96, expires: 96 };
  }

  // ---- one key ----

  // What one key holds besides its value, in versions where the key isn't in
  // the value object: the dict entry and the key's own copy.
  function keyEntry(F, K) {
    if (F.ks === 'embkey') return sc(18 + (K <= 44 ? 3 : sdsHdr(K, F)) + K);
    return 24 + sdsNew(K, F);
  }

  // A value object with the key in it (kvobjCreate,
  // createObjectWithKeyAndExpire). Room for the expiry comes free when the
  // size class leaves 8 bytes over, except in Redis 8.6+.
  function keyObject(F, K, exp) {
    const hK = sdsHdr(K, F);
    const e = exp || K >= 128;
    const min = 16 + (e ? 8 : 0) + 1 + hK + K + 1;
    const size = sc(min);
    return { size: size, hasExpire: e || (F.ks !== 'meta' && size >= min + 8) };
  }

  // A string value that fits in the object with the key.
  function embedTest(F, K, V, exp) {
    const hK = sdsHdr(K, F);
    switch (F.str) {
      case 'k82': case 'v81': return 16 + K + 3 + (exp ? 8 : 0) + 4 + V <= 64;
      case 'k86': return 16 + K + 3 + 4 + V <= 64;
      case 'v90': return 16 + hK + K + 2 + (exp ? 8 : 0) + V + 4 <= 64;
      case 'v91': return V <= 255 && 8 + hK + K + 2 + (exp ? 8 : 0) + V + 4 <= 128;
    }
    return false;
  }
  function embedObject(F, K, V, exp) {
    const hK = sdsHdr(K, F);
    if (F.str === 'v91') {
      const min = 8 + (exp ? 8 : 0) + 1 + hK + K + 1 + Math.max(V + 4, 8);
      const size = sc(min);
      return { size: size, hasExpire: exp || size >= min + 8 };
    }
    const min = 16 + (exp ? 8 : 0) + 1 + hK + K + 1 + V + 4;
    const size = sc(min);
    return { size: size, hasExpire: exp || (F.str !== 'k86' && size >= min + 8) };
  }

  // One string key: { key, value, ttl } bytes, ttl being what an expiry
  // adds to the key (the expires table aside).
  function stringKey(F, K, e, S) {
    const V = elemLen(e);
    const num = elemInt(e) !== null && V <= 20 ? elemInt(e) : null;
    const big = V >= 32768;
    const valueSds = () => (big ? bigArg(V) : sdsNew(V, F));
    if (F.str === 'robj') {
      let value;
      if (num !== null) value = num >= 0n && num < 10000n && S.sharedIntegers ? 0 : 16;
      else if (V <= 44) value = sc(20 + V);
      else value = 16 + valueSds();
      const key = keyEntry(F, K);
      const enc = num !== null ? 'int' : V <= 44 ? 'embstr' : 'raw';
      return { plain: key + value, ttl: key + value + 24, enc: enc, encTtl: enc };
    }
    // The key goes into the value object; the expiry too, when set.
    const embstrArg = num === null && V <= (F.str === 'v91' ? 116 : 44);
    const build = (exp) => {
      if (num !== null) return { obj: keyObject(F, K, exp), sep: 0, emb: false };
      if (embstrArg) {
        if (embedTest(F, K, V, exp)) return { obj: embedObject(F, K, V, exp), sep: 0, emb: true };
        return { obj: keyObject(F, K, exp), sep: sdsNew(V, F), emb: false };
      }
      return { obj: keyObject(F, K, exp), sep: valueSds(), emb: false };
    };
    const plain = build(false);
    // SET ... EX and EXPIRE both add the expiry to the stored object:
    // nothing changes if it has room, otherwise it's made again.
    let withTtl = plain;
    if (!plain.obj.hasExpire) {
      if (plain.emb) withTtl = build(true);
      else withTtl = { obj: keyObject(F, K, true), sep: plain.sep, emb: false };
    }
    const encOf = (b) => (num !== null ? 'int' : b.emb ? 'embstr' : 'raw');
    return { plain: plain.obj.size + plain.sep, ttl: withTtl.obj.size + withTtl.sep, enc: encOf(plain), encTtl: encOf(withTtl) };
  }

  // The part of a collection key that isn't the collection: the key, the
  // object, and the expiry.
  function holder(F, K) {
    if (F.ks === 'dict' || F.ks === 'kvstore' || F.ks === 'embkey') {
      const base = keyEntry(F, K) + 16;
      return { plain: base, ttl: base + 24 };
    }
    const plain = keyObject(F, K, false);
    return { plain: plain.size, ttl: plain.hasExpire ? plain.size : keyObject(F, K, true).size };
  }

  // ---- hashes ----

  function hashValue(F, g, S) {
    const N = g.fields, f = g.field, v = g.value, once = g.writes !== 'each';
    const fl = maxLenDistinct(f, N), vl = elemLen(v);
    const long = fl > S.hashMaxListpackValue || vl > S.hashMaxListpackValue;
    let safety = false;
    if (N <= S.hashMaxListpackEntries && !long) {
      let bytes;
      if (F.ziplist) {
        const vv = elemInt(v);
        bytes = ziplistPairs(zlRuns(f, N), vv !== null ? zlIntBody(vv) : zlStrBody(vl));
      } else {
        bytes = 7 + sumDistinct(f, N, lpIntEntry, (l) => lpStrEntry(l, F)) + sumSame(v, N, lpIntEntry, (l) => lpStrEntry(l, F));
      }
      // HSET checks that the listpack stays within 1 GB: one command with
      // all the fields by the length of its arguments, one field at a time
      // by the listpack's own size.
      const raw = sumDistinct(f, N, digits, (l) => l) + N * vl;
      if (once ? raw <= SAFE_SIZE : bytes <= SAFE_SIZE) return { bytes: sc(bytes), rand: [], enc: F.ziplist ? 'ziplist' : 'listpack' };
      safety = true;
    }
    // A hash table. How big its bucket array starts out: one HSET with
    // more fields than a listpack takes sizes it for them (7.2+); a
    // listpack that grows past the limit becomes a table sized for what it
    // holds (7.0+).
    let pre = 0;
    if (safety) pre = 0;
    else if (once && F.presize && N > S.hashMaxListpackEntries) pre = N;
    else if (long) pre = 0;
    else if (!F.ziplist) pre = S.hashMaxListpackEntries + 1;
    const fieldSum = (fn) => sumDistinct(f, N, (x) => fn(digits(x)), fn);
    let bytes;
    const rand = [];
    const vs = sdsNew(vl, F);
    if (F.hashHT === 'G') {
      const b = htBuckets(N, pre);
      bytes = F.htHash + 64 * b + fieldSum((l) => entryAlloc(F, l, vl));
      rand.push(Object.assign({ kind: 'children' }, childBuckets(N, b)));
    } else {
      const s = dictSize(N, pre);
      const dict = F.hashHT === 'A' ? 96 : F.hashHT === 'E' || F.hashHT === 'F' ? 64 : 56;
      bytes = dict + 8 * s;
      if (F.hashHT === 'F') {
        bytes += fieldSum((l) => entryAlloc(F, l, vl));
        rand.push(Object.assign({ kind: 'collisions' }, collisions(N, s)));
      } else if (F.hashHT === 'D' || F.hashHT === 'E') bytes += N * 24 + fieldSum(mstr) + N * vs;
      else bytes += N * 24 + fieldSum((l) => sdsNew(l, F)) + N * vs;
    }
    return { bytes: bytes, rand: rand, enc: 'hashtable' };
  }
  // A hash table entry with the field and, when the two fit in 128 bytes,
  // the value (Redis 8.6+, Valkey 8.1+).
  function entryAlloc(F, fl, vl) {
    const t = sdsHdr(fl, F);
    const a = t + fl + 1 + vl + 4;
    if (a <= 128) return sc(a);
    return sc(8 + Math.max(t, 3) + fl + 1) + sdsNew(vl, F);
  }

  // ---- sets ----

  function setValue(F, g, S) {
    const N = g.members, m = g.member, once = g.writes !== 'each';
    const num = elemInt(m);
    const ml = maxLenDistinct(m, N);
    // An intset takes at most 2^30 numbers, whatever the setting.
    const intsetMax = Math.min(S.setMaxIntsetEntries, 1073741824);
    let safety = num !== null && N <= S.setMaxIntsetEntries && N > intsetMax;
    if (num !== null && N <= intsetMax) {
      let w = 2;
      for (const r of intRuns(num, N)) w = Math.max(w, intsetWidth(r.v), intsetWidth(r.last));
      return { bytes: sc(8 + N * w), rand: [], enc: 'intset' };
    }
    // Redis 7.2+ and Valkey: a listpack while small. One SADD that brings
    // numbers past the intset limit makes a listpack if it fits one. Each
    // member added checks that the listpack stays within 1 GB.
    const lpFits = N <= S.setMaxListpackEntries && ml <= S.setMaxListpackValue;
    if (F.setListpack && lpFits && (num === null || once) && !safety) {
      const bytes = 7 + sumDistinct(m, N, lpIntEntry, (l) => lpStrEntry(l, F));
      if (bytes <= SAFE_SIZE) return { bytes: sc(bytes), rand: [], enc: 'listpack' };
      safety = true;
    }
    let pre = 0;
    if (safety) pre = 0;
    else if (num !== null) {
      // An intset that outgrows its limit becomes a table sized for it.
      if (once && F.presize) pre = N;
      else pre = S.setMaxIntsetEntries + 1;
    } else if (F.setListpack) {
      if (once && N > S.setMaxListpackEntries) pre = N;
      else if (ml > S.setMaxListpackValue) pre = 1;
      else pre = S.setMaxListpackEntries + 1;
    }
    const memberSum = (fn) => sumDistinct(m, N, (x) => fn(digits(x)), fn);
    let bytes;
    const rand = [];
    if (F.setHT === 'G') {
      const b = htBuckets(N, pre);
      bytes = F.htSet + 64 * b + memberSum((l) => sdsNew(l, F));
      rand.push(Object.assign({ kind: 'children' }, childBuckets(N, b)));
    } else {
      const s = dictSize(N, pre);
      bytes = (F.setHT === 'A' ? 96 : F.setHT === 'E' ? 64 : 56) + 8 * s + memberSum((l) => sdsNew(l, F));
      if (F.setHT === 'A' || F.setHT === 'B') bytes += 24 * N;
      else rand.push(Object.assign({ kind: 'collisions' }, collisions(N, s)));
    }
    return { bytes: bytes, rand: rand, enc: 'hashtable' };
  }

  // ---- sorted sets ----

  function zsetValue(F, g, S) {
    const N = g.members, m = g.member, once = g.writes !== 'each';
    const ml = maxLenDistinct(m, N);
    const d = parseScore(scoreOf(g));
    const score = scoreElem(F, d);
    let safety = false;
    if (N <= S.zsetMaxListpackEntries && ml <= S.zsetMaxListpackValue && S.zsetMaxListpackEntries > 0) {
      let bytes;
      if (F.ziplist) {
        const sv = elemInt(score);
        bytes = ziplistPairs(zlRuns(m, N), sv !== null ? zlIntBody(sv) : zlStrBody(elemLen(score)));
      } else {
        bytes = 7 + sumDistinct(m, N, lpIntEntry, (l) => lpStrEntry(l, F)) + sumSame(score, N, lpIntEntry, (l) => lpStrEntry(l, F));
      }
      // Each member added checks that the listpack stays within 1 GB.
      if (bytes <= SAFE_SIZE) return { bytes: sc(bytes), rand: [], enc: F.ziplist ? 'ziplist' : 'listpack' };
      safety = true;
    }
    // A skiplist and a hash table from member to node.
    let pre = 0;
    if (safety) pre = 0;
    else if (F.presize) {
      if (once) pre = N;
      else if (ml > S.zsetMaxListpackValue || S.zsetMaxListpackEntries === 0) pre = 1;
      else pre = S.zsetMaxListpackEntries + 1;
    }
    let bytes = 16;
    const rand = [];
    const z = F.zset;
    if (z === 6 || z === 7) {
      const b = htBuckets(N, pre);
      bytes += F.htZset + 64 * b;
      rand.push(Object.assign({ kind: 'children' }, childBuckets(N, b)));
    } else {
      const s = dictSize(N, pre);
      bytes += (z === 1 ? 96 : 56) + 8 * s;
      if (z === 5) rand.push(Object.assign({ kind: 'collisions' }, collisions(N, s)));
      else bytes += 24 * N;
    }
    // The skiplist struct and its 32-level header node.
    bytes += z === 7 ? 640 : (z === 4 || z === 5 ? 40 : 32) + 640;
    // Nodes: their size depends on random levels.
    let nodes = { mean: 0, var: 0 };
    for (const k of skiplistNodes(F, m, N)) {
      const r = nodeSize(k.base);
      nodes = { mean: nodes.mean + k.count * r.mean, var: nodes.var + k.count * r.var };
      bytes += k.count * k.member;
    }
    rand.push({ kind: 'nodes', mean: nodes.mean, var: nodes.var });
    return { bytes: bytes, rand: rand, enc: 'skiplist' };
  }
  // The skiplist nodes of N members counting up from m: what a node takes
  // before its levels (16 bytes each), how many nodes take that, and the
  // block of each node's member when it isn't in the node. Redis 8.6+ and
  // Valkey 9.1 keep the member in the node.
  function skiplistNodes(F, m, N) {
    const lens = new Map();
    const v0 = elemInt(m);
    if (v0 === null) lens.set(elemLen(m), N);
    else for (const r of intRuns(v0, N)) lens.set(digits(r.v), (lens.get(digits(r.v)) || 0) + r.n);
    const out = [];
    for (const [l, count] of lens) {
      const h = l === 0 ? 1 : sdsHdr(l, F);
      if (F.zset === 5) out.push({ base: 17 + h + l, count: count, member: 0 });
      else if (F.zset === 7) out.push({ base: 18 + h + l, count: count, member: 0 });
      else out.push({ base: 24, count: count, member: sdsNew(l, F) });
    }
    return out;
  }

  // ---- lists ----

  // Size limit of a quicklist node (or of a list kept as one listpack) for
  // list-max-listpack-size; a positive value counts elements instead.
  function fillLimit(fill) {
    if (fill >= 0) return { size: 8192, count: Math.max(fill, 1) };
    const lv = [4096, 8192, 16384, 32768, 65536];
    return { size: lv[Math.min(-fill - 1, 4)], count: Infinity };
  }
  function listValue(F, g, S) {
    const N = g.items, e = g.item, once = g.writes !== 'each';
    const L = elemLen(e), num = elemInt(e) !== null && L <= 20 ? elemInt(e) : null;
    const fill = S.listMaxListpackSize, lim = fillLimit(fill);
    if (F.list === 'zl') {
      // Redis 6.2: a quicklist of ziplists; each push checks the node's
      // size plus the element plus an estimate of its overhead.
      const body = num !== null && L < 32 ? zlIntBody(num) : zlStrBody(L);
      const ovh = (L < 254 ? 1 : 5) + (L < 64 ? 1 : L < 16384 ? 2 : 5);
      // sizes[k] = bytes of a ziplist with k elements.
      const sizes = [11];
      let prev = 0;
      const grow = () => {
        const size = (prev < 254 ? 1 : 5) + body;
        sizes.push(sizes[sizes.length - 1] + size);
        prev = size;
      };
      grow();
      let k = 1;
      for (;;) {
        const next = sizes[k] + L + ovh;
        const ok = fill < 0 ? next <= lim.size : next <= 8192 && k < fill;
        if (!ok || k >= N) break;
        grow();
        k++;
      }
      const full = Math.floor(N / k), rest = N % k;
      const bytes = 40 + full * (32 + sc(sizes[k])) + (rest ? 32 + sc(sizes[rest]) : 0);
      return { bytes: bytes, rand: [], enc: 'quicklist', nodes: full + (rest ? 1 : 0) };
    }
    const entry = num !== null ? lpIntEntry(num) : lpStrEntry(L, F);
    const lpBytes = (k) => 7 + k * entry;
    const exceeds = (sz, count) => (lim.count === Infinity ? sz > lim.size : sz > 8192 || count > lim.count);
    // Redis 7.2+ and Valkey: a listpack while the list is small.
    let first = 0;
    if (F.list === 'lp') {
      if (once) {
        if (!exceeds(7 + N * L, N)) return { bytes: sc(lpBytes(N)), rand: [], enc: 'listpack' };
      } else {
        // One element at a time: the listpack takes elements while its size
        // plus the new element stays within the limit, then becomes the
        // first node of the quicklist.
        let j = 0;
        while (j < N && !exceeds(lpBytes(j) + L, j + 1)) j++;
        if (j >= N) return { bytes: sc(lpBytes(N)), rand: [], enc: 'listpack' };
        first = j;
      }
    }
    const node = 40;
    const large = F.plainNodes && (fill < 0 ? L > lim.size : L > 8192);
    if (large) {
      // Each element in a node of its own, as a plain allocation.
      const bytes = F.quicklist + N * (node + sc(L));
      return { bytes: bytes, rand: [], enc: 'quicklist', nodes: N };
    }
    let k = 1;
    while (k < N && !exceeds(lpBytes(k) + L + 8, k + 1)) k++;
    const rest = N - first;
    const full = Math.floor(rest / k), tail = rest % k;
    let bytes = F.quicklist + full * (node + sc(lpBytes(k))) + (tail ? node + sc(lpBytes(tail)) : 0);
    if (first) bytes += node + sc(lpBytes(first));
    return { bytes: bytes, rand: [], enc: 'quicklist', nodes: full + (tail ? 1 : 0) + (first ? 1 : 0) };
  }

  // ---- a whole dataset ----

  const TYPES = ['string', 'hash', 'set', 'zset', 'list'];

  // Limits: more keys than anyone has, the longest string the server takes
  // (proto-max-bulk-len, 512 MB), the most elements a collection holds.
  const MAX_COUNT = 1e15, MAX_LEN = 536870912, MAX_ELEMS = 4294967295;
  const COUNT_OF = { field: 'fields', member: 'members' };

  // A group, checked, as a copy with numbers given as { int: 42 } turned
  // into text.
  function checkGroup(g0) {
    if (!g0 || typeof g0 !== 'object') throw new Error('A group must be an object.');
    const g = Object.assign({}, g0);
    if (!TYPES.includes(g.type)) throw new Error('Unknown type ' + g.type + '. Types: ' + TYPES.join(', ') + '.');
    const need = (name, min, max, what) => {
      const v = g[name];
      if (!Number.isInteger(v) || v < min) throw new Error(name + ' must be a whole number of at least ' + min + '.');
      if (v > max) throw new Error(name + ' is ' + v + ', more than ' + what + '.');
    };
    need('count', 0, MAX_COUNT, 'the calculator takes (10^15)');
    need('key', 0, MAX_LEN, 'the 512 MB a key can have');
    const elem = (name) => {
      let e = g[name];
      if (e && typeof e === 'object' && (typeof e.int === 'number' || typeof e.int === 'bigint')) {
        if (typeof e.int === 'number' && !Number.isSafeInteger(e.int)) throw new Error(name + ': give a number this big as text, { int: \'' + e.int + '\' }.');
        e = g[name] = { int: String(e.int) };
      }
      if (!e || typeof e !== 'object' || (e.int === undefined && !(Number.isInteger(e.len) && e.len >= 0))) throw new Error(name + ' must be a length, { len: 10 }, or a number, { int: \'42\' }.');
      if (e.int === undefined && e.len > MAX_LEN) throw new Error(name + ' is ' + e.len + ' bytes, more than the 512 MB a string can have.');
      if (e.int !== undefined && canonicalInt(e.int) === null) throw new Error(name + ' ' + e.int + " isn't a whole number the server keeps as one: no leading zeros, within 64 bits.");
      // Fields and members count up from the number: the last must fit too.
      const v = elemInt(e), n = g[COUNT_OF[name]];
      if (v !== null && COUNT_OF[name] && Number.isInteger(n) && v + BigInt(n) - 1n > INT64_MAX) {
        throw new Error(n + ' ' + COUNT_OF[name] + ' counting up from ' + v + ' would pass ' + INT64_MAX + ', the largest number the server keeps as one. Start lower, or give a length.');
      }
    };
    if (g.type === 'string') elem('value');
    if (g.type === 'hash') { need('fields', 1, MAX_ELEMS, 'a hash holds'); elem('field'); elem('value'); }
    if (g.type === 'set' || g.type === 'zset') { need('members', 1, MAX_ELEMS, 'a set holds'); elem('member'); }
    if (g.type === 'zset' && Number.isNaN(parseScore(scoreOf(g)))) throw new Error('score must be a number, or inf or -inf.');
    if (g.type === 'list') { need('items', 1, MAX_ELEMS, 'a list holds'); elem('item'); }
    if (g.ttl !== undefined && g.ttl !== null && !(typeof g.ttl === 'number' && g.ttl >= 0 && g.ttl <= 1)) throw new Error('ttl is the share of keys with a TTL, a number from 0 to 1.');
    if (g.ttlCount !== undefined && g.ttlCount !== null && !(Number.isInteger(g.ttlCount) && g.ttlCount >= 0 && g.ttlCount <= g.count)) {
      throw new Error('ttlCount is how many of the ' + g.count + ' keys have a TTL.');
    }
    if (g.writes !== undefined && g.writes !== null && g.writes !== 'once' && g.writes !== 'each') throw new Error("writes is 'once' (one command per key) or 'each' (one element per command).");
    return g;
  }

  // How many keys of a group have a TTL.
  function ttlCount(g) {
    if (g.ttlCount !== undefined && g.ttlCount !== null) return g.ttlCount;
    const t = g.ttl || 0;
    return Math.round(g.count * Math.min(1, Math.max(0, t)));
  }

  // What the random parts weigh: a collision entry is 16 bytes, a child
  // bucket 64, skiplist nodes are counted in bytes.
  const RAND_BYTES = { collisions: 16, children: 64, nodes: 1 };

  // Memory for one group of keys (checked), without the keyspace tables.
  // `observed` can give the random parts as they turned out, totals for the
  // group: { collisions, children, nodes }.
  function groupCost(F, g, S, observed) {
    const n = g.count, nt = ttlCount(g);
    let perPlain, perTtl, enc, encTtl, rand = [], nodes;
    if (g.type === 'string') {
      const s = stringKey(F, g.key, g.value, S);
      perPlain = s.plain;
      perTtl = s.ttl;
      enc = s.enc;
      encTtl = s.encTtl;
    } else {
      const h = holder(F, g.key);
      const val = g.type === 'hash' ? hashValue(F, g, S) : g.type === 'set' ? setValue(F, g, S) : g.type === 'zset' ? zsetValue(F, g, S) : listValue(F, g, S);
      perPlain = h.plain + val.bytes;
      perTtl = h.ttl + val.bytes;
      enc = encTtl = val.enc;
      rand = val.rand;
      nodes = val.nodes;
    }
    let mean = 0, va = 0;
    for (const r of rand) {
      const w = RAND_BYTES[r.kind];
      if (observed && observed[r.kind] !== undefined) mean += w * observed[r.kind];
      else {
        mean += n * w * r.mean;
        // The keys of a group hold the same field or member names, which
        // land in the same buckets of every key's table: their collisions
        // and child buckets go together, so the spread grows with n, not
        // with its square root. Skiplist levels are drawn for each node.
        va += (r.kind === 'nodes' ? n : n * n) * w * w * r.var;
      }
    }
    return {
      exact: (n - nt) * perPlain + nt * perTtl, mean: mean, var: va,
      perKey: perPlain, perKeyTtl: perTtl, encoding: enc, encodingTtl: encTtl, ttlKeys: nt, nodes: nodes
    };
  }

  // estimate(groups, version, settings, options) → how much used_memory
  // grows when those keys are written to an empty database, once the
  // server has settled (rehashing done). options.observed can give the
  // random parts as they turned out: { keys: { collisions | children },
  // expires: {...}, groups: [{ collisions, children, nodes }] }.
  function estimate(groups, id, settings, options) {
    const F = features(id);
    const S = settingsOf(settings);
    const opt = options || {};
    const obs = opt.observed || {};
    const list = (Array.isArray(groups) ? groups : [groups]).map(checkGroup);
    let keys = 0, ttlKeys = 0, exact = 0, mean = 0, va = 0;
    const out = list.map((g, i) => {
      const c = groupCost(F, g, S, obs.groups && obs.groups[i]);
      keys += g.count;
      ttlKeys += c.ttlKeys;
      exact += c.exact;
      mean += c.mean;
      va += c.var;
      const bytes = c.exact + c.mean;
      return {
        type: g.type, count: g.count, ttlKeys: c.ttlKeys, encoding: c.encoding, encodingTtl: c.encodingTtl, nodes: c.nodes,
        bytes: bytes, perKey: g.count ? bytes / g.count : 0, sd: Math.sqrt(c.var),
        keyBytes: c.perKey, keyBytesTtl: c.perKeyTtl
      };
    });
    const kt = keyTable(F, keys, obs.keys);
    const et = keyTable(F, ttlKeys, obs.expires);
    // A database's dicts, made for its first key and its first expiry
    // (Redis 7.4+ and Valkey 8.0+; before, they exist from startup).
    const db = dbStructs(F);
    const fixed = (keys ? db.keys : 0) + (ttlKeys ? db.expires : 0);
    exact += fixed;
    // Up to Redis 8.0 and Valkey 8.0 every expiry is a dict entry of its own
    // (24 bytes, in the key's cost above); later versions point the expires
    // table at the key's object.
    exact += kt.bytes + et.bytes;
    mean += kt.mean + et.mean;
    // The keys with a TTL are in both tables, at matching places, so the
    // two tables' collisions go together: their spreads add up.
    const ksd = Math.sqrt(kt.var) + Math.sqrt(et.var);
    va += ksd * ksd;
    return {
      version: id, keys: keys, ttlKeys: ttlKeys,
      total: exact + mean, sd: Math.sqrt(va), exact: exact, random: mean,
      tables: {
        keys: { bytes: kt.bytes + kt.mean, buckets: kt.size, kind: F.ks === 'ht' ? 'buckets' : 'slots' },
        expires: { bytes: et.bytes + et.mean, buckets: et.size, kind: F.ks === 'ht' ? 'buckets' : 'slots' },
        database: fixed
      },
      groups: out
    };
  }

  // used_memory of each version right after it starts with the default
  // config, as INFO memory reports it to the one client asking.
  const EMPTY = {
    'redis-6.2.24': 874000, 'redis-7.0.15': 881784, 'redis-7.2.16': 889296, 'redis-7.4.11': 971792, 'redis-8.0.6': 675904,
    'redis-8.2.10': 677096, 'redis-8.4.7': 692728, 'redis-8.6.7': 729376, 'redis-8.8.3': 734376, 'redis-8.10.2': 738632,
    'valkey-7.2.14': 904080, 'valkey-8.0.11': 914992, 'valkey-8.1.10': 882184, 'valkey-9.0.6': 880568, 'valkey-9.1.2': 929512
  };
  function emptyServer(id) {
    features(id);
    return EMPTY[id];
  }

  function compare(groups, settings) {
    return versions().map((v) => estimate(groups, v.id, settings));
  }

  // ---- packing small strings into hashes ----

  // The same values kept as fields of hashes, `fields` to a hash: the key's
  // last digits become the field (user:1234567 → hash user:12345, field 67),
  // so the fields are numbers 0 to fields-1. A hash has one TTL for all its
  // fields, so the strings' TTLs don't carry over.
  function pack(group0, fields) {
    const group = checkGroup(group0);
    if (group.type !== 'string') throw new Error('Only strings can be packed into hashes.');
    if (!Number.isInteger(fields) || fields < 1 || fields > MAX_ELEMS) throw new Error('Pack into hashes of a whole number of fields, at least 1.');
    const M = fields;
    const d = String(M - 1).length;
    const key = Math.max(1, group.key - d);
    const full = Math.floor(group.count / M), rest = group.count % M;
    const base = { type: 'hash', key: key, field: { int: '0' }, value: group.value, writes: 'each' };
    const out = [];
    if (full) out.push(Object.assign({}, base, { count: full, fields: M }));
    if (rest) out.push(Object.assign({}, base, { count: 1, fields: rest }));
    return out;
  }

  // ---- the text form of a dataset ----

  // One group per line:
  //   1m strings key=24 value=100 ttl=30%
  //   50000 hashes key=16 fields=20 field=8 value=int:42 writes=each
  //   200 zsets key=10 members=1000 member=12 score=1759734012.5
  // A word left out takes its default, from GROUP_DEFAULTS. A # at the
  // start of a word, outside quotes, starts a comment.
  const TYPE_WORDS = {
    string: 'string', strings: 'string', hash: 'hash', hashes: 'hash', set: 'set', sets: 'set',
    zset: 'zset', zsets: 'zset', 'sorted-set': 'zset', 'sorted-sets': 'zset', list: 'list', lists: 'list'
  };
  const GROUP_DEFAULTS = {
    string: { key: 20, value: { len: 100 } },
    hash: { key: 20, fields: 10, field: { len: 8 }, value: { len: 20 } },
    set: { key: 20, members: 10, member: { len: 10 } },
    zset: { key: 20, members: 10, member: { len: 10 }, score: '0' },
    list: { key: 20, items: 10, item: { len: 20 } }
  };
  // A count: 2500, 2,500, 2_500, 2.5k, 1.5m, 2b, 1e6. Worked out in
  // decimal digits, so 1.1b is exactly 1100000000. null if it isn't one.
  function parseCount(t) {
    const m = /^(\d{1,3}(?:,\d{3})+|\d{1,3}(?:_\d{3})+|\d+)(?:\.(\d+))?(?:e\+?(\d{1,2}))?([kmb])?$/i.exec(String(t).trim());
    if (!m) return null;
    const frac = m[2] || '';
    let digits = (m[1].replace(/[,_]/g, '') + frac).replace(/^0+(?=\d)/, '');
    const e = (m[3] ? Number(m[3]) : 0) + (m[4] ? { k: 3, m: 6, b: 9 }[m[4].toLowerCase()] : 0) - frac.length;
    if (e < 0) {
      if (/[1-9]/.test(digits.slice(Math.max(0, digits.length + e)))) return null;
      digits = digits.slice(0, Math.max(0, digits.length + e)) || '0';
    } else digits += '0'.repeat(e);
    return Number(digits);
  }
  // A length in bytes: 100, 100b, 8k or 8kb (8192), 1.5mb. The units are
  // 1024 bytes and 1024 KB, as the server's own limits count them.
  function parseLength(t) {
    const m = /^(\d{1,3}(?:,\d{3})+|\d{1,3}(?:_\d{3})+|\d+)(?:\.(\d+))?\s*(b|bytes?|k|kb|kib|m|mb|mib)?$/i.exec(String(t).trim());
    if (!m) return null;
    const unit = (m[3] || 'b').toLowerCase();
    const mult = unit[0] === 'k' ? 1024 : unit[0] === 'm' ? 1048576 : 1;
    const n = Number(m[1].replace(/[,_]/g, '') + '.' + (m[2] || '0')) * mult;
    return Number.isInteger(n) ? n : null;
  }
  function parseElem(v, name) {
    let m = /^(?:int|number|num):([+-]?\d+)$/i.exec(v);
    if (m) {
      if (canonicalInt(m[1]) === null) throw new Error(name + ': ' + m[1] + " isn't a number the server keeps as one (no leading zeros, within 64 bits); give its length instead.");
      return { int: m[1] };
    }
    m = /^"(.*)"$/.exec(v) || /^'(.*)'$/.exec(v);
    if (m) {
      const bytes = utf8Length(m[1]);
      return canonicalInt(m[1]) !== null ? { int: m[1] } : { len: bytes };
    }
    const n = parseLength(v);
    if (n === null) throw new Error(name + ' should be a length in bytes (such as 100 or 8kb), int:N for a number, or "a sample" in quotes.');
    return { len: n };
  }
  // A line without its comment: from a # at the start or after a space,
  // outside quotes.
  function stripComment(line) {
    let q = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === q) q = null;
      } else if (c === '"' || c === "'") q = c;
      else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
    }
    return line;
  }
  function utf8Length(t) {
    let n = 0;
    for (const ch of t) {
      const c = ch.codePointAt(0);
      n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
    }
    return n;
  }
  function splitWords(line) {
    const out = [];
    const re = /(\S*?"[^"]*"\S*|\S*?'[^']*'\S*|\S+)/g;
    let m;
    while ((m = re.exec(line))) out.push(m[1]);
    return out;
  }
  // parse(text) → { groups, errors: [{ line, message }] }
  function parse(text) {
    const groups = [], errors = [];
    String(text || '').replace(/^﻿/, '').split(/\r?\n|\r/).forEach((raw, i) => {
      const line = stripComment(raw).trim();
      if (!line) return;
      try {
        const words = splitWords(line);
        const count = parseCount(words[0]);
        if (count === null) throw new Error('A line starts with how many keys, such as 1000 or 2.5m.');
        const typeWord = (words[1] || '').toLowerCase();
        let type = TYPE_WORDS[typeWord];
        let rest = words.slice(2);
        if (!type && typeWord === 'sorted' && /^sets?$/i.test(words[2] || '')) { type = 'zset'; rest = words.slice(3); }
        if (!type) throw new Error('The second word is the type: strings, hashes, sets, zsets or lists.');
        const g = Object.assign({ type: type, count: count }, JSON.parse(JSON.stringify(GROUP_DEFAULTS[type])));
        for (const w of rest) {
          const m = /^([a-z-]+)=(.*)$/i.exec(w);
          if (!m) throw new Error('Expected name=value, found ' + w + '.');
          const name = m[1].toLowerCase(), v = m[2];
          const num = () => {
            const n = parseCount(v);
            if (n === null) throw new Error(name + ' should be a whole number.');
            return n;
          };
          if (name === 'key') {
            const qm = /^"(.*)"$/.exec(v) || /^'(.*)'$/.exec(v);
            g.key = qm ? utf8Length(qm[1]) : parseLength(v);
            if (g.key === null) throw new Error('key should be a length in bytes, such as 24, or "an:example" in quotes.');
          } else if (name === 'value' && (type === 'string' || type === 'hash')) g.value = parseElem(v, name);
          else if ((name === 'fields' && type === 'hash') || (name === 'members' && (type === 'set' || type === 'zset')) || (name === 'items' && type === 'list')) g[name] = num();
          else if ((name === 'field' && type === 'hash') || (name === 'member' && (type === 'set' || type === 'zset')) || (name === 'item' && type === 'list')) g[name] = parseElem(v, name);
          else if (name === 'score' && type === 'zset') {
            if (Number.isNaN(parseScore(v))) throw new Error('score should be a number.');
            g.score = v;
          } else if (name === 'ttl') {
            const pm = /^(\d+(?:\.\d+)?)%$/.exec(v);
            delete g.ttl;
            delete g.ttlCount;
            if (pm) {
              if (Number(pm[1]) > 100) throw new Error('ttl is a share from 0% to 100%, or a number of keys.');
              g.ttl = Number(pm[1]) / 100;
            } else if (/^(all|yes)$/i.test(v)) g.ttl = 1;
            else if (/^(none|no)$/i.test(v)) g.ttl = 0;
            else {
              const n = parseCount(v);
              if (n === null) throw new Error('ttl is a share such as 30%, or a number of keys.');
              if (n > count) throw new Error('ttl=' + v + ' is more keys than the ' + count + ' on the line.');
              g.ttlCount = n;
            }
          } else if (name === 'writes') {
            if (!/^(once|each)$/i.test(v)) throw new Error('writes is once (one command per key) or each (one element per command).');
            g.writes = v.toLowerCase();
          } else throw new Error(name + " isn't something a " + (type === 'zset' ? 'sorted set' : type) + ' line takes.');
        }
        checkGroup(g);
        groups.push(g);
      } catch (e) {
        errors.push({ line: i + 1, message: e.message });
      }
    });
    return { groups: groups, errors: errors };
  }
  function formatElem(e) {
    return e.int !== undefined ? 'int:' + e.int : String(e.len);
  }
  // A number in plain decimals, never 1e-7 or 1e+21.
  function plain(x) {
    const s = String(x);
    const m = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(s);
    if (!m) return s;
    const digits = m[2] + (m[3] || ''), e = Number(m[4]);
    if (e < 0) return m[1] + '0.' + '0'.repeat(-e - 1) + digits;
    return m[1] + digits + '0'.repeat(Math.max(0, e - digits.length + 1));
  }
  // A share as a percentage, to 15 digits: 0.3 → '30', 1e-9 → '0.0000001'.
  function percent(share) {
    return plain(Number((share * 100).toPrecision(15)));
  }
  function format(groups0) {
    const groups = (Array.isArray(groups0) ? groups0 : [groups0]).map(checkGroup);
    return groups.map((g) => {
      const words = [plain(g.count), { string: 'strings', hash: 'hashes', set: 'sets', zset: 'zsets', list: 'lists' }[g.type], 'key=' + g.key];
      if (g.type === 'string') words.push('value=' + formatElem(g.value));
      if (g.type === 'hash') words.push('fields=' + g.fields, 'field=' + formatElem(g.field), 'value=' + formatElem(g.value));
      if (g.type === 'set' || g.type === 'zset') words.push('members=' + g.members, 'member=' + formatElem(g.member));
      if (g.type === 'zset') words.push('score=' + String(scoreOf(g)).trim());
      if (g.type === 'list') words.push('items=' + g.items, 'item=' + formatElem(g.item));
      if (g.ttlCount) words.push('ttl=' + plain(g.ttlCount));
      else if (g.ttl && (g.ttlCount === undefined || g.ttlCount === null)) words.push('ttl=' + percent(g.ttl) + '%');
      if (g.writes === 'each' && g.type !== 'string') words.push('writes=each');
      return words.join(' ');
    }).join('\n');
  }

  // The length of the longest of `count` distinct elements counting up from
  // e (the element itself, for text): -100000 is longer than -99901.
  function longest(e, count) {
    const g = checkGroup({ type: 'set', count: 1, key: 1, members: count, member: e });
    return maxLenDistinct(g.member, count);
  }

  return {
    versions: versions, findVersion: findVersion, features: features,
    estimate: estimate, compare: compare, pack: pack, parse: parse, format: format, emptyServer: emptyServer,
    defaults: Object.assign({}, DEFAULTS), settingNames: Object.assign({}, SETTING_NAMES), settingName: settingName,
    policies: POLICIES.slice(), parseCount: parseCount, parseLength: parseLength, longest: longest, checkGroup: checkGroup,
    sizeClass: sizeClass,
    _internal: {
      sdsNew: sdsNew, sdsHdr: sdsHdr, g17: g17, fpconv: fpconv, scoreText: scoreText, scoreElem: scoreElem,
      collisions: collisions, childBuckets: childBuckets, nodeSize: nodeSize, intRuns: intRuns,
      stringKey: stringKey, holder: holder, hashValue: hashValue, setValue: setValue, zsetValue: zsetValue,
      listValue: listValue, keyTable: keyTable, settingsOf: settingsOf, canonicalInt: canonicalInt, dbStructs: dbStructs,
      skiplistNodes: skiplistNodes, checkGroup: checkGroup, plain: plain
    }
  };
});
