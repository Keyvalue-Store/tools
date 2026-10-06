// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Revision Viewer. Opens an etcd snapshot, or a member's database file, and
// shows what fills it: space by key prefix and by Kubernetes resource, the
// old revisions still kept, the 2 GiB quota, free pages a defrag would give
// back, leases, members and alarms, Secrets stored in the clear, and the
// history of any key. etcd keeps its data in a bbolt file; this reads that
// format directly. One file, no dependencies. In a browser it defines
// KVRevisions; in Node, require() returns the same functions.

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KVRevisions = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ignoreBOM keeps a U+FEFF at the start of a string, as Go does.
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  const strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const encoder = new TextEncoder();

  // code, when there is one, says what kind of problem it is: 'gzip' for a
  // file that needs unpacking first.
  class SnapshotError extends Error {
    constructor(message, code) { super(message); this.name = 'SnapshotError'; if (code) this.code = code; }
  }

  // ---- little helpers ----

  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
  // Page numbers and revisions fit well inside a JavaScript number.
  function u64(b, o) { return u32(b, o) + u32(b, o + 4) * 4294967296; }
  function u64be(b, o) { return ((b[o] << 24 | b[o + 1] << 16 | b[o + 2] << 8 | b[o + 3]) >>> 0) * 4294967296 + ((b[o + 4] << 24 | b[o + 5] << 16 | b[o + 6] << 8 | b[o + 7]) >>> 0); }
  function big64(b, o) { let v = 0n; for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[o + i]); return v; }
  function text(b) { try { return strict.decode(b); } catch (e) { return null; } }
  function show(b) {
    const t = text(b);
    if (t !== null && !/[\u0000-\u0008\u000e-\u001f]/.test(t)) return t;
    let out = '';
    for (const x of b) out += x >= 0x20 && x < 0x7f && x !== 0x5c ? String.fromCharCode(x) : '\\x' + x.toString(16).padStart(2, '0');
    return out;
  }
  function equalBytes(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  // ---- SHA-256, for the hash etcdctl puts at the end of a snapshot ----

  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
  function sha256(data) {
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
        const t1 = (hh + S1 + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
        const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        const t2 = (S0 + ((a & bb) ^ (a & c) ^ (bb & c))) | 0;
        hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = bb; bb = a; a = (t1 + t2) | 0;
      }
      h[0] += a; h[1] += bb; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
    };
    const full = Math.floor(n / 64) * 64;
    for (let o = 0; o < full; o += 64) block(data, o);
    for (let o = 0; o < tail.length; o += 64) block(tail, o);
    const out = new Uint8Array(32);
    for (let i = 0; i < 8; i++) { out[4 * i] = h[i] >>> 24; out[4 * i + 1] = h[i] >>> 16; out[4 * i + 2] = h[i] >>> 8; out[4 * i + 3] = h[i]; }
    return out;
  }
  const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

  // ---- CRC-32C, for the hash etcdutl snapshot status prints ----

  const CRC32C = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x82f63b78 : c >>> 1;
    CRC32C[i] = c >>> 0;
  }
  function crc32c(crc, b) {
    let c = ~crc >>> 0;
    for (let i = 0; i < b.length; i++) c = CRC32C[(c ^ b[i]) & 0xff] ^ (c >>> 8);
    return ~c >>> 0;
  }

  // ---- bbolt ----

  // A bbolt file is a run of fixed-size pages. Pages 0 and 1 hold two copies
  // of the meta page, written in turn; the valid one with the higher
  // transaction id is current. Data lives in B+trees of branch and leaf pages.
  const PAGE_HEADER = 16, ELEMENT = 16;
  const BRANCH = 0x01, LEAF = 0x02, META = 0x04, FREELIST = 0x10;
  const BUCKET_LEAF = 0x01;
  const MAGIC = 0xED0CDAED;

  // FNV-1a over the meta fields, the checksum bbolt keeps in each meta page.
  function fnv64(b, from, to) {
    let h = 0xcbf29ce484222325n;
    for (let i = from; i < to; i++) { h ^= BigInt(b[i]); h = (h * 0x100000001b3n) & 0xffffffffffffffffn; }
    return h;
  }

  function readMeta(b, off) {
    const m = off + PAGE_HEADER;
    if (m + 64 > b.length) return null;
    if (!(u16(b, off + 8) & META)) return null;
    if (u32(b, m) !== MAGIC) return null;
    const meta = {
      version: u32(b, m + 4), pageSize: u32(b, m + 8), flags: u32(b, m + 12),
      root: u64(b, m + 16), sequence: u64(b, m + 24), freelist: u64(b, m + 32), pgid: u64(b, m + 40), txid: u64(b, m + 48)
    };
    meta.checksumOk = big64(b, m + 56) === fnv64(b, m, m + 56);
    return meta;
  }

  // Opens the file: picks the current meta page and checks for the SHA-256
  // that etcdctl snapshot save appends.
  function openFile(bytes) {
    if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
    if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
      throw new SnapshotError('This file is gzipped. Unpack it first, for example with "gunzip backup.db.gz", then open the unpacked file.', 'gzip');
    }
    if (bytes.length < 1024) throw new SnapshotError('The file is too small to be an etcd snapshot.');
    const m0 = readMeta(bytes, 0);
    if (!m0) throw new SnapshotError('This is not an etcd snapshot: it has no bbolt meta page at the start. etcd writes snapshots with "etcdctl snapshot save"; a member keeps its data in member/snap/db.');
    if (m0.version !== 2) throw new SnapshotError('The bbolt format version is ' + m0.version + '; this reads version 2, which every etcd 3.x writes.');
    const pageSize = m0.pageSize;
    if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1))) throw new SnapshotError('The page size, ' + pageSize + ' bytes, is not one bbolt uses.');
    const m1 = readMeta(bytes, pageSize);
    const metas = [m0, m1].filter((m) => m && m.checksumOk);
    if (!metas.length) throw new SnapshotError('Both meta pages fail their checksum, so the file is damaged.');
    const meta = metas.sort((a, b) => b.txid - a.txid)[0];
    const extra = bytes.length % pageSize;
    let hash = null;
    if (extra === 32) {
      const body = bytes.subarray(0, bytes.length - 32);
      const stored = bytes.subarray(bytes.length - 32);
      hash = { stored: hex(stored), computed: null, ok: null };
      // computed: the SHA-256 as hex when the caller has a faster way to get
      // it, such as Node's crypto or the browser's crypto.subtle.
      hash.check = (computed) => { hash.computed = computed || hex(sha256(body)); hash.ok = hash.computed === hash.stored; return hash.ok; };
      hash.body = body;
    }
    const data = extra === 32 ? bytes.subarray(0, bytes.length - 32) : bytes;
    return { bytes: data, pages: Math.floor(data.length / pageSize), fileBytes: bytes.length, pageSize: pageSize, meta: meta, metas: [m0, m1], hash: hash, extra: extra };
  }

  // Reads a page header. A page can run on over the pages after it
  // (overflow); all of them must lie in the file and below the high water
  // mark, the first page the database doesn't use.
  function page(db, id) {
    if (id >= db.pages) throw new SnapshotError('Page ' + id + ' lies past the end of the file, so the file is cut short or damaged.');
    const b = db.bytes, off = id * db.pageSize;
    const overflow = u32(b, off + 12);
    if (id + overflow >= db.pages) throw new SnapshotError('Page ' + id + ' runs on past the end of the file, so the file is cut short or damaged.');
    if (id + overflow >= db.meta.pgid) throw new SnapshotError('Page ' + id + (id >= db.meta.pgid ? ' lies' : ' runs on') + ' past the pages the database says it uses, so the file is damaged.');
    return { id: id, off: off, end: off + (overflow + 1) * db.pageSize, flags: u16(b, off + 8), count: u16(b, off + 10), overflow: overflow };
  }
  const where = (p) => (p.id === 'inline' ? 'A bucket kept inside its parent' : 'Page ' + p.id);

  // Walks a B+tree, in key order, calling fn(key, value, flags) for every
  // leaf element. pages collects the ids of the pages it touched, across
  // walks. seen holds the pages this walk has reached: in a sound file each
  // page has one place in one tree, so a page reached twice means a damaged
  // or crafted file, which could otherwise loop or branch without end.
  function walkTree(db, rootId, fn, pages, seen, depth) {
    if (depth > 64) throw new SnapshotError('A tree in the file loops back on itself.');
    const p = page(db, rootId);
    for (let i = 0; i <= p.overflow; i++) {
      if (seen.has(rootId + i)) throw new SnapshotError('Page ' + (rootId + i) + ' turns up twice in one tree, so the file is damaged.');
      seen.add(rootId + i);
      if (pages) pages.add(rootId + i);
    }
    walkPage(db, p, db.bytes, fn, pages, seen, depth);
  }
  function walkPage(db, p, b, fn, pages, seen, depth) {
    const base = p.off + PAGE_HEADER;
    if (base + p.count * ELEMENT > p.end) throw new SnapshotError(where(p) + ' lists more records than fit in it, so the file is damaged.');
    if (p.flags & BRANCH) {
      for (let i = 0; i < p.count; i++) {
        const e = base + i * ELEMENT;
        walkTree(db, u64(b, e + 8), fn, pages, seen, depth + 1);
      }
    } else if (p.flags & LEAF) {
      for (let i = 0; i < p.count; i++) {
        const e = base + i * ELEMENT;
        const flags = u32(b, e), pos = u32(b, e + 4), ksize = u32(b, e + 8), vsize = u32(b, e + 12);
        const k = e + pos;
        if (k + ksize + vsize > p.end) throw new SnapshotError(where(p) + ' has a record that runs past its end, so the file is damaged.');
        fn(b.subarray(k, k + ksize), b.subarray(k + ksize, k + ksize + vsize), flags);
      }
    } else throw new SnapshotError(where(p) + ' should be part of a tree but is marked ' + p.flags + '.');
  }

  // A bucket is a named tree. Small buckets are stored inline, inside the
  // parent's value, as a page of their own after a 16-byte header.
  function walkBucket(db, value, fn, pages) {
    const rootId = u64(value, 0);
    if (rootId !== 0) return walkTree(db, rootId, fn, pages, new Set(), 0);
    const inline = value.subarray(16);
    const p = { id: 'inline', off: 0, end: inline.length, flags: u16(inline, 8), count: u16(inline, 10), overflow: 0 };
    walkPage(db, p, inline, fn, pages, new Set(), 0);
  }

  // The top-level buckets and the pages in use.
  function buckets(db) {
    const out = new Map();
    const pages = new Set([0, 1]);
    walkTree(db, db.meta.root, (k, v, flags) => {
      if (flags & BUCKET_LEAF) out.set(decoder.decode(k), v);
    }, pages, new Set(), 0);
    return { map: out, pages: pages };
  }

  // Pages listed as free, when the freelist was written to the file. etcd
  // usually leaves it out (NoFreelistSync), and then every page that no tree
  // uses is free.
  function freelist(db) {
    const id = db.meta.freelist;
    if (id === 0 || id >= db.meta.pgid || id >= db.pages) return null;
    const p = page(db, id);
    if (!(p.flags & FREELIST)) return null;
    let count = p.count, start = p.off + PAGE_HEADER;
    if (count === 0xffff) { count = u64(db.bytes, start); start += 8; }
    const ids = [];
    for (let i = 0; i < count && start + 8 * i + 8 <= p.end; i++) ids.push(u64(db.bytes, start + 8 * i));
    return { page: id, overflow: p.overflow, ids: ids };
  }

  // ---- protobuf, enough for etcd's records and Kubernetes' envelopes ----

  function varint(b, o) {
    let v = 0, s = 1, i = o;
    for (;;) {
      if (i >= b.length) return null;
      const x = b[i++];
      v += (x & 0x7f) * s;
      if (!(x & 0x80)) break;
      s *= 128;
      if (s > 2 ** 70) return null;
    }
    return { v: v, next: i };
  }
  // The fields of a message: number to list of { wire, v (number), bytes }.
  function fields(b) {
    const out = new Map();
    let i = 0;
    while (i < b.length) {
      const t = varint(b, i);
      if (!t) return null;
      const num = Math.floor(t.v / 8), wire = t.v % 8;
      i = t.next;
      if (num < 1) return null;
      let f;
      if (wire === 0) { const x = varint(b, i); if (!x) return null; f = { wire: 0, v: x.v }; i = x.next; }
      else if (wire === 2) {
        const l = varint(b, i);
        if (!l || l.next + l.v > b.length) return null;
        f = { wire: 2, bytes: b.subarray(l.next, l.next + l.v), start: l.next, end: l.next + l.v };
        i = l.next + l.v;
      } else if (wire === 1) { if (i + 8 > b.length) return null; f = { wire: 1, bytes: b.subarray(i, i + 8) }; i += 8; }
      else if (wire === 5) { if (i + 4 > b.length) return null; f = { wire: 5, bytes: b.subarray(i, i + 4) }; i += 4; }
      else return null;
      if (!out.has(num)) out.set(num, []);
      out.get(num).push(f);
    }
    return out;
  }
  // A 64-bit varint, such as a member or lease id, as hexadecimal text.
  function varintHex(b, o) {
    let v = 0n, s = 0n, i = o;
    for (;;) {
      if (i >= b.length || s > 70n) return null;
      const x = b[i++];
      v |= BigInt(x & 0x7f) << s;
      if (!(x & 0x80)) break;
      s += 7n;
    }
    return { hex: (v & 0xffffffffffffffffn).toString(16), next: i };
  }
  // The hexadecimal id in field n of a message.
  function idOf(b, n) {
    let i = 0;
    while (i < b.length) {
      const t = varint(b, i);
      if (!t) return '';
      const fn = Math.floor(t.v / 8), wire = t.v % 8;
      i = t.next;
      if (wire === 0) { const x = varintHex(b, i); if (!x) return ''; if (fn === n) return x.hex; i = x.next; }
      else if (wire === 2) { const l = varint(b, i); if (!l) return ''; i = l.next + l.v; }
      else if (wire === 1) i += 8;
      else if (wire === 5) i += 4;
      else return '';
    }
    return '';
  }
  const field = (fs, n) => fs && fs.has(n) ? fs.get(n)[0] : null;
  const num = (fs, n) => { const f = field(fs, n); return f && f.wire === 0 ? f.v : 0; };
  const bytesOf = (fs, n) => { const f = field(fs, n); return f && f.wire === 2 ? f.bytes : null; };
  const str = (fs, n) => { const b = bytesOf(fs, n); return b ? decoder.decode(b) : ''; };

  // ---- etcd's records ----

  // A key in etcd's "key" bucket is a revision: 8 bytes of main revision, an
  // underscore, 8 bytes of sub revision, and a "t" when it marks a deletion.
  function revisionOf(k) {
    if (k.length < 17 || k[8] !== 0x5f) return null;
    return { main: u64be(k, 0), sub: u64be(k, 9), tombstone: k.length > 17 && k[17] === 0x74 };
  }
  // mvccpb.KeyValue: key, create_revision, mod_revision, version, value, lease.
  function keyValue(v) {
    const fs = fields(v);
    if (!fs) return null;
    return {
      key: bytesOf(fs, 1) || new Uint8Array(0), createRevision: num(fs, 2), modRevision: num(fs, 3),
      version: num(fs, 4), value: bytesOf(fs, 5) || new Uint8Array(0), lease: fs.has(6) ? idOf(v, 6) : ''
    };
  }

  // ---- Kubernetes ----

  const K8S_MAGIC = [0x6b, 0x38, 0x73, 0x00];
  const ENC_PREFIX = encoder.encode('k8s:enc:');

  // What a value is: a Kubernetes object in protobuf (with its apiVersion,
  // kind, name, and the bytes its managedFields take), a Kubernetes object in
  // JSON (custom resources), an encrypted value, or something else.
  function describeValue(v) {
    if (v.length >= 4 && v[0] === 0x6b && v[1] === 0x38 && v[2] === 0x73 && v[3] === 0x00) {
      const unknown = fields(v.subarray(4));
      const tm = unknown && fields(bytesOf(unknown, 1) || new Uint8Array(0));
      const raw = unknown && bytesOf(unknown, 2);
      const out = { format: 'protobuf', apiVersion: tm ? str(tm, 1) : '', kind: tm ? str(tm, 2) : '' };
      const obj = raw && fields(raw);
      const metaField = obj && field(obj, 1);
      if (metaField && metaField.wire === 2) {
        const m = fields(metaField.bytes);
        if (m) {
          out.name = str(m, 1); out.namespace = str(m, 3); out.uid = str(m, 5);
          const created = bytesOf(m, 8);
          if (created) { const t = fields(created); if (t) out.created = num(t, 1); }
          let managed = 0;
          for (const f of (m.get(17) || [])) managed += f.end - f.start + 2;
          out.managedFieldsBytes = managed;
          out.labels = [];
          for (const f of (m.get(11) || [])) {
            const kv = fields(f.bytes);
            if (kv) out.labels.push([str(kv, 1), str(kv, 2)]);
          }
        }
      }
      return out;
    }
    if (v.length > ENC_PREFIX.length && equalBytes(v.subarray(0, ENC_PREFIX.length), ENC_PREFIX)) {
      const head = decoder.decode(v.subarray(0, Math.min(v.length, 80)));
      const m = /^k8s:enc:([a-z0-9]+):(v\d+):([^:]*):/.exec(head);
      return { format: 'encrypted', provider: m ? m[1] + ':' + m[2] : 'unknown', keyName: m ? m[3] : '' };
    }
    if (v.length && (v[0] === 0x7b)) {
      const t = text(v);
      if (t !== null) {
        try {
          const j = JSON.parse(t);
          if (j && typeof j === 'object' && !Array.isArray(j)) {
            const md = j.metadata && typeof j.metadata === 'object' ? j.metadata : {};
            const managed = Array.isArray(md.managedFields) ? encoder.encode(JSON.stringify(md.managedFields)).length : 0;
            return { format: 'json', apiVersion: j.apiVersion || '', kind: j.kind || '', name: md.name || '', namespace: md.namespace || '', uid: md.uid || '', managedFieldsBytes: managed };
          }
        } catch (e) { /* not JSON after all */ }
      }
    }
    const t = text(v);
    return { format: t !== null ? 'text' : 'binary' };
  }

  // Splits a Kubernetes registry key: /registry/<resource>/<namespace>/<name>,
  // or /registry/<group>/<resource>/... for API groups and custom resources.
  function registryPath(key) {
    if (!key.startsWith('/registry/')) return null;
    const parts = key.slice(10).split('/');
    if (parts.length < 2) return null;
    let resource = parts[0], rest = parts.slice(1);
    if (resource.includes('.') && parts.length >= 3) { resource = parts[1] + '.' + parts[0]; rest = parts.slice(2); }
    else if ((resource === 'services' && (parts[1] === 'specs' || parts[1] === 'endpoints'))) { resource = parts[0] + '/' + parts[1]; rest = parts.slice(2); }
    return { resource: resource, rest: rest };
  }

  // ---- Kubernetes objects in full ----

  // The field names come from kubernetes.js: in a page, load it before this
  // file; in Node it is found next to this one. Without it, objects show
  // their protobuf field numbers instead.
  let schemaFound = null;
  function kubernetesSchema() {
    if (schemaFound) return schemaFound;
    if (typeof globalThis !== 'undefined' && globalThis.KVKubernetes) schemaFound = globalThis.KVKubernetes;
    else if (typeof module === 'object' && typeof require === 'function') {
      try { schemaFound = require('./kubernetes.js'); } catch (e) { /* not there */ }
    }
    return schemaFound;
  }

  // A number as JSON wrote it, kept as text so 1.0 and 1 stay apart, as
  // they do when kubectl turns JSON into YAML.
  class Num { constructor(text) { this.text = text; } }
  const OMIT = Symbol('omit');
  const obj = () => Object.create(null);

  // JSON, with every number kept as a Num.
  function parseJson(text) {
    let i = 0;
    const n = text.length;
    const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
    const fail = () => { throw new SyntaxError('Not JSON at character ' + i); };
    const ws = () => { while (i < n && (text[i] === ' ' || text[i] === '\n' || text[i] === '\r' || text[i] === '\t')) i++; };
    function string() {
      const start = i++;
      while (i < n && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      if (i >= n) fail();
      i++;
      return JSON.parse(text.slice(start, i));
    }
    function value(depth) {
      if (depth > 1000) fail();
      ws();
      const c = text[i];
      if (c === '{') {
        i++;
        const o = obj();
        ws();
        if (text[i] === '}') { i++; return o; }
        for (;;) {
          ws();
          if (text[i] !== '"') fail();
          const k = string();
          ws();
          if (text[i++] !== ':') fail();
          o[k] = value(depth + 1);
          ws();
          if (text[i] === ',') { i++; continue; }
          if (text[i++] !== '}') fail();
          return o;
        }
      }
      if (c === '[') {
        i++;
        const a = [];
        ws();
        if (text[i] === ']') { i++; return a; }
        for (;;) {
          a.push(value(depth + 1));
          ws();
          if (text[i] === ',') { i++; continue; }
          if (text[i++] !== ']') fail();
          return a;
        }
      }
      if (c === '"') return string();
      if (text.startsWith('true', i)) { i += 4; return true; }
      if (text.startsWith('false', i)) { i += 5; return false; }
      if (text.startsWith('null', i)) { i += 4; return null; }
      NUMBER.lastIndex = i;
      const m = NUMBER.exec(text);
      if (!m || !m[0]) fail();
      i = NUMBER.lastIndex;
      return new Num(m[0]);
    }
    const v = value(0);
    ws();
    if (i !== n) fail();
    return v;
  }

  // kube-apiserver reads a custom resource's JSON into an unstructured
  // object: whole numbers that fit 64 bits become integers, the rest
  // floating point, which Go writes back in its own way.
  function unstructured(v) {
    if (v instanceof Num) {
      if (/^-?[0-9]+$/.test(v.text)) {
        const b = BigInt(v.text);
        if (b >= -(2n ** 63n) && b < 2n ** 63n) return new Num(b.toString());
      }
      return new Num(String(Number(v.text)));
    }
    if (Array.isArray(v)) return v.map(unstructured);
    if (v && typeof v === 'object') { const o = obj(); for (const k of Object.keys(v)) o[k] = unstructured(v[k]); return o; }
    return v;
  }

  // Protobuf fields with exact 64-bit numbers: number to its occurrences.
  function pbFields(b) {
    const out = new Map();
    let i = 0;
    while (i < b.length) {
      const t = varint(b, i);
      if (!t) return null;
      const num = Math.floor(t.v / 8), wire = t.v % 8;
      i = t.next;
      let f;
      if (wire === 0) {
        const start = i;
        while (i < b.length && b[i] & 0x80) i++;
        if (i >= b.length) return null;
        i++;
        f = { wire: 0, raw: b.subarray(start, i) };
      } else if (wire === 2) {
        const l = varint(b, i);
        if (!l || l.next + l.v > b.length) return null;
        f = { wire: 2, bytes: b.subarray(l.next, l.next + l.v) };
        i = l.next + l.v;
      } else if (wire === 1) { if (i + 8 > b.length) return null; f = { wire: 1, bytes: b.subarray(i, i + 8) }; i += 8; }
      else if (wire === 5) { if (i + 4 > b.length) return null; f = { wire: 5, bytes: b.subarray(i, i + 4) }; i += 4; }
      else return null;
      if (!out.has(num)) out.set(num, []);
      out.get(num).push(f);
    }
    return out;
  }
  // The unsigned 64-bit value of varint bytes.
  function uvarint(raw) {
    if (raw.length <= 7) { let v = 0, s = 1; for (const x of raw) { v += (x & 0x7f) * s; s *= 128; } return v; }
    let v = 0n, s = 0n;
    for (const x of raw) { v |= BigInt(x & 0x7f) << s; s += 7n; }
    return v & 0xffffffffffffffffn;
  }
  // As a signed 64-bit number; a Number when it is exact, a BigInt when not.
  function int64(raw) {
    let v = uvarint(raw);
    if (typeof v === 'number') return v;
    if (v >= 2n ** 63n) v -= 2n ** 64n;
    return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
  }
  function uint64(raw) {
    const v = uvarint(raw);
    return typeof v === 'number' || v > BigInt(Number.MAX_SAFE_INTEGER) ? v : Number(v);
  }
  // Varints in a field: one, or several packed together.
  function varints(f) {
    if (f.wire === 0) return [f.raw];
    if (f.wire !== 2) return [];
    const out = [];
    let i = 0;
    while (i < f.bytes.length) {
      const start = i;
      while (i < f.bytes.length && f.bytes[i] & 0x80) i++;
      i++;
      out.push(f.bytes.subarray(start, i));
    }
    return out;
  }
  function joined(list) {
    if (list.length === 1) return list[0].bytes || new Uint8Array(0);
    let n = 0;
    for (const f of list) n += f.bytes ? f.bytes.length : 0;
    const b = new Uint8Array(n);
    let o = 0;
    for (const f of list) if (f.bytes) { b.set(f.bytes, o); o += f.bytes.length; }
    return b;
  }
  function base64(b) {
    const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let out = '';
    for (let i = 0; i < b.length; i += 3) {
      const x = (b[i] << 16) | ((b[i + 1] || 0) << 8) | (b[i + 2] || 0);
      out += A[x >> 18] + A[(x >> 12) & 63] + (i + 1 < b.length ? A[(x >> 6) & 63] : '=') + (i + 2 < b.length ? A[x & 63] : '=');
    }
    return out;
  }
  const lastString = (fs, n) => { const l = fs && fs.get(n); return l ? decoder.decode(l[l.length - 1].bytes || new Uint8Array(0)) : ''; };
  const lastInt = (fs, n) => { const l = fs && fs.get(n); return l && l[l.length - 1].wire === 0 ? int64(l[l.length - 1].raw) : 0; };

  // Go's time formats, in UTC: RFC3339 to the second, or to the microsecond.
  function goTime(seconds, nanos, micro) {
    if (typeof seconds === 'bigint' || Math.abs(seconds) > 8.6e12) return String(seconds);
    const d = new Date(seconds * 1000);
    const y = d.getUTCFullYear();
    const p = (x, w) => String(x).padStart(w || 2, '0');
    let s = (y < 0 ? '-' + p(-y, 4) : p(y, 4)) + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + 'T' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds());
    if (micro) s += '.' + p(Math.floor((Number(nanos) || 0) / 1000), 6);
    return s + 'Z';
  }
  // Go's Duration.String: 1h2m3.5s, 1.5ms, 0s.
  function goDuration(ns) {
    let u = BigInt(ns);
    const neg = u < 0n;
    if (neg) u = -u;
    const frac = (v, prec) => {
      let digits = '', print = false;
      for (let i = 0; i < prec; i++) {
        const d = v % 10n;
        print = print || d !== 0n;
        if (print) digits = d.toString() + digits;
        v /= 10n;
      }
      return { text: print ? '.' + digits : '', v: v };
    };
    let out;
    if (u < 1000000000n) {
      if (u === 0n) return '0s';
      const [prec, unit] = u < 1000n ? [0, 'ns'] : u < 1000000n ? [3, '\u00b5s'] : [6, 'ms'];
      const f = frac(u, prec);
      out = f.v.toString() + f.text + unit;
    } else {
      const f = frac(u, 9);
      let rest = f.v;
      out = (rest % 60n).toString() + f.text + 's';
      rest /= 60n;
      if (rest > 0n) {
        out = (rest % 60n).toString() + 'm' + out;
        rest /= 60n;
        if (rest > 0n) out = rest.toString() + 'h' + out;
      }
    }
    return (neg ? '-' : '') + out;
  }

  // The fields of a type in kubernetes.js, parsed once.
  const parsedTypes = new WeakMap();
  function typeFields(schema, idx) {
    let cache = parsedTypes.get(schema);
    if (!cache) { cache = []; parsedTypes.set(schema, cache); }
    if (!cache[idx]) {
      const text = schema.types[idx] || '';
      cache[idx] = text ? text.split('|').map((f) => {
        const p = f.split(',');
        const flags = p[3] || '';
        return { num: Number(p[0]), name: p[1], type: parseType(p[2]), omitempty: flags.includes('e'), omitzero: flags.includes('z'), inline: flags.includes('n') };
      }) : [];
    }
    return cache[idx];
  }
  function parseType(code) {
    const c = code[0];
    if (c === '*') return { k: 'ptr', of: parseType(code.slice(1)) };
    if (c === '[') return { k: 'list', of: parseType(code.slice(1)) };
    if (c === '{') return { k: 'map', of: parseType(code.slice(1)) };
    if (c === 'W') return { k: 'wrap', of: parseType(code.slice(1)) };
    if (c === 'A' || c === 'B' || c === 'S') return { k: 'or', which: c, ref: Number(code.slice(1)) };
    if (c >= '0' && c <= '9') return { k: 'struct', ref: Number(code) };
    if ('sibuyf'.includes(c)) return { k: 'scalar', s: c };
    return { k: 'special', s: c };
  }

  // A message decoded as Kubernetes' Go code reads it and writes it as JSON:
  // fields the JSON leaves out are left out, the ones it writes as null are
  // null, and numbers that fit no JavaScript number stay BigInts.
  function decodeStruct(schema, idx, b, depth) {
    if (depth > 100) throw new SnapshotError('An object nests too deeply to show.');
    const fs = pbFields(b) || new Map();
    const out = obj();
    const inline = [];
    for (const f of typeFields(schema, idx)) {
      const v = fieldValue(schema, f.type, fs.get(f.num) || [], f.omitempty, f.omitzero, depth);
      if (v === OMIT) continue;
      if (f.inline) { inline.push(v); continue; }
      out[f.name] = v;
    }
    // Fields of an inline struct move up a level, behind the outer ones.
    for (const v of inline) if (v && typeof v === 'object') for (const k of Object.keys(v)) if (!(k in out)) out[k] = v[k];
    return out;
  }
  function fieldValue(schema, t, occ, omitempty, omitzero, depth) {
    if (t.k === 'ptr') return occ.length ? present(schema, t.of, occ, depth) : (omitempty || omitzero ? OMIT : null);
    if (t.k === 'list') {
      const items = listItems(schema, t.of, occ, depth);
      return items.length ? items : (omitempty || omitzero ? OMIT : null);
    }
    if (t.k === 'map') {
      if (!occ.length) return omitempty || omitzero ? OMIT : null;
      const m = new Map();
      for (const e of occ) {
        const fs = pbFields(e.bytes || new Uint8Array(0)) || new Map();
        m.set(lastString(fs, 1), mapValue(schema, t.of, fs.get(2) || [], depth));
      }
      const o = obj();
      for (const k of [...m.keys()].sort(goStringLess)) o[k] = m.get(k);
      return o;
    }
    const v = occ.length ? present(schema, t, occ, depth) : zero(schema, t, depth);
    if (omitempty && t.k === 'scalar' && (v === '' || v === 0 || v === false || v === 0n || (t.s === 'y' && (v === null || v === '')))) return OMIT;
    if (omitzero && (v === null || v === '' || v === 0 || v === false)) return OMIT;
    return v;
  }
  // Go sorts map keys by their bytes; for valid UTF-8 that is code point order.
  function goStringLess(a, b) {
    const x = Array.from(a), y = Array.from(b);
    for (let i = 0; i < x.length && i < y.length; i++) if (x[i] !== y[i]) return x[i].codePointAt(0) - y[i].codePointAt(0);
    return x.length - y.length;
  }
  function scalar(s, f) {
    if (s === 's') return decoder.decode(f.bytes || new Uint8Array(0));
    if (s === 'y') return base64(f.bytes || new Uint8Array(0));
    if (s === 'b') return f.wire === 0 ? uvarint(f.raw) != 0 : false;
    if (s === 'u') return f.wire === 0 ? uint64(f.raw) : 0;
    if (s === 'f') return f.bytes && f.bytes.length === 8 ? new DataView(f.bytes.buffer, f.bytes.byteOffset, 8).getFloat64(0, true) : 0;
    return f.wire === 0 ? int64(f.raw) : 0;
  }
  // The value of a field that is there.
  function present(schema, t, occ, depth) {
    const last = occ[occ.length - 1];
    switch (t.k) {
      case 'scalar': return scalar(t.s, last);
      case 'struct': return decodeStruct(schema, t.ref, joined(occ), depth + 1);
      case 'special': return special(t.s, joined(occ));
      case 'or': return either(schema, t, joined(occ), depth);
      case 'wrap': { const fs = pbFields(joined(occ)) || new Map(); const items = listItems(schema, t.of.of, fs.get(1) || [], depth); return items.length ? items : null; }
      default: return null;
    }
  }
  // The value Go's zero value writes, for a field that isn't there.
  function zero(schema, t, depth) {
    switch (t.k) {
      case 'scalar': return t.s === 's' ? '' : t.s === 'b' ? false : t.s === 'y' ? null : 0;
      case 'struct': return decodeStruct(schema, t.ref, new Uint8Array(0), depth + 1);
      case 'special': return t.s === 'D' ? '0s' : t.s === 'Q' ? '0' : t.s === 'I' ? 0 : null;
      case 'or': return t.which === 'B' ? false : null;
      default: return null;
    }
  }
  function listItems(schema, t, occ, depth) {
    const out = [];
    for (const f of occ) {
      if (t.k === 'scalar' && (t.s === 'i' || t.s === 'u' || t.s === 'b')) {
        for (const raw of varints(f)) out.push(t.s === 'b' ? uvarint(raw) != 0 : t.s === 'u' ? uint64(raw) : int64(raw));
      } else out.push(present(schema, t, [f], depth));
    }
    return out;
  }
  // A map entry's value; Go starts it at zero, and an empty list there is [].
  function mapValue(schema, t, occ, depth) {
    if (t.k === 'wrap') { const v = occ.length ? present(schema, t, occ, depth) : null; return v || []; }
    if (t.k === 'scalar' && t.s === 'y') return occ.length ? present(schema, t, occ, depth) : '';
    return occ.length ? present(schema, t, occ, depth) : zero(schema, t, depth);
  }
  // Kubernetes' types with a JSON form of their own.
  function special(s, b) {
    const fs = pbFields(b) || new Map();
    switch (s) {
      case 'T': case 'M': {
        if (!b.length) return null;
        const seconds = lastInt(fs, 1), nanos = lastInt(fs, 2);
        if (seconds === -62135596800 && !nanos) return null;
        return goTime(seconds, nanos, s === 'M');
      }
      case 'D': return goDuration(lastInt(fs, 1));
      case 'Q': return fs.has(1) ? lastString(fs, 1) : '0';
      case 'I': return lastInt(fs, 1) === 1 ? lastString(fs, 3) : lastInt(fs, 2);
      case 'R': case 'F': case 'J': {
        const l = fs.get(1);
        const raw = l ? joined(l) : null;
        if (!raw || !raw.length) return null;
        try { return parseJson(decoder.decode(raw)); } catch (e) { return decoder.decode(raw); }
      }
    }
    return null;
  }
  // The parts of a CustomResourceDefinition schema that can be a schema or
  // something else: a list of schemas, a bool, or a list of strings.
  function either(schema, t, b, depth) {
    const fs = pbFields(b) || new Map();
    const sub = (f) => decodeStruct(schema, t.ref, f.bytes || new Uint8Array(0), depth + 1);
    if (t.which === 'A') {
      const list = fs.get(2) || [];
      if (list.length) return list.map(sub);
      return fs.has(1) ? sub(fs.get(1)[fs.get(1).length - 1]) : null;
    }
    if (t.which === 'B') {
      if (fs.has(2)) return sub(fs.get(2)[fs.get(2).length - 1]);
      const a = fs.get(1);
      return Boolean(a && a[a.length - 1].wire === 0 && uvarint(a[a.length - 1].raw) != 0);
    }
    const props = (fs.get(2) || []).map((f) => decoder.decode(f.bytes));
    if (props.length) return props;
    return fs.has(1) ? sub(fs.get(1)[fs.get(1).length - 1]) : null;
  }

  // A Kubernetes object from etcd: { apiVersion, kind, format, object },
  // where object is what kubectl get -o json would show of it as stored.
  // known is false when kubernetes.js doesn't have the kind; object is then
  // null. Returns null for a value that isn't a Kubernetes object.
  function kubernetesObject(value) {
    if (value.length >= 4 && value[0] === 0x6b && value[1] === 0x38 && value[2] === 0x73 && value[3] === 0x00) {
      const unknown = pbFields(value.subarray(4));
      if (!unknown) return null;
      const tm = pbFields(unknown.has(1) ? joined(unknown.get(1)) : new Uint8Array(0)) || new Map();
      const apiVersion = lastString(tm, 1), kind = lastString(tm, 2);
      const schema = kubernetesSchema();
      const idx = schema && schema.kinds[apiVersion + ' ' + kind];
      if (idx === undefined || idx === null) return { apiVersion: apiVersion, kind: kind, format: 'protobuf', known: false, object: null };
      const body = decodeStruct(schema, idx, unknown.has(2) ? joined(unknown.get(2)) : new Uint8Array(0), 0);
      const o = obj();
      o.kind = kind;
      o.apiVersion = apiVersion;
      for (const k of Object.keys(body)) o[k] = body[k];
      return { apiVersion: apiVersion, kind: kind, format: 'protobuf', known: true, object: o };
    }
    if (value.length && value[0] === 0x7b) {
      const t = text(value);
      if (t === null) return null;
      let j;
      try { j = parseJson(t); } catch (e) { return null; }
      if (!j || typeof j !== 'object' || Array.isArray(j) || typeof j.apiVersion !== 'string' || typeof j.kind !== 'string') return null;
      return { apiVersion: j.apiVersion, kind: j.kind, format: 'json', known: true, object: unstructured(j) };
    }
    return null;
  }

  // ---- YAML, written the way kubectl writes it ----
  //
  // kubectl turns an object into JSON, reads that JSON back with go-yaml v2
  // and writes YAML with it: keys in go-yaml's order, strings quoted when
  // they would read back as something else, long lines folded after 80
  // columns, multi-line strings as | blocks. This follows go-yaml v2's
  // encoder and emitter rule by rule.

  const isBreak = (c) => c === 0x0a || c === 0x0d || c === 0x85 || c === 0x2028 || c === 0x2029;
  const isPrintable = (c) => c === 0x0a || (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xd7ff) || (c >= 0xe000 && c <= 0xfffd && c !== 0xfeff);
  const isBlank = (c) => c === 0x20 || c === 0x09;
  const isLetter = (c) => /\p{L}/u.test(String.fromCodePoint(c));
  const isDigit = (c) => /\p{Nd}/u.test(String.fromCodePoint(c));

  // go-yaml's key order: letters after other characters, runs of digits by
  // their value.
  function yamlKeyLess(a, b) {
    const ar = Array.from(a, (c) => c.codePointAt(0)), br = Array.from(b, (c) => c.codePointAt(0));
    for (let i = 0; i < ar.length && i < br.length; i++) {
      if (ar[i] === br[i]) continue;
      const al = isLetter(ar[i]), bl = isLetter(br[i]);
      if (al && bl) return ar[i] < br[i];
      if (al || bl) return bl;
      let an = 0, bn = 0, ai, bi;
      if (ar[i] === 48 || br[i] === 48) {
        for (let j = i - 1; j >= 0 && isDigit(ar[j]); j--) if (ar[j] !== 48) { an = 1; bn = 1; break; }
      }
      for (ai = i; ai < ar.length && isDigit(ar[ai]); ai++) an = an * 10 + (ar[ai] - 48);
      for (bi = i; bi < br.length && isDigit(br[bi]); bi++) bn = bn * 10 + (br[bi] - 48);
      if (an !== bn) return an < bn;
      if (ai !== bi) return ai < bi;
      return ar[i] < br[i];
    }
    return ar.length < br.length;
  }

  // Would go-yaml read this text, unquoted, as something other than a string?
  const YAML_SPECIAL = new Set(['y', 'Y', 'yes', 'Yes', 'YES', 'true', 'True', 'TRUE', 'on', 'On', 'ON', 'n', 'N', 'no', 'No', 'NO', 'false', 'False', 'FALSE',
    'off', 'Off', 'OFF', '', '~', 'null', 'Null', 'NULL', '.nan', '.NaN', '.NAN', '.inf', '.Inf', '.INF', '+.inf', '+.Inf', '+.INF', '-.inf', '-.Inf', '-.INF']);
  const YAML_FLOAT = /^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/;
  const BASE60 = /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+(?:\.[0-9_]*)?$/;
  // strconv.ParseInt and ParseUint with base 0.
  function goInt(s, unsigned) {
    const m = /^([+-]?)(0[bB][01]+|0[oO][0-7]+|0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)$/.exec(s);
    if (!m || (unsigned && m[1])) return null;
    let digits = m[2], base = 10n;
    if (/^0[bB]/.test(digits)) { base = 2n; digits = digits.slice(2); }
    else if (/^0[oO]/.test(digits)) { base = 8n; digits = digits.slice(2); }
    else if (/^0[xX]/.test(digits)) { base = 16n; digits = digits.slice(2); }
    else if (digits.length > 1 && digits[0] === '0') { base = 8n; digits = digits.slice(1); }
    let v = 0n;
    for (const d of digits) v = v * base + BigInt(parseInt(d, 16));
    if (m[1] === '-') v = -v;
    if (unsigned ? v > 2n ** 64n - 1n : (v > 2n ** 63n - 1n || v < -(2n ** 63n))) return null;
    return v;
  }
  // The timestamps go-yaml recognizes, as Go's time.Parse checks them.
  function yamlTimestamp(s) {
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:(?:([Tt])|( ))(\d{1,2}):(\d{1,2}):(\d{1,2})(?:[.,]\d+)?(Z|[+-]\d{2}:\d{2})?)?$/.exec(s);
    if (!m) return false;
    const [, y, mo, d, t, sp, h, mi, se, zone] = m;
    if (t && !zone) return false;
    if (sp && zone) return false;
    if (+mo < 1 || +mo > 12 || +d < 1 || +d > new Date(Date.UTC(+y, +mo, 0)).getUTCDate()) return false;
    if (h !== undefined && (+h > 23 || +mi > 59 || +se > 59)) return false;
    if (zone && zone !== 'Z' && (+zone.slice(1, 3) > 24 || +zone.slice(4) > 60)) return false;
    return true;
  }
  function yamlPlainIsString(s) {
    const c = s[0];
    const hint = s === '' ? 'N' : c === '+' || c === '-' ? 'S' : c >= '0' && c <= '9' ? 'D' : 'yYnNtTfFoO~'.includes(c) ? 'M' : c === '.' ? '.' : '';
    if (!hint) return true;
    if (YAML_SPECIAL.has(s)) return false;
    if (hint === 'M' || hint === 'N') return true;
    if (hint === '.') return !(/^\.[0-9]+([eE][-+]?[0-9]+)?$/.test(s) && Number.isFinite(Number(s)));
    if (yamlTimestamp(s)) return false;
    const plain = s.replace(/_/g, '');
    if (goInt(plain, false) !== null || goInt(plain, true) !== null) return false;
    if (YAML_FLOAT.test(plain) && Number.isFinite(Number(plain))) return false;
    return true;
  }
  // strconv.FormatFloat(f, 'g', -1, 64), as go-yaml writes floats.
  function goFloat(f) {
    if (Number.isNaN(f)) return '.nan';
    if (f === Infinity) return '.inf';
    if (f === -Infinity) return '-.inf';
    if (f === 0) return Object.is(f, -0) ? '-0' : '0';
    const [mant, ex] = Math.abs(f).toExponential().split('e');
    const digits = mant.replace('.', '');
    const exp = Number(ex);
    let out;
    if (exp < -4 || exp >= 6) out = digits[0] + (digits.length > 1 ? '.' + digits.slice(1) : '') + 'e' + (exp < 0 ? '-' : '+') + String(Math.abs(exp)).padStart(2, '0');
    else {
      const dp = exp + 1;
      if (dp <= 0) out = '0.' + '0'.repeat(-dp) + digits;
      else if (dp >= digits.length) out = digits + '0'.repeat(dp - digits.length);
      else out = digits.slice(0, dp) + '.' + digits.slice(dp);
    }
    return (f < 0 ? '-' : '') + out;
  }
  // A JSON number as go-yaml writes it back: whole numbers as integers,
  // the rest as Go formats floats.
  function yamlNumber(t) {
    const i = goInt(t, false);
    if (i !== null) return i.toString();
    const u = goInt(t, true);
    if (u !== null) return u.toString();
    return goFloat(Number(t));
  }
  // go-yaml reads JSON strings as YAML double-quoted scalars, which folds a
  // raw line break into a space. Go leaves only U+0085 unescaped in JSON.
  const foldNel = (s) => s.indexOf('\u0085') < 0 ? s : s.replace(/[ \u0085]*\u0085[ \u0085]*/g, (run) => {
    const n = run.split('\u0085').length - 1;
    return n === 1 ? ' ' : '\n'.repeat(n - 1);
  });

  function toYaml(root) {
    const w = { s: '', column: 0, indent: -1, indents: [], whitespace: true, indention: true };
    const put = (ch) => { w.s += ch; w.column++; };
    const putBreak = () => { w.s += '\n'; w.column = 0; };
    const writeBreak = (c) => { if (c === 0x0a) putBreak(); else { w.s += String.fromCodePoint(c); w.column = 0; } };
    function writeIndent() {
      const indent = Math.max(w.indent, 0);
      if (!w.indention || w.column > indent || (w.column === indent && !w.whitespace)) putBreak();
      while (w.column < indent) put(' ');
      w.whitespace = true;
      w.indention = true;
    }
    function indicator(t, needWhitespace, isWhitespace, isIndention) {
      if (needWhitespace && !w.whitespace) put(' ');
      for (const ch of t) put(ch);
      w.whitespace = isWhitespace;
      w.indention = w.indention && isIndention;
    }
    function increaseIndent(flow, indentless) {
      w.indents.push(w.indent);
      if (w.indent < 0) w.indent = flow ? 2 : 0;
      else if (!indentless) w.indent += 2;
    }
    const popIndent = () => { w.indent = w.indents.pop(); };

    // What go-yaml's emitter allows for a scalar.
    function analyze(cps) {
      const n = cps.length;
      if (!n) return { multiline: false, blockPlain: true, single: true, block: false };
      let flowInd = false, blockInd = false, lineBreaks = false, specialChars = false;
      let leadingSpace = false, leadingBreak = false, trailingSpace = false, trailingBreak = false, breakSpace = false, spaceBreak = false;
      let preceded = true, prevSpace = false, prevBreak = false;
      if (n >= 3 && ((cps[0] === 45 && cps[1] === 45 && cps[2] === 45) || (cps[0] === 46 && cps[1] === 46 && cps[2] === 46))) { flowInd = true; blockInd = true; }
      for (let i = 0; i < n; i++) {
        const c = cps[i];
        const followed = i + 1 >= n || isBlank(cps[i + 1]);
        const ch = String.fromCodePoint(c);
        if (i === 0) {
          if ('#,[]{}&*!|>\'"%@`'.includes(ch)) { flowInd = true; blockInd = true; }
          else if (ch === '?' || ch === ':') { flowInd = true; if (followed) blockInd = true; }
          else if (ch === '-' && followed) { flowInd = true; blockInd = true; }
        } else {
          if (',?[]{}'.includes(ch)) flowInd = true;
          else if (ch === ':') { flowInd = true; if (followed) blockInd = true; }
          else if (ch === '#' && preceded) { flowInd = true; blockInd = true; }
        }
        if (!isPrintable(c)) specialChars = true;
        if (c === 0x20) {
          if (i === 0) leadingSpace = true;
          if (i === n - 1) trailingSpace = true;
          if (prevBreak) breakSpace = true;
          prevSpace = true; prevBreak = false;
        } else if (isBreak(c)) {
          lineBreaks = true;
          if (i === 0) leadingBreak = true;
          if (i === n - 1) trailingBreak = true;
          if (prevSpace) spaceBreak = true;
          prevSpace = false; prevBreak = true;
        } else { prevSpace = false; prevBreak = false; }
        preceded = isBlank(c) || isBreak(c) || c === 0;
      }
      const r = { multiline: lineBreaks, blockPlain: true, single: true, block: true };
      if (leadingSpace || leadingBreak || trailingSpace || trailingBreak) r.blockPlain = false;
      if (trailingSpace) r.block = false;
      if (breakSpace) { r.blockPlain = false; r.single = false; }
      if (spaceBreak || specialChars) { r.blockPlain = false; r.single = false; r.block = false; }
      if (lineBreaks) r.blockPlain = false;
      if (blockInd) r.blockPlain = false;
      return r;
    }
    // A scalar's text and the style go-yaml's encoder asks for.
    function scalarText(v) {
      if (v === null || v === undefined) return { t: 'null', style: 'plain' };
      if (v === true || v === false) return { t: String(v), style: 'plain' };
      if (typeof v === 'number') return { t: Number.isInteger(v) ? String(v) : goFloat(v), style: 'plain' };
      if (typeof v === 'bigint') return { t: v.toString(), style: 'plain' };
      if (v instanceof Num) return { t: yamlNumber(v.text), style: 'plain' };
      const s = foldNel(String(v));
      const plainOk = yamlPlainIsString(s) && !(BASE60.test(s));
      return { t: s, style: s.includes('\n') ? 'literal' : plainOk ? 'plain' : 'double' };
    }
    function writePlain(cps, allowBreaks) {
      if (!w.whitespace) put(' ');
      let spaces = false;
      for (let i = 0; i < cps.length; i++) {
        const c = cps[i];
        if (c === 0x20) {
          if (allowBreaks && !spaces && w.column > 80 && cps[i + 1] !== 0x20) writeIndent();
          else put(' ');
          spaces = true;
        } else {
          put(String.fromCodePoint(c));
          w.indention = false;
          spaces = false;
        }
      }
      w.whitespace = false;
      w.indention = false;
    }
    function writeSingle(cps, allowBreaks) {
      indicator('\'', true, false, false);
      let spaces = false, breaks = false;
      for (let i = 0; i < cps.length; i++) {
        const c = cps[i];
        if (c === 0x20) {
          if (allowBreaks && !spaces && w.column > 80 && i > 0 && i < cps.length - 1 && cps[i + 1] !== 0x20) writeIndent();
          else put(' ');
          spaces = true;
        } else if (isBreak(c)) {
          if (!breaks && c === 0x0a) putBreak();
          writeBreak(c);
          w.indention = true;
          breaks = true;
        } else {
          if (breaks) writeIndent();
          if (c === 0x27) put('\'');
          put(String.fromCodePoint(c));
          w.indention = false;
          spaces = false;
          breaks = false;
        }
      }
      indicator('\'', false, false, false);
      w.whitespace = false;
      w.indention = false;
    }
    const ESCAPES = { 0x00: '0', 0x07: 'a', 0x08: 'b', 0x09: 't', 0x0a: 'n', 0x0b: 'v', 0x0c: 'f', 0x0d: 'r', 0x1b: 'e', 0x22: '"', 0x5c: '\\', 0x85: 'N', 0x2028: 'L', 0x2029: 'P' };
    function writeDouble(cps, allowBreaks) {
      let spaces = false;
      // go-yaml checks for a byte order mark at the start of the string, not
      // at each character, so after one every character is escaped.
      const bom = cps[0] === 0xfeff;
      indicator('"', true, false, false);
      for (let i = 0; i < cps.length; i++) {
        const c = cps[i];
        if (bom || !isPrintable(c) || isBreak(c) || c === 0x22 || c === 0x5c) {
          put('\\');
          if (ESCAPES[c] !== undefined) put(ESCAPES[c]);
          else {
            const [letter, width] = c <= 0xff ? ['x', 2] : c <= 0xffff ? ['u', 4] : ['U', 8];
            put(letter);
            for (const ch of c.toString(16).toUpperCase().padStart(width, '0')) put(ch);
          }
          spaces = false;
        } else if (c === 0x20) {
          if (allowBreaks && !spaces && w.column > 80 && i > 0 && i < cps.length - 1) {
            writeIndent();
            if (cps[i + 1] === 0x20) put('\\');
          } else put(' ');
          spaces = true;
        } else {
          put(String.fromCodePoint(c));
          spaces = false;
        }
      }
      indicator('"', false, false, false);
      w.whitespace = false;
      w.indention = false;
    }
    function writeLiteral(cps) {
      indicator('|', true, false, false);
      if (cps.length && (cps[0] === 0x20 || isBreak(cps[0]))) indicator('2', false, false, false);
      let chomp = '';
      if (!cps.length || !isBreak(cps[cps.length - 1])) chomp = '-';
      else if (cps.length === 1 || isBreak(cps[cps.length - 2])) chomp = '+';
      if (chomp) indicator(chomp, false, false, false);
      putBreak();
      w.indention = true;
      w.whitespace = true;
      let breaks = true;
      for (const c of cps) {
        if (isBreak(c)) { writeBreak(c); w.indention = true; breaks = true; }
        else {
          if (breaks) writeIndent();
          put(String.fromCodePoint(c));
          w.indention = false;
          breaks = false;
        }
      }
    }
    function scalarNode(v, simpleKey) {
      const sc = scalarText(v);
      const cps = Array.from(sc.t, (c) => c.codePointAt(0));
      const a = analyze(cps);
      let style = sc.style;
      if (simpleKey && a.multiline) style = 'double';
      if (style === 'plain' && !a.blockPlain) style = 'single';
      if (style === 'single' && !a.single) style = 'double';
      if (style === 'literal' && (!a.block || simpleKey)) style = 'double';
      increaseIndent(true, false);
      if (style === 'plain') writePlain(cps, !simpleKey);
      else if (style === 'single') writeSingle(cps, !simpleKey);
      else if (style === 'double') writeDouble(cps, !simpleKey);
      else writeLiteral(cps);
      popIndent();
    }
    function node(v, inMapping) {
      if (Array.isArray(v)) {
        if (!v.length) { indicator('[', true, true, false); indicator(']', false, false, false); return; }
        increaseIndent(false, inMapping && !w.indention);
        for (const item of v) {
          writeIndent();
          indicator('-', true, false, true);
          node(item, false);
        }
        popIndent();
      } else if (v && typeof v === 'object' && !(v instanceof Num)) {
        const keys = Object.keys(v).map((k) => [foldNel(k), k]);
        if (!keys.length) { indicator('{', true, true, false); indicator('}', false, false, false); return; }
        keys.sort((a, b) => (yamlKeyLess(a[0], b[0]) ? -1 : yamlKeyLess(b[0], a[0]) ? 1 : 0));
        increaseIndent(false, false);
        for (const [shown, k] of keys) {
          writeIndent();
          const sc = scalarText(shown);
          const simple = !analyze(Array.from(sc.t, (c) => c.codePointAt(0))).multiline && encoder.encode(sc.t).length <= 128;
          if (simple) {
            scalarNode(shown, true);
            indicator(':', false, false, false);
          } else {
            indicator('?', true, false, true);
            scalarNode(shown, false);
            writeIndent();
            indicator(':', true, false, true);
          }
          node(v[k], true);
        }
        popIndent();
      } else scalarNode(v, false);
    }
    node(root, false);
    writeIndent();
    return w.s;
  }

  // JSON text for a decoded value, numbers as written. indent: spaces a level.
  function toJson(v, indent) {
    const step = indent ? ' '.repeat(indent) : '';
    const walk = (x, pad) => {
      if (x === null || x === undefined) return 'null';
      if (x instanceof Num) return x.text;
      if (typeof x === 'bigint') return x.toString();
      if (typeof x !== 'object') return JSON.stringify(x);
      const inner = pad + step;
      const open = step ? '\n' + inner : '', close = step ? '\n' + pad : '', sep = step ? ',\n' + inner : ',', colon = step ? ': ' : ':';
      if (Array.isArray(x)) return x.length ? '[' + open + x.map((y) => walk(y, inner)).join(sep) + close + ']' : '[]';
      const keys = Object.keys(x);
      return keys.length ? '{' + open + keys.map((k) => JSON.stringify(k) + colon + walk(x[k], inner)).join(sep) + close + '}' : '{}';
    };
    return walk(v, '');
  }

  // ---- reading a whole snapshot ----

  // Reads every record and works out what the file holds. options.hash:
  // check the SHA-256 at the end (default true); false leaves it to the
  // caller, through snap.hash.check().
  function read(bytes, options) {
    const opt = options || {};
    const db = openFile(bytes);
    if (db.hash && opt.hash !== false) db.hash.check();
    const top = buckets(db);
    const out = {
      pageSize: db.pageSize, fileBytes: db.fileBytes, dataBytes: db.bytes.length, hash: db.hash,
      txid: db.meta.txid, highWater: db.meta.pgid, buckets: [...top.map.keys()].sort(), problems: []
    };
    const pages = top.pages;
    const bucket = (name, fn) => { const v = top.map.get(name); if (v) walkBucket(db, v, fn, pages); };

    // For "etcdutl snapshot status", below: a CRC-32C over every bucket's
    // name and every key and value in it, in order. records counts every
    // record in every bucket, as "bbolt stats" counts key/value pairs.
    let crc = 0, records = 0;
    for (const [name, v] of top.map) {
      crc = crc32c(crc, encoder.encode(name));
      walkBucket(db, v, (k, val) => { records++; crc = crc32c(crc, k); crc = crc32c(crc, val); }, pages);
    }
    out.records = records;

    // etcd's bookkeeping.
    const meta = new Map();
    bucket('meta', (k, v) => meta.set(decoder.decode(k), v));
    // Compaction revisions are kept as revisions (17 bytes), the rest as 8-byte numbers.
    const meta64 = (name) => { const v = meta.get(name); return v && v.length >= 8 ? u64be(v, 0) : null; };
    out.consistentIndex = meta64('consistent_index');
    out.term = meta64('term');
    out.compactedAt = meta64('finishedCompactRev');
    out.scheduledCompact = meta64('scheduledCompactRev');
    out.storageVersion = meta.has('storageVersion') ? decoder.decode(meta.get('storageVersion')) : null;
    const cluster = new Map();
    bucket('cluster', (k, v) => cluster.set(decoder.decode(k), decoder.decode(v)));
    out.clusterVersion = cluster.get('clusterVersion') || null;

    // Members are kept as JSON.
    out.members = [];
    bucket('members', (k, v) => {
      let j = null;
      try { j = JSON.parse(decoder.decode(v)); } catch (e) { /* skip */ }
      out.members.push({ id: decoder.decode(k), name: j && j.name || '', peerURLs: j && j.peerURLs || [], clientURLs: j && j.clientURLs || [], learner: Boolean(j && j.isLearner) });
    });
    out.removedMembers = 0;
    bucket('members_removed', () => { out.removedMembers++; });

    // Alarms: NOSPACE when the database reached its quota, CORRUPT after a
    // failed corruption check.
    out.alarms = [];
    bucket('alarm', (k) => {
      const fs = fields(k);
      const type = fs ? num(fs, 2) : 0;
      out.alarms.push({ member: idOf(k, 1), alarm: ['NONE', 'NOSPACE', 'CORRUPT'][type] || String(type) });
    });

    // Authentication.
    const auth = new Map();
    bucket('auth', (k, v) => auth.set(decoder.decode(k), v));
    out.authEnabled = auth.has('authEnabled') ? auth.get('authEnabled')[0] === 1 : false;
    out.users = []; out.roles = [];
    bucket('authUsers', (k) => out.users.push(decoder.decode(k)));
    bucket('authRoles', (k) => out.roles.push(decoder.decode(k)));

    // Leases: id, TTL in seconds.
    out.leases = new Map();
    bucket('lease', (k, v) => {
      const fs = fields(v);
      const id = hex(k).replace(/^0+(?=.)/, '');
      out.leases.set(id, { id: id, ttl: fs ? num(fs, 2) : 0, keys: 0 });
    });

    // The revisions. Records come in revision order.
    const keys = new Map();
    let revisions = 0, tombstones = 0, maxRev = 0, minRev = Infinity, recordBytes = 0;
    bucket('key', (k, v) => {
      const rev = revisionOf(k);
      const kv = keyValue(v);
      if (!rev || !kv) { out.problems.push('A record in the key bucket could not be read.'); return; }
      revisions++;
      recordBytes += k.length + v.length;
      if (rev.main > maxRev) maxRev = rev.main;
      if (rev.main < minRev) minRev = rev.main;
      const name = show(kv.key);
      let entry = keys.get(name);
      if (!entry) { entry = { key: name, raw: kv.key, history: [] }; keys.set(name, entry); }
      entry.history.push({ main: rev.main, sub: rev.sub, deleted: rev.tombstone, version: kv.version, createRevision: kv.createRevision, lease: kv.lease, valueBytes: kv.value.length, recordBytes: k.length + v.length, value: kv.value });
      if (rev.tombstone) tombstones++;
    });
    out.revision = maxRev;
    out.oldestRevision = revisions ? minRev : null;
    out.revisions = revisions;
    out.tombstones = tombstones;
    out.recordBytes = recordBytes;

    // Live keys, sizes and what each value is.
    let liveBytes = 0, live = 0;
    const kinds = new Map();
    const resources = new Map();
    const secrets = { total: 0, plain: 0, encrypted: 0, providers: new Map() };
    let managed = 0, k8sValueBytes = 0;
    for (const entry of keys.values()) {
      const last = entry.history[entry.history.length - 1];
      entry.revisions = entry.history.length;
      entry.historyBytes = entry.history.reduce((a, h) => a + h.recordBytes, 0) - (last.deleted ? 0 : last.recordBytes);
      entry.live = !last.deleted;
      entry.bytes = entry.live ? last.recordBytes : 0;
      entry.modRevision = last.main;
      entry.lease = entry.live ? last.lease : '';
      // A resource counts its deleted keys' old revisions too, so one whose
      // keys are all deleted, such as expired events, still shows.
      const reg = registryPath(entry.key);
      if (reg) {
        let r = resources.get(reg.resource);
        if (!r) {
          r = { resource: reg.resource, prefix: entry.key.slice(0, entry.key.length - reg.rest.join('/').length), keys: 0, bytes: 0, historyBytes: 0, revisions: 0 };
          resources.set(reg.resource, r);
        }
        r.historyBytes += entry.historyBytes;
        r.revisions += entry.revisions;
        if (entry.live) { r.keys++; r.bytes += last.recordBytes; }
      }
      if (!entry.live) continue;
      live++;
      liveBytes += last.recordBytes;
      const d = describeValue(last.value);
      entry.what = d;
      if (entry.lease && out.leases.has(entry.lease)) out.leases.get(entry.lease).keys++;
      if (d.kind) {
        const name = (d.apiVersion ? d.apiVersion + ' ' : '') + d.kind;
        let r = kinds.get(name);
        if (!r) { r = { kind: d.kind, apiVersion: d.apiVersion, format: d.format, objects: 0, bytes: 0, managedFieldsBytes: 0 }; kinds.set(name, r); }
        r.objects++; r.bytes += last.valueBytes; r.managedFieldsBytes += d.managedFieldsBytes || 0;
        managed += d.managedFieldsBytes || 0;
        k8sValueBytes += last.valueBytes;
      }
      if (reg && reg.resource === 'secrets') {
        secrets.total++;
        if (d.format === 'encrypted') { secrets.encrypted++; secrets.providers.set(d.provider, (secrets.providers.get(d.provider) || 0) + 1); }
        else secrets.plain++;
      }
    }
    out.keys = keys;
    out.liveKeys = live;

    // What "etcdutl snapshot status" prints, as the etcdutl of the version
    // that wrote the file prints it: the hash, the revision, the size up to
    // the high water mark and a count of keys. etcd 3.6 counts the keys that
    // exist now, 3.4 and 3.5 every record in the file, old revisions and
    // etcd's bookkeeping included. 3.6 also prints the storage version, which
    // older versions don't keep.
    const version = /^(\d+)\.(\d+)/.exec(out.storageVersion || out.clusterVersion || '');
    const countsLive = Boolean(version) && (Number(version[1]) > 3 || (Number(version[1]) === 3 && Number(version[2]) >= 6));
    out.status = { hash: crc, revision: maxRev, totalKey: countsLive ? live : records, totalSize: db.meta.pgid * db.pageSize };
    if (out.storageVersion) out.status.version = out.storageVersion;

    out.liveBytes = liveBytes;
    out.historyBytes = recordBytes - liveBytes;
    out.kinds = [...kinds.values()].sort((a, b) => b.bytes - a.bytes);
    out.resources = [...resources.values()].sort((a, b) => (b.bytes + b.historyBytes) - (a.bytes + a.historyBytes));
    out.kubernetes = kinds.size > 0;
    out.secrets = secrets;
    out.managedFieldsBytes = managed;
    out.kubernetesValueBytes = k8sValueBytes;

    // Pages: in use by a tree, free, or past the high water mark.
    const fl = freelist(db);
    if (fl) { pages.add(fl.page); for (let i = 1; i <= fl.overflow; i++) pages.add(fl.page + i); }
    out.pagesTotal = Math.floor(db.bytes.length / db.pageSize);
    out.pagesInUse = pages.size;
    out.pagesBelowHighWater = Math.min(db.meta.pgid, out.pagesTotal);
    out.pagesFree = out.pagesBelowHighWater - pages.size;
    out.freelistStored = Boolean(fl);
    out.bytesInUse = pages.size * db.pageSize;
    return out;
  }

  // ---- questions about the data ----

  // The prefix tree of live keys, split on "/", with the bytes each holds,
  // live and in old revisions.
  function prefixes(snap, depth, under) {
    const want = depth || 3;
    const base = under || '';
    const groups = new Map();
    for (const e of snap.keys.values()) {
      if (base && !e.key.startsWith(base)) continue;
      const rest = e.key.slice(base.length);
      const parts = rest.split('/');
      const lead = rest.startsWith('/') ? 1 : 0;
      const take = parts.slice(0, Math.min(parts.length - 1, want + lead));
      const prefix = base + (take.length ? take.join('/') + '/' : '');
      let g = groups.get(prefix);
      if (!g) { g = { prefix: prefix, keys: 0, liveKeys: 0, bytes: 0, historyBytes: 0, revisions: 0 }; groups.set(prefix, g); }
      g.keys++; if (e.live) g.liveKeys++;
      g.bytes += e.bytes; g.historyBytes += e.historyBytes; g.revisions += e.revisions;
    }
    return [...groups.values()].sort((a, b) => (b.bytes + b.historyBytes) - (a.bytes + a.historyBytes));
  }

  // Keys ranked: by the space they take now, or by the revisions kept.
  function topKeys(snap, by, n) {
    const list = [...snap.keys.values()];
    if (by === 'revisions') list.sort((a, b) => b.revisions - a.revisions || b.historyBytes - a.historyBytes);
    else if (by === 'history') list.sort((a, b) => b.historyBytes - a.historyBytes);
    else list.sort((a, b) => b.bytes - a.bytes);
    return list.slice(0, n || 20);
  }

  // Every revision of one key that the snapshot keeps.
  function history(snap, key) {
    const e = snap.keys.get(key);
    if (!e) return null;
    return e.history.map((h) => ({
      revision: h.main, sub: h.sub, deleted: h.deleted, version: h.version, createRevision: h.createRevision, lease: h.lease,
      bytes: h.valueBytes, value: h.value, what: h.deleted ? null : describeValue(h.value)
    }));
  }

  // A value as text to show: a Kubernetes object as kubectl get -o yaml
  // shows it, other JSON pretty-printed, text as is, a protobuf object
  // kubernetes.js doesn't know as its field numbers, anything else as
  // escaped bytes.
  function valueText(value, max) {
    const limit = max || 1000000;
    const k = kubernetesObject(value);
    if (k && k.known) return toYaml(k.object).slice(0, limit);
    const d = describeValue(value);
    if (d.format === 'json') {
      try { return toJson(parseJson(decoder.decode(value)), 2).slice(0, limit); } catch (e) { /* fall through */ }
    }
    if (d.format === 'text') return decoder.decode(value).slice(0, limit);
    if (d.format === 'encrypted') return '(encrypted with ' + d.provider + (d.keyName ? ', key ' + d.keyName : '') + ': ' + value.length + ' bytes)';
    if (d.format === 'protobuf') {
      const unknown = fields(value.subarray(4));
      const raw = unknown && bytesOf(unknown, 2);
      const head = d.apiVersion + ' ' + d.kind + (d.namespace ? ' ' + d.namespace + '/' : ' ') + (d.name || '') + '\n';
      return (head + (raw ? protoText(raw, '', 0) : '')).slice(0, limit);
    }
    return show(value).slice(0, limit);
  }
  // A protobuf message without its schema: field numbers, with nested
  // messages indented and text shown as text.
  function protoText(b, pad, depth) {
    const fs = fields(b);
    if (!fs || depth > 12) return pad + show(b) + '\n';
    let out = '';
    const all = [];
    for (const [n, list] of fs) for (const f of list) all.push([n, f]);
    all.sort((a, b2) => (a[1].start || 0) - (b2[1].start || 0));
    for (const [n, f] of all) {
      if (f.wire === 0) out += pad + n + ': ' + f.v + '\n';
      else if (f.wire === 2) {
        const t = text(f.bytes);
        const inner = f.bytes.length && depth < 12 ? fields(f.bytes) : null;
        const looksText = t !== null && /^[\x20-\x7e\u00a0-\uffff\t\n\r]*$/.test(t);
        if (looksText && (!inner || t.length < 2 || /^[\x20-\x7e]+$/.test(t))) out += pad + n + ': ' + JSON.stringify(t) + '\n';
        else if (inner && f.bytes.length) out += pad + n + ' {\n' + protoText(f.bytes, pad + '  ', depth + 1) + pad + '}\n';
        else out += pad + n + ': ' + show(f.bytes) + '\n';
      } else out += pad + n + ': 0x' + hex(f.bytes) + '\n';
    }
    return out;
  }

  // Lines of a unified diff between two texts, for two revisions of a value.
  function diffLines(a, b) {
    const x = a.split('\n'), y = b.split('\n');
    if (x.length * y.length > 4000000) return null;
    const m = x.length, n = y.length;
    const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
    for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const out = [];
    let i = 0, j = 0;
    while (i < m && j < n) {
      if (x[i] === y[j]) { out.push(' ' + x[i]); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) out.push('-' + x[i++]);
      else out.push('+' + y[j++]);
    }
    while (i < m) out.push('-' + x[i++]);
    while (j < n) out.push('+' + y[j++]);
    return out;
  }

  // ---- findings ----

  const GiB = 1024 * 1024 * 1024;
  const MiB = 1024 * 1024;
  // What deserves attention, worst first. quota: the --quota-backend-bytes
  // the cluster runs with (2 GiB by default).
  function findings(snap, quota) {
    const q = quota || 2 * GiB;
    const out = [];
    const pct = (a, b) => (b ? Math.round(1000 * a / b) / 10 : 0);
    // etcd measures its quota against the database's size, free pages included.
    const size = snap.status.totalSize;
    if (snap.alarms.some((a) => a.alarm === 'NOSPACE')) {
      out.push({ level: 'bad', code: 'nospace', title: 'The NOSPACE alarm is raised', text: 'The database reached its quota and etcd refuses writes until the alarm is cleared. Compact, defragment every member, then run "etcdctl alarm disarm".' });
    }
    if (snap.alarms.some((a) => a.alarm === 'CORRUPT')) out.push({ level: 'bad', code: 'corrupt', title: 'The CORRUPT alarm is raised', text: 'A member failed etcd\'s corruption check. Restore that member from a good snapshot.' });
    if (snap.hash && snap.hash.ok === false) out.push({ level: 'bad', code: 'hash', title: 'The SHA-256 at the end of the file doesn\'t match', text: 'The snapshot was changed or cut short after etcdctl wrote it. etcdutl snapshot restore would refuse it.' });
    if (size >= 0.8 * q) {
      out.push({ level: size >= 0.95 * q ? 'bad' : 'warn', code: 'quota', title: 'The database is at ' + pct(size, q) + '% of its ' + human(q) + ' quota',
        text: 'At the quota etcd raises NOSPACE and stops taking writes. Compaction frees space inside the file; defragmenting gives it back.' });
    }
    if (snap.secrets.plain > 0) {
      out.push({ level: 'warn', code: 'secrets', title: snap.secrets.plain + ' of ' + snap.secrets.total + ' Secrets are stored in the clear', text: 'Anyone with this file or a backup of it can read them. Kubernetes encrypts Secrets at rest only when kube-apiserver has an EncryptionConfiguration.' });
    } else if (snap.secrets.total > 0) {
      out.push({ level: 'ok', code: 'secrets', title: 'All ' + snap.secrets.total + ' Secrets are encrypted at rest', text: 'With ' + [...snap.secrets.providers.keys()].join(', ') + '.' });
    }
    const big = [...snap.keys.values()].filter((e) => e.live && e.history[e.history.length - 1].valueBytes >= MiB);
    if (big.length) {
      const top = big.sort((a, b) => b.bytes - a.bytes)[0];
      out.push({ level: 'warn', code: 'big-values', title: big.length + (big.length === 1 ? ' value is' : ' values are') + ' over 1 MiB',
        text: 'etcd refuses requests over 1.5 MiB by default (--max-request-bytes), so these can barely grow. The biggest is ' + top.key + ', ' + human(top.history[top.history.length - 1].valueBytes) + '.' });
    }
    if (snap.pagesFree > 0 && snap.pagesFree * snap.pageSize > 0.25 * size) {
      out.push({ level: 'info', code: 'free', title: pct(snap.pagesFree, snap.pagesBelowHighWater) + '% of the database is free pages',
        text: 'They count toward the quota until "etcdctl defrag" gives them back. Defragmenting would shrink it by about ' + human(snap.pagesFree * snap.pageSize) + '.' });
    }
    if (snap.historyBytes > snap.liveBytes) {
      out.push({ level: 'info', code: 'history', title: 'Old revisions take more space than the current data', text: human(snap.historyBytes) + ' of old revisions and deletions against ' + human(snap.liveBytes) + ' of current values. Compaction removes them; kube-apiserver compacts every five minutes by default.' });
    }
    const events = snap.resources.find((r) => r.resource === 'events');
    const all = snap.liveBytes + snap.historyBytes;
    if (events && events.bytes + events.historyBytes > 0.3 * all) {
      out.push({ level: 'info', code: 'events', title: 'Events take ' + pct(events.bytes + events.historyBytes, all) + '% of the data', text: 'kube-apiserver keeps each event for --event-ttl, an hour by default. Busy clusters often give events an etcd of their own with --etcd-servers-overrides.' });
    }
    if (snap.managedFieldsBytes > 0.2 * snap.kubernetesValueBytes && snap.kubernetesValueBytes > 0) {
      out.push({ level: 'info', code: 'managed-fields', title: 'managedFields take ' + pct(snap.managedFieldsBytes, snap.kubernetesValueBytes) + '% of the Kubernetes objects', text: 'Server-side apply records which client set which field, in every object. It is often the biggest single part of small objects.' });
    }
    if (snap.authEnabled) out.push({ level: 'info', code: 'auth', title: 'Authentication is on', text: snap.users.length + (snap.users.length === 1 ? ' user and ' : ' users and ') + snap.roles.length + (snap.roles.length === 1 ? ' role are' : ' roles are') + ' defined.' });
    const rank = { bad: 0, warn: 1, info: 2, ok: 3 };
    return out.map((f, i) => [f, i]).sort((a, b) => rank[a[0].level] - rank[b[0].level] || a[1] - b[1]).map((x) => x[0]);
  }

  // Everything worth reporting, as plain data that JSON.stringify can write.
  // options: quota, top (how many keys and prefixes), depth (of prefixes).
  function report(snap, options) {
    const opt = options || {};
    const top = opt.top || 20;
    const quota = opt.quota || 2 * GiB;
    const lastOf = (e) => e.history[e.history.length - 1];
    const keyRow = (e) => ({ key: e.key, live: e.live, bytes: e.bytes, historyBytes: e.historyBytes, revisions: e.revisions, modRevision: e.modRevision,
      createRevision: lastOf(e).createRevision, version: lastOf(e).version, lease: e.lease || null, kind: e.what && e.what.kind ? (e.what.apiVersion ? e.what.apiVersion + ' ' : '') + e.what.kind : null });
    return {
      file: { bytes: snap.fileBytes, pageSize: snap.pageSize, snapshot: Boolean(snap.hash), sha256: snap.hash ? { stored: snap.hash.stored, matches: snap.hash.ok } : null },
      etcd: { storageVersion: snap.storageVersion, clusterVersion: snap.clusterVersion, revision: snap.revision, compactedAt: snap.compactedAt, oldestRevision: snap.oldestRevision,
        consistentIndex: snap.consistentIndex, term: snap.term },
      status: snap.status,
      size: { database: snap.status.totalSize, inUse: snap.bytesInUse, free: snap.pagesFree * snap.pageSize, quota: quota, quotaUsed: snap.status.totalSize / quota },
      pages: { total: snap.pagesTotal, belowHighWater: snap.pagesBelowHighWater, inUse: snap.pagesInUse, free: snap.pagesFree, freelistStored: snap.freelistStored },
      keys: { live: snap.liveKeys, all: snap.keys.size, revisions: snap.revisions, deletions: snap.tombstones, liveBytes: snap.liveBytes, historyBytes: snap.historyBytes },
      members: snap.members, removedMembers: snap.removedMembers, alarms: snap.alarms,
      auth: { enabled: snap.authEnabled, users: snap.users, roles: snap.roles },
      leases: [...snap.leases.values()],
      kubernetes: snap.kubernetes ? {
        secrets: { total: snap.secrets.total, plain: snap.secrets.plain, encrypted: snap.secrets.encrypted, providers: Object.fromEntries(snap.secrets.providers) },
        managedFieldsBytes: snap.managedFieldsBytes, valueBytes: snap.kubernetesValueBytes, resources: snap.resources, kinds: snap.kinds
      } : null,
      findings: findings(snap, quota),
      prefixes: prefixes(snap, opt.depth || 3).slice(0, top),
      biggestKeys: topKeys(snap, 'bytes', top).map(keyRow),
      mostRevisions: topKeys(snap, 'revisions', top).map(keyRow),
      problems: snap.problems
    };
  }

  function human(n) {
    if (n < 1024) return n + ' B';
    const u = ['KiB', 'MiB', 'GiB', 'TiB'];
    let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
    return (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2)).replace(/\.0+$/, '') + ' ' + u[i];
  }

  // A size as people type it, in bytes: 8GiB, 8Gi, 8GB, 8G, 8589934592.
  // KiB to TiB count in 1024s; kB to TB, and K to T, in 1000s. NaN when it
  // isn't a size. The command line's --quota and the page both use it.
  function parseSize(s) {
    const m = /^(\d+(?:\.\d+)?)\s*([kmgt]i?b?|b)?$/i.exec(String(s).trim());
    if (!m) return NaN;
    const unit = (m[2] || '').toLowerCase().replace(/b$/, '');
    const pow = { '': 0, k: 1, ki: 1, m: 2, mi: 2, g: 3, gi: 3, t: 4, ti: 4 }[unit];
    const base = unit.length === 2 || unit === '' ? 1024 : 1000;
    return Math.round(Number(m[1]) * base ** pow);
  }

  return {
    read: read, openFile: openFile, prefixes: prefixes, topKeys: topKeys, history: history, valueText: valueText,
    diffLines: diffLines, findings: findings, report: report, describeValue: describeValue, registryPath: registryPath, human: human, parseSize: parseSize,
    kubernetesObject: kubernetesObject, kubernetesSchema: kubernetesSchema, toYaml: toYaml, toJson: toJson, parseJson: parseJson, Num: Num,
    sha256: sha256, fields: fields, SnapshotError: SnapshotError, GiB: GiB, MiB: MiB
  };
});
