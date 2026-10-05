// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Tests for the Value Inspector. The fixtures were written by the real
// serializers (Python's pickle, msgpack, cbor2, bson, protobuf and its
// compression libraries; PHP's serialize, sessions and igbinary; Ruby's
// Marshal; Java's ObjectOutputStream; Django's Redis cache), each with what
// that language reads back from it, plus DUMP payloads and redis-cli and
// valkey-cli output from Valkey 9.1.2 and Redis 8.10.2. The scripts that
// wrote them are in test/generate/. Run with: node --test

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const I = require('../inspect.js');

const FIX = path.join(__dirname, 'fixtures');
const bin = (name) => new Uint8Array(fs.readFileSync(path.join(FIX, name + '.bin')));
const fixtures = fs.readdirSync(FIX).filter((f) => f.endsWith('.json') && fs.existsSync(path.join(FIX, f.slice(0, -5) + '.bin'))).map((f) => f.slice(0, -5)).sort();

// The inspector's value in the canonical form the generators wrote.
function cj(x, exact) {
  if (!x) return null;
  switch (x.t) {
    case 'null': return null;
    case 'bool': return x.v;
    case 'int': return { i: x.v };
    case 'float': return { n: Number.isFinite(x.v) ? x.v : String(x.v) };
    case 'num': {
      if (exact) return { num: x.v };
      if (/Decimal/.test(x.note || '')) return { dec: x.v };
      const n = Number(x.v);
      return { n: Number.isFinite(n) ? n : String(n) };
    }
    case 'str': return x.v;
    case 'bin': return { b: Buffer.from(x.v).toString('hex') };
    case 'date': return Number.isFinite(x.v) ? { ms: x.v } : { date: x.text };
    case 'list': return x.items.map((e) => cj(e, exact));
    case 'map': return { map: x.entries.map(([k, v]) => [cj(k, exact), cj(v, exact)]) };
    case 'obj': {
      const o = { obj: x.cls, fields: x.fields.map(([k, v]) => [typeof k === 'string' ? k : cj(k, exact), cj(v, exact)]) };
      if (x.items && x.items.length) o.items = x.items.map((e) => cj(e, exact));
      return o;
    }
    case 'tagged': return x.tag === 'Decimal128' ? { tag: x.tag, v: { dec: x.v.v } } : { tag: x.tag, v: cj(x.v, exact) };
    case 'ref': return { ref: x.v };
  }
  throw new Error('unknown node ' + x.t);
}

// Reads protobuf fields back with the schema the generator used.
function protobufWithSchema(msg, schema) {
  const zigzag = (v) => { const x = BigInt(v); return String((x >> 1n) ^ -(x & 1n)); };
  const signed = (v, bits) => String(BigInt.asIntN(bits, BigInt(v)));
  const varints = (bytes) => { const out = []; let x = 0n, s = 0n; for (const c of bytes) { x |= BigInt(c & 0x7f) << s; s += 7n; if (!(c & 0x80)) { out.push({ i: String(x) }); x = 0n; s = 0n; } } return out; };
  const raw = (v) => (v.t === 'bin' ? Buffer.from(v.v) : v.t === 'str' ? Buffer.from(v.v) : null);
  return msg.fields.map(([name, v]) => {
    const n = name.replace('field ', '');
    const type = schema[n];
    switch (type) {
      case 'int64': return [n, { i: signed(v.v, 64) }];
      case 'int32': return [n, { i: signed(v.v, 64) }];
      case 'sint32': return [n, { i: zigzag(v.v) }];
      case 'bool': return [n, v.v === '1'];
      case 'fixed32': case 'fixed64': case 'uint64': return [n, { i: v.v }];
      case 'double': return [n, { n: Number(/as double: (\S+)/.exec(v.note)[1]) }];
      case 'float': return [n, { n: Number(/as float: (\S+)/.exec(v.note)[1]) }];
      case 'string': return [n, v.v];
      case 'bytes': return [n, { b: Buffer.from(v.v).toString('hex') }];
      case 'packed int32': assert.ok(v.t === 'bin', 'packed field shown as bytes'); return [n, varints(raw(v))];
      case 'Inner': return [n, v.fields.map(([k, x]) => [k.replace('field ', ''), x.t === 'int' ? { i: x.v } : x.v])];
    }
    return [n, '?' + type];
  });
}

