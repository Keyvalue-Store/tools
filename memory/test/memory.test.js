// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// The Memory Calculator against what 15 real servers did
// (fixtures/runs.json.gz, recorded by generate/record.py): how much
// used_memory grew for keys of thousands of shapes, the encoding each
// value got, and what chance decided in the hash tables. Then the parts
// that don't come from a server.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const M = require('../memory.js');
const R = require('./replay.js');

// Without the recorded cases the replay tests fail, and the rest still run.
let data = null, missing = null;
try {
  data = R.load();
} catch (e) {
  missing = e;
}

test('the recorded cases are there, for all 15 versions', () => {
  assert.ok(data, missing && missing.message);
  assert.deepEqual(Object.keys(data).sort(), M.versions().map((v) => v.id).sort());
});

for (const [id, rec] of Object.entries(data || {})) {
  test(id + ': every recorded case comes out the way the server did it', () => {
    const d = R.differences(id, rec);
    assert.ok(rec.cases.length > 1000, 'cases were recorded');
    assert.equal(d.length, 0, d.length + ' differences, such as:\n' + d.slice(0, 6).map((x) => JSON.stringify(x)).join('\n'));
  });
  test(id + ': the expected values for what chance decides', () => {
    // Skiplist levels, keys sharing buckets, overflow buckets: estimated
    // without knowing the outcome, the cases should scatter around zero.
    const c = R.chance(id, rec);
    assert.ok(c.n >= 30, 'cases with random parts');
    assert.ok(Math.abs(c.mean) < 0.75, 'mean z ' + c.mean.toFixed(3));
    assert.ok(c.within3 >= 0.97, (100 * c.within3).toFixed(1) + '% within 3 standard deviations');
  });
}

test('versions are found by loose names', () => {
  assert.equal(M.findVersion('valkey 9.1'), 'valkey-9.1.2');
  assert.equal(M.findVersion('Redis 7.2.16'), 'redis-7.2.16');
  assert.equal(M.findVersion('redis-8'), 'redis-8.10.2');
  assert.equal(M.findVersion('6.2'), 'redis-6.2.24');
  assert.equal(M.findVersion('redis'), 'redis-8.10.2');
  assert.equal(M.findVersion('Valkey'), 'valkey-9.1.2');
  assert.equal(M.findVersion('valkey 9.1.99'), 'valkey-9.1.2');
  assert.equal(M.findVersion('nonsense'), null);
  assert.equal(M.findVersion(''), null);
  assert.throws(() => M.estimate([], 'redis-5.0.0'), /Unknown version/);
});

test('jemalloc size classes', () => {
  const want = { 1: 8, 8: 8, 9: 16, 17: 24, 41: 48, 64: 64, 65: 80, 97: 112, 129: 160, 257: 320, 1025: 1280, 14337: 16384, 16385: 20480, 1048577: 1310720 };
  for (const [n, c] of Object.entries(want)) assert.equal(M.sizeClass(Number(n)), c, 'size class of ' + n);
});

test('a few figures worked out by hand', () => {
  // Redis 7.2, "SET k:000000001 value-of-10" (key 11 bytes, value 10): a
  // 24-byte dict entry, the key copied with a 1-byte header (16), the value
  // in one block with its object (16 + 3 + 10 + 1 = 30, so 32), and a
  // 4-slot table.
  const one = [{ type: 'string', count: 1, key: 11, value: { len: 10 } }];
  assert.equal(M.estimate(one, 'redis-7.2.16').total, 24 + 16 + 32 + 32);
  // Redis 8.10: object, key and value in one block: 16 + 1 + 13 + 14 = 44,
  // so 48; and the keys dict made for the first key (96).
  assert.equal(M.estimate(one, 'redis-8.10.2').total, 48 + 32 + 96);
  // A number from 0 to 9999 is shared up to Redis 8.0, unless an LRU, LFU
  // or LRM policy needs a clock in every object.
  const n = [{ type: 'string', count: 1, key: 11, value: { int: '42' } }];
  assert.equal(M.estimate(n, 'redis-7.2.16').total, 24 + 16 + 32);
  assert.equal(M.estimate(n, 'redis-7.2.16', { maxmemoryPolicy: 'allkeys-lru' }).total, 24 + 16 + 16 + 32);
  assert.equal(M.estimate(n, 'redis-7.2.16', { maxmemoryPolicy: 'volatile-lrm' }).total, 24 + 16 + 16 + 32);
  // HSET key f1 v1 in 7.2: a listpack of 7 + 4 + 4 bytes, so 16.
  const h = M.estimate([{ type: 'hash', count: 1, key: 3, fields: 1, field: { len: 2 }, value: { len: 2 } }], 'redis-7.2.16');
  assert.equal(h.groups[0].encoding, 'listpack');
  assert.equal(h.total, 8 + 24 + 16 + 16 + 32);
});

