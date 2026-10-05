// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Tests for the Snapshot Viewer. The fixtures are snapshots written by real
// servers (Valkey 9.1.2, Redis 8.10.2, 7.2.16, 6.2.24, 3.2.13 and 2.8.24) after a known
// dataset was loaded, with what each server said about every key when asked
// through ordinary commands: its value, encoding, expiry, DEBUG OBJECT
// serializedlength and DUMP payload. Run with: node --test

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const R = require('../rdb.js');

const fixture = (name) => new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures', name)));
const expected = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name + '.expected.json'), 'utf8'));
const hex = (b) => Buffer.from(b).toString('hex');
const sha = (x) => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const cmpPair = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
const scoreText = (x) => (x === Infinity ? 'inf' : x === -Infinity ? '-inf' : String(x));
function arrayText(v) {
  const s = v instanceof Uint8Array ? Buffer.from(v).toString() : String(v);
  if (/^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(s) && isFinite(parseFloat(s))) return 'num:' + String(parseFloat(s));
  return 'str:' + hex(v instanceof Uint8Array ? v : Buffer.from(s));
}

// The same canonical form the recording script built from the server's replies.
function canonical(type, module, value) {
  switch (type) {
    case 'string': return hex(value);
    case 'list': return value.map(hex);
    case 'set': return value.map(hex).sort();
    case 'zset': return value.map((p) => [hex(p[0]), scoreText(p[1])]).sort(cmpPair);
    case 'hash': return value.map((p) => [hex(p[0]), hex(p[1]), p[2] === undefined ? null : p[2]]).sort(cmpPair);
    case 'stream': return {
      entries: value.entries.map((x) => [x[0], x[1].map((f) => [hex(f[0]), hex(f[1])])]),
      length: value.length, lastId: value.lastId,
      groups: value.groups.map((g) => ({
        name: hex(g.name), lastId: g.lastId,
        pending: g.pending.map((p) => [p.id, Number(p.deliveries)]),
        consumers: g.consumers.map((c) => [hex(c.name), c.pending]).sort(cmpPair)
      })).sort((a, b) => (a.name < b.name ? -1 : 1))
    };
    case 'array': return value.map((p) => [Number(p[0]), arrayText(p[1])]);
    case 'module': return { module: module };
  }
  return null;
}
function streamExtras(v, exp) {
  const out = {};
  if (exp.entriesAdded !== undefined) { out.entriesAdded = Number(v.entriesAdded); out.maxDeletedId = v.maxDeletedId; out.firstId = v.firstId; }
  if (exp.idmp) out.idmp = { duration: v.idmp.duration, maxEntries: v.idmp.maxEntries, producers: v.idmp.producers.length,
    ids: v.idmp.producers.reduce((a, p) => a + p.entries.length, 0), added: v.idmp.added, duplicates: v.idmp.duplicates };
  out.groups = v.groups.map((g) => {
    const r = { name: hex(g.name) };
    if (g.entriesRead !== undefined && exp.groups.find((y) => y.name === r.name && y.entriesRead !== undefined)) r.entriesRead = Number(g.entriesRead);
    if (g.nacked) r.nacked = g.nacked.length;
    return r;
  }).sort((a, b) => (a.name < b.name ? -1 : 1));
  return out;
}

// OBJECT ENCODING, and the RDB types a key with it may be saved as.
const ENC = {
  listpack: { hash: [16, 25], zset: [17], set: [20], list: [18] }, ziplist: { hash: [13], zset: [12], list: [10, 14] },
  hashtable: { hash: [4, 22, 24], set: [2] }, listpackex: { hash: [25] }, intset: { set: [11] }, skiplist: { zset: [3, 5] },
  quicklist: { list: [14, 18] }, linkedlist: { list: [1] }
};

function readAll(name, values) {
  const got = new Map();
  const info = R.read(R.bufferSource(fixture(name)), { values: values, onKey: (e) => got.set(e.db + ':' + hex(e.key), e) });
  return { info, got };
}

