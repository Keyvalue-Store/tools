// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Tests for the Hash Slot Calculator. The fixtures were recorded from real
// servers, Valkey 9.1.2 and Redis 8.10.2, so these tests compare the tool with
// what the servers answered. Run with: node --test

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('../slots.js');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const enc = new TextEncoder();
const str = (b) => Buffer.from(b).toString();

test('CRC16 matches the XMODEM check value', () => {
  assert.equal(S.crc16(enc.encode('123456789')), 0x31c3);
});

test('examples from the cluster specification', () => {
  assert.equal(S.keySlot('somekey'), 11058);
  assert.equal(S.keySlot('foo{hash_tag}'), 2515);
  assert.equal(S.keySlot('somekey{hash_tag}'), 2515);
  assert.equal(S.keySlot('{user1000}.following'), S.keySlot('{user1000}.followers'));
  // Only the first { and the first } after it count, and {} hashes the whole key.
  assert.equal(S.keySlot('foo{}{bar}'), S.crc16(enc.encode('foo{}{bar}')) & 16383);
  assert.equal(S.keySlot('foo{{bar}}zap'), S.crc16(enc.encode('{bar')) & 16383);
  assert.equal(S.keySlot('foo{bar}{zap}'), S.keySlot('bar'));
});

test('every recorded key lands in the slot Valkey 9.1.2 gave it', () => {
  const lines = fixture('keyslot-valkey.jsonl').trim().split('\n');
  assert.ok(lines.length > 1000);
  for (const line of lines) {
    const k = JSON.parse(line);
    assert.equal(S.keySlot(new Uint8Array(Buffer.from(k.hex, 'hex'))), k.slot, 'key ' + k.hex);
  }
});

for (const server of ['valkey', 'redis']) {
  test(`keys and CROSSSLOT answers match ${server}`, () => {
    const lines = fixture(`commands-${server}.jsonl`).trim().split('\n');
    let checked = 0;
    for (const line of lines) {
      const rec = JSON.parse(line);
      const r = S.checkCommand(rec.args.map((a) => enc.encode(a)));
      assert.deepEqual(r.keys.map((k) => str(k.bytes)), rec.keys, rec.args.join(' '));
      if (rec.crossslot === undefined) continue;
      if (server === 'valkey' && rec.args[0] === 'MSETEX' && r.crossSlot) {
        // Valkey 9.1.2 runs MSETEX across slots; the tool says so in a note.
        assert.equal(rec.crossslot, false);
        assert.ok(r.notes.some((n) => n.includes('Valkey 9.1.2')));
        continue;
      }
      assert.equal(r.crossSlot, rec.crossslot, rec.args.join(' '));
      checked++;
    }
    assert.ok(checked > 600);
  });

  test(`CLUSTER NODES from ${server} reads as three primaries with the even split`, () => {
    const nodes = S.parseClusterNodes(fixture(`cluster-nodes-${server}.txt`));
    assert.equal(nodes.length, 3);
    const got = nodes.map((n) => n.ranges[0].join('-')).sort((a, b) => parseInt(a) - parseInt(b));
    assert.deepEqual(got, S.evenSplit(3).map((r) => r.ranges[0].join('-')));
  });
}

test('even split matches valkey-cli --cluster create for 4 to 10 primaries', () => {
  for (const line of fixture('even-split-valkey.txt').trim().split('\n')) {
    const m = /^N=(\d+) MATCH server: (.*)$/.exec(line.trim());
    assert.ok(m, line);
    const want = m[2].trim().split(' ');
    assert.deepEqual(S.evenSplit(+m[1]).map((r) => r.ranges[0].join('-')), want);
  }
});

test('CLUSTER NODES with replicas, migrating slots and hostnames', () => {
  const text = [
    '07c37dfeb235213a872192d90877d0cd55635b91 127.0.0.1:30004@31004,host-d slave e7d1eecce10fd6bb5eb35b9f99a514335d9ba9ca 0 1426238317239 4 connected',
    '67ed2db8d677e59ec4a4cefb06858cf2a1a89fa1 127.0.0.1:30002@31002,host-b master - 0 1426238316232 2 connected 5461-10922 [5461->-e7d1eecce10fd6bb5eb35b9f99a514335d9ba9ca]',
    '292f8b365bb7edb5e285caf0b7e6ddc7265d2f4f 127.0.0.1:30003@31003 master - 0 1426238318243 3 connected 10923-16383',
    'e7d1eecce10fd6bb5eb35b9f99a514335d9ba9ca 127.0.0.1:30001@31001 myself,master - 0 0 1 connected 0-5460'
  ].join('\n');
  const nodes = S.parseClusterNodes(text);
  assert.equal(nodes.length, 3);
  assert.equal(nodes[0].node, 'host-b (127.0.0.1:30002)');
  assert.deepEqual(nodes[0].ranges, [[5461, 10922]]);
  const map = S.slotMap(nodes);
  assert.equal(map[0], 2);
  assert.equal(map[16383], 1);
});