test('encodings and the limits that change them', () => {
  const hash = (fields, value) => [{ type: 'hash', count: 1, key: 8, fields: fields, field: { len: 6 }, value: { len: value } }];
  assert.equal(M.estimate(hash(512, 10), 'redis-8.10.2').groups[0].encoding, 'listpack');
  assert.equal(M.estimate(hash(513, 10), 'redis-8.10.2').groups[0].encoding, 'hashtable');
  assert.equal(M.estimate(hash(10, 65), 'redis-8.10.2').groups[0].encoding, 'hashtable');
  assert.equal(M.estimate(hash(513, 10), 'redis-8.10.2', { hashMaxListpackEntries: 1000 }).groups[0].encoding, 'listpack');
  assert.equal(M.estimate(hash(10, 10), 'redis-6.2.24').groups[0].encoding, 'ziplist');
  const set = (n, member) => [{ type: 'set', count: 1, key: 8, members: n, member: member }];
  assert.equal(M.estimate(set(512, { int: '1' }), 'valkey-9.1.2').groups[0].encoding, 'intset');
  assert.equal(M.estimate(set(100, { len: 8 }), 'valkey-9.1.2').groups[0].encoding, 'listpack');
  assert.equal(M.estimate(set(100, { len: 8 }), 'redis-7.0.15').groups[0].encoding, 'hashtable');
  const list = (n, writes) => [{ type: 'list', count: 1, key: 8, items: n, item: { len: 10 }, writes: writes }];
  assert.equal(M.estimate(list(600, 'once'), 'redis-7.2.16').groups[0].encoding, 'listpack');
  assert.equal(M.estimate(list(900, 'once'), 'redis-7.2.16').groups[0].encoding, 'quicklist');
  assert.equal(M.estimate(list(10, 'once'), 'redis-7.0.15').groups[0].encoding, 'quicklist');
  const z = [{ type: 'zset', count: 1, key: 8, members: 200, member: { len: 8 }, score: '1' }];
  const r = M.estimate(z, 'redis-8.10.2');
  assert.equal(r.groups[0].encoding, 'skiplist');
  assert.ok(r.sd > 0 && r.random > 0, 'skiplist nodes are left to chance');
});

test('a listpack stops at 1 GB, an intset at 2^30 numbers', () => {
  const big = { hashMaxListpackEntries: 300000000 };
  const h = (writes) => [{ type: 'hash', count: 1, key: 8, fields: 200000000, field: { len: 4 }, value: { len: 4 }, writes: writes }];
  // One HSET checks its arguments, 1.6 GB of them; one field at a time,
  // the listpack's own size.
  assert.equal(M.estimate(h('once'), 'redis-8.10.2', big).groups[0].encoding, 'hashtable');
  assert.equal(M.estimate(h('each'), 'redis-8.10.2', big).groups[0].encoding, 'hashtable');
  const h2 = (writes) => [{ type: 'hash', count: 1, key: 8, fields: 100000000, field: { len: 4 }, value: { len: 4 }, writes: writes }];
  assert.equal(M.estimate(h2('once'), 'redis-6.2.24', big).groups[0].encoding, 'ziplist');
  assert.equal(M.estimate(h2('each'), 'redis-6.2.24', big).groups[0].encoding, 'hashtable');
  const s = [{ type: 'set', count: 1, key: 8, members: 1100000000, member: { int: '0' } }];
  assert.equal(M.estimate(s, 'redis-8.10.2', { setMaxIntsetEntries: 2000000000 }).groups[0].encoding, 'hashtable');
  assert.equal(M.estimate(s, 'redis-8.10.2', { setMaxIntsetEntries: 1000000000 }).groups[0].encoding, 'hashtable');
});

