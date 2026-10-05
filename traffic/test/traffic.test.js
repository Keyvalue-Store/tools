// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Tests for the Traffic Analyzer. The fixtures are MONITOR captures recorded
// with valkey-cli and redis-cli from real servers (Valkey 9.1.2, Redis
// 8.10.2, 7.2.16, 6.2.24 and 2.8.24) while a known workload ran from several
// client addresses, with what every connection sent, the keys COMMAND GETKEYS
// reported for each command, the commands each script ran, and CLUSTER
// KEYSLOT for every key. Run with: node --test

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const T = require('../traffic.js');

const FIX = path.join(__dirname, 'fixtures');
const read = (name) => fs.readFileSync(path.join(FIX, name), 'latin1');
const expected = (name) => JSON.parse(fs.readFileSync(path.join(FIX, name + '.expected.json'), 'utf8'));
const keyBytes = (k) => (typeof k === 'string' ? Buffer.from(k, 'utf8') : Buffer.from(k.hex, 'hex'));
const hash = (args) => crypto.createHash('sha256').update(Buffer.concat(args.map((a) => Buffer.concat([Buffer.from(a.length + ':'), Buffer.from(a)])))).digest('hex').slice(0, 16);
const exampleText = () => {
  const ctx = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'app', 'example.js'), 'utf8'), ctx);
  return ctx.KVTrafficExample;
};

// Walks a capture line by line against what each connection sent. Every
// line must be the next command of its connection, and the lines a script
// ran must follow the script's own line.
function replay(name, text) {
  const exp = expected(name);
  const keys = exp.keys.map(keyBytes);
  const queues = new Map(exp.connections.map((c) => [c.client, { ops: c.ops.filter((o) => !o.hidden), i: 0 }]));
  const steps = [];
  let lua = [];
  for (const line of text.split('\n')) {
    if (!line.trim() || line.trim() === 'OK') continue;
    const cmd = T.parseLine(line);
    assert.ok(cmd, name + ': could not read ' + line.slice(0, 80));
    let e;
    if (cmd.client === 'lua') {
      e = lua.shift();
      assert.ok(e, name + ': a script line nobody sent: ' + line.slice(0, 80));
    } else {
      assert.equal(lua.length, 0, name + ': script lines missing before ' + line.slice(0, 80));
      const q = queues.get(cmd.client);
      assert.ok(q, name + ': unknown connection ' + cmd.client);
      e = q.ops[q.i++];
      assert.ok(e, name + ': more commands than ' + cmd.client + ' sent');
      if (e.lua) lua = e.lua.slice();
    }
    steps.push({ cmd: cmd, exp: e });
  }
  assert.equal(lua.length, 0, name + ': script lines missing at the end');
  for (const [client, q] of queues) assert.equal(q.i, q.ops.length, name + ': commands from ' + client + ' missing');
  return { exp: exp, keys: keys, steps: steps };
}

// The analyzer's rules, applied to what was sent: which keys a command uses
// and how. Scripts and pub/sub are left out, and so are commands that
// neither read nor write.
function accessesOf(step, flags) {
  const name = step.exp.n, f = flags[name] || '', base = name.split(' ')[0];
  if (f.includes('x') || f.includes('p')) return null;
  if (base === 'FLUSHALL' || base === 'FLUSHDB') return { flush: base === 'FLUSHALL' ? -1 : step.cmd.db };
  if (!f.includes('r') && !f.includes('w')) return null;
  if (!step.exp.k.length) return null;
  const op = ['DEL', 'UNLINK', 'GETDEL'].includes(base) ? 2 : f.includes('w') ? 1 : 0;
  return { op: op, keys: step.exp.k };
}

const CAPTURES = ['valkey-9.1.2', 'redis-8.10.2', 'redis-7.2.16', 'redis-6.2.24', 'redis-2.8.24'];