for (const name of ['valkey-9.1.2', 'redis-8.10.2', 'redis-7.2.16', 'redis-6.2.24', 'redis-3.2.13', 'redis-2.8.24', 'valkey-9.1.2-lfu', 'redis-8.10.2-lru']) {
  test(`every key in the ${name} snapshot matches what the server said`, () => {
    const exp = expected(name);
    const { info, got } = readAll(name + '.rdb', true);
    const light = readAll(name + '.rdb', false).got;
    assert.equal(info.checksum.status, 'ok');
    assert.equal(info.trailing, 0);
    assert.equal(got.size, exp.keys.length);
    // RDB 6 (Redis 2.6 to 3.0) had no fields about the server.
    if (info.version >= 7) assert.equal(R.auxValue(info, exp.server === 'valkey' ? 'valkey-ver' : 'redis-ver'), exp.version);
    if (exp.functions) assert.deepEqual(info.functions.map(R.functionName), exp.functions.map((f) => f + ' (lua)'));
    for (const k of exp.keys) {
      const id = k.db + ':' + k.key;
      const e = got.get(id);
      assert.ok(e, id + ' is missing');
      const type = k.type === 'vectorset' ? 'module' : k.type;
      assert.equal(e.type, type, id);
      if (type === 'module') assert.equal(e.module, k.type);
      const allowed = (ENC[k.encoding] || {})[e.type];
      if (allowed) assert.ok(allowed.includes(e.rdbType), `${id}: ${k.encoding} saved as RDB type ${e.rdbType}`);
      if (k.expire === 'some') assert.notEqual(e.expire, null, id);
      else assert.equal(e.expire === null ? null : Number(e.expire), k.expire, id);
      if (k.freq !== undefined) assert.equal(e.freq, k.freq, id);
      if (k.idle !== undefined) assert.ok(Math.abs(e.idle - k.idle) <= 2, `${id} idle ${e.idle} vs ${k.idle}`);
      // Bytes of the value in the file against DEBUG OBJECT serializedlength.
      // Redis 8.10.2 reports template hashes at their DUMP size and leaves the
      // 8-byte minimum expiry of hashes with field TTLs out of its count.
      const valueBytes = e.offset + e.size - e.valueOffset;
      if (exp.server === 'redis' && (e.rdbType === 30 || e.rdbType === 32)) { if (k.dump) assert.equal(k.serializedLength, k.dump.length / 2 - 11, id); }
      else if (exp.server === 'redis' && (e.rdbType === 24 || e.rdbType === 25)) assert.equal(valueBytes, k.serializedLength + 8, id);
      else assert.equal(valueBytes, k.serializedLength, id);
      // Reading without values gives the same sizes and counts.
      assert.equal(light.get(id).size, e.size, id);
      assert.equal(light.get(id).length, e.length, id);
      const cv = canonical(e.type, e.module, e.value);
      if (k.value !== undefined) assert.deepEqual(cv, k.value, id);
      else assert.equal(sha(cv), k.valueSha256, id);
      if (k.streamExtras) assert.deepEqual(streamExtras(e.value, k.streamExtras), k.streamExtras, id);
      if (k.dump) {
        const d = R.readDump(new Uint8Array(Buffer.from(k.dump, 'hex')));
        assert.equal(d.checksum, 'ok', id);
        assert.equal(d.extra, 0, id);
        assert.deepEqual(canonical(d.type, d.module, d.value), cv, id + ' DUMP');
      }
      // Decoding one value again from its offset gives the same value.
      if (e.type !== 'module') assert.deepEqual(canonical(e.type, e.module, R.readValueAt(fixture(name + '.rdb'), e, info)), cv, id);
    }
  });
}

