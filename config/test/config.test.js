// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// The Config Checker against what 15 real servers did with about 69,000
// config files (fixtures/runs.json.gz, recorded by generate/record.py),
// and the parts that don't come from a server.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const C = require('../config.js');
const R = require('./replay.js');

const data = R.load();

for (const [id, rec] of Object.entries(data.versions)) {
  test(id + ': every recorded file reads the way the server read it', () => {
    const problems = R.replay(id, rec);
    const shown = problems.slice(0, 10).map((p) => p.name + ': ' + p.problem).join('\n');
    assert.equal(problems.length, 0, problems.length + ' differences, such as:\n' + shown);
  });
}

test('all 15 versions are recorded', () => {
  assert.deepEqual(Object.keys(data.versions).sort(), C.versions().map((v) => v.id).sort());
});

test('versions are found by loose names', () => {
  assert.equal(C.findVersion('valkey 9.1'), 'valkey-9.1.2');
  assert.equal(C.findVersion('Redis 7.2.16'), 'redis-7.2.16');
  assert.equal(C.findVersion('redis-8'), 'redis-8.10.2');
  assert.equal(C.findVersion('6.2'), 'redis-6.2.24');
  assert.equal(C.findVersion('valkey 5'), null);
  assert.equal(C.findVersion('nonsense'), null);
});

test('the error is the one the server prints, with the line', () => {
  const r = C.check('maxmemory 100mb\nmaxmemory-policy allkeys-lru\nappendfsync sometimes\n', 'valkey-9.1.2');
  assert.equal(r.ok, false);
  assert.equal(r.error.line, 3);
  assert.equal(r.error.output, "\n*** FATAL CONFIG FILE ERROR (Version 9.1.2) ***\nReading the configuration file, at line 3\n>>> 'appendfsync sometimes'\nargument(s) must be one of the following: everysec, always, no\n");
  const old = C.check('appendfsync sometimes\n', 'redis-6.2.24');
  assert.match(old.error.output, /\(Redis 6\.2\.24\)/);
  assert.match(old.error.output, /argument must be one of the following: everysec, always, no/);
});

test('every problem is listed, each as if the ones before were fixed', () => {
  const r = C.check('port 70000\nhz 20\nmaxmemory lots\nhz 30\n', 'redis-8.10.2');
  assert.deepEqual(r.problems.map((p) => p.line), [1, 3]);
  assert.equal(r.values.get('hz'), '30');
  assert.deepEqual(r.setBy.get('hz'), [2, 4]);
});

test('values read as CONFIG GET shows them', () => {
  const r = C.check('maxmemory 2gb\nmaxmemory-clients 10%\nsave 900 1\nsave 300 10\nnotify-keyspace-events KEA\nunixsocketperm 700\nslave-read-only no\n', 'valkey-8.1.10');
  assert.equal(r.values.get('maxmemory'), '2147483648');
  assert.equal(r.values.get('maxmemory-clients'), '10%');
  assert.equal(r.values.get('save'), '900 1 300 10');
  assert.equal(r.values.get('notify-keyspace-events'), 'AKE');
  assert.equal(r.values.get('unixsocketperm'), '700');
  assert.equal(r.values.get('replica-read-only'), 'no');
  assert.equal(r.defaults.get('maxmemory'), '0');
});

test('bytes and text both work, and bytes stay bytes', () => {
  const bytes = Uint8Array.from(Buffer.from('syslog-ident "caf\\xc3\\xa9"\n', 'latin1'));
  const r = C.check(bytes, 'redis-7.4.11');
  assert.equal(C.fromBinary(r.values.get('syslog-ident')), 'café');
  const t = C.check('syslog-ident café\n', 'redis-7.4.11');
  assert.equal(t.values.get('syslog-ident'), r.values.get('syslog-ident'));
});

test('lines split the way each version splits them', () => {
  assert.deepEqual(C.splitArgs('a "b c" \'d\\\'e\' "\\x41\\n"'), ['a', 'b c', "d'e", 'A\n']);
  assert.equal(C.splitArgs('"abc"def'), null);
  assert.equal(C.check('syslog-ident "abc"def\n', 'redis-8.10.2').ok, false);
  assert.equal(C.check('syslog-ident "abc"def\n', 'valkey-9.1.2').values.get('syslog-ident'), 'abcdef');
});

test('module settings and a server that stops while starting', () => {
  const r = C.check('foo.bar 1\n', 'valkey-9.1.2');
  assert.equal(r.ok, false);
  assert.equal(r.error.startup, true);
  assert.deepEqual(r.error.log, ['Unused Module Configuration: foo.bar', 'Module Configuration detected without loadmodule directive or no ApplyConfig call: aborting']);
  assert.equal(C.check('loadmodule /x.so\nfoo.bar 1\n', 'valkey-9.1.2').ok, true);
  assert.equal(C.check('bogus 1\n', 'redis-8.10.2').error.startup, true);
  assert.equal(C.check('bogus 1\n', 'redis-7.4.11').error.message, 'Bad directive or wrong number of arguments');
});