test('ziplists of numbers counted run by run, as fast for 100 million as for 10', () => {
  // The same sum entry by entry: each entry starts with the size of the
  // one before it, 1 byte below 254 and 5 from there.
  const F = M.features('redis-6.2.24');
  const S = { hashMaxListpackEntries: 1e9, hashMaxListpackValue: 1e9, zsetMaxListpackEntries: 1e9, zsetMaxListpackValue: 1e9 };
  const body = (v) => (v >= 0n && v <= 12n ? 1 : v >= -128n && v <= 127n ? 2 : v >= -32768n && v <= 32767n ? 3 : v >= -8388608n && v <= 8388607n ? 4 : v >= -2147483648n && v <= 2147483647n ? 5 : 9);
  const str = (l) => (l <= 63 ? 1 : l <= 16383 ? 2 : 5) + l;
  for (const [start, n, vl] of [['-200', 400, 3], ['-40000', 300, 250], ['8388600', 20, 260], ['2147483640', 30, 0], ['5', 1, 300]]) {
    let total = 11, prev = 0;
    for (let i = 0; i < n; i++) {
      for (const b of [body(BigInt(start) + BigInt(i)), str(vl)]) {
        const size = (prev < 254 ? 1 : 5) + b;
        total += size;
        prev = size;
      }
    }
    const g = { type: 'hash', count: 1, key: 3, fields: n, field: { int: start }, value: { len: vl } };
    assert.equal(M._internal.hashValue(F, g, Object.assign({}, M.defaults, S)).bytes, M.sizeClass(total), 'hash from ' + start);
  }
  const t = Date.now();
  const r = M.estimate([{ type: 'zset', count: 1, key: 8, members: 100000000, member: { int: '-50000000' } }], 'redis-6.2.24', { zsetMaxListpackEntries: 100000000 });
  assert.equal(r.groups[0].encoding, 'ziplist');
  assert.ok(Date.now() - t < 1000, 'quick');
});

test('the spread of what chance decides', () => {
  // Keys of a group have the same field names, so their tables' collisions
  // go together: a hundred keys spread a hundred times as much as one.
  const g = (count) => [{ type: 'hash', count: count, key: 8, fields: 600, field: { len: 6 }, value: { len: 10 } }];
  const one = M.estimate(g(1), 'redis-8.10.2').groups[0].sd, many = M.estimate(g(100), 'redis-8.10.2').groups[0].sd;
  assert.ok(one > 0);
  assert.ok(Math.abs(many / one - 100) < 1e-6, 'ratio ' + many / one);
  // Skiplist levels are drawn for each node: ten times, for a hundred.
  const z = (count) => [{ type: 'zset', count: count, key: 8, members: 300, member: { len: 6 } }];
  const zo = M.estimate(z(1), 'redis-7.2.16').groups[0].sd, zm = M.estimate(z(100), 'redis-7.2.16').groups[0].sd;
  assert.ok(Math.abs(zm / zo - 10) < 1e-6, 'ratio ' + zm / zo);
});

test('scores the way each version writes them', () => {
  const I = M._internal;
  // Grisu2 sometimes prints more digits than it needs.
  assert.equal(I.fpconv(1.23e22), '12300000000000001000000');
  assert.equal(I.fpconv(0.1), '0.1');
  assert.equal(I.fpconv(1.5e-5), '0.000015');
  assert.equal(I.fpconv(1e-7), '1e-7');
  assert.equal(I.fpconv(1.5e300), '1.5e+300');
  assert.equal(I.fpconv(-2.5), '-2.5');
  assert.equal(I.g17(0.1), '0.10000000000000001');
  assert.equal(I.g17(1e21), '1e+21');
  const F = (id) => M.features(id);
  assert.equal(I.scoreText(F('redis-6.2.24'), 4503599627370496), '4503599627370496');
  assert.equal(I.scoreText(F('redis-7.0.15'), 0.1), '0.10000000000000001');
  assert.equal(I.scoreText(F('redis-7.2.16'), 0.1), '0.1');
  // Whole numbers within 2^62 are kept as integers from 7.0.
  assert.deepEqual(I.scoreElem(F('redis-7.2.16'), 1759734012), { int: '1759734012' });
  assert.deepEqual(I.scoreElem(F('redis-7.2.16'), -0), { int: '0' });
  assert.deepEqual(I.scoreElem(F('redis-6.2.24'), -0), { len: 2 });
  // ZADD refuses a score that overflows or underflows.
  const zs = (score) => [{ type: 'zset', count: 1, key: 8, members: 1, member: { len: 3 }, score: score }];
  assert.throws(() => M.estimate(zs('1e400'), 'redis-8.10.2'), /score/);
  assert.throws(() => M.estimate(zs('-1e-400'), 'redis-8.10.2'), /score/);
  assert.equal(M.estimate(zs('inf'), 'redis-8.10.2').groups[0].encoding, 'listpack');
});

