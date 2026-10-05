// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Tests for the Mass Insert Builder. The replies-*.bin fixtures are raw
// replies recorded from Valkey 9.1.2 and Redis 8.10.2 in RESP2 and RESP3.
// Run with: node --test

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const P = require('../pipe.js');

const text = (b) => Buffer.from(b).toString();
const commands = (out) => P.decode(out.bytes(), 1e9).values.map((v) => P.asCommand(v));

test('commands are encoded with byte lengths', () => {
  assert.equal(text(P.encodeCommand(['SET', 'key', 'value'])), '*3\r\n$3\r\nSET\r\n$3\r\nkey\r\n$5\r\nvalue\r\n');
  assert.equal(text(P.encodeCommand(['SET', 'é', '€'])), '*3\r\n$3\r\nSET\r\n$2\r\né\r\n$3\r\n€\r\n');
  assert.equal(text(P.encodeCommand(['SET', 'k', 'a\r\nb'])), '*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$4\r\na\r\nb\r\n');
});

test('CSV: quotes, line breaks, delimiters', () => {
  const r = P.parseCSV('﻿id,note\r\n1,"a, ""b""\nc"\r\n2,\n');
  assert.deepEqual(r.rows, [['id', 'note'], ['1', 'a, "b"\nc'], ['2', '']]);
  assert.equal(P.guessDelimiter('a\tb\tc\n1\t2\t3'), '\t');
  assert.equal(P.guessDelimiter('a;b\n1;2'), ';');
  assert.equal(P.guessDelimiter('a|b\n1|2'), '|');
  assert.equal(P.guessDelimiter('"x;y",b\n1,2'), ',');
  assert.throws(() => P.parseCSV('a,"b\n'), /not closed/);
  const rec = P.csvRecords('1,2\n3,4', { header: false });
  assert.deepEqual(rec.columns, ['column1', 'column2']);
  assert.equal(rec.records[1].column2, '4');
});

test('hashes leave out the fields used in the key', () => {
  const { records, columns } = P.csvRecords('id,name,city\n42,Ana,Lisbon\n');
  let b = P.build(records, columns, { key: 'user:${id}', type: 'hash' });
  assert.deepEqual(commands(b.output), ['HSET "user:42" "name" "Ana" "city" "Lisbon"']);
  b = P.build(records, columns, { key: 'user:${id}', type: 'hash', includeKeyFields: true, ttl: 60 });
  assert.deepEqual(commands(b.output), ['HSET "user:42" "id" "42" "name" "Ana" "city" "Lisbon"', 'EXPIRE "user:42" "60"']);
  b = P.build(records, columns, { key: 'cart:{${id}}:info', type: 'hash', fields: ['city'] });
  assert.deepEqual(commands(b.output), ['HSET "cart:{42}:info" "city" "Lisbon"']);
});

test('strings, lists, sets and sorted sets', () => {
  const { records, columns } = P.csvRecords('user,item,score\n1,mug,10\n1,pan,2.5\n2,mug,oops\n');
  assert.deepEqual(commands(P.build(records, columns, { key: 'k:${user}', type: 'string', value: 'item', ttl: 30 }).output),
    ['SET "k:1" "mug" "EX" "30"', 'SET "k:1" "pan" "EX" "30"', 'SET "k:2" "mug" "EX" "30"']);
  assert.deepEqual(commands(P.build(records, columns, { key: 'l:${user}', type: 'list', value: 'item', fresh: true, ttl: 5 }).output),
    ['DEL "l:1"', 'RPUSH "l:1" "mug"', 'RPUSH "l:1" "pan"', 'DEL "l:2"', 'RPUSH "l:2" "mug"', 'EXPIRE "l:1" "5"', 'EXPIRE "l:2" "5"']);
  assert.deepEqual(commands(P.build(records, columns, { key: 's:${item}', type: 'set', value: 'user' }).output),
    ['SADD "s:mug" "1"', 'SADD "s:pan" "1"', 'SADD "s:mug" "2"']);
  const z = P.build(records, columns, { key: 'z', type: 'zset', score: 'score', member: 'item' });
  assert.deepEqual(commands(z.output), ['ZADD "z" "10" "mug"', 'ZADD "z" "2.5" "pan"']);
  assert.deepEqual(z.skipped, [{ record: 3, reason: 'the score "oops" is not a number' }]);
  assert.deepEqual(commands(P.build(records, columns, { key: 'k:${user}', type: 'string', value: 'item', db: 3 }).output)[0], 'SELECT "3"');
});