for (const name of fixtures) {
  test(`${name} decodes to what its own language reads back`, () => {
    const exp = JSON.parse(fs.readFileSync(path.join(FIX, name + '.json'), 'utf8'));
    const a = I.analyze(bin(name));
    assert.deepEqual(a.layers.map((l) => l.id), exp.layers, 'layers');
    for (const l of a.layers) if (l.check !== null && l.check !== undefined) assert.match(l.check, /ok/, l.id + ' checksum');
    assert.equal(a.result.id, exp.format, 'format');
    if (exp.format === 'protobuf') {
      assert.deepEqual(protobufWithSchema(a.result.value, exp.value.schema), exp.value.fields);
    } else if (exp.format === 'image') {
      assert.equal(a.result.image.mime, exp.mime);
      if (exp.mime !== 'image/svg+xml') { assert.equal(a.result.image.width, exp.width); assert.equal(a.result.image.height, exp.height); }
    } else if (exp.value !== null) {
      assert.deepEqual(cj(a.result.value, exp.exact), exp.value);
    }
    // The text form and the JSON form never fail on a decoded value.
    if (a.result.value) { assert.equal(typeof I.show(a.result.value), 'string'); JSON.stringify(I.plain(a.result.value)); }
  });
}

test('redis-cli and valkey-cli --no-raw output reads back to the exact bytes', () => {
  const quoted = fs.readdirSync(FIX).filter((f) => /-quoted-/.test(f));
  assert.ok(quoted.length >= 10);
  for (const f of quoted) {
    const original = f.replace(/^.*-quoted-/, '').replace(/\.txt$/, '');
    const r = I.fromInput(fs.readFileSync(path.join(FIX, f), 'utf8'));
    assert.equal(r.form, 'quoted', f);
    assert.deepEqual(Buffer.from(r.bytes), Buffer.from(bin(original)), f);
  }
});

test('pasted input: quoted, hex with separators, and plain text', () => {
  assert.deepEqual(Array.from(I.fromInput('"a\\x00\\n\\"\\\\\\a\\b"').bytes), [97, 0, 10, 34, 92, 7, 8]);
  assert.equal(I.fromInput('"a\\x00"').form, 'quoted');
  assert.deepEqual(Array.from(I.fromInput('0x1f8b08').bytes), [0x1f, 0x8b, 0x08]);
  assert.deepEqual(Array.from(I.fromInput('1f 8b 08 00').bytes), [0x1f, 0x8b, 0x08, 0x00]);
  assert.deepEqual(Array.from(I.fromInput('de:ad:be:ef').bytes), [0xde, 0xad, 0xbe, 0xef]);
  // Hex digits run together stay text: they could be a hash.
  assert.equal(I.fromInput('da39a3ee5e6b4b0d3255bfef95601890afd80709').form, 'text');
  assert.equal(I.fromInput('"not closed').form, 'text');
  assert.equal(I.fromInput('héllo').form, 'text');
});

test('text: numbers, times, hashes, and base64 that is only base64-shaped', () => {
  const t = (s) => I.analyze(new TextEncoder().encode(s)).result;
  assert.equal(t('hello world').id, 'text');
  assert.ok(t('1791218550').notes.some((n) => n.includes('2026-10-05T16:42:30Z')));
  assert.ok(t('1791218550123').notes.some((n) => n.includes('2026-10-05T16:42:30.123Z')));
  assert.ok(t('da39a3ee5e6b4b0d3255bfef95601890afd80709').notes.some((n) => n.includes('SHA-1')));
  // Random tokens are base64-shaped but decode to nothing in particular.
  for (let i = 0; i < 200; i++) {
    const tok = crypto.randomBytes(18).toString('base64url');
    assert.equal(t(tok).id, 'text', tok);
  }
  // Base64 of text decodes.
  const a = I.analyze(new TextEncoder().encode(Buffer.from('user:42 logged in').toString('base64')));
  assert.deepEqual(a.layers.map((l) => l.id), ['base64']);
  assert.equal(a.result.value.v, 'user:42 logged in');
  assert.equal(I.analyze(new Uint8Array(0)).result.id, 'empty');
});

test('JSON keeps every digit of every number', () => {
  const a = I.analyze(bin('json-exact'));
  const shown = I.show(a.result.value);
  assert.ok(shown.includes('12345678901234567890123'));
  assert.ok(shown.includes('0.1000000000000000055511151231257827'));
  assert.ok(shown.includes('1e400'));
  assert.deepEqual(I.plain(I.parseJSON('{"a":[1,2.5,"x",null,true]}')), { a: [1, 2.5, 'x', null, true] });
  assert.throws(() => I.parseJSON('{"a":1,}'), /JSON/);
});