test('the text form', () => {
  const p = M.parse('1m strings key=24 value=100 ttl=30%\n50k hashes key="user:1234" fields=20 field=int:0 value=int:42 writes=each # profiles\n' +
    '200 sorted sets key=10 members=1000 member=12 score=0.5\n10 lists items=2.5k item="héllo"');
  assert.deepEqual(p.errors, []);
  assert.equal(p.groups.length, 4);
  assert.deepEqual(p.groups[0], { type: 'string', count: 1000000, key: 24, value: { len: 100 }, ttl: 0.3 });
  assert.equal(p.groups[1].key, 9);
  assert.deepEqual(p.groups[1].field, { int: '0' });
  assert.equal(p.groups[1].writes, 'each');
  assert.equal(p.groups[2].type, 'zset');
  assert.equal(p.groups[3].items, 2500);
  assert.deepEqual(p.groups[3].item, { len: 6 });
  assert.deepEqual(M.parse(M.format(p.groups)).groups, p.groups);
  const bad = M.parse('lots of strings\n5 strings value=int:007\n5 sets fields=3');
  assert.equal(bad.errors.length, 3);
  assert.match(bad.errors[1].message, /007/);
});

test('the text form: counts, lengths, comments and TTLs', () => {
  const one = (line) => {
    const p = M.parse(line);
    assert.deepEqual(p.errors, [], line);
    return p.groups[0];
  };
  const fails = (line, re) => {
    const p = M.parse(line);
    assert.equal(p.errors.length, 1, line);
    if (re) assert.match(p.errors[0].message, re);
  };
  // A # in quotes is part of the sample.
  assert.deepEqual(one('1 strings value="hello #world" # a comment').value, { len: 12 });
  // Counts: decimal k, m and b, groups of three digits, exponents.
  assert.equal(one('1.1b strings').count, 1100000000);
  assert.equal(one('1,000,000 strings').count, 1000000);
  assert.equal(one('1_000 strings').count, 1000);
  assert.equal(one('1e6 strings').count, 1000000);
  assert.equal(one('2.5e+3 strings').count, 2500);
  fails('1,5k strings');
  fails('1.5 strings');
  // Lengths: bytes, and kb and mb of 1024.
  assert.equal(one('1 strings key=20b').key, 20);
  assert.deepEqual(one('1 strings value=8k').value, { len: 8192 });
  assert.deepEqual(one('1 strings value=32kb').value, { len: 32768 });
  assert.deepEqual(one('1 strings value=1.5mb').value, { len: 1572864 });
  fails('1 strings value=0.1k', /length/);
  fails('1 strings key=1gb', /key/);
  // TTLs: a share, all or none, or a number of keys, no more than there are.
  assert.equal(one('100 strings ttl=all').ttl, 1);
  assert.equal(one('100 strings ttl=none').ttl, 0);
  assert.equal(one('100 strings ttl=5').ttlCount, 5);
  fails('100 strings ttl=150%', /100%/);
  fails('100 strings ttl=500', /more keys/);
  // What format writes, parse reads back the same.
  const g = [{ type: 'string', count: 1e15, key: 10, value: { len: 5 }, ttl: 1e-9 }, { type: 'zset', count: 3, key: 4, members: 2, member: { int: 9 } }];
  const text = M.format(g);
  assert.equal(text, '1000000000000000 strings key=10 value=5 ttl=0.0000001%\n3 zsets key=4 members=2 member=int:9 score=0');
  const back = M.parse(text).groups;
  assert.equal(back[0].count, 1e15);
  assert.ok(Math.abs(back[0].ttl - 1e-9) < 1e-24);
  assert.deepEqual(back[1].member, { int: '9' });
  // A byte order mark and old Mac line ends.
  assert.equal(M.parse('﻿10 strings\r20 sets').groups.length, 2);
});