test('mistakes in the mapping are explained', () => {
  const { records, columns } = P.csvRecords('id,name\n1,Ana\n');
  assert.throws(() => P.build(records, columns, { key: 'user:${uid}', type: 'hash' }), /\$\{uid\}, which is not a column. The columns are: id, name/);
  assert.throws(() => P.build(records, columns, { key: '', type: 'hash' }), /Set a key template/);
  assert.throws(() => P.build(records, columns, { key: 'u:${id}', type: 'string', value: 'nope' }), /no column called nope/);
  assert.throws(() => P.build(records, columns, { key: 'u:${id}', type: 'hash', ttl: 'soon' }), /whole number of seconds/);
  const empty = P.build([{ id: '' }], ['id'], { key: '${id}', type: 'set', value: 'id' });
  assert.equal(empty.output.commands, 0);
  assert.equal(empty.skipped[0].reason, 'the key is empty');
});

test('JSON keeps long numbers exactly', () => {
  const r = P.jsonRecords('[{"id": 12345678901234567890, "price": 1.50, "tags": ["a"], "none": null}]');
  const b = P.build(r.records, r.columns, { key: 'p:${id}', type: 'string', wholeRow: true });
  assert.deepEqual(commands(b.output), ['SET "p:12345678901234567890" "{\\"id\\":12345678901234567890,\\"price\\":1.50,\\"tags\\":[\\"a\\"],\\"none\\":null}"']);
  const lines = P.jsonRecords('{"a": 1}\n{"a": 2, "b": true}\n');
  assert.deepEqual(lines.columns, ['a', 'b']);
  assert.throws(() => P.jsonRecords('{"a": 1}\n[1]\n'), /Record 2 is not an object/);
  assert.throws(() => P.jsonRecords('{"a": 1}\n{"a": }\n'), /Line 2 is not valid JSON/);
});

test('command lines follow redis-cli quoting', () => {
  const b = P.buildFromCommands('# setup\n\nSET a "x\\ny"\nSET b \'it\\\'s\'\nSET c "\\x00\\xff"\n');
  assert.equal(b.output.commands, 3);
  const vals = P.decode(b.output.bytes()).values.map((v) => Array.from(v.items[2].bytes));
  assert.deepEqual(vals, [[120, 10, 121], Array.from(Buffer.from("it's")), [0, 255]]);
  assert.throws(() => P.buildFromCommands('SET a b\nSET "c d\n'), /Line 2: A double quote is not closed/);
});

test('pasted protocol: escaped, hex dump, or with carriage returns lost', () => {
  const esc = P.bytesFromText('*2\\r\\n$3\\r\\nGET\\r\\n$3\\r\\nfoo\\r\\n');
  assert.equal(esc.form, 'escaped');
  assert.deepEqual(P.decode(esc.bytes).values.map(P.asCommand), ['GET "foo"']);
  const hex = P.bytesFromText('2a 31 0d 0a 24 34 0d 0a 50 49 4e 47 0d 0a');
  assert.equal(hex.form, 'hex');
  assert.deepEqual(P.decode(hex.bytes).values.map(P.asCommand), ['PING']);
  const lf = P.decode(new TextEncoder().encode('*2\n$3\nGET\n$3\nfoo\n'));
  assert.equal(lf.lfOnly, true);
  assert.deepEqual(lf.values.map(P.asCommand), ['GET "foo"']);
  assert.throws(() => P.decode(new TextEncoder().encode('*2\r\n$3\r\nGET\r\n$10\r\nfoo\r\n')), /runs past the end at byte/);
});

test('decodes real replies from Valkey and Redis, RESP2 and RESP3', () => {
  const norm = (v) => {
    if (v.type === 'bulk' || v.type === 'verbatim') return { type: v.type, hex: Buffer.from(v.bytes).toString('hex') };
    if (v.items) return { type: v.type, items: v.items.map(norm) };
    if (v.type === 'null') return { type: 'null' };
    return { type: v.type, value: String(v.value) };
  };
  for (const server of ['valkey', 'redis']) for (const proto of ['2', '3']) {
    const base = path.join(__dirname, 'fixtures', `replies-resp${proto}-${server}`);
    const got = P.decode(new Uint8Array(fs.readFileSync(base + '.bin'))).values.map(norm);
    const want = JSON.parse(fs.readFileSync(base + '.expected.json', 'utf8'));
    // The expected file stores verbatim text with its format prefix; compare the text after it.
    want.forEach((w, i) => { if (w.type === 'verbatim') w.hex = w.hex.slice(8); });
    assert.deepEqual(got, want, server + ' RESP' + proto);
  }
});

