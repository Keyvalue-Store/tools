// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Snapshot Viewer. Reads the RDB snapshots Redis and Valkey write (dump.rdb,
// the base file of an append-only directory, the output of redis-cli --rdb)
// and the payloads of the DUMP command: every key with its database, type,
// encoding, size in the file, expiry and value. Knows RDB versions 1 to 11
// shared by both servers, 12 to 15 from Redis and 80 from Valkey 9. One file,
// no dependencies. In a browser it defines KVRdb; in Node, require() returns
// the same functions.

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KVRdb = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const decoder = new TextDecoder('utf-8');
  const strictDecoder = new TextDecoder('utf-8', { fatal: true });
  const encoder = new TextEncoder();

  class RdbError extends Error {
    constructor(message, offset) {
      super(offset === undefined ? message : message + ' (at byte ' + offset.toLocaleString('en-US') + ')');
      this.offset = offset;
    }
  }

  // ---- Reading bytes ----

  // A source over bytes already in memory. The command line has its own
  // source that reads a file piece by piece; both offer the same methods.
  function bufferSource(bytes) {
    let pos = 0;
    const need = (n) => { if (pos + n > bytes.length) throw new RdbError('The file ends in the middle of a value', pos); };
    return {
      get pos() { return pos; },
      size: bytes.length,
      byte() { need(1); return bytes[pos++]; },
      bytes(n) { need(n); const b = bytes.subarray(pos, pos + n); pos += n; return b; },
      skip(n) { need(n); pos += n; },
      atEnd() { return pos >= bytes.length; },
      // CRC64 of everything before the current position.
      crc() { return crc64(bytes.subarray(0, pos)); },
      rest() { return bytes.length - pos; }
    };
  }

  const view = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
  const TWO32 = 4294967296;

  function u32be(b, o) { return ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]; }
  function u64be(b, o) { return BigInt(u32be(b, o)) * 4294967296n + BigInt(u32be(b, o + 4)); }
  function small(n) { return n <= BigInt(Number.MAX_SAFE_INTEGER) && n >= -BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n; }

  // ---- CRC64 (Jones polynomial, reflected), the checksum RDB files and DUMP payloads carry ----

  const CRC_LO = new Uint32Array(256), CRC_HI = new Uint32Array(256);
  (function () {
    const pLo = 0xac4bc9b5, pHi = 0x95ac9329;   // 0xad93d23594c935a9, bit-reversed
    for (let i = 0; i < 256; i++) {
      let lo = i, hi = 0;
      for (let k = 0; k < 8; k++) {
        const bit = lo & 1;
        lo = ((lo >>> 1) | ((hi & 1) << 31)) >>> 0;
        hi >>>= 1;
        if (bit) { lo = (lo ^ pLo) >>> 0; hi = (hi ^ pHi) >>> 0; }
      }
      CRC_LO[i] = lo; CRC_HI[i] = hi;
    }
  })();

  // Returns [low 32 bits, high 32 bits]. Pass the previous result to continue.
  function crc64(bytes, prev) {
    let lo = prev ? prev[0] : 0, hi = prev ? prev[1] : 0;
    for (let i = 0; i < bytes.length; i++) {
      const x = (lo ^ bytes[i]) & 0xff;
      lo = (((lo >>> 8) | ((hi & 0xff) << 24)) ^ CRC_LO[x]) >>> 0;
      hi = ((hi >>> 8) ^ CRC_HI[x]) >>> 0;
    }
    return [lo, hi];
  }
  const crcHex = (c) => c[1].toString(16).padStart(8, '0') + c[0].toString(16).padStart(8, '0');

  // ---- LZF, the compression RDB uses for strings ----

  function lzf(input, outLen) {
    const out = new Uint8Array(outLen);
    let ip = 0, op = 0;
    while (ip < input.length) {
      let ctrl = input[ip++];
      if (ctrl < 32) {
        ctrl++;
        if (op + ctrl > outLen || ip + ctrl > input.length) throw new RdbError('Compressed data is damaged');
        out.set(input.subarray(ip, ip + ctrl), op);
        ip += ctrl; op += ctrl;
      } else {
        let len = ctrl >> 5;
        let ref = op - ((ctrl & 0x1f) << 8) - 1;
        if (len === 7) len += input[ip++];
        ref -= input[ip++];
        len += 2;
        if (ref < 0 || op + len > outLen) throw new RdbError('Compressed data is damaged');
        for (let k = 0; k < len; k++) out[op++] = out[ref++];
      }
    }
    if (op !== outLen) throw new RdbError('Compressed data is shorter than its declared length');
    return out;
  }

  // ---- Lengths, strings and numbers ----

  // A length: 6 bits, 14 bits, or a 32- or 64-bit number that follows. The
  // value 11xxxxxx marks a specially encoded string instead (see readString).
  function lenFrom(src, b, big) {
    const t = b >> 6;
    if (t === 0) return big ? BigInt(b & 0x3f) : b & 0x3f;
    if (t === 1) { const v = ((b & 0x3f) << 8) | src.byte(); return big ? BigInt(v) : v; }
    if (b === 0x80) { const x = src.bytes(4); const v = u32be(x, 0); return big ? BigInt(v) : v; }
    if (b === 0x81) {
      const x = src.bytes(8);
      if (big) return u64be(x, 0);
      const hi = u32be(x, 0);
      if (hi >= 0x200000) throw new RdbError('A length is too large', src.pos - 8);
      return hi * TWO32 + u32be(x, 4);
    }
    throw new RdbError('Expected a length, found an encoded string', src.pos - 1);
  }
  const readLen = (src) => lenFrom(src, src.byte(), false);
  const readLenBig = (src) => lenFrom(src, src.byte(), true);

  // A string. Returns { bytes, length, enc } where enc is 'raw', 'int' or
  // 'lzf'. With skipLzf, compressed strings are skipped rather than
  // decompressed, and bytes is null.
  function readStringInfo(src, skipLzf) {
    const b = src.byte();
    if (b >> 6 !== 3) {
      const n = lenFrom(src, b, false);
      return { bytes: src.bytes(n), length: n, enc: 'raw' };
    }
    const enc = b & 0x3f;
    let v;
    if (enc === 0) v = (src.byte() << 24) >> 24;
    else if (enc === 1) { const x = src.bytes(2); v = view(x).getInt16(0, true); }
    else if (enc === 2) { const x = src.bytes(4); v = view(x).getInt32(0, true); }
    else if (enc === 3) {
      const clen = readLen(src), ulen = readLen(src);
      const c = src.bytes(clen);
      return { bytes: skipLzf ? null : lzf(c, ulen), length: ulen, enc: 'lzf', compressed: clen };
    } else throw new RdbError('Unknown string encoding ' + enc, src.pos - 1);
    const bytes = encoder.encode(String(v));
    return { bytes: bytes, length: bytes.length, enc: 'int' };
  }
  const readString = (src) => readStringInfo(src, false).bytes;

  function readMs(src) { return small(view(src.bytes(8)).getBigInt64(0, true)); }
  function readBinaryDouble(src) { return view(src.bytes(8)).getFloat64(0, true); }
  // Sorted sets before RDB 8 stored scores as text with a one-byte length.
  function readTextDouble(src) {
    const n = src.byte();
    if (n === 253) return NaN;
    if (n === 254) return Infinity;
    if (n === 255) return -Infinity;
    return parseFloat(decoder.decode(src.bytes(n)));
  }

  // ---- Compact encodings inside strings: ziplist, listpack, intset ----

  // Each returns the entries as Uint8Array (strings) or numbers/BigInts
  // (integers stored as integers).
  function ziplist(zl) {
    if (zl.length < 11) throw new RdbError('A ziplist is too short');
    const dv = view(zl);
    const out = [];
    let p = 10;
    while (p < zl.length && zl[p] !== 0xff) {
      p += zl[p] < 254 ? 1 : 5;                      // previous entry length
      const e = zl[p];
      if (e >> 6 === 0) { const n = e & 0x3f; out.push(zl.subarray(p + 1, p + 1 + n)); p += 1 + n; }
      else if (e >> 6 === 1) { const n = ((e & 0x3f) << 8) | zl[p + 1]; out.push(zl.subarray(p + 2, p + 2 + n)); p += 2 + n; }
      else if (e >> 6 === 2) { const n = u32be(zl, p + 1); out.push(zl.subarray(p + 5, p + 5 + n)); p += 5 + n; }
      else if (e === 0xc0) { out.push(dv.getInt16(p + 1, true)); p += 3; }
      else if (e === 0xd0) { out.push(dv.getInt32(p + 1, true)); p += 5; }
      else if (e === 0xe0) { out.push(small(dv.getBigInt64(p + 1, true))); p += 9; }
      else if (e === 0xf0) { out.push((zl[p + 1] | (zl[p + 2] << 8) | (zl[p + 3] << 16)) << 8 >> 8); p += 4; }
      else if (e === 0xfe) { out.push((zl[p + 1] << 24) >> 24); p += 2; }
      else if (e >= 0xf1 && e <= 0xfd) { out.push((e & 0x0f) - 1); p += 1; }
      else throw new RdbError('Unknown ziplist entry encoding 0x' + e.toString(16));
      if (p > zl.length) throw new RdbError('A ziplist entry runs past its end');
    }
    return out;
  }
  const ziplistCount = (zl) => { const n = zl.length >= 10 ? zl[8] | (zl[9] << 8) : 0; return n < 65535 ? n : ziplist(zl).length; };

  function listpack(lp) {
    if (lp.length < 7) throw new RdbError('A listpack is too short');
    const dv = view(lp);
    const out = [];
    let p = 6;
    while (p < lp.length && lp[p] !== 0xff) {
      const e = lp[p];
      let len;
      if ((e & 0x80) === 0) { out.push(e & 0x7f); len = 1; }
      else if ((e & 0xc0) === 0x80) { const n = e & 0x3f; out.push(lp.subarray(p + 1, p + 1 + n)); len = 1 + n; }
      else if ((e & 0xe0) === 0xc0) { let v = ((e & 0x1f) << 8) | lp[p + 1]; if (v >= 4096) v -= 8192; out.push(v); len = 2; }
      else if ((e & 0xf0) === 0xe0) { const n = ((e & 0x0f) << 8) | lp[p + 1]; out.push(lp.subarray(p + 2, p + 2 + n)); len = 2 + n; }
      else if (e === 0xf0) { const n = dv.getUint32(p + 1, true); out.push(lp.subarray(p + 5, p + 5 + n)); len = 5 + n; }
      else if (e === 0xf1) { out.push(dv.getInt16(p + 1, true)); len = 3; }
      else if (e === 0xf2) { out.push((lp[p + 1] | (lp[p + 2] << 8) | (lp[p + 3] << 16)) << 8 >> 8); len = 4; }
      else if (e === 0xf3) { out.push(dv.getInt32(p + 1, true)); len = 5; }
      else if (e === 0xf4) { out.push(small(dv.getBigInt64(p + 1, true))); len = 9; }
      else throw new RdbError('Unknown listpack entry encoding 0x' + e.toString(16));
      p += len + (len < 128 ? 1 : len < 16384 ? 2 : len < 2097152 ? 3 : len < 268435456 ? 4 : 5);
      if (p > lp.length) throw new RdbError('A listpack entry runs past its end');
    }
    return out;
  }
  const listpackCount = (lp) => { const n = lp.length >= 6 ? lp[4] | (lp[5] << 8) : 0; return n < 65535 ? n : listpack(lp).length; };

  function intset(b) {
    if (b.length < 8) throw new RdbError('An intset is too short');
    const dv = view(b);
    const width = dv.getUint32(0, true), n = dv.getUint32(4, true);
    if ((width !== 2 && width !== 4 && width !== 8) || 8 + width * n > b.length) throw new RdbError('An intset is damaged');
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const o = 8 + i * width;
      out[i] = width === 2 ? dv.getInt16(o, true) : width === 4 ? dv.getInt32(o, true) : small(dv.getBigInt64(o, true));
    }
    return out;
  }
  const intsetCount = (b) => (b.length >= 8 ? view(b).getUint32(4, true) : 0);

  // Integers stored compactly come back as numbers; as members of a set or a
  // list they are strings like any other.
  const asBytes = (x) => (x instanceof Uint8Array ? x : encoder.encode(String(x)));
  function asNumber(x) {
    if (!(x instanceof Uint8Array)) return Number(x);
    const t = decoder.decode(x);
    if (t === 'inf' || t === '+inf') return Infinity;
    if (t === '-inf') return -Infinity;
    return parseFloat(t);
  }
  const asInt = (x) => (x instanceof Uint8Array ? BigInt(decoder.decode(x)) : BigInt(x));

  // ---- Types ----

  // RDB type number -> [data type, encoding]. Numbers 22 and up mean
  // different things to Redis (RDB 12 to 15) and Valkey (RDB 80).
  const COMMON = {
    0: ['string', 'string'], 1: ['list', 'linked list'], 2: ['set', 'hashtable'], 3: ['zset', 'skiplist (text scores)'],
    4: ['hash', 'hashtable'], 5: ['zset', 'skiplist'], 6: ['module', 'module (4.0 pre-release)'], 7: ['module', 'module'],
    9: ['hash', 'zipmap'], 10: ['list', 'ziplist'], 11: ['set', 'intset'], 12: ['zset', 'ziplist'], 13: ['hash', 'ziplist'],
    14: ['list', 'quicklist (ziplists)'], 15: ['stream', 'listpacks'], 16: ['hash', 'listpack'], 17: ['zset', 'listpack'],
    18: ['list', 'quicklist'], 19: ['stream', 'listpacks'], 20: ['set', 'listpack'], 21: ['stream', 'listpacks']
  };
  const REDIS = {
    22: ['hash', 'hashtable with field TTLs (7.4 pre-release)'], 23: ['hash', 'listpack with field TTLs (7.4 pre-release)'],
    24: ['hash', 'hashtable with field TTLs'], 25: ['hash', 'listpack with field TTLs'], 26: ['stream', 'listpacks'],
    27: ['stream', 'listpacks'], 28: ['array', 'array'], 29: ['hash', 'template listpack'], 30: ['hash', 'template listpack'],
    31: ['hash', 'template array'], 32: ['hash', 'template array'], 33: ['gcra', 'gcra']
  };
  const VALKEY = { 22: ['hash', 'hashtable with field TTLs'] };

  function typeInfo(t, flavor) {
    if (COMMON[t]) return COMMON[t];
    if (flavor === 'redis') return REDIS[t] || null;
    if (flavor === 'valkey') return VALKEY[t] || null;
    return null;
  }

  // Module types are named by a 64-bit id: nine characters of 6 bits each,
  // then a 10-bit encoding version.
  const MODULE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  function moduleName(id) {
    let x = id >> 10n, name = '';
    for (let i = 0; i < 9; i++) { name = MODULE_CHARS[Number(x & 63n)] + name; x >>= 6n; }
    return { name: name, version: Number(id & 1023n) };
  }

  // Module data is written as typed items, ending with 0. Returns the count.
  function skipModuleItems(src) {
    let n = 0;
    for (;;) {
      const op = readLen(src);
      if (op === 0) return n;
      if (op === 1 || op === 2) readLenBig(src);
      else if (op === 3) src.skip(4);
      else if (op === 4) src.skip(8);
      else if (op === 5) readStringInfo(src, true);
      else throw new RdbError('Unknown module data item ' + op, src.pos);
      n++;
    }
  }

  // ---- Values ----

  const pairsOf = (items, want, fn) => {
    if (items.length % 2) throw new RdbError('An encoded hash or sorted set has an odd number of entries');
    const out = [];
    for (let i = 0; i < items.length; i += 2) out.push(fn(items[i], items[i + 1]));
    return out;
  };

  function readId(src) { const ms = readLenBig(src), seq = readLenBig(src); return ms + '-' + seq; }
  function rawId(b) { return u64be(b, 0) + '-' + u64be(b, 8); }

  // One listpack of a stream: a master entry with the field names, then
  // entries whose IDs are offsets from the listpack's key.
  function streamListpack(key, lp, out) {
    if (key.length !== 16) throw new RdbError('A stream node key is not 16 bytes');
    const ms = u64be(key, 0), seq = u64be(key, 8);
    const items = listpack(lp);
    const num = (x) => Number(x);
    let i = 0;
    i += 2;                                                      // count, deleted
    const nf = num(items[i++]);
    const master = items.slice(i, i + nf); i += nf;
    i++;                                                         // master terminator
    while (i < items.length) {
      const flags = num(items[i++]);
      const id = (ms + asInt(items[i++])) + '-' + (seq + asInt(items[i++]));
      const fields = [];
      if (flags & 2) { for (let k = 0; k < nf; k++) fields.push([master[k], asBytes(items[i++])]); }
      else { const n = num(items[i++]); for (let k = 0; k < n; k++) { fields.push([asBytes(items[i]), asBytes(items[i + 1])]); i += 2; } }
      i++;                                                       // lp-count
      if (!(flags & 1) && out) out.push([id, fields.map((f) => [asBytes(f[0]), f[1]])]);
    }
  }

  function readStream(src, t, flavor, want) {
    const nodes = readLen(src);
    const entries = want ? [] : null;
    for (let i = 0; i < nodes; i++) {
      const key = readString(src);
      const lp = readString(src);
      if (want) streamListpack(key, lp, entries);
    }
    const s = { entries: entries, length: readLen(src), lastId: readId(src) };
    if (t >= 19) { s.firstId = readId(src); s.maxDeletedId = readId(src); s.entriesAdded = small(readLenBig(src)); }
    const ngroups = readLen(src);
    s.groups = [];
    for (let g = 0; g < ngroups; g++) {
      const group = { name: readString(src), lastId: readId(src) };
      if (t >= 19) group.entriesRead = small(readLenBig(src));
      const npel = readLen(src);
      group.pending = [];
      for (let k = 0; k < npel; k++) {
        const id = rawId(src.bytes(16));
        group.pending.push({ id: id, deliveryTime: readMs(src), deliveries: small(readLenBig(src)) });
      }
      const ncons = readLen(src);
      group.consumers = [];
      for (let c = 0; c < ncons; c++) {
        const consumer = { name: readString(src), seenTime: readMs(src) };
        if (t >= 21) consumer.activeTime = readMs(src);
        const n = readLen(src);
        consumer.pending = [];
        for (let k = 0; k < n; k++) consumer.pending.push(rawId(src.bytes(16)));
        group.consumers.push(consumer);
      }
      if (flavor === 'redis' && t >= 27) {
        const n = readLen(src);
        group.nacked = [];
        for (let k = 0; k < n; k++) group.nacked.push(rawId(src.bytes(16)));
      }
      s.groups.push(group);
    }
    if (flavor === 'redis' && t >= 26) {
      const idmp = { duration: small(readLenBig(src)), maxEntries: small(readLenBig(src)), producers: [] };
      const np = readLen(src);
      for (let p = 0; p < np; p++) {
        const producer = { id: readString(src), entries: [] };
        const n = readLen(src);
        for (let k = 0; k < n; k++) producer.entries.push([readString(src), readId(src)]);
        idmp.producers.push(producer);
      }
      idmp.added = small(readLenBig(src));
      idmp.duplicates = small(readLenBig(src));
      s.idmp = idmp;
    }
    return { value: s, length: s.length, detail: nodes + (nodes === 1 ? ' listpack' : ' listpacks') };
  }

  // Template-encoded hashes (Redis 8.8 and later) store the field names once,
  // in a template, and each hash only its values.
  function readTemplateFields(src) {
    const fmt = readLen(src);
    if (fmt === 0) return listpack(readString(src)).map(asBytes);
    if (fmt !== 1) throw new RdbError('Unknown hash template field format ' + fmt, src.pos);
    const n = readLen(src), out = [];
    for (let i = 0; i < n; i++) out.push(readString(src));
    return out;
  }
  function templateValues(lp, fields, ctxTemplates) {
    const items = listpack(lp);
    const id = Number(items[0]);
    const names = fields || (ctxTemplates && ctxTemplates.get(id));
    if (!names) throw new RdbError('A hash refers to template ' + id + ', which the file does not define');
    if (items.length - 1 !== names.length) throw new RdbError('A template hash has ' + (items.length - 1) + ' values for ' + names.length + ' fields');
    return names.map((f, i) => [f, asBytes(items[i + 1])]);
  }

  // Reads one value of RDB type t. Returns { value, length, detail }:
  // value is null unless want is true; length is the number of elements, or
  // of bytes for a string.
  function readValue(src, t, flavor, ctx, want) {
    const list = (items) => ({ value: want ? items.map(asBytes) : null, length: items.length });
    switch (t) {
      case 0: {
        const s = readStringInfo(src, !want);
        return {
          value: s.bytes, length: s.length, encoding: s.enc === 'int' ? 'integer' : s.enc === 'lzf' ? 'compressed (LZF)' : 'raw',
          detail: s.enc === 'lzf' ? s.compressed.toLocaleString('en-US') + ' bytes compressed' : ''
        };
      }
      case 1: case 2: {
        const n = readLen(src), out = want ? [] : null;
        for (let i = 0; i < n; i++) { const s = readStringInfo(src, !want); if (want) out.push(s.bytes); }
        return { value: out, length: n };
      }
      case 3: case 5: {
        const n = readLen(src), out = want ? [] : null;
        for (let i = 0; i < n; i++) {
          const m = readStringInfo(src, !want);
          const score = t === 5 ? readBinaryDouble(src) : readTextDouble(src);
          if (want) out.push([m.bytes, score]);
        }
        return { value: out, length: n };
      }
      case 4: {
        const n = readLen(src), out = want ? [] : null;
        for (let i = 0; i < n; i++) {
          const f = readStringInfo(src, !want), v = readStringInfo(src, !want);
          if (want) out.push([f.bytes, v.bytes]);
        }
        return { value: out, length: n };
      }
      case 7: {
        const id = readLenBig(src);
        const m = moduleName(id);
        const items = skipModuleItems(src);
        return { value: null, length: null, detail: m.name + ', ' + items + ' data items, encoding version ' + m.version, module: m.name };
      }
      case 10: case 11: case 20: {
        const blob = readString(src);
        if (!want) return { value: null, length: t === 10 ? ziplistCount(blob) : t === 11 ? intsetCount(blob) : listpackCount(blob) };
        return list(t === 10 ? ziplist(blob) : t === 11 ? intset(blob) : listpack(blob));
      }
      case 12: case 13: case 16: case 17: {
        const blob = readString(src);
        const zl = t === 12 || t === 13;
        if (!want) return { value: null, length: (zl ? ziplistCount(blob) : listpackCount(blob)) / 2 };
        const items = zl ? ziplist(blob) : listpack(blob);
        const isZset = t === 12 || t === 17;
        const v = pairsOf(items, want, (a, b) => (isZset ? [asBytes(a), asNumber(b)] : [asBytes(a), asBytes(b)]));
        return { value: v, length: v.length };
      }
      case 14: case 18: {
        const nodes = readLen(src);
        const out = want ? [] : null;
        let count = 0, plain = 0;
        for (let i = 0; i < nodes; i++) {
          let container = 2;
          if (t === 18) container = readLen(src);
          const blob = readString(src);
          if (container === 1) { count++; plain++; if (want) out.push(blob); }
          else if (container === 2) {
            if (want) { const items = t === 14 ? ziplist(blob) : listpack(blob); count += items.length; for (const x of items) out.push(asBytes(x)); }
            else count += t === 14 ? ziplistCount(blob) : listpackCount(blob);
          } else throw new RdbError('Unknown quicklist container ' + container, src.pos);
        }
        return { value: out, length: count, detail: nodes + (nodes === 1 ? ' node' : ' nodes') + (plain ? ', ' + plain + ' stored plain' : '') };
      }
      case 15: case 19: case 21:
        return readStream(src, t, flavor, want);
    }
    if (flavor === 'redis') {
      switch (t) {
        case 22: case 24: {
          const minExpire = t === 24 ? BigInt(readMs(src)) : 0n;
          const n = readLen(src), out = want ? [] : null;
          let withTtl = 0;
          for (let i = 0; i < n; i++) {
            const ttl = readLenBig(src);
            const f = readStringInfo(src, !want), v = readStringInfo(src, !want);
            const at = ttl === 0n ? null : t === 24 ? small(ttl + minExpire - 1n) : small(ttl);
            if (at !== null) withTtl++;
            if (want) out.push([f.bytes, v.bytes, at]);
          }
          return { value: out, length: n, fieldTtls: withTtl };
        }
        case 23: case 25: {
          if (t === 25) readMs(src);
          const items = listpack(readString(src));
          if (items.length % 3) throw new RdbError('A hash listpack with field TTLs has a broken entry count');
          const out = [];
          let withTtl = 0;
          for (let i = 0; i < items.length; i += 3) {
            const ttl = asNumber(items[i + 2]);
            const at = ttl === 0 ? null : ttl;
            if (at !== null) withTtl++;
            out.push([asBytes(items[i]), asBytes(items[i + 1]), at]);
          }
          return { value: want ? out : null, length: out.length, fieldTtls: withTtl };
        }
        case 26: case 27:
          return readStream(src, t, flavor, want);
        case 28: {
          const count = readLen(src);
          const hasInsert = readLen(src);
          const insertIndex = hasInsert ? small(readLenBig(src)) : null;
          const out = want ? [] : null;
          for (let i = 0; i < count; i++) {
            const idx = small(readLenBig(src));
            const tag = readLen(src);
            let v;
            if (tag === 0 || tag === 3) v = readStringInfo(src, !want).bytes;
            else if (tag === 1) v = small(view(src.bytes(8)).getBigInt64(0, true));
            else if (tag === 2) v = readBinaryDouble(src);
            else throw new RdbError('Unknown array element tag ' + tag, src.pos);
            if (want) out.push([idx, v]);
          }
          return { value: out, length: count, insertIndex: insertIndex };
        }
        case 29: case 31: {
          const fields = readTemplateFields(src);
          if (t === 29) { const v = templateValues(readString(src), fields); return { value: want ? v : null, length: v.length }; }
          const out = [];
          for (const f of fields) out.push([f, readString(src)]);
          return { value: want ? out : null, length: out.length };
        }
        case 30: {
          const v = templateValues(readString(src), null, ctx.templates);
          return { value: want ? v : null, length: v.length };
        }
        case 32: {
          const id = readLen(src);
          const names = ctx.templates.get(id);
          if (!names) throw new RdbError('A hash refers to template ' + id + ', which the file does not define', src.pos);
          const out = [];
          for (const f of names) out.push([f, readString(src)]);
          return { value: want ? out : null, length: out.length };
        }
        case 33: {
          const tat = small(readLenBig(src));
          return { value: want ? tat : null, length: 1 };
        }
      }
    }
    if (flavor === 'valkey' && t === 22) {
      const n = readLen(src), out = want ? [] : null;
      let withTtl = 0;
      for (let i = 0; i < n; i++) {
        const f = readStringInfo(src, !want), v = readStringInfo(src, !want);
        const at = readMs(src);
        const exp = at === -1 ? null : at;
        if (exp !== null) withTtl++;
        if (want) out.push([f.bytes, v.bytes, exp]);
      }
      return { value: out, length: n, fieldTtls: withTtl };
    }
    if (t === 9) throw new RdbError('Zipmap hashes, written by Redis 2.4 and older, are not supported', src.pos);
    if (t === 6) throw new RdbError('Module values from Redis 4.0 release candidates are not supported', src.pos);
    throw new RdbError('Unknown value type ' + t, src.pos);
  }

  // ---- The file ----

  // Reads the header and returns a parser whose step() reads up to n keys.
  // Options: onKey(entry), values (decode values, default false).
  function parser(src, opts) {
    opts = opts || {};
    const head = src.bytes(9);
    const magic = decoder.decode(head);
    let version, flavor;
    if (magic.startsWith('REDIS') && /^\d{4}$/.test(magic.slice(5))) { version = parseInt(magic.slice(5), 10); flavor = version >= 12 ? 'redis' : 'common'; }
    else if (magic.startsWith('VALKEY') && /^\d{3}$/.test(magic.slice(6))) { version = parseInt(magic.slice(6), 10); flavor = 'valkey'; }
    else throw new RdbError('This is not an RDB file. A snapshot starts with REDIS or VALKEY and a version number.');
    if (flavor === 'common' && version > 11) throw new RdbError('Unknown RDB version ' + version);

    const info = {
      magic: magic, version: version, flavor: flavor, aux: [], functions: [], moduleAux: [], templates: 0,
      databases: [], slotInfo: 0, slotImports: [], keys: 0, done: false, end: null, checksum: null, trailing: 0
    };
    const ctx = { templates: new Map() };
    Object.defineProperty(info, 'templateMap', { value: ctx.templates, enumerable: false });
    const onKey = opts.onKey || (() => {});
    const want = !!opts.values;
    let db = 0, expire = null, idle = null, freq = null, keyMeta = 0, start = null;

    function step(max) {
      let n = 0;
      while (!info.done && n < max) {
        const at = src.pos;
        const t = src.byte();
        if (start === null) start = at;
        if (t === 252) { expire = readMs(src); continue; }
        if (t === 253) { expire = view(src.bytes(4)).getInt32(0, true) * 1000; continue; }
        if (t === 248) { idle = readLen(src); continue; }
        if (t === 249) { freq = src.byte(); continue; }
        if (t === 243 && flavor === 'redis') {               // key metadata from modules
          const classes = readLen(src);
          for (let i = 0; i < classes; i++) { src.skip(4); skipModuleItems(src); }
          keyMeta += classes;
          continue;
        }
        const info0 = typeInfo(t, flavor);
        if (info0) {
          const key = readString(src);
          const valueAt = src.pos;
          const v = readValue(src, t, flavor, ctx, want);
          const entry = {
            db: db, key: key, rdbType: t, type: info0[0], encoding: v.encoding || info0[1], detail: v.detail || '',
            expire: expire, idle: idle, freq: freq, offset: start, valueOffset: valueAt, size: src.pos - start,
            length: v.length, value: v.value
          };
          if (v.fieldTtls) entry.fieldTtls = v.fieldTtls;
          if (v.module) entry.module = v.module;
          if (v.insertIndex !== undefined) entry.insertIndex = v.insertIndex;
          if (keyMeta) entry.keyMeta = keyMeta;
          onKey(entry);
          info.keys++;
          n++;
          expire = idle = freq = null; keyMeta = 0; start = null;
          continue;
        }
        start = null;
        if (expire !== null || idle !== null || freq !== null) throw new RdbError('An expiry or access record is not followed by a key', at);
        if (t === 255) { finish(); break; }
        if (t === 254) { db = readLen(src); continue; }
        if (t === 251) { info.databases.push({ db: db, keys: readLen(src), expires: readLen(src) }); continue; }
        if (t === 250) { const k = readString(src), v = readString(src); info.aux.push([decoder.decode(k), decoder.decode(v)]); continue; }
        if (t === 245) { info.functions.push(decoder.decode(readString(src))); continue; }
        if (t === 247) {
          const m = moduleName(readLenBig(src));
          if (readLen(src) !== 2) throw new RdbError('Module data has a bad header', src.pos);
          const when = readLen(src);
          info.moduleAux.push({ module: m.name, when: when === 1 ? 'before keys' : 'after keys', items: skipModuleItems(src) });
          continue;
        }
        if (t === 244) { readLen(src); readLen(src); readLen(src); info.slotInfo++; continue; }
        if (t === 243 && flavor === 'valkey') {
          const job = decoder.decode(readString(src));
          const n2 = readLen(src), ranges = [];
          for (let i = 0; i < n2; i++) ranges.push([readLen(src), readLen(src)]);
          info.slotImports.push({ job: job, ranges: ranges });
          continue;
        }
        if (t === 242 && flavor === 'redis') {
          const id = readLen(src), count = readLen(src), fields = [];
          for (let i = 0; i < count; i++) fields.push(readString(src));
          ctx.templates.set(id, fields);
          info.templates++;
          continue;
        }
        if (t === 246) throw new RdbError('Functions saved by Redis 7.0 release candidates are not supported', at);
        throw new RdbError('Unknown record type ' + t, at);
      }
      return n;
    }

    function finish() {
      info.end = src.pos;
      info.done = true;
      if (version >= 5) {
        const computed = src.crc();
        if (src.rest() >= 8) {
          const b = src.bytes(8);
          const stored = [view(b).getUint32(0, true), view(b).getUint32(4, true)];
          info.checksum = stored[0] === 0 && stored[1] === 0
            ? { status: 'off', stored: crcHex(stored), computed: crcHex(computed) }
            : { status: stored[0] === computed[0] && stored[1] === computed[1] ? 'ok' : 'mismatch', stored: crcHex(stored), computed: crcHex(computed) };
        } else info.checksum = { status: 'missing', computed: crcHex(computed) };
      }
      info.trailing = src.rest();
    }

    return { info: info, step: step, get done() { return info.done; } };
  }

  // Reads a whole file. Returns the info object; entries go to opts.onKey.
  function read(src, opts) {
    const p = parser(src, opts);
    while (!p.done) {
      if (src.atEnd && src.atEnd()) throw new RdbError('The file ends before its end marker', src.pos);
      p.step(100000);
    }
    return p.info;
  }

  // Decodes one value again from its offset, for showing it on demand.
  function readValueFrom(src, entry, info) {
    const ctx = { templates: (info && info.templateMap) || new Map() };
    return readValue(src, entry.rdbType, info ? info.flavor : 'common', ctx, true).value;
  }
  function readValueAt(bytes, entry, info) {
    const src = bufferSource(bytes);
    src.skip(entry.valueOffset);
    return readValueFrom(src, entry, info);
  }

  // ---- DUMP payloads ----

  // DUMP returns one serialized value, then the RDB version (2 bytes) and a
  // CRC64 of everything before it. Valkey 9 writes version 80, Redis 8 up to 15.
  function readDump(bytes) {
    if (bytes.length < 11) throw new RdbError('Too short for a DUMP payload, which ends with a 2-byte version and an 8-byte checksum');
    // redis-cli adds a line break after raw output; drop it when the payload
    // only checks out without it.
    for (const cut of [1, 2]) {
      const tail = bytes.subarray(bytes.length - cut);
      if ((cut === 1 && tail[0] === 10) || (cut === 2 && tail[0] === 13 && tail[1] === 10)) {
        const b = bytes.subarray(0, bytes.length - cut);
        if (b.length >= 11 && dumpChecksumOk(b) && !dumpChecksumOk(bytes)) { bytes = b; break; }
      }
    }
    const n = bytes.length;
    const version = bytes[n - 10] | (bytes[n - 9] << 8);
    const flavor = version >= 80 ? 'valkey' : version >= 12 ? 'redis' : 'common';
    const computed = crc64(bytes.subarray(0, n - 8));
    const stored = [view(bytes).getUint32(n - 8, true), view(bytes).getUint32(n - 4, true)];
    const checksum = stored[0] === 0 && stored[1] === 0 ? 'off' : stored[0] === computed[0] && stored[1] === computed[1] ? 'ok' : 'mismatch';
    const src = bufferSource(bytes.subarray(0, n - 10));
    let t = src.byte(), keyMeta = 0;
    if (t === 243 && flavor === 'redis') {
      const classes = readLen(src);
      for (let i = 0; i < classes; i++) { src.skip(4); skipModuleItems(src); }
      keyMeta = classes;
      t = src.byte();
    }
    const ti = typeInfo(t, flavor);
    if (!ti) throw new RdbError('Unknown value type ' + t + ' for RDB version ' + version);
    const v = readValue(src, t, flavor, { templates: new Map() }, true);
    const out = { version: version, flavor: flavor, checksum: checksum, rdbType: t, type: ti[0], encoding: v.encoding || ti[1], detail: v.detail || '', length: v.length, value: v.value, extra: src.rest() };
    if (v.fieldTtls) out.fieldTtls = v.fieldTtls;
    if (v.module) out.module = v.module;
    if (keyMeta) out.keyMeta = keyMeta;
    return out;
  }

  function dumpChecksumOk(b) {
    const n = b.length;
    const c = crc64(b.subarray(0, n - 8));
    return view(b).getUint32(n - 8, true) === c[0] && view(b).getUint32(n - 4, true) === c[1];
  }

  // Turns text into bytes: hex (with or without spaces), redis-cli's quoted
  // form with \xHH escapes, or the bytes of the text itself.
  function bytesFromText(text) {
    const t = String(text).trim();
    const compact = t.replace(/\s+/g, '');
    if (compact.length && compact.length % 2 === 0 && /^(0x)?[0-9a-fA-F]+$/.test(compact)) {
      const hex = compact.replace(/^0x/, '');
      const out = new Uint8Array(hex.length / 2);
      for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
      return { bytes: out, form: 'hex' };
    }
    let s = t;
    if (/^"/.test(s) && /"$/.test(s)) s = s.slice(1, -1);
    if (/\\x[0-9a-fA-F]{2}/.test(s) || /^"/.test(t)) {
      const out = [];
      for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === '\\' && i + 1 < s.length) {
          const n = s[i + 1];
          if (n === 'x' && /^[0-9a-fA-F]{2}$/.test(s.substr(i + 2, 2))) { out.push(parseInt(s.substr(i + 2, 2), 16)); i += 3; continue; }
          const map = { n: 10, r: 13, t: 9, b: 8, a: 7, '"': 34, '\\': 92 };
          if (map[n] !== undefined) { out.push(map[n]); i++; continue; }
        }
        for (const b of encoder.encode(c)) out.push(b);
      }
      return { bytes: new Uint8Array(out), form: 'quoted' };
    }
    return { bytes: encoder.encode(t), form: 'text' };
  }

  // ---- Showing values ----

  // Bytes as text when they are printable UTF-8, otherwise with \xHH escapes,
  // the way redis-cli quotes them.
  function showBytes(b) {
    if (b === null || b === undefined) return '(not decoded)';
    try {
      const t = strictDecoder.decode(b);
      if (/^[^\x00-\x1f\x7f"\\]*$/.test(t)) return '"' + t + '"';
    } catch (e) { /* not UTF-8 */ }
    let s = '"';
    for (const c of b) {
      if (c === 0x5c) s += '\\\\';
      else if (c === 0x22) s += '\\"';
      else if (c === 10) s += '\\n';
      else if (c === 13) s += '\\r';
      else if (c === 9) s += '\\t';
      else if (c >= 0x20 && c < 0x7f) s += String.fromCharCode(c);
      else s += '\\x' + c.toString(16).padStart(2, '0');
    }
    return s + '"';
  }
  // A key for lists: plain text when safe, quoted when not.
  function showKey(b) {
    try {
      const t = strictDecoder.decode(b);
      if (/^[^\x00-\x20\x7f"\\]*$/.test(t) && t.length) return t;
    } catch (e) { /* fall through */ }
    return showBytes(b);
  }

  function fmtScore(x) {
    if (x === Infinity) return 'inf';
    if (x === -Infinity) return '-inf';
    return String(x);
  }
  function fmtTime(ms) { return ms === null || ms === undefined ? '' : new Date(Number(ms)).toISOString().replace('.000Z', 'Z'); }

  // A decoded value in redis-cli's style, at most max elements.
  function show(entry, value, max) {
    max = max || 1000;
    const lines = [];
    const more = (n) => { if (n > max) lines.push('... ' + (n - max).toLocaleString('en-US') + ' more'); };
    const type = entry.type;
    if (value === null || value === undefined) return '(value not decoded)';
    if (type === 'string') return showBytes(value);
    if (type === 'list' || type === 'set') {
      value.slice(0, max).forEach((v, i) => lines.push((i + 1) + ') ' + showBytes(v)));
      more(value.length);
    } else if (type === 'zset') {
      value.slice(0, max).forEach((v, i) => lines.push((i + 1) + ') ' + showBytes(v[0]) + '  ' + fmtScore(v[1])));
      more(value.length);
    } else if (type === 'hash') {
      value.slice(0, max).forEach((v, i) => lines.push((i + 1) + ') ' + showBytes(v[0]) + ' => ' + showBytes(v[1]) + (v[2] ? '  (expires ' + fmtTime(v[2]) + ')' : '')));
      more(value.length);
    } else if (type === 'array') {
      value.slice(0, max).forEach((v) => lines.push('[' + v[0] + '] ' + (v[1] instanceof Uint8Array ? showBytes(v[1]) : typeof v[1] === 'number' && !Number.isInteger(v[1]) ? '(double) ' + v[1] : '(integer) ' + v[1])));
      more(value.length);
    } else if (type === 'stream') {
      const s = value;
      s.entries.slice(0, max).forEach((e) => lines.push(e[0] + '  ' + e[1].map((f) => showBytes(f[0]) + ' ' + showBytes(f[1])).join('  ')));
      more(s.entries.length);
      lines.push('', 'last ID ' + s.lastId + (s.firstId ? ', first ID ' + s.firstId : '') + (s.entriesAdded !== undefined ? ', ' + s.entriesAdded + ' entries ever added' : ''));
      for (const g of s.groups) {
        lines.push('group ' + showBytes(g.name) + ': last delivered ' + g.lastId + ', ' + g.pending.length + ' pending' + (g.nacked && g.nacked.length ? ', ' + g.nacked.length + ' NACKed' : '') + ', consumers ' + (g.consumers.map((c) => showBytes(c.name) + ' (' + c.pending.length + ')').join(', ') || 'none'));
      }
      if (s.idmp && (s.idmp.producers.length || s.idmp.added)) lines.push('idempotent producers: ' + s.idmp.producers.length + ', IDs kept ' + s.idmp.duration + ' s, ' + s.idmp.added + ' added, ' + s.idmp.duplicates + ' duplicates caught');
    } else if (type === 'gcra') {
      lines.push('(integer) ' + value);
    } else lines.push('(value not shown)');
    return lines.join('\n');
  }

  // ---- Totals ----

  // Collects totals as keys arrive. snapshotTime (ms) sets the "now" for
  // TTLs; by default it comes from the file's ctime field.
  function summary(opts) {
    opts = opts || {};
    const top = opts.top || 50;
    const s = {
      keys: 0, bytes: 0, elements: 0, byType: {}, byEncoding: {}, byDb: {}, expiring: 0, expired: 0,
      ttl: { 'under 1 minute': 0, 'under 1 hour': 0, 'under 1 day': 0, 'under 1 week': 0, 'under 30 days': 0, 'longer': 0 },
      largest: [], longest: [], prefixes: new Map(), prefixOverflow: 0, modules: {}, fieldTtls: 0, idle: null, freq: null,
      streamEntries: 0, streamGroups: 0, streamPending: 0
    };
    let now = opts.snapshotTime || null;
    const keepTop = (arr, e, by) => {
      if (arr.length < top) { arr.push(e); arr.sort((a, b) => b[by] - a[by]); }
      else if (e[by] > arr[arr.length - 1][by]) { arr[arr.length - 1] = e; arr.sort((a, b) => b[by] - a[by]); }
    };
    return {
      setNow(ms) { now = ms; },
      add(e) {
        const len = e.length || 0;
        s.keys++; s.bytes += e.size; s.elements += e.type === 'string' ? 1 : len;
        const t = s.byType[e.type] || (s.byType[e.type] = { keys: 0, bytes: 0, elements: 0 });
        t.keys++; t.bytes += e.size; t.elements += e.type === 'string' ? 0 : len;
        const encName = e.type + ' / ' + e.encoding;
        const en = s.byEncoding[encName] || (s.byEncoding[encName] = { keys: 0, bytes: 0 });
        en.keys++; en.bytes += e.size;
        const d = s.byDb[e.db] || (s.byDb[e.db] = { keys: 0, bytes: 0, expiring: 0 });
        d.keys++; d.bytes += e.size;
        if (e.expire !== null) {
          s.expiring++; d.expiring++;
          if (now !== null) {
            const left = Number(e.expire) - now;
            if (left <= 0) s.expired++;
            else if (left < 60e3) s.ttl['under 1 minute']++;
            else if (left < 3600e3) s.ttl['under 1 hour']++;
            else if (left < 86400e3) s.ttl['under 1 day']++;
            else if (left < 7 * 86400e3) s.ttl['under 1 week']++;
            else if (left < 30 * 86400e3) s.ttl['under 30 days']++;
            else s.ttl.longer++;
          }
        }
        const lite = { db: e.db, key: e.key, type: e.type, encoding: e.encoding, size: e.size, length: e.length, expire: e.expire };
        keepTop(s.largest, lite, 'size');
        if (e.type !== 'string' && e.length !== null) keepTop(s.longest, lite, 'length');
        // Prefix: the key up to its first separator.
        let sep = e.key.indexOf(58);
        if (sep < 0) sep = e.key.findIndex((c) => c === 46 || c === 47 || c === 124);
        let prefix = decoder.decode(sep > 0 ? e.key.subarray(0, sep + 1) : e.key);
        if (sep <= 0) prefix = '(keys without a separator)';
        const p = s.prefixes.get(prefix);
        if (p) { p.keys++; p.bytes += e.size; }
        else if (s.prefixes.size < 100000) s.prefixes.set(prefix, { keys: 1, bytes: e.size });
        else s.prefixOverflow++;
        if (e.module) s.modules[e.module] = (s.modules[e.module] || 0) + 1;
        if (e.fieldTtls) s.fieldTtls += e.fieldTtls;
        if (e.idle !== null) {
          s.idle = s.idle || { 'under 1 hour': 0, 'under 1 day': 0, 'under 1 week': 0, 'longer': 0 };
          if (e.idle < 3600) s.idle['under 1 hour']++; else if (e.idle < 86400) s.idle['under 1 day']++; else if (e.idle < 604800) s.idle['under 1 week']++; else s.idle.longer++;
        }
        if (e.freq !== null) {
          s.freq = s.freq || { '0-4': 0, '5-15': 0, '16-63': 0, '64-255': 0 };
          if (e.freq < 5) s.freq['0-4']++; else if (e.freq < 16) s.freq['5-15']++; else if (e.freq < 64) s.freq['16-63']++; else s.freq['64-255']++;
        }
        if (e.type === 'stream' && e.value) {
          s.streamEntries += e.value.entries ? e.value.entries.length : 0;
        }
      },
      result() {
        const prefixes = Array.from(s.prefixes.entries()).map(([p, v]) => ({ prefix: p, keys: v.keys, bytes: v.bytes }))
          .sort((a, b) => b.keys - a.keys);
        return Object.assign({}, s, { prefixes: prefixes.slice(0, top), prefixCount: s.prefixes.size, snapshotTime: now });
      }
    };
  }

  function auxValue(info, name) {
    const a = info.aux.find((x) => x[0] === name);
    return a ? a[1] : null;
  }
  // The library name from a function's code, its first line "#!lua name=lib".
  function functionName(code) {
    const m = /^#!(\w+)\s+name=([^\s]+)/.exec(code);
    return m ? m[2] + ' (' + m[1] + ')' : code.slice(0, 40);
  }

  return {
    RdbError: RdbError,
    bufferSource: bufferSource,
    crc64: crc64,
    crcHex: crcHex,
    lzf: lzf,
    ziplist: ziplist,
    listpack: listpack,
    intset: intset,
    moduleName: moduleName,
    typeInfo: typeInfo,
    parser: parser,
    read: read,
    readValueAt: readValueAt,
    readValueFrom: readValueFrom,
    readDump: readDump,
    bytesFromText: bytesFromText,
    showBytes: showBytes,
    showKey: showKey,
    show: show,
    fmtTime: fmtTime,
    summary: summary,
    auxValue: auxValue,
    functionName: functionName
  };
});