test('groups and settings are checked', () => {
  const s = (extra) => [Object.assign({ type: 'string', count: 10, key: 8, value: { len: 5 } }, extra)];
  assert.throws(() => M.estimate(s({ ttl: '30%' }), 'redis-8.10.2'), /ttl/);
  assert.throws(() => M.estimate(s({ ttl: 2 }), 'redis-8.10.2'), /ttl/);
  assert.throws(() => M.estimate(s({ ttlCount: 20 }), 'redis-8.10.2'), /ttlCount/);
  assert.throws(() => M.estimate(s({ ttlCount: -1 }), 'redis-8.10.2'), /ttlCount/);
  assert.throws(() => M.estimate(s({ count: 1e16 }), 'redis-8.10.2'), /count/);
  assert.throws(() => M.estimate(s({ value: { len: 600000000 } }), 'redis-8.10.2'), /512 MB/);
  assert.throws(() => M.estimate(s({ type: 'stream' }), 'redis-8.10.2'), /Unknown type/);
  assert.throws(() => M.estimate([null], 'redis-8.10.2'), /object/);
  // A number can come as a number.
  assert.equal(M.estimate(s({ value: { int: 42 } }), 'redis-8.10.2').groups[0].encoding, 'int');
  assert.throws(() => M.estimate(s({ value: { int: 2 ** 60 } }), 'redis-8.10.2'), /as text/);
  // Members counting up from a number must stay within 64 bits.
  const set = (start, n) => [{ type: 'set', count: 1, key: 8, members: n, member: { int: start } }];
  assert.throws(() => M.estimate(set('9223372036854775806', 3), 'redis-8.10.2'), /9223372036854775807/);
  assert.equal(M.estimate(set('9223372036854775806', 2), 'redis-8.10.2').groups[0].encoding, 'intset');
  assert.equal(M.parse('1 sets members=1000 member=int:9223372036854775807').errors.length, 1);
  // Settings: whole numbers, known names, known policies.
  const g = s({});
  assert.throws(() => M.estimate(g, 'redis-8.10.2', { hashMaxListpackEntries: -1 }), /0 or more/);
  assert.throws(() => M.estimate(g, 'redis-8.10.2', { listMaxListpackSize: NaN }), /list-max-listpack-size/);
  assert.throws(() => M.estimate(g, 'redis-8.10.2', { maxmemoryPolicy: 'banana' }), /maxmemory-policy/);
  assert.throws(() => M.estimate(g, 'redis-8.10.2', { hashMaxZiplistEntries: 5 }), /Unknown setting/);
  const h = [{ type: 'hash', count: 1, key: 8, fields: 600, field: { len: 4 }, value: { len: 4 } }];
  assert.equal(M.estimate(h, 'redis-8.10.2', { hashMaxListpackEntries: undefined }).groups[0].encoding, 'hashtable');
  assert.equal(M.estimate(h, 'redis-8.10.2', { hashMaxListpackEntries: '1024' }).groups[0].encoding, 'listpack');
  assert.equal(M.estimate(h, 'redis-8.10.2', { maxmemoryPolicy: 'AllKeys-LRU' }).groups[0].encoding, 'hashtable');
  // Packing takes a whole number of fields.
  assert.throws(() => M.pack(g[0], NaN), /whole number/);
  assert.throws(() => M.pack(g[0], 0), /whole number/);
  assert.throws(() => M.pack(h[0], 100), /Only strings/);
});