test('inflate matches zlib on random and repetitive data, every strategy and level', () => {
  const rnd = (n, seed) => { const b = Buffer.alloc(n); let s = seed; for (let i = 0; i < n; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; b[i] = s % 7 === 0 ? (s >> 8) & 0xff : 97 + (s % 5); } return b; };
  const inputs = [Buffer.alloc(0), Buffer.from('a'), rnd(1000, 1), rnd(100000, 2), crypto.randomBytes(5000), Buffer.alloc(70000, 120), Buffer.from('abc'.repeat(30000))];
  const strategies = [zlib.constants.Z_DEFAULT_STRATEGY, zlib.constants.Z_FILTERED, zlib.constants.Z_HUFFMAN_ONLY, zlib.constants.Z_RLE, zlib.constants.Z_FIXED];
  for (const input of inputs) {
    for (const strategy of strategies) for (const level of [0, 1, 6, 9]) {
      const raw = zlib.deflateRawSync(input, { strategy, level });
      assert.deepEqual(Buffer.from(I.inflate(new Uint8Array(raw), 0).out), input, `level ${level} strategy ${strategy} size ${input.length}`);
    }
    const gz = I.gunzip(new Uint8Array(zlib.gzipSync(input)));
    assert.equal(gz.check, 'ok');
    assert.deepEqual(Buffer.from(gz.out), input);
    const z = I.unzlib(new Uint8Array(zlib.deflateSync(input)));
    assert.equal(z.check, 'ok');
    assert.equal(I.crc32(new Uint8Array(input)), zlib.crc32(input));
  }
});

test('damaged compressed data is caught by its checksum', () => {
  const gz = new Uint8Array(zlib.gzipSync(Buffer.from('{"a": "' + 'x'.repeat(500) + '"}')));
  gz[gz.length - 6] ^= 0xff;
  assert.equal(I.gunzip(gz).check, 'mismatch');
  const z = bin('zlib-json');
  z[z.length - 1] ^= 1;
  assert.equal(I.unzlib(z).check, 'mismatch');
  // A zlib header on text that isn't zlib is not taken for zlib.
  assert.equal(I.analyze(new TextEncoder().encode('x marks the spot')).result.id, 'text');
});

test('a pickle that would run a command is only described', () => {
  // What pickle.dumps writes for an object whose __reduce__ returns (os.system, ('echo hi',)).
  const evil = Buffer.from('80049522000000000000008c05706f736978948c0673797374656d9493948c076563686f20686994859452942e', 'hex');
  const a = I.analyze(new Uint8Array(evil));
  assert.equal(a.result.id, 'pickle');
  assert.equal(a.result.value.cls, 'posix.system');
  assert.equal(a.result.value.items[0].v, 'echo hi');
});

test('random and damaged input never throws and always finishes', () => {
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x80000000; };
  const started = Date.now();
  for (let i = 0; i < 3000; i++) {
    const b = new Uint8Array(Math.floor(rand() * 300));
    for (let k = 0; k < b.length; k++) b[k] = Math.floor(rand() * 256);
    // Give some a real signature so the format decoders get exercised.
    const sigs = [[0x1f, 0x8b, 8], [0xac, 0xed, 0, 5], [0x80, 4], [4, 8], [0, 0, 0, 2], [0x04, 0x22, 0x4d, 0x18], [0x82], [0xa2], [0x0a]];
    if (i % 2 && b.length > 8) b.set(sigs[i % sigs.length]);
    const a = I.analyze(b);
    if (a.result.value) I.show(a.result.value);
  }
  for (const name of fixtures) {
    const original = bin(name);
    for (let k = 0; k < 30; k++) {
      const b = original.slice(0, Math.max(1, Math.floor(rand() * original.length)));
      if (b.length) b[Math.floor(rand() * b.length)] ^= 1 << Math.floor(rand() * 8);
      const a = I.analyze(b);
      if (a.result.value) { I.show(a.result.value); I.plain(a.result.value); }
    }
  }
  assert.ok(Date.now() - started < 60000);
});

test('the printed form', () => {
  const v = I.analyze(new TextEncoder().encode('{"name": "alice", "tags": ["a", "b"], "n": 1}')).result.value;
  assert.equal(I.show(v), '{"name": "alice", "tags": ["a", "b"], "n": 1}');
  const m = I.analyze(bin('ruby-marshal-array')).result.value;
  assert.equal(I.show(m), '[1, :a, "b"]');
  const big = I.show(I.analyze(bin('java-session')).result.value);
  assert.ok(big.includes('com.example.Customer {'));
  assert.ok(big.includes('status: com.example.Status.ACTIVE'));
});

test('the command line reads files, standard input and pasted text', () => {
  const cli = path.join(__dirname, '..', 'cli.js');
  const run = (args, input) => spawnSync(process.execPath, [cli].concat(args), { input: input, encoding: 'utf8' });
  let r = run([path.join(FIX, 'gzip-json.bin')]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /gzip/);
  assert.match(r.stdout, /"user": "alice"/);
  r = run(['-'], fs.readFileSync(path.join(FIX, 'valkey-9.1.2-quoted-pickle-protocol-4.txt')));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Python pickle/);
  r = run(['--text', '"\\x80\\x04\\x95\\x0b\\x00\\x00\\x00\\x00\\x00\\x00\\x00}\\x94\\x8c\\x01a\\x94K\\x01s."']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /"a": 1/);
  r = run([path.join(FIX, 'bson.bin'), '--json']);
  const j = JSON.parse(r.stdout);
  assert.equal(j.format, 'bson');
  assert.equal(j.value.name, 'alice');
});