for (const name of CAPTURES) {
  test(`every command in the ${name} capture reads back as sent, with the keys GETKEYS reported`, () => {
    const { exp, keys, steps } = replay(name, read(name + '.txt'));
    let lua = 0;
    for (const { cmd, exp: e } of steps) {
      const where = `${name}: ${T.showKey(cmd.args[0])} from ${cmd.client}`;
      assert.equal(hash(cmd.args), e.h, where + ' arguments');
      assert.equal(T.commandInfo(cmd.args).name, e.n, where + ' name');
      // The same keys in any order: Redis 6.2 lists the destination of
      // ZUNIONSTORE last, newer servers first.
      const got = T.keyPositions(cmd.args).map((i) => Buffer.from(cmd.args[i]).toString('hex')).sort();
      assert.deepEqual(got, e.k.map((i) => keys[i].toString('hex')).sort(), where + ' keys');
      if (cmd.client === 'lua') lua++;
    }
    const sent = exp.connections.reduce((a, c) => a + c.ops.filter((o) => !o.hidden).length, 0);
    assert.equal(steps.length - lua, sent);
    assert.ok(lua > 0);
  });

  test(`the totals for the ${name} capture match the workload`, () => {
    const { exp, keys, steps } = replay(name, read(name + '.txt'));
    const an = T.analyzer();
    an.addText(read(name + '.txt'));
    const r = an.result({ top: 1000 });
    assert.equal(r.commands, steps.length);
    assert.equal(r.unparsed, 0);

    // Commands by name and kind, and lines from scripts.
    const byName = new Map();
    const kinds = { read: 0, write: 0, script: 0, pubsub: 0, other: 0 };
    for (const { exp: e } of steps) {
      byName.set(e.n, (byName.get(e.n) || 0) + 1);
      const f = exp.flags[e.n] || '';
      kinds[f.includes('x') ? 'script' : f.includes('p') ? 'pubsub' : f.includes('w') ? 'write' : f.includes('r') ? 'read' : 'other']++;
    }
    assert.deepEqual(Object.fromEntries(r.byCommand.map((c) => [c.name, c.count])), Object.fromEntries(byName));
    assert.deepEqual(r.kinds, kinds);
    assert.equal(r.luaLines, steps.filter((s) => s.cmd.client === 'lua').length);
    assert.equal(r.multi, byName.get('MULTI') || 0);
    const hosts = new Map();
    for (const { cmd } of steps) { const h = cmd.client === 'lua' ? 'lua' : cmd.client.split(':')[0]; hosts.set(h, (hosts.get(h) || 0) + 1); }
    assert.deepEqual(Object.fromEntries(r.hosts.map((h) => [h.host, h.count])), Object.fromEntries(hosts));
    assert.equal(r.connections, exp.connections.filter((c) => c.ops.some((o) => !o.hidden)).length);

    // Every key: reads, writes and deletes.
    const want = new Map();
    let cross = 0;
    for (const s of steps) {
      const a = accessesOf(s, exp.flags);
      if (!a || a.flush !== undefined) continue;
      const slots = new Set();
      for (const k of a.keys) {
        const id = s.cmd.db + ':' + keys[k].toString('hex');
        const w = want.get(id) || [0, 0, 0];
        w[a.op]++;
        want.set(id, w);
        slots.add(exp.slots[k]);
      }
      if (slots.size > 1) cross++;
    }
    const got = new Map(an.keyStats().map((k) => [k.db + ':' + Buffer.from(k.key).toString('hex'), [k.reads, k.writes, k.deletes]]));
    assert.deepEqual(got, want);
    assert.equal(r.keys.distinct, want.size);

    // Findings.
    const finding = (id) => r.findings.find((f) => f.id === id);
    const count = (id) => (finding(id) ? finding(id).count : 0);
    const text = (b) => Buffer.from(b).toString();
    assert.equal(count('keys'), byName.get('KEYS') || 0);
    assert.equal(count('flush'), (byName.get('FLUSHDB') || 0) + (byName.get('FLUSHALL') || 0));
    assert.equal(count('cross-slot'), cross);
    assert.equal(count('large'), steps.filter((s) => s.cmd.args.some((a) => a.length >= 100 * 1024)).length);
    assert.equal(count('whole'), steps.filter((s) => ['SMEMBERS', 'HGETALL', 'HKEYS', 'HVALS', 'SUNION', 'SINTER', 'SDIFF'].includes(s.exp.n) ||
      (['LRANGE', 'ZRANGE', 'ZREVRANGE'].includes(s.exp.n) && text(s.cmd.args[2]) === '0' && text(s.cmd.args[3]) === '-1')).length);
    assert.equal(count('databases'), steps.filter((s) => s.cmd.db !== 0 && s.exp.n !== 'SELECT').length);
    // SET without an expiry, then EXPIRE on the same key, from one connection.
    const last = new Map();
    let setExpire = 0;
    for (const { cmd, exp: e } of steps) {
      const prev = last.get(cmd.client);
      if (/^P?EXPIRE(AT)?$/.test(e.n) && prev && prev === cmd.db + ':' + text(cmd.args[1])) setExpire++;
      last.set(cmd.client, e.n === 'SET' && !cmd.args.slice(3).some((a) => /^(EX|PX|EXAT|PXAT|KEEPTTL)$/i.test(text(a))) ? cmd.db + ':' + text(cmd.args[1]) : null);
    }
    assert.equal(count('set-expire'), setExpire);
    // The busiest key.
    const top = Array.from(want.entries()).map(([id, w]) => [id, w[0] + w[1] + w[2]]).sort((a, b) => b[1] - a[1])[0];
    assert.equal(r.keys.top[0].total, top[1]);
    const accesses = Array.from(want.values()).reduce((a, w) => a + w[0] + w[1] + w[2], 0);
    assert.equal(r.keys.accesses, accesses);
    if (top[1] / accesses >= 0.1) assert.equal(count('hot-key'), top[1]);

    // How the keys would spread over a cluster of three primaries.
    const per = [0, 0, 0];
    for (const s of steps) {
      const a = accessesOf(s, exp.flags);
      if (a && a.keys) for (const k of a.keys) per[exp.slots[k] <= 5460 ? 0 : exp.slots[k] <= 10922 ? 1 : 2]++;
    }
    assert.deepEqual(r.cluster.perPrimary, per);
  });

  test(`the hit-rate curve for the ${name} capture matches a simulated LRU cache`, () => {
    const { exp, keys, steps } = replay(name, read(name + '.txt'));
    const an = T.analyzer();
    an.addText(read(name + '.txt'));
    const curve = an.curve();
    // The same accesses, through real caches of a few sizes.
    const seq = [];
    for (const s of steps) {
      const a = accessesOf(s, exp.flags);
      if (!a) continue;
      if (a.flush !== undefined) seq.push({ flush: a.flush });
      else for (const k of a.keys) seq.push({ key: s.cmd.db + ':' + keys[k].toString('hex'), db: s.cmd.db, op: a.op });
    }
    const distinct = new Set(seq.filter((x) => x.key).map((x) => x.key)).size;
    assert.equal(curve.keys, distinct);
    for (const size of [1, 2, 3, 5, 10, 25, 50, 100, 200, distinct]) {
      const cache = new Map();
      let hits = 0, reads = 0;
      for (const x of seq) {
        if (x.flush !== undefined) { for (const [k, db] of cache) if (x.flush === -1 || db === x.flush) cache.delete(k); continue; }
        if (x.op === 0) { reads++; if (cache.has(x.key)) hits++; }
        cache.delete(x.key);
        if (x.op === 2) continue;
        cache.set(x.key, x.db);
        if (cache.size > size) cache.delete(cache.keys().next().value);
      }
      assert.equal(curve.reads, reads);
      assert.equal(curve.hits(size), hits, `${name}: a cache of ${size} keys`);
    }
  });

  test(`key slots for the ${name} capture match CLUSTER KEYSLOT`, () => {
    const exp = expected(name);
    exp.keys.forEach((k, i) => assert.equal(T.keySlot(keyBytes(k)), exp.slots[i], JSON.stringify(k)));
  });
}