test('settings by the names each version gives them', () => {
  assert.equal(M.settingName('hashMaxListpackEntries', 'redis-6.2.24'), 'hash-max-ziplist-entries');
  assert.equal(M.settingName('listMaxListpackSize', 'redis-6.2.24'), 'list-max-ziplist-size');
  assert.equal(M.settingName('setMaxIntsetEntries', 'redis-6.2.24'), 'set-max-intset-entries');
  assert.equal(M.settingName('setMaxListpackEntries', 'redis-6.2.24'), null);
  assert.equal(M.settingName('setMaxListpackEntries', 'redis-7.0.15'), null);
  assert.equal(M.settingName('setMaxListpackEntries', 'redis-7.2.16'), 'set-max-listpack-entries');
  assert.equal(M.settingName('zsetMaxListpackValue', 'valkey-9.1.2'), 'zset-max-listpack-value');
  assert.throws(() => M.settingName('nope', 'redis-7.2.16'), /Unknown setting/);
});

test('the longest of numbers counting up', () => {
  assert.equal(M.longest({ int: '-100000' }, 100), 7);
  assert.equal(M.longest({ int: '99999' }, 2), 6);
  assert.equal(M.longest({ int: 5 }, 1), 1);
  assert.equal(M.longest({ len: 10 }, 5), 10);
});

test('packing strings into hashes', () => {
  const g = { type: 'string', count: 1234, key: 13, value: { len: 8 } };
  const packed = M.pack(g, 100);
  assert.deepEqual(packed.map((x) => [x.count, x.fields, x.key]), [[12, 100, 11], [1, 34, 11]]);
  const before = M.estimate([g], 'redis-8.10.2').total;
  const after = M.estimate(packed, 'redis-8.10.2').total;
  assert.ok(after < before / 3, 'packing saves most of it');
});

test('compare, settings and the empty server', () => {
  const all = M.compare([{ type: 'string', count: 1000, key: 16, value: { len: 30 } }]);
  assert.equal(all.length, 15);
  for (const r of all) assert.ok(Math.abs(r.total - r.exact - r.random) < 1e-6);
  assert.ok(M.emptyServer('valkey-9.1.2') > 500000);
  const none = M.estimate([], 'redis-8.10.2');
  assert.equal(none.total, 0);
  assert.equal(none.keys, 0);
});

test('the command line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kvmem-'));
  try {
    const cli = path.join(__dirname, '..', 'cli.js');
    const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    let r = run('1000 strings key=11 value=10', '--server', '7.2');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Redis 7\.2\.16: used_memory grows by/);
    r = run('1000 strings key=11 value=10', '--compare', '--json');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).length, 15);
    r = run('10000 strings key=13 value=8', '--pack', '100');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Saves /);
    // Packing raises the limits the hashes need, and says so, by the
    // version's own names.
    r = run('10000 strings key=13 value=8', '--pack', '1000', '--server', '6.2');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /hash-max-ziplist-entries 1000/);
    for (const bad of ['0', 'abc', '-5', '1.5']) assert.equal(run('10 strings', '--pack', bad).status, 2, '--pack ' + bad);
    const file = path.join(dir, 'keys.txt');
    fs.writeFileSync(file, '# my keys\n100 hashes fields=600 field=8 value=10\n');
    r = run('--file', file, '--set', 'hash-max-listpack-entries=1000', '--json', '--server', 'valkey 9.1');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).groups[0].encoding, 'listpack');
    // Errors name the line of the file they're on.
    fs.writeFileSync(file, '# my keys\n\n5 bananas\n');
    r = run('--file', file);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /keys\.txt, line 3:/);
    r = run('10 strings', '--file', path.join(dir, 'none.txt'));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /no such file/);
    fs.writeFileSync(file, '# nothing yet\n');
    assert.equal(run('--file', file).status, 2);
    assert.equal(run('0 strings key=10', '--compare').status, 2);
    assert.equal(run('3 bananas').status, 2);
    assert.equal(run('3 strings', '--server', 'redis 5').status, 2);
    assert.equal(run('3 strings', '--server', 'valkey').status, 0);
    assert.equal(run('3 strings', '--version', '8').status, 2);
    assert.equal(run('3 strings', '--set', 'hash-max-listpack-entries=-1').status, 2);
    assert.equal(run('3 strings', '--set', 'maxmemory-policy=banana').status, 2);
    assert.equal(run('3 strings', '--pack', '10', '--compare').status, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
