// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Value Inspector. Takes a value as it sits in Redis, Valkey, Memcached or
// any key-value store, works out what format it's in and decodes it,
// layer by layer: base64 or hex text, gzip, zlib, LZ4 or Snappy
// compression, and then JSON, JWT, MessagePack, CBOR, BSON, Protocol
// Buffers, PHP serialize and sessions, igbinary, Java serialization,
// Python pickle and Ruby Marshal. Nothing is ever run: pickles, Java
// streams and Marshal data are read as data, never executed. One file, no
// dependencies. In a browser it defines KVInspect; in Node, require()
// returns the same functions.

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KVInspect = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8');
  const strictDecoder = new TextDecoder('utf-8', { fatal: true });

  class FormatError extends Error {
    constructor(message, at) { super(at === undefined ? message : message + ' (at byte ' + at + ')'); this.at = at; }
  }

  // ---- Values ----
  //
  // Every decoder returns the same kind of tree, so one printer shows them all:
  //   { t: 'map', entries: [[key, value], ...] }   dicts, hashes, objects' fields
  //   { t: 'list', items: [...], kind }             arrays, lists, tuples, sets
  //   { t: 'str', v }    text          { t: 'bin', v }   bytes
  //   { t: 'int', v }    whole number, as a string so big ones stay exact
  //   { t: 'float', v }  number        { t: 'num', v }   decimal written as text
  //   { t: 'bool', v }   { t: 'null' } { t: 'date', v, text }
  //   { t: 'obj', cls, fields: [[name, value]], items: [...], note }
  //   { t: 'tagged', tag, v }  a value with a label, such as a CBOR tag
  //   { t: 'ref', v }    a back-reference to something shown earlier
  // Anything may carry a note.
  const V = {
    map: (entries, note) => ({ t: 'map', entries: entries, note: note }),
    list: (items, kind) => ({ t: 'list', items: items, kind: kind }),
    str: (v) => ({ t: 'str', v: v }),
    bin: (v) => ({ t: 'bin', v: v }),
    int: (v) => ({ t: 'int', v: String(v) }),
    float: (v) => ({ t: 'float', v: v }),
    num: (v) => ({ t: 'num', v: String(v) }),
    bool: (v) => ({ t: 'bool', v: !!v }),
    nul: (note) => ({ t: 'null', note: note }),
    date: (ms, text) => ({ t: 'date', v: ms, text: text }),
    obj: (cls, fields, items, note) => ({ t: 'obj', cls: cls, fields: fields || [], items: items, note: note }),
    tagged: (tag, v) => ({ t: 'tagged', tag: tag, v: v }),
    ref: (v) => ({ t: 'ref', v: v })
  };

  // Text from bytes when it's valid UTF-8, or null.
  function utf8(b) { try { return strictDecoder.decode(b); } catch (e) { return null; } }
  // A string value: text when it's UTF-8, bytes otherwise.
  const textOrBytes = (b) => { const t = utf8(b); return t === null ? V.bin(b) : V.str(t); };
  const latin1 = (b) => { let s = ''; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, b.subarray(i, i + 8192)); return s; };
  const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  const concat = (parts) => { let n = 0; for (const p of parts) n += p.length; const out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
  // Printable text: no control characters but tab, line feed and carriage return.
  const printable = (t) => !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(t);
  function isoTime(ms) {
    if (!isFinite(ms) || Math.abs(ms) > 8.64e15) return null;
    return new Date(ms).toISOString().replace('.000Z', 'Z');
  }

  // A cursor over bytes with the reads every format needs.
  class Reader {
    constructor(b, pos) { this.b = b; this.pos = pos || 0; this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength); }
    get left() { return this.b.length - this.pos; }
    need(n) { if (this.pos + n > this.b.length) throw new FormatError('The value ends early', this.pos); }
    u8() { this.need(1); return this.b[this.pos++]; }
    peek() { this.need(1); return this.b[this.pos]; }
    bytes(n) { if (n < 0) throw new FormatError('Negative length', this.pos); this.need(n); const v = this.b.subarray(this.pos, this.pos + n); this.pos += n; return v; }
    u16be() { this.need(2); const v = this.dv.getUint16(this.pos); this.pos += 2; return v; }
    u16le() { this.need(2); const v = this.dv.getUint16(this.pos, true); this.pos += 2; return v; }
    i16be() { this.need(2); const v = this.dv.getInt16(this.pos); this.pos += 2; return v; }
    u32be() { this.need(4); const v = this.dv.getUint32(this.pos); this.pos += 4; return v; }
    u32le() { this.need(4); const v = this.dv.getUint32(this.pos, true); this.pos += 4; return v; }
    i32be() { this.need(4); const v = this.dv.getInt32(this.pos); this.pos += 4; return v; }
    i32le() { this.need(4); const v = this.dv.getInt32(this.pos, true); this.pos += 4; return v; }
    u64be() { this.need(8); const v = this.dv.getBigUint64(this.pos); this.pos += 8; return v; }
    u64le() { this.need(8); const v = this.dv.getBigUint64(this.pos, true); this.pos += 8; return v; }
    i64be() { this.need(8); const v = this.dv.getBigInt64(this.pos); this.pos += 8; return v; }
    i64le() { this.need(8); const v = this.dv.getBigInt64(this.pos, true); this.pos += 8; return v; }
    f16be() { this.need(2); const h = this.dv.getUint16(this.pos); this.pos += 2; return half(h); }
    f32be() { this.need(4); const v = this.dv.getFloat32(this.pos); this.pos += 4; return v; }
    f32le() { this.need(4); const v = this.dv.getFloat32(this.pos, true); this.pos += 4; return v; }
    f64be() { this.need(8); const v = this.dv.getFloat64(this.pos); this.pos += 8; return v; }
    f64le() { this.need(8); const v = this.dv.getFloat64(this.pos, true); this.pos += 8; return v; }
    // Unsigned LEB128, as BigInt when it's past 2^53.
    varint() {
      let result = 0n, shift = 0n;
      for (let i = 0; i < 10; i++) {
        const c = this.u8();
        result |= BigInt(c & 0x7f) << shift;
        if (!(c & 0x80)) return result;
        shift += 7n;
      }
      throw new FormatError('A varint runs past 10 bytes', this.pos);
    }
    cstring() {
      const end = this.b.indexOf(0, this.pos);
      if (end < 0) throw new FormatError('A name has no terminating zero', this.pos);
      const v = this.b.subarray(this.pos, end);
      this.pos = end + 1;
      return v;
    }
  }
  function half(h) {
    const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
    if (e === 0) return s * Math.pow(2, -14) * (f / 1024);
    if (e === 31) return f ? NaN : s * Infinity;
    return s * Math.pow(2, e - 15) * (1 + f / 1024);
  }
  const num = (x) => (typeof x === 'bigint' && x >= BigInt(Number.MIN_SAFE_INTEGER) && x <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(x) : x);

  // ---- What was pasted ----

  // Text as redis-cli prints it in quotes, hex, or plain text. Returns
  // { bytes, form } with form 'quoted', 'hex' or 'text'.
  function fromInput(text) {
    const s = String(text);
    const t = s.trim();
    if (t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"') {
      const q = unquote(t.slice(1, -1));
      if (q) return { bytes: q, form: 'quoted' };
    }
    // Hex with spaces, colons or a 0x in front. Hex digits run together
    // could just as well be text, such as a hash, so those stay text, and
    // the analysis tries them as hex later.
    const h = t.replace(/^0x/i, '').replace(/[\s:]+/g, '');
    if (h.length >= 2 && h.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(h) && (/^0x/i.test(t) || /^[0-9a-fA-F]{2}([\s:]+[0-9a-fA-F]{2})+$/.test(t))) {
      return { bytes: hexBytes(h), form: 'hex' };
    }
    return { bytes: encoder.encode(s), form: 'text' };
  }
  // redis-cli's escapes inside quotes: \xHH, \n, \r, \t, \a, \b, \" and \\.
  function unquote(s) {
    const out = [];
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '\\') {
        const n = s[i + 1];
        if (n === 'x' && /^[0-9a-fA-F]{2}$/.test(s.substr(i + 2, 2))) { out.push(parseInt(s.substr(i + 2, 2), 16)); i += 3; continue; }
        const map = { n: 10, r: 13, t: 9, a: 7, b: 8, '"': 34, '\\': 92 };
        if (map[n] !== undefined) { out.push(map[n]); i++; continue; }
        return null;
      }
      if (c === '"') return null;
      for (const b of encoder.encode(c)) out.push(b);
    }
    return new Uint8Array(out);
  }
  function hexBytes(h) { const b = new Uint8Array(h.length / 2); for (let i = 0; i < b.length; i++) b[i] = parseInt(h.substr(i * 2, 2), 16); return b; }

  // Base64, standard or URL-safe, with or without padding. Returns bytes or null.
  const B64 = new Int16Array(256).fill(-1);
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.split('').forEach((c, i) => { B64[c.charCodeAt(0)] = i; });
  B64['-'.charCodeAt(0)] = 62; B64['_'.charCodeAt(0)] = 63;
  function base64Bytes(s) {
    const t = s.replace(/[\r\n]/g, '').replace(/=+$/, '');
    if (t.length % 4 === 1) return null;
    const out = new Uint8Array(Math.floor(t.length * 3 / 4));
    let o = 0, acc = 0, bits = 0;
    for (let i = 0; i < t.length; i++) {
      const v = B64[t.charCodeAt(i)];
      if (v < 0) return null;
      acc = (acc << 6) | v; bits += 6;
      if (bits >= 8) { bits -= 8; out[o++] = (acc >> bits) & 0xff; }
    }
    return out.subarray(0, o);
  }
  // Looks like base64 on its own: one alphabet, long enough, sensible padding.
  function looksBase64(t) {
    if (t.length < 8) return null;
    const plain = /^[A-Za-z0-9+/]+={0,2}$/.test(t) && t.length % 4 === 0;
    const url = /^[A-Za-z0-9_-]+$/.test(t) && t.length % 4 !== 1;
    if (!plain && !url) return null;
    // Words and numbers alone are base64-shaped too; ask for a mix.
    if (!/[A-Z]/.test(t) || !/[a-z]/.test(t) || !/[0-9+/_-]/.test(t)) return null;
    return base64Bytes(t);
  }

  // ---- Checksums ----

  const CRC32 = new Int32Array(256), CRC32C = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i, d = i;
    for (let k = 0; k < 8; k++) { c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; d = d & 1 ? 0x82f63b78 ^ (d >>> 1) : d >>> 1; }
    CRC32[i] = c; CRC32C[i] = d;
  }
  function crc32(b, table) {
    table = table || CRC32;
    let c = -1;
    for (let i = 0; i < b.length; i++) c = table[(c ^ b[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  }
  function adler32(b) {
    let a = 1, s = 0;
    for (let i = 0; i < b.length; i++) { a = (a + b[i]) % 65521; s = (s + a) % 65521; }
    return ((s << 16) | a) >>> 0;
  }
  // xxHash32, which LZ4 frames use.
  function xxh32(b, seed) {
    const P1 = 2654435761, P2 = 2246822519, P3 = 3266489917, P4 = 668265263, P5 = 374761393;
    const rotl = (x, r) => (x << r) | (x >>> (32 - r));
    const u32 = (i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
    let i = 0, h;
    const len = b.length;
    seed = seed >>> 0;
    if (len >= 16) {
      let v1 = (seed + P1 + P2) >>> 0, v2 = (seed + P2) >>> 0, v3 = seed, v4 = (seed - P1) >>> 0;
      const round = (v, x) => Math.imul(rotl((v + Math.imul(x, P2)) >>> 0, 13), P1) >>> 0;
      for (; i + 16 <= len; i += 16) { v1 = round(v1, u32(i)); v2 = round(v2, u32(i + 4)); v3 = round(v3, u32(i + 8)); v4 = round(v4, u32(i + 12)); }
      h = (rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18)) >>> 0;
    } else h = (seed + P5) >>> 0;
    h = (h + len) >>> 0;
    for (; i + 4 <= len; i += 4) h = Math.imul(rotl((h + Math.imul(u32(i), P3)) >>> 0, 17), P4) >>> 0;
    for (; i < len; i++) h = Math.imul(rotl((h + Math.imul(b[i], P5)) >>> 0, 11), P1) >>> 0;
    h ^= h >>> 15; h = Math.imul(h, P2) >>> 0;
    h ^= h >>> 13; h = Math.imul(h, P3) >>> 0;
    h ^= h >>> 16;
    return h >>> 0;
  }
  // CRC64 with the Jones polynomial, which Redis DUMP payloads end with.
  const CRC_LO = new Uint32Array(256), CRC_HI = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let lo = i, hi = 0;
    for (let k = 0; k < 8; k++) {
      const bit = lo & 1;
      lo = ((lo >>> 1) | ((hi & 1) << 31)) >>> 0;
      hi >>>= 1;
      if (bit) { lo = (lo ^ 0xac4bc9b5) >>> 0; hi = (hi ^ 0x95ac9329) >>> 0; }
    }
    CRC_LO[i] = lo; CRC_HI[i] = hi;
  }
  function crc64(b) {
    let lo = 0, hi = 0;
    for (let i = 0; i < b.length; i++) {
      const x = (lo ^ b[i]) & 0xff;
      lo = (((lo >>> 8) | ((hi & 0xff) << 24)) ^ CRC_LO[x]) >>> 0;
      hi = ((hi >>> 8) ^ CRC_HI[x]) >>> 0;
    }
    return [lo, hi];
  }

  // ---- DEFLATE (RFC 1951), for gzip and zlib ----

  // The most any decompression may produce, so a small value that expands
  // to gigabytes can't take the page down.
  const MAX_OUT = 256 * 1024 * 1024;
  // Output that grows as needed.
  function sink(size) {
    let buf = new Uint8Array(Math.max(256, size)), n = 0;
    return {
      get n() { return n; },
      room(k) {
        if (n + k > MAX_OUT) throw new FormatError('It decompresses to more than 256 MB');
        if (n + k > buf.length) { const b = new Uint8Array(Math.max(buf.length * 2, n + k)); b.set(buf.subarray(0, n)); buf = b; }
      },
      push(x) { this.room(1); buf[n++] = x; },
      append(b) { this.room(b.length); buf.set(b, n); n += b.length; },
      // Copy len bytes from dist back; they may overlap what's being written.
      copy(dist, len) {
        if (dist <= 0 || dist > n) throw new FormatError('A back-reference points outside the data');
        this.room(len);
        for (let i = 0; i < len; i++) { buf[n] = buf[n - dist]; n++; }
      },
      done() { return buf.slice(0, n); }
    };
  }
  const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  const CLORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
  // A canonical Huffman code from code lengths: how many codes of each length,
  // and the symbols in code order.
  function huffman(lengths) {
    const counts = new Uint16Array(16), symbols = new Uint16Array(lengths.length), offs = new Uint16Array(16);
    for (let i = 0; i < lengths.length; i++) counts[lengths[i]]++;
    counts[0] = 0;
    for (let i = 1, sum = 0; i < 16; i++) { offs[i] = sum; sum += counts[i]; }
    for (let i = 0; i < lengths.length; i++) if (lengths[i]) symbols[offs[lengths[i]]++] = i;
    return { counts: counts, symbols: symbols };
  }
  const FIXED_L = huffman(Array.from({ length: 288 }, (_, i) => (i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8)));
  const FIXED_D = huffman(new Array(30).fill(5));

  // Inflates from pos. Returns { out, end }, end being the first byte after the data.
  function inflate(src, pos) {
    let p = pos, bitbuf = 0, bitcnt = 0;
    const out = sink((src.length - pos) * 4);
    const bit = () => {
      if (!bitcnt) { if (p >= src.length) throw new FormatError('The compressed data ends early', p); bitbuf = src[p++]; bitcnt = 8; }
      const b = bitbuf & 1;
      bitbuf >>= 1; bitcnt--;
      return b;
    };
    const bits = (k) => { let v = 0; for (let i = 0; i < k; i++) v |= bit() << i; return v; };
    const decode = (h) => {
      let code = 0, first = 0, index = 0;
      for (let len = 1; len < 16; len++) {
        code |= bit();
        const count = h.counts[len];
        if (code - count < first) return h.symbols[index + (code - first)];
        index += count; first += count;
        first <<= 1; code <<= 1;
      }
      throw new FormatError('A Huffman code that means nothing', p);
    };
    let last;
    do {
      last = bit();
      const type = bits(2);
      if (type === 0) {
        bitbuf = 0; bitcnt = 0;
        if (p + 4 > src.length) throw new FormatError('A stored block ends early', p);
        const len = src[p] | (src[p + 1] << 8), nlen = src[p + 2] | (src[p + 3] << 8);
        if ((len ^ 0xffff) !== nlen) throw new FormatError('A stored block with a wrong length', p);
        p += 4;
        if (p + len > src.length) throw new FormatError('A stored block ends early', p);
        out.append(src.subarray(p, p + len));
        p += len;
      } else if (type === 1 || type === 2) {
        let lt = FIXED_L, dt = FIXED_D;
        if (type === 2) {
          const nlen = bits(5) + 257, ndist = bits(5) + 1, ncode = bits(4) + 4;
          if (nlen > 286 || ndist > 30) throw new FormatError('Too many codes in a block', p);
          const cl = new Array(19).fill(0);
          for (let i = 0; i < ncode; i++) cl[CLORDER[i]] = bits(3);
          const ct = huffman(cl);
          const lengths = [];
          while (lengths.length < nlen + ndist) {
            const s = decode(ct);
            if (s < 16) lengths.push(s);
            else if (s === 16) { if (!lengths.length) throw new FormatError('A repeat with nothing to repeat', p); const prev = lengths[lengths.length - 1]; for (let r = 3 + bits(2); r > 0; r--) lengths.push(prev); }
            else if (s === 17) { for (let r = 3 + bits(3); r > 0; r--) lengths.push(0); }
            else { for (let r = 11 + bits(7); r > 0; r--) lengths.push(0); }
          }
          if (lengths.length > nlen + ndist) throw new FormatError('Code lengths run over', p);
          lt = huffman(lengths.slice(0, nlen));
          dt = huffman(lengths.slice(nlen));
        }
        for (;;) {
          const s = decode(lt);
          if (s < 256) out.push(s);
          else if (s === 256) break;
          else {
            const li = s - 257;
            if (li >= 29) throw new FormatError('A length code out of range', p);
            const len = LBASE[li] + bits(LEXT[li]);
            const ds = decode(dt);
            if (ds >= 30) throw new FormatError('A distance code out of range', p);
            out.copy(DBASE[ds] + bits(DEXT[ds]), len);
          }
        }
      } else throw new FormatError('A block of an unknown type', p);
    } while (!last);
    return { out: out.done(), end: p };
  }

  function gunzip(b) {
    const r = new Reader(b);
    if (r.u8() !== 0x1f || r.u8() !== 0x8b) throw new FormatError('Not gzip');
    if (r.u8() !== 8) throw new FormatError('gzip with a method other than deflate');
    const flg = r.u8(), mtime = r.u32le();
    r.u8(); r.u8();
    if (flg & 4) r.bytes(r.u16le());
    const name = flg & 8 ? latin1(r.cstring()) : null;
    const comment = flg & 16 ? latin1(r.cstring()) : null;
    if (flg & 2) r.u16le();
    const { out, end } = inflate(b, r.pos);
    if (end + 8 > b.length) throw new FormatError('The gzip trailer is missing', end);
    const t = new Reader(b, end);
    const crc = t.u32le(), size = t.u32le();
    const facts = [];
    if (name) facts.push('file name ' + name);
    if (mtime) facts.push('dated ' + isoTime(mtime * 1000));
    if (comment) facts.push('comment ' + comment);
    return { out: out, check: crc === crc32(out) && size === (out.length >>> 0) ? 'ok' : 'mismatch', facts: facts, rest: b.length - t.pos };
  }
  const isZlib = (b) => b.length >= 6 && (b[0] & 0x0f) === 8 && (b[0] >> 4) <= 7 && ((b[0] << 8) | b[1]) % 31 === 0 && !(b[1] & 0x20);
  function unzlib(b) {
    const { out, end } = inflate(b, 2);
    if (end + 4 > b.length) throw new FormatError('The zlib checksum is missing', end);
    const stored = ((b[end] << 24) | (b[end + 1] << 16) | (b[end + 2] << 8) | b[end + 3]) >>> 0;
    const level = ['fastest', 'fast', 'default', 'best'][b[1] >> 6];
    return { out: out, check: stored === adler32(out) ? 'ok' : 'mismatch', facts: ['compression level: ' + level], rest: b.length - end - 4 };
  }

  // ---- LZ4 ----

  // One LZ4 block into out, which may already hold earlier blocks the block
  // refers back to.
  function lz4Block(src, out) {
    const r = new Reader(src);
    while (r.left) {
      const token = r.u8();
      let lit = token >> 4;
      if (lit === 15) { let x; do { x = r.u8(); lit += x; } while (x === 255); }
      out.append(r.bytes(lit));
      if (!r.left) break;
      const off = r.u16le();
      if (!off) throw new FormatError('An LZ4 match with offset 0', r.pos);
      let len = token & 15;
      if (len === 15) { let x; do { x = r.u8(); len += x; } while (x === 255); }
      out.copy(off, len + 4);
    }
  }
  function lz4Frame(b) {
    const r = new Reader(b);
    if (r.u32le() !== 0x184d2204) throw new FormatError('Not an LZ4 frame');
    const flg = r.u8(), bd = r.u8();
    if (flg >> 6 !== 1) throw new FormatError('An LZ4 frame of an unknown version');
    let size = null;
    if (flg & 8) size = r.u64le();
    if (flg & 1) throw new FormatError('An LZ4 frame that needs a dictionary');
    const hc = r.u8();
    const facts = ['blocks up to ' + ({ 4: '64 KB', 5: '256 KB', 6: '1 MB', 7: '4 MB' }[(bd >> 4) & 7] || '?')];
    let check = ((xxh32(b.subarray(4, r.pos - 1), 0) >>> 8) & 0xff) === hc ? 'ok' : 'mismatch';
    const out = sink(size ? Number(size) : b.length * 3);
    for (;;) {
      const word = r.u32le();
      if (word === 0) break;
      const data = r.bytes(word & 0x7fffffff);
      if (flg & 0x10) { const c = r.u32le(); if (c !== xxh32(data, 0)) check = 'mismatch'; }
      if (word & 0x80000000) out.append(data); else lz4Block(data, out);
    }
    const result = out.done();
    if (flg & 4) { const c = r.u32le(); if (c !== xxh32(result, 0)) check = 'mismatch'; }
    if (size !== null && Number(size) !== result.length) check = 'mismatch';
    return { out: result, check: check, facts: facts, rest: r.left };
  }
  // A bare LZ4 block after its size as 4 bytes, little-endian, the way Python's
  // lz4.block and several client libraries store it.
  function lz4Sized(b, bigEndian) {
    const r = new Reader(b);
    const size = bigEndian ? r.u32be() : r.u32le();
    // LZ4 can grow data that won't compress, but only by a little.
    if (size === 0 || size > MAX_OUT || size + Math.ceil(size / 255) + 16 < b.length - 4) throw new FormatError('Not a sized LZ4 block');
    const out = sink(size);
    lz4Block(b.subarray(4), out);
    const result = out.done();
    if (result.length !== size) throw new FormatError('The LZ4 block does not match its size');
    return { out: result, check: 'size ok', facts: [], rest: 0 };
  }

  // ---- Snappy ----

  function snappyRaw(b) {
    const r = new Reader(b);
    const size = Number(r.varint());
    if (size > MAX_OUT) throw new FormatError('Too big for Snappy');
    const out = sink(size);
    while (r.left) {
      const tag = r.u8();
      const type = tag & 3;
      if (type === 0) {
        let len = tag >> 2;
        if (len >= 60) { const n = len - 59; let v = 0; for (let i = 0; i < n; i++) v += r.u8() * Math.pow(256, i); len = v; }
        out.append(r.bytes(len + 1));
      } else if (type === 1) out.copy(((tag >> 5) << 8) | r.u8(), ((tag >> 2) & 7) + 4);
      else if (type === 2) out.copy(r.u16le(), (tag >> 2) + 1);
      else out.copy(r.u32le(), (tag >> 2) + 1);
      if (out.n > size) throw new FormatError('Snappy data longer than it says');
    }
    if (out.n !== size) throw new FormatError('Snappy data shorter than it says');
    return { out: out.done(), check: 'size ok', facts: [], rest: 0 };
  }
  const SNAPPY_ID = [0xff, 0x06, 0x00, 0x00, 0x73, 0x4e, 0x61, 0x50, 0x70, 0x59];
  const masked = (c) => ((((c >>> 15) | (c << 17)) >>> 0) + 0xa282ead8) >>> 0;
  function snappyFramed(b) {
    const r = new Reader(b);
    const parts = [];
    let check = 'ok';
    while (r.left) {
      const type = r.u8();
      const len = r.u8() | (r.u8() << 8) | (r.u8() << 16);
      const data = r.bytes(len);
      if (type === 0xff) { if (latin1(data) !== 'sNaPpY') throw new FormatError('A bad Snappy stream marker'); continue; }
      if (type === 0x00 || type === 0x01) {
        const crc = data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24);
        const chunk = type === 0x00 ? snappyRaw(data.subarray(4)).out : data.subarray(4);
        if (masked(crc32(chunk, CRC32C)) !== (crc >>> 0)) check = 'mismatch';
        parts.push(chunk);
      } else if (type < 0x80) throw new FormatError('A Snappy chunk of an unknown type');
    }
    return { out: concat(parts), check: check, facts: [], rest: 0 };
  }

  // Formats that are only named, since decoding them needs far more code.
  const NAMED = [
    { id: 'zstd', name: 'Zstandard', test: (b) => b[0] === 0x28 && b[1] === 0xb5 && b[2] === 0x2f && b[3] === 0xfd },
    { id: 'bzip2', name: 'bzip2', test: (b) => b[0] === 0x42 && b[1] === 0x5a && b[2] === 0x68 && b[3] >= 0x31 && b[3] <= 0x39 && b[4] === 0x31 && b[5] === 0x41 },
    { id: 'xz', name: 'xz', test: (b) => b[0] === 0xfd && b[1] === 0x37 && b[2] === 0x7a && b[3] === 0x58 && b[4] === 0x5a && b[5] === 0 },
    { id: 'zip', name: 'a ZIP archive', test: (b) => b[0] === 0x50 && b[1] === 0x4b && b[2] === 3 && b[3] === 4 },
    { id: 'pdf', name: 'a PDF document', test: (b) => latin1(b.subarray(0, 5)) === '%PDF-' },
    { id: 'dotnet', name: '.NET BinaryFormatter data', test: (b) => b[0] === 0 && b[1] === 1 && b[2] === 0 && b[3] === 0 && b[4] === 0 && b[5] === 0xff && b[6] === 0xff && b[7] === 0xff && b[8] === 0xff },
    { id: 'avro', name: 'an Avro container file', test: (b) => latin1(b.subarray(0, 4)) === 'Obj\x01' },
    { id: 'parquet', name: 'a Parquet file', test: (b) => latin1(b.subarray(0, 4)) === 'PAR1' }
  ];

  // ---- JSON, with every number kept exactly as written ----

  function parseJSON(text) {
    let i = 0;
    const fail = (what) => { throw new FormatError('JSON: ' + what, i); };
    const ws = () => { while (i < text.length) { const c = text.charCodeAt(i); if (c === 32 || c === 9 || c === 10 || c === 13) i++; else break; } };
    const NUM = /-?(?:0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/y;
    function str() {
      i++;
      let out = '';
      for (;;) {
        if (i >= text.length) fail('a string runs to the end');
        const c = text[i];
        if (c === '"') { i++; return out; }
        if (c === '\\') {
          const e = text[i + 1];
          const map = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (map[e] !== undefined) { out += map[e]; i += 2; continue; }
          if (e === 'u' && /^[0-9a-fA-F]{4}$/.test(text.substr(i + 2, 4))) { out += String.fromCharCode(parseInt(text.substr(i + 2, 4), 16)); i += 6; continue; }
          fail('a bad escape');
        }
        if (text.charCodeAt(i) < 0x20) fail('a control character in a string');
        out += c; i++;
      }
    }
    function value(depth) {
      if (depth > 500) fail('nested too deep');
      ws();
      const c = text[i];
      if (c === '{') {
        i++; const entries = [];
        ws();
        if (text[i] === '}') { i++; return V.map(entries); }
        for (;;) {
          ws();
          if (text[i] !== '"') fail('a key that is not a string');
          const k = str();
          ws();
          if (text[i] !== ':') fail('a missing colon');
          i++;
          entries.push([V.str(k), value(depth + 1)]);
          ws();
          if (text[i] === ',') { i++; continue; }
          if (text[i] === '}') { i++; return V.map(entries); }
          fail('a missing comma or brace');
        }
      }
      if (c === '[') {
        i++; const items = [];
        ws();
        if (text[i] === ']') { i++; return V.list(items); }
        for (;;) {
          items.push(value(depth + 1));
          ws();
          if (text[i] === ',') { i++; continue; }
          if (text[i] === ']') { i++; return V.list(items); }
          fail('a missing comma or bracket');
        }
      }
      if (c === '"') return V.str(str());
      if (text.startsWith('true', i)) { i += 4; return V.bool(true); }
      if (text.startsWith('false', i)) { i += 5; return V.bool(false); }
      if (text.startsWith('null', i)) { i += 4; return V.nul(); }
      NUM.lastIndex = i;
      const m = NUM.exec(text);
      if (m) { i += m[0].length; return m[1] || m[2] ? V.num(m[0]) : V.int(m[0]); }
      fail('an unexpected character');
    }
    const v = value(0);
    ws();
    if (i < text.length) fail('more text after the value');
    return v;
  }

  // ---- JWT ----

  const JWT = /^[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*$/;
  function parseJWT(text) {
    const parts = text.split('.');
    const part = (s) => { const b = base64Bytes(s); const t = b && utf8(b); if (t === null) throw new FormatError('Not a JWT'); return parseJSON(t); };
    const header = part(parts[0]);
    if (header.t !== 'map' || !header.entries.some(([k]) => k.v === 'alg')) throw new FormatError('Not a JWT');
    const payload = part(parts[1]);
    // Times in the claims, in plain dates.
    if (payload.t === 'map') for (const e of payload.entries) {
      if (['exp', 'iat', 'nbf', 'auth_time'].includes(e[0].v) && e[1].t === 'int') e[1] = Object.assign({}, e[1], { note: isoTime(Number(e[1].v) * 1000) });
    }
    const sig = base64Bytes(parts[2]) || new Uint8Array(0);
    return V.obj('JSON Web Token', [['header', header], ['payload', payload], ['signature', V.bin(sig)]], null, 'The signature is not checked.');
  }

  // ---- PHP serialize() and sessions ----

  function phpReader(b) {
    let i = 0;
    const fail = (what) => { throw new FormatError('PHP: ' + what, i); };
    const until = (ch) => {
      const end = b.indexOf(ch.charCodeAt(0), i);
      if (end < 0) fail('missing ' + ch);
      const s = latin1(b.subarray(i, end));
      i = end + 1;
      return s;
    };
    const expect = (s) => { for (let k = 0; k < s.length; k++) if (b[i + k] !== s.charCodeAt(k)) fail('expected ' + s); i += s.length; };
    const intOf = (s) => { if (!/^[+-]?\d+$/.test(s)) fail('a bad number'); return s.replace(/^\+/, ''); };
    const quoted = () => {
      const len = +intOf(until(':'));
      expect('"');
      if (i + len > b.length) fail('a string runs past the end');
      const v = b.subarray(i, i + len);
      i += len;
      expect('"');
      return v;
    };
    // A property name: "\0*\0name" is protected, "\0Class\0name" private.
    const prop = (k) => {
      if (k.t !== 'str' || k.v[0] !== '\0') return k;
      const end = k.v.indexOf('\0', 1);
      const owner = k.v.slice(1, end), name = k.v.slice(end + 1);
      return Object.assign(V.str(name), { note: owner === '*' ? 'protected' : 'private, ' + owner });
    };
    function members(n, object) {
      const entries = [];
      for (let k = 0; k < n; k++) {
        const key = value(true);
        entries.push([object ? prop(key) : key, value(false)]);
      }
      expect('}');
      return entries;
    }
    // Every value but a key takes a numbered slot, which r:N and R:N point
    // back to. R: (a PHP reference) takes none of its own.
    const slots = [];
    const target = (n) => { const v = slots[n - 1]; if (!v) fail('a reference to a value that does not exist'); return v; };
    function value(isKey) {
      if (i >= b.length) fail('ends early');
      const type = String.fromCharCode(b[i]);
      if (type === 'N') { expect('N;'); if (!isKey) slots.push(V.nul()); return isKey ? V.nul() : slots[slots.length - 1]; }
      i += 2;
      if (b[i - 1] !== 0x3a) fail('a bad type marker');
      if (type === 'R') return target(+intOf(until(';')));
      const slot = isKey ? -1 : slots.push(null) - 1;
      const v = read(type, slot);
      if (slot >= 0) slots[slot] = v;
      return v;
    }
    function read(type, slot) {
      switch (type) {
        case 'b': { const s = until(';'); if (s !== '0' && s !== '1') fail('a bad boolean'); return V.bool(s === '1'); }
        case 'i': return V.int(intOf(until(';')));
        case 'd': {
          const s = until(';');
          if (s === 'INF') return V.float(Infinity);
          if (s === '-INF') return V.float(-Infinity);
          if (s === 'NAN') return V.float(NaN);
          if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) fail('a bad float');
          return V.num(s);
        }
        case 's': { const v = quoted(); expect(';'); return textOrBytes(v); }
        case 'a': {
          const n = +intOf(until(':')); expect('{');
          // The slot holds the array before its members are read, so they can point back to it.
          const node = {};
          if (slot >= 0) slots[slot] = node;
          return Object.assign(node, phpArray(members(n, false)));
        }
        case 'O': {
          const cls = latin1(quoted()); expect(':');
          const n = +intOf(until(':')); expect('{');
          const node = V.obj(cls, []);
          if (slot >= 0) slots[slot] = node;
          node.fields = members(n, true);
          return node;
        }
        case 'C': {
          const cls = latin1(quoted()); expect(':');
          const len = +intOf(until(':')); expect('{');
          const data = b.subarray(i, i + len); i += len;
          expect('}');
          return V.obj(cls, [['serialized', textOrBytes(data)]], null, 'written by the class\'s own serialize method');
        }
        case 'E': { const v = latin1(quoted()); expect(';'); const p = v.split(':'); return V.obj(p[0], [], null, 'enum case ' + p[1]); }
        case 'r': return target(+intOf(until(';')));
      }
      fail('an unknown type ' + JSON.stringify(type));
    }
    return { value: value, get pos() { return i; }, set pos(v) { i = v; } };
  }
  // A PHP array with keys 0, 1, 2... in order is a list; any other is a map.
  function phpArray(entries) {
    if (entries.every(([k], i) => k.t === 'int' && k.v === String(i))) return V.list(entries.map((e) => e[1]));
    return V.map(entries);
  }
  const PHP_START = /^(?:[abidsOCE]:|N;)/;
  function parsePHP(b) {
    const r = phpReader(b);
    const v = r.value(false);
    if (r.pos !== b.length) throw new FormatError('PHP: more after the value', r.pos);
    return v;
  }
  // session_encode() with the default "php" handler: name|value name|value...
  function parsePHPSession(b) {
    const r = phpReader(b);
    const entries = [];
    while (r.pos < b.length) {
      const bar = b.indexOf(0x7c, r.pos);
      if (bar <= r.pos) throw new FormatError('Not a PHP session');
      const name = utf8(b.subarray(r.pos, bar));
      if (name === null || /[;{}"]/.test(name)) throw new FormatError('Not a PHP session');
      r.pos = bar + 1;
      entries.push([V.str(name), r.value(false)]);
    }
    if (!entries.length) throw new FormatError('Not a PHP session');
    return V.map(entries, 'session');
  }

  // ---- MessagePack ----

  function parseMsgpack(b) {
    const r = new Reader(b);
    function str(n) { return textOrBytes(r.bytes(n)); }
    function arr(n, d) { const items = []; for (let i = 0; i < n; i++) items.push(value(d + 1)); return V.list(items); }
    function map(n, d) { const e = []; for (let i = 0; i < n; i++) { const k = value(d + 1); e.push([k, value(d + 1)]); } return V.map(e); }
    function ext(type, data) {
      if (type === -1) {
        const x = new Reader(data);
        let sec, ns = 0;
        if (data.length === 4) sec = x.u32be();
        else if (data.length === 8) { const hi = x.u32be(), lo = x.u32be(); ns = hi >>> 2; sec = (hi & 3) * 4294967296 + lo; }
        else if (data.length === 12) { ns = x.u32be(); sec = Number(x.i64be()); }
        else return V.tagged('timestamp', V.bin(data));
        const ms = sec * 1000 + Math.floor(ns / 1e6);
        const iso = isoTime(ms);
        return V.date(ms, iso && ns % 1e6 ? iso.replace(/(\.\d{3})?Z$/, '.' + String(ns).padStart(9, '0') + 'Z') : iso);
      }
      return V.tagged('ext type ' + type, V.bin(data));
    }
    function value(d) {
      if (d > 500) throw new FormatError('MessagePack nested too deep', r.pos);
      const c = r.u8();
      if (c <= 0x7f) return V.int(c);
      if (c >= 0xe0) return V.int(c - 256);
      if (c >= 0x80 && c <= 0x8f) return map(c & 15, d);
      if (c >= 0x90 && c <= 0x9f) return arr(c & 15, d);
      if (c >= 0xa0 && c <= 0xbf) return str(c & 31);
      switch (c) {
        case 0xc0: return V.nul();
        case 0xc2: return V.bool(false);
        case 0xc3: return V.bool(true);
        case 0xc4: return V.bin(r.bytes(r.u8()));
        case 0xc5: return V.bin(r.bytes(r.u16be()));
        case 0xc6: return V.bin(r.bytes(r.u32be()));
        case 0xc7: { const n = r.u8(); const t = r.u8() << 24 >> 24; return ext(t, r.bytes(n)); }
        case 0xc8: { const n = r.u16be(); const t = r.u8() << 24 >> 24; return ext(t, r.bytes(n)); }
        case 0xc9: { const n = r.u32be(); const t = r.u8() << 24 >> 24; return ext(t, r.bytes(n)); }
        case 0xca: return V.float(r.f32be());
        case 0xcb: return V.float(r.f64be());
        case 0xcc: return V.int(r.u8());
        case 0xcd: return V.int(r.u16be());
        case 0xce: return V.int(r.u32be());
        case 0xcf: return V.int(r.u64be());
        case 0xd0: return V.int(r.u8() << 24 >> 24);
        case 0xd1: return V.int(r.i16be());
        case 0xd2: return V.int(r.i32be());
        case 0xd3: return V.int(r.i64be());
        case 0xd4: case 0xd5: case 0xd6: case 0xd7: case 0xd8: { const t = r.u8() << 24 >> 24; return ext(t, r.bytes(1 << (c - 0xd4))); }
        case 0xd9: return str(r.u8());
        case 0xda: return str(r.u16be());
        case 0xdb: return str(r.u32be());
        case 0xdc: return arr(r.u16be(), d);
        case 0xdd: return arr(r.u32be(), d);
        case 0xde: return map(r.u16be(), d);
        case 0xdf: return map(r.u32be(), d);
      }
      throw new FormatError('MessagePack has no type 0xc1', r.pos - 1);
    }
    const v = value(0);
    if (r.left) throw new FormatError('MessagePack: more after the value', r.pos);
    return v;
  }

  // ---- CBOR (RFC 8949) ----

  function parseCBOR(b) {
    const r = new Reader(b);
    const BREAK = {};
    function arg(info) {
      if (info < 24) return info;
      if (info === 24) return r.u8();
      if (info === 25) return r.u16be();
      if (info === 26) return r.u32be();
      if (info === 27) return num(r.u64be());
      throw new FormatError('CBOR: a bad length', r.pos);
    }
    function chunks(major, d) {
      const parts = [];
      for (;;) {
        const c = r.u8();
        if (c === 0xff) break;
        if (c >> 5 !== major || (c & 31) === 31) throw new FormatError('CBOR: a bad chunk', r.pos);
        parts.push(r.bytes(Number(arg(c & 31))));
      }
      return concat(parts);
    }
    function bigFrom(bytes) { let x = 0n; for (const c of bytes) x = (x << 8n) | BigInt(c); return x; }
    function tagged(tag, d) {
      const v = value(d + 1);
      if (tag === 0 && v.t === 'str') { const ms = Date.parse(v.v); return V.date(ms, v.v); }
      if (tag === 1 && (v.t === 'int' || v.t === 'float')) { const ms = Number(v.v) * 1000; return V.date(ms, isoTime(ms)); }
      if (tag === 2 && v.t === 'bin') return V.int(bigFrom(v.v));
      if (tag === 3 && v.t === 'bin') return V.int(-1n - bigFrom(v.v));
      if (tag === 4 && v.t === 'list' && v.items.length === 2) return V.tagged('decimal fraction', v);
      if (tag === 24 && v.t === 'bin') { try { return V.tagged('embedded CBOR', parseCBOR(v.v)); } catch (e) { return V.tagged('tag 24', v); } }
      if (tag === 37 && v.t === 'bin' && v.v.length === 16) { const h = hex(v.v); return V.tagged('UUID', V.str(`${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`)); }
      if (tag === 258 && v.t === 'list') return V.list(v.items, 'set');
      if (tag === 55799) return v;
      return V.tagged('tag ' + tag, v);
    }
    function value(d) {
      if (d > 500) throw new FormatError('CBOR nested too deep', r.pos);
      const c = r.u8();
      const major = c >> 5, info = c & 31;
      if (major === 7) {
        if (info === 20) return V.bool(false);
        if (info === 21) return V.bool(true);
        if (info === 22) return V.nul();
        if (info === 23) return V.nul('undefined');
        if (info === 25) return V.float(r.f16be());
        if (info === 26) return V.float(r.f32be());
        if (info === 27) return V.float(r.f64be());
        if (info === 31) return BREAK;
        if (info < 20) return V.tagged('simple', V.int(info));
        if (info === 24) return V.tagged('simple', V.int(r.u8()));
        throw new FormatError('CBOR: a bad simple value', r.pos);
      }
      if (info === 31) {
        if (major === 2) return V.bin(chunks(2, d));
        if (major === 3) { const t = utf8(chunks(3, d)); if (t === null) throw new FormatError('CBOR: text that is not UTF-8'); return V.str(t); }
        if (major === 4) { const items = []; for (;;) { const v = value(d + 1); if (v === BREAK) break; items.push(v); } return V.list(items); }
        if (major === 5) { const e = []; for (;;) { const k = value(d + 1); if (k === BREAK) break; e.push([k, value(d + 1)]); } return V.map(e); }
        throw new FormatError('CBOR: indefinite length where none is allowed', r.pos);
      }
      const n = arg(info);
      switch (major) {
        case 0: return V.int(n);
        case 1: return V.int(typeof n === 'bigint' ? -1n - n : -1 - n);
        case 2: return V.bin(r.bytes(Number(n)));
        case 3: { const t = utf8(r.bytes(Number(n))); if (t === null) throw new FormatError('CBOR: text that is not UTF-8'); return V.str(t); }
        case 4: { const items = []; for (let i = 0; i < n; i++) items.push(value(d + 1)); return V.list(items); }
        case 5: { const e = []; for (let i = 0; i < n; i++) { const k = value(d + 1); e.push([k, value(d + 1)]); } return V.map(e); }
        case 6: return tagged(Number(n), d);
      }
    }
    const v = value(0);
    if (v === BREAK || r.left) throw new FormatError('CBOR: more after the value', r.pos);
    return v;
  }

  // ---- BSON ----

  // Decimal128 to text: 113-bit coefficient and a 14-bit exponent biased by 6176.
  function decimal128(bytes) {
    const lo = new Reader(bytes).u64le(), hi = new Reader(bytes, 8).u64le();
    const neg = (hi >> 63n) & 1n;
    const comb = (hi >> 58n) & 0x1fn;
    if (comb === 0x1fn) return 'NaN';
    if (comb === 0x1en) return neg ? '-Infinity' : 'Infinity';
    let exp, coef;
    // With the two bits after the sign set, the coefficient would pass 10^34,
    // which the standard counts as zero.
    if (((hi >> 61n) & 3n) === 3n) { exp = (hi >> 47n) & 0x3fffn; coef = 0n; }
    else { exp = (hi >> 49n) & 0x3fffn; coef = ((hi & 0x1ffffffffffffn) << 64n) | lo; }
    const e = Number(exp) - 6176;
    const digits = coef.toString();
    const adjusted = e + digits.length - 1;
    let s;
    if (e <= 0 && adjusted >= -6) {
      const point = digits.length + e;
      s = e === 0 ? digits : point > 0 ? digits.slice(0, point) + '.' + digits.slice(point) : '0.' + '0'.repeat(-point) + digits;
    } else s = digits[0] + (digits.length > 1 ? '.' + digits.slice(1) : '') + 'E' + (adjusted >= 0 ? '+' : '') + adjusted;
    return (neg ? '-' : '') + s;
  }
  function parseBSON(b) {
    function doc(r, d, isArray) {
      if (d > 200) throw new FormatError('BSON nested too deep', r.pos);
      const start = r.pos, len = r.i32le();
      if (len < 5 || start + len > r.b.length) throw new FormatError('BSON: a document with a bad length', start);
      const end = start + len;
      const entries = [];
      while (r.pos < end - 1) {
        const type = r.u8();
        const name = utf8(r.cstring());
        if (name === null) throw new FormatError('BSON: a name that is not UTF-8', r.pos);
        entries.push([V.str(name), element(r, type, d)]);
      }
      if (r.u8() !== 0 || r.pos !== end) throw new FormatError('BSON: a document that does not end where it says', r.pos);
      return isArray ? V.list(entries.map((e) => e[1])) : V.map(entries);
    }
    function string(r) { const n = r.i32le(); const s = r.bytes(n); if (s[n - 1] !== 0) throw new FormatError('BSON: a string without its zero', r.pos); return textOrBytes(s.subarray(0, n - 1)); }
    function element(r, type, d) {
      switch (type) {
        case 0x01: return V.float(r.f64le());
        case 0x02: return string(r);
        case 0x03: return doc(r, d + 1, false);
        case 0x04: return doc(r, d + 1, true);
        case 0x05: {
          const n = r.i32le(), sub = r.u8();
          let data = r.bytes(n);
          if (sub === 2) data = data.subarray(4);
          if ((sub === 3 || sub === 4) && data.length === 16) { const h = hex(data); return V.tagged(sub === 4 ? 'UUID' : 'UUID (old format)', V.str(`${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`)); }
          return sub === 0 || sub === 2 ? V.bin(data) : V.tagged('binary subtype ' + sub, V.bin(data));
        }
        case 0x06: return V.nul('undefined');
        case 0x07: { const id = r.bytes(12); const sec = (id[0] << 24 | id[1] << 16 | id[2] << 8 | id[3]) >>> 0; return Object.assign(V.tagged('ObjectId', V.str(hex(id))), { note: 'made ' + isoTime(sec * 1000) }); }
        case 0x08: { const x = r.u8(); if (x > 1) throw new FormatError('BSON: a bad boolean', r.pos); return V.bool(x); }
        case 0x09: { const ms = Number(r.i64le()); return V.date(ms, isoTime(ms)); }
        case 0x0a: return V.nul();
        case 0x0b: { const p = latin1(r.cstring()), f = latin1(r.cstring()); return V.tagged('regex', V.str('/' + p + '/' + f)); }
        case 0x0c: { const ns = string(r); return V.tagged('DBPointer ' + (ns.v || ''), V.str(hex(r.bytes(12)))); }
        case 0x0d: return V.tagged('JavaScript', string(r));
        case 0x0e: return V.tagged('symbol', string(r));
        case 0x0f: { r.i32le(); const code = string(r); return V.tagged('JavaScript with scope', V.list([code, doc(r, d + 1, false)])); }
        case 0x10: return V.int(r.i32le());
        case 0x11: { const inc = r.u32le(), sec = r.u32le(); return Object.assign(V.tagged('Timestamp', V.str(sec + ', ' + inc)), { note: isoTime(sec * 1000) }); }
        case 0x12: return V.int(r.i64le());
        case 0x13: return V.tagged('Decimal128', V.num(decimal128(r.bytes(16))));
        case 0xff: return V.tagged('MinKey', V.nul());
        case 0x7f: return V.tagged('MaxKey', V.nul());
      }
      throw new FormatError('BSON: an unknown element type 0x' + type.toString(16), r.pos - 1);
    }
    if (b.length < 5 || new Reader(b).i32le() !== b.length || b[b.length - 1] !== 0) throw new FormatError('Not BSON');
    return doc(new Reader(b), 0, false);
  }

  // ---- Protocol Buffers, without the schema ----

  // A message is a list of numbered fields. The wire format says how long
  // each value is, but not what it means, so varints show as numbers,
  // fixed-width values as numbers with their float reading, and
  // length-delimited values as text, a nested message or bytes, whichever
  // fits best.
  function parseProtobuf(b, depth, strict) {
    const r = new Reader(b);
    const fields = [];
    depth = depth || 0;
    if (depth > 64) throw new FormatError('Protobuf nested too deep');
    while (r.left) {
      const key = r.varint();
      const field = Number(key >> 3n), wt = Number(key & 7n);
      if (field < 1 || field > 536870911 || (strict && field > 20000)) throw new FormatError('Protobuf: a bad field number', r.pos);
      let v;
      if (wt === 0) {
        const x = r.varint();
        v = V.int(x);
        if (x >= 1n << 63n) v.note = 'as int64: ' + (x - (1n << 64n));
      } else if (wt === 1) {
        const x = r.u64le();
        const f = new DataView(b.buffer, b.byteOffset + r.pos - 8, 8).getFloat64(0, true);
        v = Object.assign(V.int(x), { note: 'fixed64; as double: ' + f });
      } else if (wt === 5) {
        const x = r.u32le();
        const f = new DataView(b.buffer, b.byteOffset + r.pos - 4, 4).getFloat32(0, true);
        v = Object.assign(V.int(x), { note: 'fixed32; as float: ' + Math.fround(f) });
      } else if (wt === 2) {
        const len = r.varint();
        if (len > BigInt(r.left)) throw new FormatError('Protobuf: a field runs past the end', r.pos);
        const data = r.bytes(Number(len));
        const t = utf8(data);
        if (t !== null && printable(t)) v = V.str(t);
        else {
          try {
            const inner = parseProtobuf(data, depth + 1, true);
            v = inner.fields.length ? inner : V.bin(data);
          } catch (e) { v = V.bin(data); }
        }
      } else throw new FormatError('Protobuf: wire type ' + wt + ' is not used any more or is invalid', r.pos);
      fields.push(['field ' + field, v]);
    }
    return V.obj('message', fields);
  }

  // ---- igbinary, PHP's binary serializer ----

  function parseIgbinary(b) {
    const r = new Reader(b);
    const version = r.u32be();
    if (version !== 1 && version !== 2) throw new FormatError('Not igbinary');
    const strings = [];
    // Arrays, objects and PHP references are numbered as they come, and
    // later copies of the same one point back by number.
    const refs = [];
    const fail = (what) => { throw new FormatError('igbinary: ' + what, r.pos); };
    function str(c) {
      switch (c) {
        case 0x0d: return V.str('');
        case 0x0e: return at(r.u8()); case 0x0f: return at(r.u16be()); case 0x10: return at(r.u32be());
        case 0x11: return keep(r.bytes(r.u8())); case 0x12: return keep(r.bytes(r.u16be())); case 0x13: return keep(r.bytes(r.u32be()));
      }
      return null;
    }
    function at(i) { if (i >= strings.length) fail('a string id that does not exist'); return strings[i]; }
    function keep(bytes) { const v = textOrBytes(bytes); strings.push(v); return v; }
    function name() { const c = r.u8(); const s = str(c); if (!s) fail('a missing name'); return s; }
    function ref(i) { if (i >= refs.length || !refs[i]) fail('a reference to something that does not exist'); return refs[i]; }
    function prop(k) {
      if (k.t !== 'str' || k.v[0] !== '\0') return k;
      const end = k.v.indexOf('\0', 1);
      const owner = k.v.slice(1, end);
      return Object.assign(V.str(k.v.slice(end + 1)), { note: owner === '*' ? 'protected' : 'private, ' + owner });
    }
    function members(c, object, d) {
      const n = c === 0x14 ? r.u8() : c === 0x15 ? r.u16be() : c === 0x16 ? r.u32be() : fail('a missing array');
      const entries = [];
      for (let i = 0; i < n; i++) {
        const kc = r.u8();
        let k = str(kc);
        if (!k) k = number(kc);
        if (!k) fail('a bad key');
        entries.push([object ? prop(k) : k, value(d + 1, false)]);
      }
      return entries;
    }
    function number(c) {
      switch (c) {
        case 0x06: return V.int(r.u8()); case 0x07: return V.int(-r.u8());
        case 0x08: return V.int(r.u16be()); case 0x09: return V.int(-r.u16be());
        case 0x0a: return V.int(r.u32be()); case 0x0b: return V.int(-r.u32be());
        case 0x20: return V.int(r.u64be()); case 0x21: return V.int(-r.u64be());
      }
      return null;
    }
    // registered: true when a PHP reference already took the number.
    function value(d, registered) {
      if (d > 500) fail('nested too deep');
      const c = r.u8();
      const s = str(c);
      if (s) return s;
      const n = number(c);
      if (n) return n;
      const slot = () => (registered ? -1 : refs.push(null) - 1);
      switch (c) {
        case 0x00: return V.nul();
        case 0x04: return V.bool(false);
        case 0x05: return V.bool(true);
        case 0x0c: return V.float(r.f64be());
        case 0x14: case 0x15: case 0x16: {
          const node = {}, i = slot();
          if (i >= 0) refs[i] = node;
          return Object.assign(node, phpArray(members(c, false, d)));
        }
        case 0x17: case 0x18: case 0x19: case 0x1a: case 0x1b: case 0x1c: {
          const cls = c <= 0x19 ? keep(r.bytes(c === 0x17 ? r.u8() : c === 0x18 ? r.u16be() : r.u32be())) : at(c === 0x1a ? r.u8() : c === 0x1b ? r.u16be() : r.u32be());
          const node = V.obj(cls.v, []), i = slot();
          if (i >= 0) refs[i] = node;
          const next = r.u8();
          if (next === 0x27) { node.note = 'enum case ' + name().v; return node; }
          node.fields = members(next, true, d);
          return node;
        }
        case 0x1d: case 0x1e: case 0x1f: {
          const i = slot();
          const cls = name();
          const data = r.bytes(c === 0x1d ? r.u8() : c === 0x1e ? r.u16be() : r.u32be());
          const node = V.obj(cls.v, [['serialized', textOrBytes(data)]], null, 'written by the class\'s own serialize method');
          if (i >= 0) refs[i] = node;
          return node;
        }
        case 0x01: case 0x02: case 0x03: return ref(c === 0x01 ? r.u8() : c === 0x02 ? r.u16be() : r.u32be());
        case 0x22: case 0x23: case 0x24: return ref(c === 0x22 ? r.u8() : c === 0x23 ? r.u16be() : r.u32be());
        case 0x25: {
          // A PHP reference: new ones take a number, repeats point back.
          if (r.peek() >= 0x01 && r.peek() <= 0x03) return value(d + 1, true);
          const i = refs.push(null) - 1;
          const v = value(d + 1, true);
          refs[i] = v;
          return v;
        }
      }
      fail('an unknown type 0x' + c.toString(16));
    }
    const v = value(0, false);
    if (r.left) fail('more after the value');
    return v;
  }

  // ---- Java serialization (ObjectOutputStream) ----

  // Java writes strings in "modified UTF-8": zero as two bytes, and
  // characters past U+FFFF as two 3-byte halves.
  function mutf8(b) {
    let s = '';
    for (let i = 0; i < b.length;) {
      const c = b[i];
      if (c < 0x80) { s += String.fromCharCode(c); i++; }
      else if ((c & 0xe0) === 0xc0 && i + 1 < b.length) { s += String.fromCharCode(((c & 0x1f) << 6) | (b[i + 1] & 0x3f)); i += 2; }
      else if ((c & 0xf0) === 0xe0 && i + 2 < b.length) { s += String.fromCharCode(((c & 0x0f) << 12) | ((b[i + 1] & 0x3f) << 6) | (b[i + 2] & 0x3f)); i += 3; }
      else throw new FormatError('Java: a string that is not modified UTF-8');
    }
    return s;
  }
  const JAVA_BOXES = new Set(['java.lang.Integer', 'java.lang.Long', 'java.lang.Short', 'java.lang.Byte', 'java.lang.Double', 'java.lang.Float', 'java.lang.Boolean', 'java.lang.Character']);
  const uuidText = (hi, lo) => { const h = BigInt.asUintN(64, hi).toString(16).padStart(16, '0') + BigInt.asUintN(64, lo).toString(16).padStart(16, '0'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; };
  const pad = (n, w) => String(n).padStart(w || 2, '0');

  function parseJava(b) {
    const r = new Reader(b);
    if (r.u16be() !== 0xaced) throw new FormatError('Not Java serialization');
    const version = r.u16be();
    let handles = [];
    const BASE = 0x7e0000;
    const fail = (what) => { throw new FormatError('Java: ' + what, r.pos); };
    const utf = () => mutf8(r.bytes(r.u16be()));
    const handle = (v) => { handles.push(v); return v; };
    const deref = () => { const h = r.i32be() - BASE; if (h < 0 || h >= handles.length) fail('a reference to nothing'); return handles[h]; };
    let depth = 0;

    function classDesc() {
      const tc = r.u8();
      if (tc === 0x70) return null;
      if (tc === 0x71) { const d = deref(); if (!d || !d.isDesc) fail('a reference that is not a class'); return d; }
      if (tc === 0x72) {
        const desc = { isDesc: true, name: utf(), suid: r.i64be(), fields: [] };
        handle(desc);
        desc.flags = r.u8();
        const n = r.i16be();
        for (let i = 0; i < n; i++) {
          const code = String.fromCharCode(r.u8());
          const name = utf();
          let cls = null;
          if (code === '[' || code === 'L') { const s = object(r.u8()); cls = s.t === 'str' ? s.v : '?'; }
          else if (!'BCDFIJSZ'.includes(code)) fail('a field of an unknown type ' + code);
          desc.fields.push({ code: code, name: name, cls: cls });
        }
        desc.annotation = contents();
        desc.superDesc = classDesc();
        return desc;
      }
      if (tc === 0x7d) {
        const desc = { isDesc: true, fields: [], flags: 0x02, interfaces: [] };
        handle(desc);
        for (let i = r.i32be(); i > 0; i--) desc.interfaces.push(utf());
        desc.name = 'proxy for ' + desc.interfaces.join(', ');
        desc.annotation = contents();
        desc.superDesc = classDesc();
        return desc;
      }
      fail('a bad class description 0x' + tc.toString(16));
    }
    function primitive(code) {
      switch (code) {
        case 'B': return V.int(r.u8() << 24 >> 24);
        case 'C': return V.str(String.fromCharCode(r.u16be()));
        case 'D': return V.float(r.f64be());
        case 'F': return V.float(r.f32be());
        case 'I': return V.int(r.i32be());
        case 'J': return V.int(r.i64be());
        case 'S': return V.int(r.i16be());
        case 'Z': return V.bool(r.u8());
      }
      fail('an unknown primitive ' + code);
    }
    // Block data and objects up to TC_ENDBLOCKDATA: what a writeObject
    // method wrote after the normal fields.
    function contents() {
      const out = [];
      for (;;) {
        const tc = r.u8();
        if (tc === 0x78) return out;
        if (tc === 0x77) out.push({ block: r.bytes(r.u8()) });
        else if (tc === 0x7a) out.push({ block: r.bytes(r.i32be()) });
        else out.push(object(tc));
      }
    }
    function object(tc) {
      if (++depth > 400) fail('nested too deep');
      try {
        switch (tc) {
          case 0x70: return V.nul();
          case 0x71: { const v = deref(); return v && v.isDesc ? V.tagged('class', V.str(v.name)) : v; }
          case 0x72: case 0x7d: { r.pos--; const d = classDesc(); return V.tagged('class description', V.str(d.name)); }
          case 0x73: return newObject();
          case 0x74: return handle(V.str(utf()));
          case 0x7c: return handle(V.str(mutf8(r.bytes(Number(r.u64be())))));
          case 0x75: return newArray();
          case 0x76: { const d = classDesc(); return handle(V.tagged('class', V.str(d ? d.name : 'null'))); }
          case 0x7e: {
            const d = classDesc();
            const v = handle(V.obj(d.name, []));
            const name = object(r.u8());
            v.cls = d.name + '.' + name.v;
            v.note = 'enum';
            return v;
          }
          case 0x79: handles = []; return object(r.u8());
          case 0x7b: fail('the stream holds an exception thrown while it was written');
        }
        fail('an unknown item 0x' + tc.toString(16));
      } finally { depth--; }
    }
    function newArray() {
      const d = classDesc();
      const arr = handle(V.list([], d.name));
      const n = r.i32be();
      if (n < 0 || n > r.left * 8 + 8) fail('an array with a bad length');
      const code = d.name[1];
      if (code === 'B') { const bytes = r.bytes(n); Object.assign(arr, V.bin(new Uint8Array(bytes))); delete arr.items; delete arr.kind; arr.note = 'byte[]'; return arr; }
      for (let i = 0; i < n; i++) arr.items.push('BCDFIJSZ'.includes(code) ? primitive(code) : object(r.u8()));
      arr.kind = javaType(d.name);
      return arr;
    }
    function newObject() {
      const d = classDesc();
      if (!d) fail('an object without a class');
      const obj = handle(V.obj(d.name, []));
      const chain = [];
      for (let x = d; x; x = x.superDesc) chain.unshift(x);
      const written = [];
      for (const c of chain) {
        if (c.flags & 0x04) {
          if (!(c.flags & 0x08)) fail(c.name + ' wrote its own data in the old format, which only the class can read');
          written.push({ cls: c.name, items: contents(), external: true });
          continue;
        }
        if (c.flags & 0x02) {
          for (const f of c.fields) obj.fields.push([f.name, f.code === 'L' || f.code === '[' ? object(r.u8()) : primitive(f.code)]);
          if (c.flags & 0x01) written.push({ cls: c.name, items: contents() });
        }
      }
      return javaKnown(obj, written);
    }

    // Classes common enough to show the way Java code would see them.
    function javaKnown(obj, written) {
      const data = (cls) => { const w = written.find((x) => x.cls === cls); return w ? w.items : null; };
      const objs = (items) => items.filter((x) => !x.block);
      const field = (name) => { const f = obj.fields.find((x) => x[0] === name); return f ? f[1] : null; };
      const cls = obj.cls;
      let shown = null;
      if (JAVA_BOXES.has(cls) && field('value')) shown = Object.assign({}, field('value'), { note: cls.slice(10) });
      else if (data('java.util.HashMap') || data('java.util.Hashtable') || data('java.util.TreeMap')) {
        const o = objs(data('java.util.HashMap') || data('java.util.Hashtable') || data('java.util.TreeMap'));
        const entries = [];
        for (let i = 0; i + 1 < o.length; i += 2) entries.push([o[i], o[i + 1]]);
        shown = V.map(entries);
      } else if (data('java.util.ArrayList') || data('java.util.LinkedList') || data('java.util.ArrayDeque') || data('java.util.Vector')) {
        shown = V.list(objs(data('java.util.ArrayList') || data('java.util.LinkedList') || data('java.util.ArrayDeque') || data('java.util.Vector')));
      } else if (data('java.util.HashSet') || data('java.util.TreeSet')) {
        const o = objs(data('java.util.HashSet') || data('java.util.TreeSet'));
        shown = V.list(cls === 'java.util.TreeSet' || data('java.util.TreeSet') ? o.slice(1) : o, 'set');
      } else if (cls === 'java.util.Date' || cls === 'java.sql.Timestamp') {
        // A Timestamp keeps whole seconds in its Date part and the rest in nanos.
        const blk = (data('java.util.Date') || []).find((x) => x.block);
        if (blk && blk.block.length >= 8) {
          let ms = Number(new Reader(blk.block).i64be());
          if (cls === 'java.sql.Timestamp' && field('nanos')) ms += Math.floor(Number(field('nanos').v) / 1e6);
          shown = V.date(ms, isoTime(ms));
        }
      } else if (cls === 'java.util.UUID' && field('mostSigBits') && field('leastSigBits')) {
        shown = V.tagged('UUID', V.str(uuidText(BigInt(field('mostSigBits').v), BigInt(field('leastSigBits').v))));
      } else if (cls === 'java.math.BigInteger' && field('signum') && field('magnitude')) {
        let x = 0n;
        for (const c of field('magnitude').v || []) x = (x << 8n) | BigInt(c);
        shown = V.int(Number(field('signum').v) < 0 ? -x : x);
      } else if (cls === 'java.math.BigDecimal' && field('intVal') && field('scale')) {
        const digits = field('intVal').v, scale = Number(field('scale').v);
        if (field('intVal').t === 'int') {
          const neg = digits.startsWith('-'), d = neg ? digits.slice(1) : digits;
          const s = scale <= 0 ? d + '0'.repeat(-scale) : d.length > scale ? d.slice(0, d.length - scale) + '.' + d.slice(d.length - scale) : '0.' + '0'.repeat(scale - d.length) + d;
          shown = V.num((neg ? '-' : '') + s);
        }
      } else if (cls === 'java.time.Ser') {
        const blk = (data('java.time.Ser') || []).filter((x) => x.block).map((x) => x.block);
        if (blk.length) shown = javaTime(concat(blk));
      }
      if (shown) {
        if (!shown.note) shown.note = cls;
        // Keep the object that handles point at, but show it as the plain value.
        for (const k of Object.keys(obj)) delete obj[k];
        return Object.assign(obj, shown);
      }
      for (const w of written) {
        const items = w.items.map((x) => (x.block ? V.bin(x.block) : x));
        const method = w.external ? 'writeExternal' : 'writeObject';
        if (items.length) obj.fields.push(['written by ' + (w.cls === obj.cls ? method : w.cls + '.' + method), V.list(items)]);
      }
      return obj;
    }

    // java.time values, which travel as java.time.Ser with a type byte
    // first. They're shown the way their toString() writes them.
    function javaTime(b) {
      const x = new Reader(b);
      const frac = (n) => (n % 1e6 === 0 ? '.' + pad(n / 1e6, 3) : n % 1e3 === 0 ? '.' + pad(n / 1e3, 6) : '.' + pad(n, 9));
      const date = () => { const y = x.i32be(), m = x.u8(), d = x.u8(); return (y > 9999 ? '+' : '') + pad(y, 4) + '-' + pad(m) + '-' + pad(d); };
      const time = () => {
        let h = x.u8() << 24 >> 24, m = 0, s = 0, n = 0;
        if (h < 0) h = ~h;
        else { m = x.u8() << 24 >> 24; if (m < 0) m = ~m; else { s = x.u8() << 24 >> 24; if (s < 0) s = ~s; else n = x.i32be(); } }
        return pad(h) + ':' + pad(m) + (s || n ? ':' + pad(s) : '') + (n ? frac(n) : '');
      };
      const offsetText = (sec) => { if (!sec) return 'Z'; const a = Math.abs(sec); return (sec < 0 ? '-' : '+') + pad(Math.floor(a / 3600)) + ':' + pad(Math.floor(a / 60) % 60) + (a % 60 ? ':' + pad(a % 60) : ''); };
      const offset = () => { const o = x.u8() << 24 >> 24; return offsetText(o === 127 ? x.i32be() : o * 900); };
      const zone = () => { const t = x.u8(); return t === 7 ? mutf8(x.bytes(x.u16be())) : t === 8 ? offset() : ''; };
      const type = x.u8();
      switch (type) {
        case 1: {
          // Duration.toString(): PT8H6M12.345S
          const seconds = x.i64be(), nanos = x.i32be();
          if (seconds === 0n && nanos === 0) return V.tagged('java.time.Duration', V.str('PT0S'));
          let total = seconds;
          if (seconds < 0n && nanos > 0) total++;
          const hours = total / 3600n, minutes = Number((total % 3600n) / 60n), secs = Number(total % 60n);
          let out = 'PT';
          if (hours) out += hours + 'H';
          if (minutes) out += minutes + 'M';
          if (secs === 0 && nanos === 0 && out.length > 2) return V.tagged('java.time.Duration', V.str(out));
          out += seconds < 0n && nanos > 0 ? (secs === 0 ? '-0' : String(secs)) : String(secs);
          if (nanos > 0) out += '.' + String(seconds < 0n ? 2e9 - nanos : nanos + 1e9).slice(1).replace(/0+$/, '');
          return V.tagged('java.time.Duration', V.str(out + 'S'));
        }
        case 2: { const s = Number(x.i64be()), n = x.i32be(); const ms = s * 1000 + Math.floor(n / 1e6); const iso = isoTime(ms); return Object.assign(V.date(ms, iso && n % 1e6 ? iso.replace(/(\.\d+)?Z$/, '.' + String(n).padStart(9, '0') + 'Z') : iso), { note: 'java.time.Instant' }); }
        case 3: return V.tagged('java.time.LocalDate', V.str(date()));
        case 4: return V.tagged('java.time.LocalTime', V.str(time()));
        case 5: return V.tagged('java.time.LocalDateTime', V.str(date() + 'T' + time()));
        case 6: {
          const dt = date() + 'T' + time(), off = offset(), z = zone();
          return V.tagged('java.time.ZonedDateTime', V.str(dt + off + (z && z !== off ? '[' + z + ']' : '')));
        }
        case 7: return V.tagged('java.time.ZoneId', V.str(mutf8(x.bytes(x.u16be()))));
        case 8: return V.tagged('java.time.ZoneOffset', V.str(offset()));
        case 9: { const t = time(); return V.tagged('java.time.OffsetTime', V.str(t + offset())); }
        case 10: { const dt = date() + 'T' + time(); return V.tagged('java.time.OffsetDateTime', V.str(dt + offset())); }
        case 11: return V.tagged('java.time.Year', V.str(String(x.i32be())));
        case 12: { const y = x.i32be(), m = x.u8(); return V.tagged('java.time.YearMonth', V.str(pad(y, 4) + '-' + pad(m))); }
        case 13: { const m = x.u8(), d = x.u8(); return V.tagged('java.time.MonthDay', V.str('--' + pad(m) + '-' + pad(d))); }
        case 14: { const y = x.i32be(), m = x.i32be(), d = x.i32be(); return V.tagged('java.time.Period', V.str(!y && !m && !d ? 'P0D' : 'P' + (y ? y + 'Y' : '') + (m ? m + 'M' : '') + (d ? d + 'D' : ''))); }
      }
      return null;
    }

    const items = [];
    while (r.left) {
      const tc = r.u8();
      if (tc === 0x77) items.push(V.bin(r.bytes(r.u8())));
      else if (tc === 0x7a) items.push(V.bin(r.bytes(r.i32be())));
      else items.push(object(tc));
    }
    if (!items.length) fail('an empty stream');
    const v = items.length === 1 ? items[0] : V.list(items, 'stream');
    if (version !== 5) v.note = (v.note ? v.note + '; ' : '') + 'stream version ' + version;
    return v;
  }
  // [I -> int[], [Ljava.lang.String; -> java.lang.String[]
  function javaType(sig) {
    let dims = 0;
    while (sig[dims] === '[') dims++;
    const t = sig.slice(dims);
    const base = { B: 'byte', C: 'char', D: 'double', F: 'float', I: 'int', J: 'long', S: 'short', Z: 'boolean' }[t] || (t[0] === 'L' ? t.slice(1, -1) : t);
    return base + '[]'.repeat(dims);
  }

  // ---- Python pickle ----

  // Python's own escapes in protocol 0 strings: S'...' and V... lines.
  function pyUnescape(s, unicode) {
    const out = [];
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c !== '\\') { out.push(c.charCodeAt(0)); continue; }
      const n = s[++i];
      const simple = { n: 10, r: 13, t: 9, '\\': 92, "'": 39, '"': 34, a: 7, b: 8, f: 12, v: 11, '0': 0 };
      if (n === 'x') { out.push(parseInt(s.substr(i + 1, 2), 16)); i += 2; }
      else if (unicode && n === 'u') { out.push(parseInt(s.substr(i + 1, 4), 16)); i += 4; }
      else if (unicode && n === 'U') { out.push(parseInt(s.substr(i + 1, 8), 16)); i += 8; }
      else if (/[0-7]/.test(n) && /^[0-7]{1,3}/.test(s.slice(i))) { const m = /^[0-7]{1,3}/.exec(s.slice(i))[0]; out.push(parseInt(m, 8)); i += m.length - 1; }
      else if (simple[n] !== undefined) out.push(simple[n]);
      else { out.push(92); out.push(n.charCodeAt(0)); }
    }
    return out;
  }
  function pyDate(bytes, kind) {
    const b = bytes;
    if (kind === 'date' && b.length === 4) return pad((b[0] << 8) | b[1], 4) + '-' + pad(b[2]) + '-' + pad(b[3]);
    if (kind === 'time' && b.length === 6) { const us = (b[3] << 16) | (b[4] << 8) | b[5]; return pad(b[0] & 0x7f) + ':' + pad(b[1]) + ':' + pad(b[2]) + (us ? '.' + pad(us, 6) : ''); }
    if (kind === 'datetime' && b.length === 10) {
      const us = (b[7] << 16) | (b[8] << 8) | b[9];
      return pad((b[0] << 8) | b[1], 4) + '-' + pad(b[2] & 0x7f) + '-' + pad(b[3]) + 'T' + pad(b[4]) + ':' + pad(b[5]) + ':' + pad(b[6]) + (us ? '.' + pad(us, 6) : '');
    }
    return null;
  }

  function parsePickle(b) {
    const r = new Reader(b);
    const stack = [], marks = [], memo = new Map();
    let proto = 0;
    const fail = (what) => { throw new FormatError('pickle: ' + what, r.pos); };
    const top = () => { if (!stack.length) fail('the stack is empty'); return stack[stack.length - 1]; };
    const pop = () => { if (!stack.length || (marks.length && marks[marks.length - 1] === stack.length)) fail('the stack is empty'); return stack.pop(); };
    const popMark = () => { if (!marks.length) fail('no mark'); return stack.splice(marks.pop()); };
    const line = () => { const end = b.indexOf(10, r.pos); if (end < 0) fail('a line without its end'); const s = latin1(b.subarray(r.pos, end)); r.pos = end + 1; return s; };
    const bigLE = (bytes) => { let x = 0n; for (let i = bytes.length - 1; i >= 0; i--) x = (x << 8n) | BigInt(bytes[i]); if (bytes.length && bytes[bytes.length - 1] & 0x80) x -= 1n << BigInt(bytes.length * 8); return x; };
    const glob = (module, name) => ({ t: 'global', module: module, name: name });
    const isGlobal = (g, full) => g && g.t === 'global' && (g.module + '.' + g.name) === full;
    const gname = (g) => (g && g.t === 'global' ? g.module + '.' + g.name : 'callable');
    const morph = (target, v) => { for (const k of Object.keys(target)) delete target[k]; return Object.assign(target, v); };
    const textOf = (v) => (v.t === 'str' ? v.v : v.t === 'bin' ? latin1(v.v) : null);

    // What calling something with arguments made: known ones as plain
    // values, the rest as an object named after what was called.
    function reduce(f, args) {
      const a = args && args.t === 'list' ? args.items : [];
      const name = gname(f);
      const plain = name.replace(/^__builtin__\./, 'builtins.').replace(/^copy_reg\./, 'copyreg.');
      switch (plain) {
        case 'builtins.set': return V.list(a[0] && a[0].items ? a[0].items.slice() : [], 'set');
        case 'builtins.frozenset': return V.list(a[0] && a[0].items ? a[0].items.slice() : [], 'frozenset');
        case 'builtins.bytearray': { const t = a[0] ? textOf(a[0]) : ''; return V.tagged('bytearray', V.bin(a[0] && a[0].t === 'bin' ? a[0].v : Uint8Array.from(t || '', (c) => c.charCodeAt(0)))); }
        case 'builtins.complex': return V.tagged('complex', V.list(a));
        case 'builtins.bytes': return V.bin(a[0] && a[0].t === 'bin' ? a[0].v : a[0] && a[0].items ? Uint8Array.from(a[0].items, (x) => Number(x.v)) : new Uint8Array(0));
        case 'zoneinfo.ZoneInfo._unpickle': return Object.assign(V.tagged('timezone', a[0] || V.nul()), { zone: a[0] ? textOf(a[0]) : null });
        case '_codecs.encode': { const t = a[0] && textOf(a[0]); if (t !== null && a[1] && textOf(a[1]) === 'latin1') return V.bin(Uint8Array.from(t, (c) => c.charCodeAt(0))); break; }
        case 'collections.OrderedDict': { const m = V.map([], 'OrderedDict'); if (a[0] && a[0].items) for (const p of a[0].items) if (p.items && p.items.length === 2) m.entries.push([p.items[0], p.items[1]]); return m; }
        case 'collections.defaultdict': return V.map([], 'defaultdict(' + (a[0] ? gname(a[0]) : 'None') + ')');
        case 'collections.deque': return V.list(a[0] && a[0].items ? a[0].items.slice() : [], 'deque');
        case 'decimal.Decimal': if (a[0] && a[0].t === 'str') return Object.assign(V.num(a[0].v), { note: 'Decimal' }); break;
        case 'datetime.datetime': case 'datetime.date': case 'datetime.time': {
          const kind = plain.split('.')[1];
          const raw = a[0] && (a[0].t === 'bin' ? a[0].v : a[0].t === 'str' ? Uint8Array.from(a[0].v, (c) => c.charCodeAt(0)) : null);
          const text = raw && pyDate(raw, kind);
          if (text) {
            const tz = (a[1] && a[1].tz) || '';
            const zone = a[1] && a[1].zone;
            if (kind === 'datetime') {
              if (zone) return Object.assign(V.date(null, text + '[' + zone + ']'), { note: 'datetime' });
              // Without a time zone it's a wall-clock time, not a moment.
              if (!tz) return Object.assign(V.date(null, text), { note: 'datetime, no time zone' });
              const ms = Date.parse(text + (tz !== 'UTC' ? tz : 'Z'));
              return Object.assign(V.date(isFinite(ms) ? ms : null, text + (tz === 'UTC' ? '+00:00' : tz)), { note: 'datetime' });
            }
            return V.tagged(plain, V.str(text));
          }
          break;
        }
        case 'datetime.timedelta': {
          const [d, s, us] = a.map((x) => Number(x && x.v) || 0);
          // The way Python prints it: "1 day, 1:02:03.000005".
          return V.tagged('timedelta', V.str((d ? d + (Math.abs(d) === 1 ? ' day, ' : ' days, ') : '') + Math.floor(s / 3600) + ':' + pad(Math.floor(s / 60) % 60) + ':' + pad(s % 60) + (us ? '.' + pad(us, 6) : '')));
        }
        case 'datetime.timezone': {
          const off = a[0] && a[0].t === 'tagged' && a[0].tag === 'timedelta' ? a[0].v.v : null;
          const v = V.tagged('timezone', V.str(off || 'UTC'));
          if (off !== null) { const m = /^(-?\d+ days?, )?(\d+):(\d\d):(\d\d)/.exec(off); if (m) { let sec = (+m[2]) * 3600 + (+m[3]) * 60 + (+m[4]); if (m[1] && m[1].startsWith('-1')) sec -= 86400; v.tz = sec === 0 ? 'UTC' : (sec < 0 ? '-' : '+') + pad(Math.floor(Math.abs(sec) / 3600)) + ':' + pad(Math.floor(Math.abs(sec) / 60) % 60); } }
          else v.tz = 'UTC';
          return v;
        }
        case 'pytz._UTC': return Object.assign(V.tagged('timezone', V.str('UTC')), { tz: 'UTC' });
        case 're._compile': return V.tagged('regex', a[0] || V.nul());
        case 'copyreg._reconstructor': return V.obj(gname(a[0]), []);
        case 'django.db.models.base.model_unpickle': {
          const id = a[0];
          const label = id && id.items ? id.items.map((x) => textOf(x)).join('.') : 'model';
          return V.obj(label, [], null, 'Django model');
        }
      }
      return Object.assign(V.obj(name, [], a.length ? a : undefined, 'built by calling ' + name), { label: 'arguments' });
    }
    function build(obj, state) {
      if (obj.t === 'obj') {
        let st = state;
        if (st.t === 'list' && st.kind === 'tuple' && st.items.length === 2) {
          const [d, slots] = st.items;
          const entries = [].concat(d.t === 'map' ? d.entries : [], slots.t === 'map' ? slots.entries : []);
          st = V.map(entries);
        }
        if (obj.cls === 'uuid.UUID' && st.t === 'map') {
          const e = st.entries.find((x) => textOf(x[0]) === 'int');
          if (e) { const h = BigInt(e[1].v).toString(16).padStart(32, '0'); return morph(obj, V.tagged('UUID', V.str(`${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`))); }
        }
        if (st.t === 'map') { for (const [k, v] of st.entries) obj.fields.push([k.t === 'str' ? k.v : k, v]); }
        else obj.fields.push(['state', st]);
        return obj;
      }
      if (obj.t === 'map' && state.t === 'map') { obj.entries.push(...state.entries); return obj; }
      return obj;
    }

    for (let guard = 0; ; guard++) {
      if (guard > 50000000) fail('too long');
      const op = r.u8();
      switch (op) {
        case 0x80: proto = r.u8(); if (proto > 5) fail('protocol ' + proto + ' is newer than this reader'); break;
        case 0x95: r.bytes(8); break;
        case 0x2e: {
          if (stack.length !== 1 || marks.length) fail('the stack does not end with one value');
          if (r.left) fail('more after the end');
          const v = stack[0];
          v.note = (v.note ? v.note + '; ' : '') + 'protocol ' + proto;
          return v;
        }
        case 0x28: marks.push(stack.length); break;
        case 0x4e: stack.push(V.nul()); break;
        case 0x88: stack.push(V.bool(true)); break;
        case 0x89: stack.push(V.bool(false)); break;
        case 0x49: { const s = line(); if (s === '01') stack.push(V.bool(true)); else if (s === '00') stack.push(V.bool(false)); else if (/^-?\d+$/.test(s)) stack.push(V.int(s)); else fail('a bad INT'); break; }
        case 0x4a: stack.push(V.int(r.i32le())); break;
        case 0x4b: stack.push(V.int(r.u8())); break;
        case 0x4d: stack.push(V.int(r.u16le())); break;
        case 0x4c: { const s = line().replace(/L$/, ''); if (!/^-?\d+$/.test(s)) fail('a bad LONG'); stack.push(V.int(s)); break; }
        case 0x8a: stack.push(V.int(bigLE(r.bytes(r.u8())))); break;
        case 0x8b: stack.push(V.int(bigLE(r.bytes(r.i32le())))); break;
        case 0x46: { const s = line(); stack.push(/^-?(inf|nan)$/i.test(s) ? V.float(parseFloat(s.replace(/inf/i, 'Infinity'))) : V.num(s)); break; }
        case 0x47: stack.push(V.float(r.f64be())); break;
        case 0x53: {
          const s = line();
          const q = s[0];
          if ((q !== "'" && q !== '"') || s[s.length - 1] !== q) fail('a bad STRING');
          stack.push(textOrBytes(Uint8Array.from(pyUnescape(s.slice(1, -1), false))));
          break;
        }
        case 0x54: stack.push(textOrBytes(r.bytes(r.i32le()))); break;
        case 0x55: stack.push(textOrBytes(r.bytes(r.u8()))); break;
        case 0x56: stack.push(V.str(String.fromCodePoint(...pyUnescape(line(), true)))); break;
        case 0x58: case 0x8c: case 0x8d: {
          const n = op === 0x58 ? r.u32le() : op === 0x8c ? r.u8() : Number(r.u64le());
          const t = utf8(r.bytes(n));
          if (t === null) fail('text that is not UTF-8');
          stack.push(V.str(t));
          break;
        }
        case 0x42: stack.push(V.bin(r.bytes(r.u32le()))); break;
        case 0x43: stack.push(V.bin(r.bytes(r.u8()))); break;
        case 0x8e: stack.push(V.bin(r.bytes(Number(r.u64le())))); break;
        case 0x96: stack.push(V.tagged('bytearray', V.bin(r.bytes(Number(r.u64le()))))); break;
        case 0x5d: stack.push(V.list([], 'list')); break;
        case 0x29: stack.push(V.list([], 'tuple')); break;
        case 0x7d: stack.push(V.map([])); break;
        case 0x8f: stack.push(V.list([], 'set')); break;
        case 0x6c: stack.push(V.list(popMark(), 'list')); break;
        case 0x74: stack.push(V.list(popMark(), 'tuple')); break;
        case 0x85: stack.push(V.list([pop()], 'tuple')); break;
        case 0x86: { const y = pop(), x = pop(); stack.push(V.list([x, y], 'tuple')); break; }
        case 0x87: { const z = pop(), y = pop(), x = pop(); stack.push(V.list([x, y, z], 'tuple')); break; }
        case 0x64: { const items = popMark(); const m = V.map([]); for (let i = 0; i + 1 < items.length; i += 2) m.entries.push([items[i], items[i + 1]]); stack.push(m); break; }
        case 0x61: { const v = pop(); const l = top(); if (!l.items) fail('APPEND to something that is not a list'); l.items.push(v); break; }
        case 0x65: { const items = popMark(); const l = top(); if (!l.items) fail('APPENDS to something that is not a list'); l.items.push(...items); break; }
        case 0x73: { const v = pop(), k = pop(); const m = top(); if (m.entries) m.entries.push([k, v]); else if (m.t === 'obj') m.fields.push([textOf(k) || k, v]); else fail('SETITEM on something that is not a dict'); break; }
        case 0x75: { const items = popMark(); const m = top(); for (let i = 0; i + 1 < items.length; i += 2) { if (m.entries) m.entries.push([items[i], items[i + 1]]); else if (m.t === 'obj') m.fields.push([textOf(items[i]) || items[i], items[i + 1]]); else fail('SETITEMS on something that is not a dict'); } break; }
        case 0x90: { const items = popMark(); const s = top(); if (!s.items) fail('ADDITEMS to something that is not a set'); s.items.push(...items); break; }
        case 0x91: stack.push(V.list(popMark(), 'frozenset')); break;
        case 0x30: if (marks.length && marks[marks.length - 1] === stack.length) marks.pop(); else pop(); break;
        case 0x31: popMark(); break;
        case 0x32: stack.push(top()); break;
        case 0x70: memo.set(+line(), top()); break;
        case 0x71: memo.set(r.u8(), top()); break;
        case 0x72: memo.set(r.u32le(), top()); break;
        case 0x94: memo.set(memo.size, top()); break;
        case 0x67: case 0x68: case 0x6a: {
          const k = op === 0x67 ? +line() : op === 0x68 ? r.u8() : r.u32le();
          if (!memo.has(k)) fail('a memo entry that does not exist');
          stack.push(memo.get(k));
          break;
        }
        case 0x63: { const m = line(), n = line(); stack.push(glob(m, n)); break; }
        case 0x93: { const n = pop(), m = pop(); stack.push(glob(textOf(m), textOf(n))); break; }
        case 0x52: { const a = pop(), f = pop(); stack.push(reduce(f, a)); break; }
        case 0x81: { const a = pop(), c = pop(); stack.push(isGlobal(c, 'collections.OrderedDict') ? V.map([], 'OrderedDict') : isGlobal(c, 'builtins.set') ? V.list([], 'set') : V.obj(gname(c), [], a.items && a.items.length ? a.items : undefined)); break; }
        case 0x92: { const kw = pop(), a = pop(), c = pop(); stack.push(V.obj(gname(c), kw.t === 'map' ? kw.entries.map(([k, v]) => [textOf(k) || k, v]) : [], a.items && a.items.length ? a.items : undefined)); break; }
        case 0x62: { const s = pop(); build(top(), s); break; }
        case 0x69: { const m = line(), n = line(); const a = popMark(); stack.push(V.obj(m + '.' + n, [], a.length ? a : undefined)); break; }
        case 0x6f: { const items = popMark(); if (!items.length) fail('OBJ without a class'); stack.push(V.obj(gname(items[0]), [], items.length > 1 ? items.slice(1) : undefined)); break; }
        case 0x50: stack.push(V.tagged('persistent id', V.str(line()))); break;
        case 0x51: stack.push(V.tagged('persistent id', pop())); break;
        case 0x82: stack.push(V.tagged('extension', V.int(r.u8()))); break;
        case 0x83: stack.push(V.tagged('extension', V.int(r.u16le()))); break;
        case 0x84: stack.push(V.tagged('extension', V.int(r.i32le()))); break;
        case 0x97: stack.push(V.tagged('out-of-band buffer', V.nul())); break;
        case 0x98: break;
        default: fail('an unknown opcode 0x' + op.toString(16));
      }
    }
  }

  // ---- Ruby Marshal ----

  function parseMarshal(b) {
    const r = new Reader(b);
    if (r.u8() !== 4 || r.u8() !== 8) throw new FormatError('Not Ruby Marshal 4.8');
    const symbols = [], objects = [];
    const fail = (what) => { throw new FormatError('Marshal: ' + what, r.pos); };
    function long() {
      const c = r.u8() << 24 >> 24;
      if (c === 0) return 0;
      if (c >= 5) return c - 5;
      if (c <= -5) return c + 5;
      let x = 0;
      const n = Math.abs(c);
      for (let i = 0; i < n; i++) x += r.u8() * Math.pow(256, i);
      return c > 0 ? x : x - Math.pow(256, n);
    }
    const raw = () => r.bytes(long());
    function symbol() {
      const tc = r.u8();
      if (tc === 0x3a) { const s = utf8(raw()) || '?'; symbols.push(s); return s; }
      if (tc === 0x3b) { const i = long(); if (i >= symbols.length) fail('a symbol link to nothing'); return symbols[i]; }
      if (tc === 0x49) { const s = symbol(); for (let n = long(); n > 0; n--) { symbol(); value(1); } return s; }
      fail('expected a symbol');
    }
    const keep = (v) => { objects.push(v); return v; };
    // Time#_dump: two little-endian words of bit fields, in UTC.
    function rubyTime(data) {
      if (data.length < 8) return null;
      const x = new Reader(data);
      const p = x.u32le(), s = x.u32le();
      let ms;
      if (!(p & 0x80000000)) ms = p * 1000 + Math.floor(s / 1000);
      else {
        const year = ((p >>> 14) & 0xffff) + 1900, mon = (p >>> 10) & 0xf, day = (p >>> 5) & 0x1f, hour = p & 0x1f;
        const min = (s >>> 26) & 0x3f, sec = (s >>> 20) & 0x3f, usec = s & 0xfffff;
        ms = Date.UTC(year, mon, day, hour, min, sec) + Math.floor(usec / 1000);
      }
      return V.date(ms, isoTime(ms));
    }
    function value(d) {
      if (d > 500) fail('nested too deep');
      const tc = String.fromCharCode(r.u8());
      switch (tc) {
        case '0': return V.nul();
        case 'T': return V.bool(true);
        case 'F': return V.bool(false);
        case 'i': return V.int(long());
        case ':': case ';': { r.pos--; return Object.assign(V.str(symbol()), { note: 'symbol' }); }
        case '"': return keep(V.bin(raw()));
        case 'I': {
          const v = value(d + 1);
          let enc = null;
          const ivars = [];
          for (let n = long(); n > 0; n--) {
            const k = symbol(), val = value(d + 1);
            if (k === 'E') enc = val.t === 'bool' ? (val.v ? 'UTF-8' : 'US-ASCII') : null;
            else if (k === 'encoding') enc = val.t === 'bin' ? latin1(val.v) : val.t === 'str' ? val.v : null;
            else ivars.push([k, val]);
          }
          if (v.t === 'bin' && enc) { const t = enc === 'UTF-8' || enc === 'US-ASCII' ? utf8(v.v) : null; if (t !== null) { delete v.v; Object.assign(v, V.str(t)); } else v.note = enc; }
          if (v.t === 'date') {
            const off = ivars.find((x) => x[0] === 'offset'), zone = ivars.find((x) => x[0] === 'zone');
            const notes = [];
            if (off && off[1].t === 'int') { const sec = Number(off[1].v); notes.push('offset ' + (sec < 0 ? '-' : '+') + pad(Math.floor(Math.abs(sec) / 3600)) + ':' + pad(Math.floor(Math.abs(sec) / 60) % 60)); }
            if (zone) notes.push('zone ' + (zone[1].t === 'bin' ? latin1(zone[1].v) : zone[1].v));
            v.note = ['Time'].concat(notes).join(', ');
          } else if (ivars.length && v.t === 'obj') v.fields.push(...ivars);
          return v;
        }
        case '[': { const l = keep(V.list([])); for (let n = long(); n > 0; n--) l.items.push(value(d + 1)); return l; }
        case '{': case '}': {
          const m = keep(Object.assign(V.map([]), { arrow: true }));
          for (let n = long(); n > 0; n--) { const k = value(d + 1); m.entries.push([k, value(d + 1)]); }
          if (tc === '}') m.note = 'default: ' + show(value(d + 1));
          return m;
        }
        case 'f': {
          const s = latin1(raw()).split('\0')[0];
          return keep(s === 'inf' ? V.float(Infinity) : s === '-inf' ? V.float(-Infinity) : s === 'nan' ? V.float(NaN) : V.num(s));
        }
        case 'l': {
          const sign = String.fromCharCode(r.u8());
          const bytes = r.bytes(long() * 2);
          let x = 0n;
          for (let i = bytes.length - 1; i >= 0; i--) x = (x << 8n) | BigInt(bytes[i]);
          return keep(V.int(sign === '-' ? -x : x));
        }
        case 'o': {
          const o = keep(V.obj(symbol(), []));
          for (let n = long(); n > 0; n--) { const k = symbol(); o.fields.push([k, value(d + 1)]); }
          return o;
        }
        case 'S': {
          const o = keep(V.obj(symbol(), [], null, 'Struct'));
          for (let n = long(); n > 0; n--) { const k = symbol(); o.fields.push([k, value(d + 1)]); }
          return o;
        }
        case 'u': {
          const cls = symbol();
          const data = raw();
          if (cls === 'Time') { const t = rubyTime(data); if (t) return keep(t); }
          return keep(V.obj(cls, [['_dump', textOrBytes(data)]], null, 'written by ' + cls + '._dump'));
        }
        case 'U': {
          const o = keep(V.obj(symbol(), [], null, 'written by marshal_dump'));
          o.fields.push(['marshal_dump', value(d + 1)]);
          return o;
        }
        case 'C': { const cls = symbol(); const v = value(d + 1); v.note = (v.note ? v.note + '; ' : '') + 'a ' + cls; return v; }
        case 'e': { const mod = symbol(); const v = value(d + 1); v.note = (v.note ? v.note + '; ' : '') + 'extended with ' + mod; return v; }
        case '/': { const src = raw(); const opt = r.u8(); return keep(V.tagged('Regexp', V.str('/' + latin1(src) + '/' + (opt & 1 ? 'i' : '') + (opt & 2 ? 'x' : '') + (opt & 4 ? 'm' : '')))); }
        case 'c': return keep(V.tagged('Class', V.str(latin1(raw()))));
        case 'm': case 'M': return keep(V.tagged('Module', V.str(latin1(raw()))));
        case 'd': { const o = keep(V.obj(symbol(), [], null, 'written by _dump_data')); o.fields.push(['data', value(d + 1)]); return o; }
        case '@': { const i = long(); if (i >= objects.length || !objects[i]) fail('an object link to nothing'); return objects[i]; }
      }
      fail('an unknown type ' + JSON.stringify(tc));
    }
    const v = value(0);
    if (r.left) fail('more after the value');
    // Strings without an encoding are binary in Ruby; show them as text
    // when they're valid UTF-8 anyway.
    (function walk(x, seen) {
      if (!x || typeof x !== 'object' || seen.has(x)) return;
      seen.add(x);
      if (x.t === 'bin' && !x.note) { const t = utf8(x.v); if (t !== null && printable(t)) { delete x.v; Object.assign(x, V.str(t), { note: 'no encoding set' }); } }
      for (const k of ['items', 'entries', 'fields']) if (x[k]) for (const e of x[k]) { if (Array.isArray(e)) { walk(e[0], seen); walk(e[1], seen); } else walk(e, seen); }
      if (x.v && typeof x.v === 'object' && x.v.t) walk(x.v, seen);
    })(v, new Set());
    return v;
  }

  // ---- Images and other files ----

  function imageInfo(b) {
    const s = latin1(b.subarray(0, 16));
    if (b.length >= 24 && s.startsWith('\x89PNG\r\n\x1a\n')) { const r = new Reader(b, 16); return { mime: 'image/png', name: 'PNG image', width: r.u32be(), height: r.u32be() }; }
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
      for (let i = 2; i + 9 < b.length && b[i] === 0xff;) {
        const m = b[i + 1], len = (b[i + 2] << 8) | b[i + 3];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { mime: 'image/jpeg', name: 'JPEG image', height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8] };
        i += 2 + len;
      }
      return { mime: 'image/jpeg', name: 'JPEG image' };
    }
    if ((s.startsWith('GIF87a') || s.startsWith('GIF89a')) && b.length >= 10) return { mime: 'image/gif', name: 'GIF image', width: b[6] | (b[7] << 8), height: b[8] | (b[9] << 8) };
    if (s.startsWith('RIFF') && latin1(b.subarray(8, 12)) === 'WEBP' && b.length >= 30) {
      const chunk = latin1(b.subarray(12, 16));
      const info = { mime: 'image/webp', name: 'WebP image' };
      if (chunk === 'VP8X') { info.width = 1 + (b[24] | (b[25] << 8) | (b[26] << 16)); info.height = 1 + (b[27] | (b[28] << 8) | (b[29] << 16)); }
      else if (chunk === 'VP8 ') { info.width = (b[26] | (b[27] << 8)) & 0x3fff; info.height = (b[28] | (b[29] << 8)) & 0x3fff; }
      else if (chunk === 'VP8L') { const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0; info.width = (bits & 0x3fff) + 1; info.height = ((bits >>> 14) & 0x3fff) + 1; }
      return info;
    }
    if (s.startsWith('BM') && b.length > 26) {
      // The file size and a known header size, since plenty of text starts with BM.
      const r = new Reader(b, 2), size = r.u32le();
      r.pos = 14;
      const header = r.u32le();
      if (size === b.length && [12, 40, 52, 56, 108, 124].includes(header)) { r.pos = 18; return { mime: 'image/bmp', name: 'BMP image', width: r.i32le(), height: Math.abs(r.i32le()) }; }
    }
    if (latin1(b.subarray(4, 8)) === 'ftyp' && /^(avif|avis|heic|heix|mif1)/.test(latin1(b.subarray(8, 12)))) return { mime: latin1(b.subarray(8, 12)).startsWith('avi') ? 'image/avif' : 'image/heic', name: latin1(b.subarray(8, 12)).startsWith('avi') ? 'AVIF image' : 'HEIC image' };
    return null;
  }

  // A Redis DUMP payload ends with its format version and a CRC64 of the rest.
  function isRedisDump(b) {
    if (b.length < 11 || b[0] > 40) return false;
    const n = b.length, c = crc64(b.subarray(0, n - 8));
    const lo = (b[n - 8] | (b[n - 7] << 8) | (b[n - 6] << 16) | (b[n - 5] << 24)) >>> 0;
    const hi = (b[n - 4] | (b[n - 3] << 8) | (b[n - 2] << 16) | (b[n - 1] << 24)) >>> 0;
    return c[0] === lo && c[1] === hi;
  }

  // Readings of a short binary value as numbers.
  function numberNotes(b) {
    const notes = [];
    const d = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (b.length === 2) notes.push(`As a 16-bit number: ${d.getUint16(0, true)} little-endian, ${d.getUint16(0)} big-endian`);
    if (b.length === 4) notes.push(`As a 32-bit integer: ${d.getInt32(0, true)} little-endian, ${d.getInt32(0)} big-endian. As a float: ${d.getFloat32(0, true)} little-endian, ${d.getFloat32(0)} big-endian`);
    if (b.length === 8) notes.push(`As a 64-bit integer: ${d.getBigInt64(0, true)} little-endian, ${d.getBigInt64(0)} big-endian. As a double: ${d.getFloat64(0, true)} little-endian, ${d.getFloat64(0)} big-endian`);
    if (b.length === 16) { const h = hex(b); notes.push(`As a UUID: ${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`); }
    return notes;
  }
  // Notes for text that stands for something: a time, or a hash.
  function textNotes(t) {
    const notes = [];
    const s = t.trim();
    if (/^\d{10}(\.\d+)?$/.test(s)) { const ms = parseFloat(s) * 1000; if (ms > 946684800000 && ms < 4102444800000) notes.push('As a Unix time in seconds: ' + isoTime(Math.round(ms))); }
    if (/^\d{13}$/.test(s)) { const ms = +s; if (ms > 946684800000 && ms < 4102444800000) notes.push('As a Unix time in milliseconds: ' + isoTime(ms)); }
    if (/^[0-9a-f]+$/i.test(s)) {
      const hashes = { 32: 'MD5', 40: 'SHA-1', 64: 'SHA-256', 96: 'SHA-384', 128: 'SHA-512' };
      if (hashes[s.length]) notes.push(`${s.length} hex digits, the length of a ${hashes[s.length]} hash.`);
    }
    return notes;
  }

  // Hex and ASCII side by side, 16 bytes a line.
  function hexdump(b, max) {
    max = max || 4096;
    const lines = [];
    for (let i = 0; i < Math.min(b.length, max); i += 16) {
      const row = b.subarray(i, Math.min(i + 16, b.length));
      const hx = Array.from(row, (x) => x.toString(16).padStart(2, '0')).join(' ');
      const asc = Array.from(row, (x) => (x >= 0x20 && x < 0x7f ? String.fromCharCode(x) : '.')).join('');
      lines.push(i.toString(16).padStart(8, '0') + '  ' + hx.padEnd(47) + '  ' + asc);
    }
    if (b.length > max) lines.push(`... ${b.length - max} more bytes`);
    return lines.join('\n');
  }

  // ---- Working out what a value is ----

  const startsWith = (b, sig) => sig.every((x, i) => b[i] === x);
  const u32le0 = (b) => (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;

  // Whether what's inside base64, hex or headerless compression is
  // convincing enough to count: a format with a signature, real-looking
  // text, or a guess with plenty of evidence.
  function convincing(inner) {
    if (inner.id === 'binary' || inner.id === 'empty') return false;
    if (inner.id === 'text') { const t = inner.value.v; return t.length >= 6 && (t.match(/[A-Za-z0-9 ]/g) || []).length / t.length >= 0.7; }
    if (inner.score !== undefined && inner.score < 4) return false;
    return true;
  }

  // Peels one layer, or names what's left. Returns
  //   { layer: true, id, name, out, check, facts }      something wrapped around more bytes
  //   { id, name, value, notes, alternatives, image }   the value itself
  function identify(b, depth) {
    const tryLayer = (id, name, f) => { try { const x = f(); return Object.assign({ layer: true, id: id, name: name }, x); } catch (e) { return null; } };
    const tryValue = (id, name, f) => { try { return { id: id, name: name, value: f() }; } catch (e) { return null; } };
    let x;
    if (!b.length) return { id: 'empty', name: 'An empty value', value: V.str('') };

    // Compression and containers, by their first bytes.
    if (b[0] === 0x1f && b[1] === 0x8b && (x = tryLayer('gzip', 'gzip', () => gunzip(b)))) return x;
    if (startsWith(b, [0x04, 0x22, 0x4d, 0x18]) && (x = tryLayer('lz4', 'LZ4 frame', () => lz4Frame(b)))) return x;
    if (startsWith(b, SNAPPY_ID) && (x = tryLayer('snappy', 'Snappy, framed', () => snappyFramed(b)))) return x;
    if (isZlib(b) && (x = tryLayer('zlib', 'zlib', () => unzlib(b))) && x.check === 'ok') return x;
    for (const n of NAMED) if (n.test(b)) return { id: n.id, name: n.name, value: null, notes: ['This tool recognizes ' + n.name + ' but doesn\'t decode it.'] };
    const img = imageInfo(b);
    if (img) return { id: 'image', name: img.name, value: null, image: img, notes: img.width ? [img.width + ' by ' + img.height + ' pixels'] : [] };

    // Serializers with a signature.
    if (b[0] === 0xac && b[1] === 0xed && b[2] === 0 && (x = tryValue('java', 'Java serialization', () => parseJava(b)))) return x;
    if (b[0] === 0x80 && b[1] >= 2 && b[1] <= 5 && b[b.length - 1] === 0x2e && (x = tryValue('pickle', 'Python pickle', () => parsePickle(b)))) return x;
    if (b[0] === 4 && b[1] === 8 && (x = tryValue('marshal', 'Ruby Marshal', () => parseMarshal(b)))) return x;
    if (b[0] === 0 && b[1] === 0 && b[2] === 0 && (b[3] === 1 || b[3] === 2) && (x = tryValue('igbinary', 'PHP igbinary', () => parseIgbinary(b)))) return x;
    if (b.length >= 5 && u32le0(b) === b.length && b[b.length - 1] === 0 && (x = tryValue('bson', 'BSON', () => parseBSON(b)))) return x;
    if (isRedisDump(b)) return { id: 'redis-dump', name: 'A Redis or Valkey DUMP payload', value: null, notes: ['The Snapshot Viewer reads DUMP payloads: https://keyvaluestore.com/tools/snapshot/'], version: b[b.length - 10] | (b[b.length - 9] << 8) };

    // PHP's serialize() and sessions, and pickle's older protocols, are
    // mostly text but may hold any bytes, such as the zero bytes around
    // private property names, so they're tried on the bytes as they are.
    const head = latin1(b.subarray(0, 64));
    const noNewline = b[b.length - 1] === 10 ? b.subarray(0, b.length - (b[b.length - 2] === 13 ? 2 : 1)) : b;
    if (PHP_START.test(head)) for (const v of [b, noNewline]) if ((x = tryValue('php', 'PHP serialize', () => parsePHP(v)))) return x;
    if (/^[A-Za-z0-9_.-]+\|/.test(head) && (x = tryValue('php-session', 'PHP session', () => parsePHPSession(noNewline)))) return x;
    if (b[b.length - 1] === 0x2e && '(]})cIlLSVNKJFdtUXTMG'.includes(head[0]) && (x = tryValue('pickle', 'Python pickle', () => parsePickle(b)))) return x;

    // Text.
    let text = utf8(b);
    const bom = text !== null && text.charCodeAt(0) === 0xfeff;
    if (bom) text = text.slice(1);
    if (text !== null && printable(text)) {
      const t = text.trim();
      if (/^[[{"]/.test(t) && (x = tryValue('json', 'JSON', () => parseJSON(t)))) return x;
      if (JWT.test(t) && (x = tryValue('jwt', 'JSON Web Token', () => parseJWT(t)))) return x;
      if (/^(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(t)) return { id: 'image', name: 'SVG image', value: V.str(text), image: { mime: 'image/svg+xml', name: 'SVG image' } };
      // Text that encodes something else.
      if (depth < 7) {
        const b64 = looksBase64(t);
        if (b64 && b64.length >= 3 && convincing(identify(b64, depth + 1))) return { layer: true, id: 'base64', name: 'Base64', out: b64, check: null, facts: [] };
        if (/^[0-9a-fA-F]+$/.test(t) && t.length % 2 === 0 && t.length >= 16) {
          const hb = hexBytes(t);
          if (convincing(identify(hb, depth + 1))) return { layer: true, id: 'hex', name: 'Hex digits', out: hb, check: null, facts: [] };
        }
      }
      const notes = textNotes(t);
      if (bom) notes.unshift('Starts with a UTF-8 byte order mark.');
      if (t !== '' && /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(t)) notes.unshift('A number.');
      return { id: 'text', name: 'Text', value: V.str(text), notes: notes };
    }

    // Binary with no signature: try the formats that have none.
    const found = [];
    const add = (c) => { if (c) found.push(c); };
    const c0 = b[0];
    if (depth < 7) {
      for (const [id, name, f] of [['lz4-block', 'LZ4 block with its size first', () => lz4Sized(b, false)], ['lz4-block-be', 'LZ4 block with its size first (big-endian)', () => lz4Sized(b, true)], ['snappy-raw', 'Snappy', () => snappyRaw(b)]]) {
        const l = tryLayer(id, name, f);
        if (l && l.out.length && convincing(identify(l.out, depth + 1))) return l;
      }
    }
    if ((c0 >= 0x80 && c0 <= 0x9f) || (c0 >= 0xc4 && c0 <= 0xdf && c0 !== 0xc1)) add(tryValue('msgpack', 'MessagePack', () => parseMsgpack(b)));
    if ((c0 >= 0x80 && c0 <= 0xbf) || (c0 >= 0xc0 && c0 <= 0xdb) || c0 === 0xd9) add(tryValue('cbor', 'CBOR', () => parseCBOR(b)));
    const proto = tryValue('protobuf', 'Protocol Buffers', () => parseProtobuf(b, 0, true));
    if (proto && proto.value.fields.length) add(proto);
    if (found.length) {
      // Prefer the reading with the most text in it: keys and strings are
      // what real data is made of, and wrong readings rarely produce them.
      const score = (v) => {
        let s = 0;
        (function walk(x, d) {
          if (!x || d > 50) return;
          if (x.t === 'str' && x.v.length && printable(x.v)) s += 2 + Math.min(10, x.v.length / 4);
          // Floats, booleans, nulls and dates each need a particular type byte.
          if (x.t === 'float' || x.t === 'bool' || x.t === 'null' || x.t === 'date') s += 1;
          if (x.t === 'bin') s -= 1;
          if (x.t === 'tagged') s -= 2;
          for (const k of ['items', 'entries', 'fields']) if (x[k]) for (const e of x[k]) { if (Array.isArray(e)) { walk(e[0], d + 1); walk(e[1], d + 1); } else walk(e, d + 1); }
          if (x.v && typeof x.v === 'object' && x.v.t) walk(x.v, d + 1);
        })(v, 0);
        return s;
      };
      const order = { msgpack: 2, cbor: 1, protobuf: 0 };
      found.sort((p, q) => score(q.value) - score(p.value) || order[q.id] - order[p.id]);
      const best = found[0];
      // A reading made only of small integers and raw bytes is too weak to
      // call, since random bytes often parse as one. Show it as a possibility.
      best.score = score(best.value);
      if (best.score < 2) return { id: 'binary', name: 'Binary data', value: V.bin(b), notes: numberNotes(b), alternatives: found };
      best.alternatives = found.slice(1);
      if (best.id === 'protobuf') best.notes = ['Without the .proto schema the field names and types are unknown. Varints show as unsigned numbers; zigzag-encoded sint fields would read differently.'];
      return best;
    }
    return { id: 'binary', name: 'Binary data', value: V.bin(b), notes: numberNotes(b) };
  }

  // Peels every layer and decodes what's inside.
  // Returns { layers: [{ id, name, size, out, check, facts }], result: { id, name, value, notes, alternatives, image }, bytes }
  function analyze(input) {
    let b = input instanceof Uint8Array ? input : encoder.encode(String(input));
    const layers = [];
    for (let depth = 0; depth < 8; depth++) {
      const x = identify(b, depth);
      if (!x.layer) return { layers: layers, result: x, bytes: b };
      const facts = (x.facts || []).slice();
      if (x.rest) facts.push(x.rest + ' bytes follow the compressed data');
      layers.push({ id: x.id, name: x.name, size: b.length, out: x.out.length, check: x.check, facts: facts });
      b = x.out;
    }
    return { layers: layers, result: { id: 'binary', name: 'Binary data', value: V.bin(b), notes: ['Stopped after 8 layers.'] }, bytes: b };
  }

  // ---- Showing a value ----

  function quote(s) {
    return '"' + s.replace(/[\\"\u0000-\u001f\u007f]/g, (c) => ({ '\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\r', '\t': '\\t' }[c] || '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))) + '"';
  }
  const floatText = (x) => (Number.isNaN(x) ? 'NaN' : x === Infinity ? 'Infinity' : x === -Infinity ? '-Infinity' : Object.is(x, -0) ? '-0.0' : Number.isInteger(x) && Math.abs(x) < 1e21 ? x + '.0' : String(x));
  // The value as readable text, nested with two-space indents.
  function show(v, opts) {
    opts = opts || {};
    const maxStr = opts.maxString || 4000, maxItems = opts.maxItems || 2000;
    const path = new Set();
    const note = (s, x) => (x && x.note && x.note !== 'symbol' && !(x.t === 'map' || x.t === 'list') ? s + '  // ' + x.note : s);
    const short = (s) => (s.length > maxStr ? s.slice(0, maxStr) + '... (' + (s.length - maxStr) + ' more characters)' : s);
    function scalar(x) {
      switch (x.t) {
        case 'null': return 'null';
        case 'bool': return x.v ? 'true' : 'false';
        case 'int': case 'num': return x.v;
        case 'float': return floatText(x.v);
        case 'str': return x.note === 'symbol' ? ':' + (/^[A-Za-z_][\w]*[?!=]?$/.test(x.v) ? x.v : quote(x.v)) : quote(short(x.v));
        case 'bin': { const n = x.v.length; return 'bytes(' + n + ') ' + hex(x.v.subarray(0, Math.min(n, maxStr / 2))) + (n > maxStr / 2 ? '...' : ''); }
        case 'date': return x.text || isoTime(x.v) || String(x.v);
        case 'ref': return '<' + x.v + '>';
      }
      return null;
    }
    // A map key or field name. Symbols show the Ruby way, other notes in brackets.
    // Field names show bare when they're simple names; map keys keep quotes.
    const simple = (t) => /^[A-Za-z_$@][\w$@-]*$/.test(t);
    function key(k, bare) {
      if (typeof k === 'string') return (bare ? /^[A-Za-z_$@][\w$@ .-]*$/.test(k) && !/\s$/.test(k) : simple(k)) ? k : quote(k);
      if (k.t === 'str' && k.note === 'symbol') return ':' + (/^[A-Za-z_][\w]*[?!=]?$/.test(k.v) ? k.v : quote(k.v));
      const s = bare && k.t === 'str' && /^[A-Za-z_$@][\w$@ .-]*$/.test(k.v) && !/\s$/.test(k.v) ? k.v : one(Object.assign({}, k, { note: undefined }), '');
      return k.note ? s + ' (' + k.note + ')' : s;
    }
    function one(x, ind) {
      if (x === null || x === undefined) return 'null';
      const s = scalar(x);
      if (s !== null) return note(s, x);
      if (path.has(x)) return '<cycle>';
      path.add(x);
      try {
        if (x.t === 'tagged') return note(x.tag + '(' + one(x.v, ind) + ')', x);
        let open, close, parts;
        const label = (x.note && (x.t === 'map' || x.t === 'list') ? x.note + ' ' : '');
        if (x.t === 'list') {
          const kind = x.kind && x.kind !== 'list' ? x.kind + ' ' : '';
          open = label + kind + '['; close = ']';
          parts = x.items.slice(0, maxItems).map((e) => one(e, ind + '  '));
          if (x.items.length > maxItems) parts.push('... ' + (x.items.length - maxItems) + ' more');
        } else if (x.t === 'map') {
          open = label + '{'; close = '}';
          const sep = x.arrow ? ' => ' : ': ';
          parts = x.entries.slice(0, maxItems).map(([k, e]) => key(k, false) + sep + one(e, ind + '  '));
          if (x.entries.length > maxItems) parts.push('... ' + (x.entries.length - maxItems) + ' more');
        } else if (x.t === 'obj') {
          open = x.cls + ' {'; close = '}';
          parts = x.fields.slice(0, maxItems).map(([k, e]) => key(k, true) + ': ' + one(e, ind + '  '));
          if (x.items && x.items.length) parts.push((x.label || 'items') + ': ' + one(V.list(x.items), ind + '  '));
          if (!parts.length) return x.cls + (x.note ? '  // ' + x.note : '');
          if (x.note) open += '  // ' + x.note;
        } else return '?';
        const flat = open + parts.join(', ') + close;
        if (!parts.length) return open + close;
        if (flat.length <= 76 && !flat.includes('\n') && !open.includes('//') && !parts.some((p) => p.includes('//'))) return flat;
        return open + '\n' + parts.map((p) => ind + '  ' + p).join('\n') + '\n' + ind + close;
      } finally { path.delete(x); }
    }
    return one(v, '');
  }

  // The value as plain JSON-ready data: maps with text keys become objects,
  // bytes become { "$bytes": base64 }, objects keep their class in "$class".
  function plain(v) {
    const path = new Set();
    const b64 = (b) => { const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'; let s = ''; for (let i = 0; i < b.length; i += 3) { const n = (b[i] << 16) | ((b[i + 1] || 0) << 8) | (b[i + 2] || 0); s += A[n >> 18] + A[(n >> 12) & 63] + (i + 1 < b.length ? A[(n >> 6) & 63] : '=') + (i + 2 < b.length ? A[n & 63] : '='); } return s; };
    function p(x) {
      if (!x) return null;
      switch (x.t) {
        case 'null': return null;
        case 'bool': return x.v;
        case 'int': { const n = Number(x.v); return Number.isSafeInteger(n) ? n : x.v; }
        case 'num': { const n = Number(x.v); return isFinite(n) && String(n) === x.v.replace(/^\+/, '') ? n : x.v; }
        case 'float': return isFinite(x.v) ? x.v : floatText(x.v);
        case 'str': return x.v;
        case 'bin': return { $bytes: b64(x.v) };
        case 'date': return x.text || isoTime(x.v);
        case 'ref': return { $ref: x.v };
      }
      if (path.has(x)) return { $cycle: true };
      path.add(x);
      try {
        if (x.t === 'tagged') return { $tag: x.tag, value: p(x.v) };
        if (x.t === 'list') return x.items.map(p);
        if (x.t === 'map') {
          const keys = x.entries.map(([k]) => (k.t === 'str' ? k.v : k.t === 'int' ? k.v : null));
          if (keys.every((k) => k !== null) && new Set(keys).size === keys.length) { const o = {}; x.entries.forEach(([, e], i) => { o[keys[i]] = p(e); }); return o; }
          return x.entries.map(([k, e]) => [p(k), p(e)]);
        }
        if (x.t === 'obj') {
          const o = { $class: x.cls };
          for (const [k, e] of x.fields) o[typeof k === 'string' ? k : JSON.stringify(p(k))] = p(e);
          if (x.items && x.items.length) o['$' + (x.label || 'items')] = x.items.map(p);
          return o;
        }
        return null;
      } finally { path.delete(x); }
    }
    return p(v);
  }

  return {
    FormatError: FormatError,
    fromInput: fromInput,
    analyze: analyze,
    identify: identify,
    show: show,
    plain: plain,
    hexdump: hexdump,
    utf8: utf8,
    base64Bytes: base64Bytes,
    hexBytes: hexBytes,
    // The decoders, for use on their own.
    parseJSON: parseJSON, parseJWT: parseJWT, parsePHP: parsePHP, parsePHPSession: parsePHPSession,
    parseMsgpack: parseMsgpack, parseCBOR: parseCBOR, parseBSON: parseBSON, parseProtobuf: parseProtobuf, parseIgbinary: parseIgbinary,
    parseJava: parseJava, parsePickle: parsePickle, parseMarshal: parseMarshal,
    inflate: inflate, gunzip: gunzip, unzlib: unzlib, lz4Frame: lz4Frame, lz4Sized: lz4Sized, snappyRaw: snappyRaw, snappyFramed: snappyFramed,
    crc32: crc32, adler32: adler32, xxh32: xxh32
  };
});