test('cluster-mode snapshots: slot records from Redis, slot-info fields from Valkey', () => {
  const r = readAll('redis-8.10.2-cluster.rdb', true);
  assert.equal(r.got.size, 201);
  assert.equal(r.info.slotInfo, 201);
  const v = readAll('valkey-9.1.2-cluster.rdb', true);
  assert.equal(v.got.size, 201);
  assert.equal(v.info.aux.filter((a) => a[0] === 'slot-info').length, 201);
  for (const [, e] of v.got) if (e.type === 'string') assert.equal(Buffer.from(e.value).toString(), 'v' + Buffer.from(e.key).toString().split(':')[1]);
});

test('a snapshot written with rdbchecksum no and rdbcompression no', () => {
  const { info, got } = readAll('valkey-9.1.2-nochecksum.rdb', true);
  assert.equal(info.checksum.status, 'off');
  assert.equal(got.size, 3);
  assert.equal(Buffer.from(got.get('0:' + hex(Buffer.from('plain:long'))).value).toString(), 'abc'.repeat(200));
});

test('an AOF file with an RDB preamble: the snapshot, then the commands after it', () => {
  const bytes = fixture('redis-6.2.24-preamble.aof');
  const { info } = readAll('redis-6.2.24-preamble.aof', true);
  assert.equal(info.checksum.status, 'ok');
  assert.ok(info.trailing > 0);
  assert.equal(Buffer.from(bytes.subarray(info.end + 8, info.end + 12)).toString(), '*2\r\n');
});

test('CRC64 matches the Jones check value, and a damaged DUMP payload is caught', () => {
  assert.equal(R.crcHex(R.crc64(new TextEncoder().encode('123456789'))), 'e9c6d914c4b8d9ca');
  const exp = expected('valkey-9.1.2');
  const k = exp.keys.find((x) => Buffer.from(x.key, 'hex').toString() === 'hash:small');
  const payload = new Uint8Array(Buffer.from(k.dump, 'hex'));
  payload[3] ^= 1;
  assert.equal(R.readDump(payload).checksum, 'mismatch');
});

test('pasted DUMP payloads: hex and redis-cli quoted text', () => {
  const exp = expected('redis-7.2.16');
  const k = exp.keys.find((x) => Buffer.from(x.key, 'hex').toString() === 'zset:small');
  const bytes = Buffer.from(k.dump, 'hex');
  const quoted = '"' + Array.from(bytes).map((b) => (b >= 0x20 && b < 0x7f && b !== 0x22 && b !== 0x5c ? String.fromCharCode(b) : '\\x' + b.toString(16).padStart(2, '0'))).join('') + '"';
  for (const text of [k.dump, k.dump.replace(/(..)/g, '$1 '), quoted]) {
    const d = R.readDump(R.bytesFromText(text).bytes);
    assert.equal(d.type, 'zset');
    assert.equal(d.checksum, 'ok');
    assert.equal(d.length, 5);
  }
});

test('files that are not snapshots, or are cut short, give a clear error', () => {
  assert.throws(() => R.read(R.bufferSource(new TextEncoder().encode('hello world'))), /not an RDB file/);
  const cut = fixture('redis-7.2.16.rdb').subarray(0, 5000);
  assert.throws(() => R.read(R.bufferSource(cut)), /ends/);
  assert.throws(() => R.readDump(new Uint8Array([0, 1, 2])), /Too short/);
});

test('totals: keys by type and database, biggest keys, prefixes and expiries', () => {
  const sum = R.summary({ top: 5 });
  const info = R.read(R.bufferSource(fixture('redis-8.10.2.rdb')), { onKey: (e) => sum.add(e) });
  sum.setNow(Number(R.auxValue(info, 'ctime')) * 1000);
  const s = sum.result();
  assert.equal(s.keys, 60);
  assert.equal(s.byDb[1].keys, 2);
  assert.equal(Buffer.from(s.largest[0].key).toString(), 'list:big');
  assert.equal(s.prefixes[0].prefix, 'profile:');
  assert.equal(s.modules.vectorset, 1);
  assert.equal(s.fieldTtls, 102);
});