test('arguments split the way redis-cli splits them', () => {
  const a = S.splitArgs(`MSET "a b" 1 'c\\'d' "\\x41\\n" 😀k`).map(str);
  assert.deepEqual(a, ['MSET', 'a b', '1', "c'd", 'A\n', '😀k']);
  assert.deepEqual(Array.from(S.splitArgs(`SET "\\xe2\\x82\\xac" v`)[1]), [0xe2, 0x82, 0xac]);
  assert.throws(() => S.splitArgs('GET "abc"x'), /followed by a space/);
  assert.throws(() => S.splitArgs('GET "abc'), /not closed/);
});

test('pasted key lists: numbering, quotes and raw mode', () => {
  assert.equal(str(S.parseKeyLine('1) "user:42"')), 'user:42');
  assert.deepEqual(Array.from(S.parseKeyLine('"bin:\\x00\\xff"')), [98, 105, 110, 58, 0, 255]);
  assert.equal(str(S.parseKeyLine('"quoted"', true)), '"quoted"');
  assert.equal(S.displayKey(S.parseKeyLine('"bin:\\x00\\xff"')), 'bin:\\x00\\xff');
  assert.equal(S.displayKey(enc.encode('user:€')), 'user:€');
  assert.equal(S.parseKeyList('a\r\n\r\nb\n').length, 2);
});

test('counting many keys by slot and node', () => {
  const keys = [];
  for (let i = 0; i < 3000; i++) keys.push(enc.encode('user:' + i));
  for (let i = 0; i < 500; i++) keys.push(enc.encode('cart:{42}:' + i));
  const r = S.analyze(keys, S.evenSplit(3));
  assert.equal(r.total, 3500);
  assert.equal(r.perNode.reduce((a, b) => a + b, 0), 3500);
  assert.equal(r.tagged, 500);
  assert.deepEqual(r.topTags[0], ['42', 500]);
  assert.equal(r.topSlots[0][0], S.keySlot('{42}'));
  assert.ok(r.topSlots[0][1] >= 500);
});

test('commands that cannot be read return a clear error', () => {
  assert.match(S.checkCommand('ZUNIONSTORE out 3 a b').error, /number of keys/);
  assert.match(S.checkCommand('ZUNION 0 a').error, /number of keys/);
  assert.match(S.checkCommand('XREAD STREAMS a b 0').error, /IDs/);
  assert.match(S.checkCommand('').error, /Type a command/);
  const r = S.checkCommand('GET user:1');
  assert.equal(r.crossSlot, false);
  assert.equal(r.keys.length, 1);
});

test('scripts and functions may have no keys', () => {
  // Both servers ran these; COMMAND GETKEYS has nothing to list for them.
  for (const c of ['EVAL "return 1" 0', 'EVAL_RO "return 1" 0', 'EVALSHA e0e1f9fabfc9d4800c877a703b823ac0578ff8db 0', 'FCALL f 0']) {
    const r = S.checkCommand(c);
    assert.equal(r.error, undefined, c);
    assert.equal(r.keys.length, 0, c);
    assert.equal(r.crossSlot, false, c);
  }
});

test('SORT with a destination named like an option: both servers\' readings', () => {
  // Recorded with COMMAND GETKEYS. Redis 8.10.2 skips the destination after
  // STORE; Valkey 9.1.2 reads it again as an option.
  for (const line of fixture('sort-store-names.jsonl').trim().split('\n')) {
    const rec = JSON.parse(line);
    const r = S.checkCommand(rec.args.map((a) => enc.encode(a)));
    const keys = r.keys.map((k) => str(k.bytes));
    assert.deepEqual(keys, rec.redis, rec.args.join(' '));
    assert.deepEqual(r.valkeyKeys ? r.valkeyKeys.map(str) : keys, rec.valkey, rec.args.join(' '));
    assert.equal(r.notes.some((n) => n.startsWith('Valkey 9.1.2 finds other keys')), !!r.valkeyKeys);
  }
});

test('SUNSUBSCRIBE carries a note on how Redis and Valkey differ', () => {
  const r = S.checkCommand('SUNSUBSCRIBE ch522612 ch469800');
  assert.equal(r.crossSlot, true);
  assert.ok(r.notes.some((n) => n.includes('Redis 8.10.2 runs SUNSUBSCRIBE on any node')));
});

test('real valkey-cli SCAN output reads back as the exact keys, raw or quoted', () => {
  const want = fixture('scan-keys.hex').trim().split('\n').sort();
  const read = (name) => {
    const bytes = fs.readFileSync(path.join(__dirname, 'fixtures', name));
    return S.parseKeyBuffer(new Uint8Array(bytes)).map((k) => Buffer.from(k).toString('hex'));
  };
  // Raw output stops each key at its first zero byte; that is valkey-cli, not
  // the parser. The quoted (--no-raw) output keeps every byte.
  const cutAtZero = (hex) => { for (let i = 0; i < hex.length; i += 2) if (hex.substr(i, 2) === '00') return hex.slice(0, i); return hex; };
  assert.deepEqual(read('scan-raw.txt').sort(), want.map(cutAtZero).sort());
  assert.deepEqual(read('scan-noraw.txt').sort(), want);
  // SCAN as a command also prints the cursor, "0", as its first line.
  const cmd = read('scan-cmd-noraw.txt');
  assert.equal(cmd[0], Buffer.from('0').toString('hex'));
  assert.deepEqual(cmd.slice(1).sort(), want);
});