test('advice: the risky settings come first', () => {
  const r = C.check('protected-mode no\nbind 0.0.0.0\nsave ""\nappendonly no\nenable-debug-command yes\nrename-command FLUSHALL ""\n', 'redis-7.2.16');
  const codes = C.advise(r).map((f) => f.code);
  assert.equal(codes[0], 'open');
  assert.ok(codes.includes('no-persistence'));
  assert.ok(codes.includes('enable-debug-command'));
  assert.ok(codes.includes('renamed'));
  const quiet = C.advise(C.check('requirepass ' + 'x'.repeat(40) + '\nmaxmemory 1gb\nmaxmemory-policy allkeys-lru\n', 'valkey-9.1.2'));
  assert.ok(!quiet.some((f) => f.level === 'bad'));
});

test('the minimal file keeps what changes something, with current names', () => {
  const r = C.check('# a comment\nslave-read-only no\nmaxmemory 0\nhz 10\nport 6380\nrename-command KEYS ""\n', 'redis-8.10.2');
  assert.deepEqual(C.minimal(r), ['replica-read-only no', 'port 6380', 'rename-command KEYS ""']);
});

test('CONFIG GET output: raw, numbered and quoted', () => {
  const raw = 'maxmemory\n1073741824\nmaxmemory-policy\nallkeys-lru\nsave\n\n';
  assert.equal(C.parseConfigGet(raw).get('maxmemory-policy'), 'allkeys-lru');
  assert.equal(C.parseConfigGet(raw).get('save'), '');
  const numbered = '1) "maxmemory"\n2) "1073741824"\n3) "save"\n4) ""\n5) "dir"\n6) "/var/lib/redis"\n';
  const m = C.parseConfigGet(numbered);
  assert.equal(m.get('save'), '');
  assert.equal(m.get('dir'), '/var/lib/redis');
  const cmp = C.compareConfigGet(m, 'redis-7.2.16');
  assert.equal(cmp.rows.find((x) => x.name === 'maxmemory').changed, true);
  assert.equal(cmp.rows.find((x) => x.name === 'save').changed, true);
});

test('CONFIG GET * output says which version it came from', () => {
  // Some versions have exactly the same settings (Redis 7.2.16 and Valkey
  // 7.2.14, say); then any of them is a right answer.
  for (const [id, rec] of Object.entries(data.versions)) {
    const map = new Map(Object.entries(rec.baseline));
    const guess = C.guessVersion(map);
    const cmp = C.compareConfigGet(map, guess, { tls: rec.tls });
    assert.deepEqual(cmp.unknown, [], id + ' guessed as ' + guess);
    // The recordings leave out dir and unixsocket, which say where the test ran.
    const missing = cmp.rows.filter((x) => x.value === null && !x.hidden && x.name !== 'dir' && x.name !== 'unixsocket');
    assert.deepEqual(missing.map((x) => x.name), [], id + ' guessed as ' + guess);
  }
  const v91 = new Map(Object.entries(data.versions['valkey-9.1.2'].baseline));
  assert.equal(C.guessVersion(v91), 'valkey-9.1.2');
});

test('the command line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kvconfig-'));
  const good = path.join(dir, 'good.conf'), bad = path.join(dir, 'bad.conf');
  fs.writeFileSync(good, 'maxmemory 1gb\nmaxmemory-policy allkeys-lru\n');
  fs.writeFileSync(bad, 'maxmemory 1gb\nmaxmemory-policy most-recent\n');
  const cli = path.join(__dirname, '..', 'cli.js');
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  let r = run(good, '--server', 'valkey-9.1');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /the server starts/);
  r = run(bad, '--server', 'redis 8.10');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FATAL CONFIG FILE ERROR \(Redis 8\.10\.2\)/);
  r = run(bad);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /Valkey 9\.1\.2 +stops at line 2/);
  r = run(good, '--server', '8', '--json');
  assert.equal(JSON.parse(r.stdout).starts, true);
  r = run(good, '--server', 'valkey 9', '--minimal');
  assert.equal(r.stdout.trim(), 'maxmemory 1073741824\nmaxmemory-policy allkeys-lru');
  r = run(path.join(dir, 'missing.conf'));
  assert.equal(r.status, 2);
  r = run(good, '--server', 'redis 5');
  assert.equal(r.status, 2);
  fs.rmSync(dir, { recursive: true });
});