test('the example on the page is a real capture, and reads back as sent', () => {
  const text = exampleText();
  const { steps } = replay('example', text);
  for (const { cmd, exp: e } of steps) assert.equal(hash(cmd.args), e.h);
  const an = T.analyzer();
  an.addText(text);
  const r = an.result();
  assert.equal(r.commands, steps.length);
  assert.ok(r.duration > 30);
});

test('reading a file in pieces gives the same result as reading it at once', () => {
  const text = read('valkey-9.1.2.txt');
  const whole = T.analyzer();
  whole.addText(text);
  const pieces = T.analyzer();
  for (let i = 0; i < text.length; i += 997) pieces.addChunk(text.slice(i, i + 997), i + 997 >= text.length);
  assert.deepEqual(pieces.result(), whole.result());
  assert.deepEqual(pieces.curve().points, whole.curve().points);
});

test('MONITOR lines: escapes, clients, and lines that are not commands', () => {
  const p = T.parseLine('1791218550.754262 [0 127.0.0.1:54650] "SET" "bin\\x00key" "line\\nbreak \\"quote\\" \\\\ \\t\\a\\b\\r"');
  assert.equal(p.sec, 1791218550);
  assert.equal(p.usec, 754262);
  assert.equal(p.db, 0);
  assert.equal(p.client, '127.0.0.1:54650');
  assert.deepEqual(Buffer.from(p.args[1]), Buffer.from('bin\x00key', 'latin1'));
  assert.equal(Buffer.from(p.args[2]).toString(), 'line\nbreak "quote" \\ \t\x07\x08\r');
  // Straight off the socket, with a + and CRLF; an IPv6 client; a Unix socket.
  assert.deepEqual(T.parseLine('+1791218550.1 [3 [::1]:6000] "GET" "k"\r').args.map((a) => Buffer.from(a).toString()), ['GET', 'k']);
  assert.equal(T.parseLine('+1791218550.1 [3 [::1]:6000] "GET" "k"\r').usec, 100000);
  assert.equal(T.parseLine('1791218550.100000 [12 [::1]:6000] "GET" "k"').client, '[::1]:6000');
  assert.equal(T.parseLine('1791218550.100000 [0 unix:/tmp/redis.sock] "PING"').client, 'unix:/tmp/redis.sock');
  // A capture saved as UTF-8 text by some other tool.
  assert.equal(Buffer.from(T.parseLine('1791218550.100000 [0 lua] "SET" "café" "\u{1F525}"').args[2]).toString(), '\u{1F525}');
  for (const bad of ['OK', '', 'hello', '1791218550.1 [0 127.0.0.1:1] "GET" "unterminated', '1791218550.1 [0 127.0.0.1:1] GET k', '1791218550 [0 x] "GET"']) assert.equal(T.parseLine(bad), null, bad);
  const an = T.analyzer();
  an.addText('OK\n1791218550.1 [0 127.0.0.1:1] "GET" "k"\nnot a command\n1791218550.2 [0 127.0.0.1:1] "MODULE.CMD" "x"\n');
  const r = an.result();
  assert.equal(r.commands, 2);
  assert.equal(r.unparsed, 1);
  assert.deepEqual(r.unparsedExamples, ['not a command']);
  assert.deepEqual(r.findings.find((f) => f.id === 'unknown').examples, ['MODULE.CMD']);
});