test('RESP3 push replies and attributes, as Valkey 9.1.2 and Redis 8.10.2 send them', () => {
  // Recorded after HELLO 3: DEBUG PROTOCOL attrib, DEBUG PROTOCOL push,
  // SUBSCRIBE news, UNSUBSCRIBE news, PING.
  for (const server of ['valkey', 'redis']) {
    const d = P.decode(new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures', `push-attr-${server}.bin`))));
    assert.equal(d.complete, true, server);
    const v = d.values;
    assert.deepEqual(v.map((x) => x.type), ['map', 'bulk', 'bulk', 'push', 'push', 'push', 'simple'], server);
    // An attribute belongs to the reply that follows it.
    assert.equal(Buffer.from(v[1].bytes).toString(), 'Some real reply following the attribute');
    assert.equal(Buffer.from(v[1].attributes[0].bytes).toString(), 'key-popularity');
    assert.equal(Buffer.from(v[2].bytes).toString(), 'Some real reply following the push reply');
    assert.equal(P.show(v[3]), '1) "server-cpu-usage"\n2) (integer) 42');
    assert.equal(P.show(v[4]), '1) "subscribe"\n2) "news"\n3) (integer) 1');
    assert.equal(v[6].value, 'PONG');
  }
});

test('hex dumps from hexdump -C, xxd, od and Wireshark read back as the exact bytes', () => {
  const fx = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name));
  // The client's side of a real valkey-cli session, dumped by each tool.
  // hexdump and od print * in place of repeated lines; od's default offsets are octal.
  for (const name of ['dump-hexdump-C.txt', 'dump-xxd.txt', 'dump-od-x1z.txt', 'dump-od-octal.txt']) {
    const r = P.bytesFromText(fx(name).toString());
    assert.equal(r.form, 'dump', name);
    assert.deepEqual(Buffer.from(r.bytes), fx('dump-client.bin'), name);
  }
  // tshark -z follow,tcp,hex shows both sides, the server's indented.
  const follow = P.bytesFromText(fx('dump-wireshark-follow.txt').toString());
  assert.equal(follow.form, 'dump');
  assert.deepEqual(Buffer.from(follow.bytes), fx('dump-stream.bin'));
  const values = P.decode(follow.bytes).values;
  const shown = values.map((v) => (P.isReply(v, follow.replies) ? null : P.asCommand(v)) || P.show(v));
  assert.deepEqual(shown.slice(0, 3), ['SET "cache:blob" "' + 'a'.repeat(64) + '"', 'OK', 'GET "cache:blob"']);
  // The server's side reads as replies, even a reply shaped like a command.
  assert.equal(shown[7], '1) "name"\n2) "Ana Silva"\n3) "plan"\n4) "pro"');
  const s = P.summarize(values, follow.replies);
  assert.deepEqual([s.commands, s.replies], [5, 5]);
  // od right after its first line prints *, and its offsets are octal.
  const rep = P.bytesFromText(fx('dump-od-repeat.txt').toString());
  assert.equal(Buffer.from(rep.bytes).toString(), ':1\r\n'.repeat(100));
  // Text columns that hold | or > are still text columns.
  const sym = P.bytesFromText(fx('dump-xxd-symbols.txt').toString());
  assert.deepEqual(Buffer.from(sym.bytes), Buffer.from(P.encodeCommand(['SET', 'rule', 'xxxx10 > 9 | ok'])));
  const ws = P.bytesFromText(fx('dump-wireshark-symbols.txt').toString());
  assert.deepEqual(Buffer.from(ws.bytes), fx('dump-wireshark-symbols.bin'));
  // Plain hex and protocol text are not mistaken for dumps.
  for (const t of ['2a 31 0d 0a 24 34 0d 0a 50 49 4e 47 0d 0a', '2a31 0d0a 2434 0d0a', 'PING', 'dead beef', '*1\r\n$4\r\nPING\r\n']) {
    assert.notEqual(P.bytesFromText(t).form, 'dump', t);
  }
});

test('replies print the way redis-cli prints them', () => {
  const b = new TextEncoder().encode('*3\r\n$1\r\na\r\n:7\r\n*2\r\n$-1\r\n+OK\r\n%1\r\n+k\r\n,1.5\r\n-ERR no\r\n');
  const vals = P.decode(b).values;
  assert.equal(P.show(vals[0]), '1) "a"\n2) (integer) 7\n3) 1) (nil)\n   2) OK');
  assert.equal(P.show(vals[1]), '1# k => (double) 1.5');
  assert.equal(P.show(vals[2]), '(error) ERR no');
  const s = P.summarize(P.decode(P.buildFromCommands('SET a 1\nSET b 2\nDEL a').output.bytes()).values);
  assert.deepEqual({ ...s.counts }, { SET: 2, DEL: 1 });
});