test('keys of commands whose keys sit in unusual places match COMMAND GETKEYS', () => {
  const g = JSON.parse(fs.readFileSync(path.join(FIX, 'getkeys.json'), 'utf8'));
  assert.ok(g.forms.length >= 60);
  for (const f of g.forms) {
    const mine = T.keyPositions(f.args.map((a) => Buffer.from(a))).map((i) => f.args[i]).sort();
    for (const server of ['valkey', 'redis']) assert.deepEqual(mine, (f[server] || []).slice().sort(), server + ': ' + f.args.join(' '));
  }
  assert.deepEqual(T.keyPositions([Buffer.from('NOT-A-COMMAND'), Buffer.from('x')]), []);
});

test('the hit-rate curve agrees with simulated caches on random traffic', () => {
  let seed = 42;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x80000000; };
  for (let round = 0; round < 20; round++) {
    const nKeys = 5 + Math.floor(rand() * 60), n = 300 + Math.floor(rand() * 700);
    const keyDb = Array.from({ length: nKeys }, () => Math.floor(rand() * 3));
    const keys = new Int32Array(n), ops = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const u = rand();
      if (u < 0.01) { ops[i] = 3; keys[i] = rand() < 0.5 ? -1 : -2 - Math.floor(rand() * 3); }
      else { keys[i] = Math.floor(Math.pow(rand(), 2) * nKeys); ops[i] = u < 0.6 ? 0 : u < 0.9 ? 1 : 2; }
    }
    const c = T.lruCurve(keys, ops, nKeys, keyDb);
    for (let size = 1; size <= nKeys; size++) {
      const cache = new Map();
      let hits = 0;
      for (let i = 0; i < n; i++) {
        const k = keys[i], op = ops[i];
        if (op === 3) { for (const x of Array.from(cache.keys())) if (k === -1 || keyDb[x] === -2 - k) cache.delete(x); continue; }
        if (op === 0 && cache.has(k)) hits++;
        cache.delete(k);
        if (op === 2) continue;
        cache.set(k, true);
        if (cache.size > size) cache.delete(cache.keys().next().value);
      }
      assert.equal(c.hits(size), hits, `round ${round}, size ${size}`);
    }
  }
});

test('slot ranges for a new cluster match --cluster create', () => {
  assert.deepEqual(T.evenSplit(3), [[0, 5460], [5461, 10922], [10923, 16383]]);
  assert.deepEqual(T.evenSplit(1), [[0, 16383]]);
  const six = T.evenSplit(6);
  assert.equal(six.length, 6);
  assert.equal(six[5][1], 16383);
  for (let i = 1; i < six.length; i++) assert.equal(six[i][0], six[i - 1][1] + 1);
});

test('the command line reads a capture', () => {
  const cli = path.join(__dirname, '..', 'cli.js');
  const out = spawnSync(process.execPath, [cli, path.join(FIX, 'redis-7.2.16.txt'), '--json'], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  const j = JSON.parse(out.stdout);
  const { steps } = replay('redis-7.2.16', read('redis-7.2.16.txt'));
  assert.equal(j.commands, steps.length);
  assert.ok(j.curve.points.length > 2);
  const csv = spawnSync(process.execPath, [cli, path.join(FIX, 'redis-7.2.16.txt'), '--keys'], { encoding: 'utf8' });
  assert.equal(csv.status, 0, csv.stderr);
  assert.equal(csv.stdout.trim().split('\n').length, j.keys.distinct + 1);
});
