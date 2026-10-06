// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// The ACL Builder against what 15 real servers did (fixtures/runs.json.gz,
// recorded by generate/record.py): ACL SETUSER and ACL LIST, ACL DRYRUN,
// commands queued in MULTI, COMMAND GETKEYSANDFLAGS, ACL LOAD and user
// lines in config files. Then the parts that don't come from a server.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const A = require('../acl.js');
const R = require('./replay.js');

const data = R.load();
const b = (s) => A.toBinary(s);

for (const [id, rec] of Object.entries(data)) {
  test(id + ': every recorded case comes out the way the server did it', () => {
    const d = R.differences(id, rec);
    const all = Object.entries(d).flatMap(([kind, list]) => list.map((x) => kind + ': ' + x));
    assert.equal(all.length, 0, all.length + ' differences, such as:\n' + all.slice(0, 8).join('\n'));
    for (const kind of ['setuser', 'aclfile', 'config', 'getkeys', 'multi']) assert.ok(rec[kind] && rec[kind].length, kind + ' was recorded');
    if (!id.startsWith('redis-6.')) assert.ok(rec.dryrun && rec.dryrun.length, 'dryrun was recorded');
  });
}

test('all 15 versions are recorded', () => {
  assert.deepEqual(Object.keys(data).sort(), A.versions().map((v) => v.id).sort());
});

test('versions are found by loose names', () => {
  assert.equal(A.findVersion('valkey 9.1'), 'valkey-9.1.2');
  assert.equal(A.findVersion('Redis 7.2.16'), 'redis-7.2.16');
  assert.equal(A.findVersion('redis-8'), 'redis-8.10.2');
  assert.equal(A.findVersion('6.2'), 'redis-6.2.24');
  assert.equal(A.findVersion('nonsense'), null);
});

test('ACL SETUSER: all the rules or none, with the server\'s error', () => {
  const ok = A.setUser(null, 'app', ['on', '>secret', '~app:*', '%R~cache:*', '&events:*', '-@all', '+@read', '-keys', '+set'], 'redis-7.2.16');
  assert.equal(ok.ok, true);
  assert.equal(A.listLine(ok.user, 'redis-7.2.16').line,
    'user app on sanitize-payload #2bb80d537b1da3e38bd30361aa855686bde0eacd7162fef6a25fe97bf527a25b ~app:* %R~cache:* resetchannels &events:* -@all +@read -keys +set');
  const bad = A.setUser(ok.user, 'app', ['+get', '%X~a'], 'redis-7.2.16');
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'Error in ACL SETUSER modifier \'%X~a\': Syntax error');
  // Redis 6.2: no %R~, and a new user may already use every channel.
  assert.equal(A.setUser(null, 'app', ['&news'], 'redis-6.2.24').error,
    'Error in ACL SETUSER modifier \'&news\': Adding a pattern after the * pattern (or the \'allchannels\' flag) is not valid and does not have any effect. Try \'resetchannels\' to start with an empty list of channels');
  assert.equal(A.setUser(null, 'a b', [], 'valkey-9.1.2').error, 'Usernames can\'t contain spaces or null characters');
  assert.equal(A.setUser(null, 'x', ['(+get', '~a'], 'valkey-9.1.2').error, 'Unmatched parenthesis in acl selector starting at \'(+get\'.');
});

test('selectors and Valkey 9.1 databases', () => {
  const r = A.setUser(null, 'x', ['on', 'nopass', '~a:*', '+get', '(~b:* +set)', 'db=0,2'], 'valkey-9.1.2');
  assert.equal(A.listLine(r.user, 'valkey-9.1.2').line, 'user x on nopass ~a:* resetchannels db=0,2 -@all +get (~b:* resetchannels -@all +set)');
  const u = r.user;
  assert.equal(A.check(u, ['GET', 'a:1'].map(b), 'valkey-9.1.2').allowed, true);
  assert.equal(A.check(u, ['SET', 'b:1', 'x'].map(b), 'valkey-9.1.2').selector, 1);
  // Selector 1 has every database but not GET: the command is the reason given.
  assert.equal(A.check(u, ['GET', 'a:1'].map(b), 'valkey-9.1.2', { db: 1 }).reason, 'command');
  const one = A.setUser(null, 'x', ['on', 'nopass', '~*', '+@all', 'db=0'], 'valkey-9.1.2').user;
  const deniedDb = A.check(one, ['GET', 'a:1'].map(b), 'valkey-9.1.2', { db: 1 });
  assert.equal(deniedDb.reason, 'db');
  assert.equal(deniedDb.reply.error, 'NOPERM No permissions to access database');
  assert.equal(deniedDb.dryrun.reply, 'User x has no permissions to access database GET');
  assert.equal(A.check(one, ['SELECT', '3'].map(b), 'valkey-9.1.2').dryrun.reply, 'User x has no permissions to access database 3');
  assert.equal(A.setUser(null, 'x', ['db=2147483648'], 'valkey-9.1.2').error, 'Error in ACL SETUSER modifier \'db=2147483648\': The provided database ID is out of range');
  assert.equal(A.setUser(null, 'x', ['db=1'], 'valkey-9.0.6').error, 'Error in ACL SETUSER modifier \'db=1\': Syntax error');
});

test('ACL DRYRUN and NOPERM, per version', () => {
  const rules = ['on', 'nopass', '%R~cache:*', '+@all'];
  const want = {
    'redis-6.2.24': [null, 'NOPERM this user has no permissions to access one of the keys used as arguments'],
    'redis-7.0.15': ['This user has no permissions to access the \'cache:x\' key', 'NOPERM this user has no permissions to access one of the keys used as arguments'],
    'redis-7.2.16': ['User u has no permissions to access the \'cache:x\' key', 'NOPERM No permissions to access a key'],
    'valkey-9.1.2': ['User u has no permissions to access the \'cache:x\' key', 'NOPERM No permissions to access a key']
  };
  for (const [id, [dry, noperm]] of Object.entries(want)) {
    const r = A.setUser(null, 'u', id === 'redis-6.2.24' ? ['on', 'nopass', '~cache:*', '+@all', '-set'] : rules, id);
    const c = A.check(r.user, ['SET', 'cache:x', '1'].map(b), id);
    assert.equal(c.allowed, false, id);
    if (dry) assert.equal(c.dryrun.reply, dry, id);
    else assert.equal(c.dryrun, null);
    assert.equal(c.reply.error, id === 'redis-6.2.24' ? 'NOPERM this user has no permissions to run the \'set\' command or its subcommand' : noperm, id);
    assert.equal(A.check(r.user, ['GET', 'cache:x'].map(b), id).allowed, true, id);
  }
});

test('keys and their flags, as COMMAND GETKEYSANDFLAGS gives them', () => {
  assert.deepEqual(A.getKeys(['SET', 'k', 'v', 'GET'].map(b), 'redis-8.10.2').keys, [['k', ['RW', 'access', 'update']]]);
  assert.deepEqual(A.getKeys(['SORT', 'k', 'BY', 'w', 'STORE', 'd'].map(b), 'redis-8.10.2').keys, [['k', ['RO', 'access']], ['d', ['OW', 'update']]]);
  assert.deepEqual(A.getKeys(['EVAL', 's', '2', 'a', 'b', 'c'].map(b), 'valkey-9.1.2').keys, [['a', ['RW', 'access', 'update']], ['b', ['RW', 'access', 'update']]]);
  assert.deepEqual(A.getKeys(['XREAD', 'COUNT', '2', 'STREAMS', 's1', 's2', '0', '0'].map(b), 'redis-6.2.24').keys.map((k) => k[0]), ['s1', 's2']);
  assert.equal(A.getKeys(['PING'].map(b), 'redis-8.10.2').error, 'The command has no key arguments');
});

test('ACL LIST crashes the server for some first arguments', () => {
  const r = A.setUser(null, 'x', ['+select|a b'], 'redis-7.2.16');
  assert.equal(r.ok, true);
  assert.ok(A.listLine(r.user, 'redis-7.2.16').crash);
  // 6.2 and 7.0 work their rules out from the bitmap and don't crash.
  assert.ok(A.listLine(A.setUser(null, 'x', ['+select|a b'], 'redis-7.0.15').user, 'redis-7.0.15').line);
  const e = A.explain(r.user, 'redis-7.2.16');
  assert.ok(e.warnings.some((w) => w.code === 'crash'));
});

test('ACL files and config lines', () => {
  const file = 'user default off\nuser app on nopass ~app:* +@read\n';
  const r = A.loadFile(file, 'redis-8.10.2');
  assert.equal(r.ok, true);
  assert.equal(A.listLine(r.users.get('app'), 'redis-8.10.2').line, 'user app on nopass sanitize-payload ~app:* resetchannels -@all +@read');
  const bad = A.loadFile('user app on +nosuch\nuser app off\nhello\n', 'redis-8.10.2', { filename: '/etc/redis/users.acl' });
  assert.equal(bad.error, '/etc/redis/users.acl:1: Error in applying operation \'+nosuch\': Unknown command or category name in ACL. WARNING: Duplicate user \'app\' found on line 2. /etc/redis/users.acl:3 should start with user keyword followed by the username. WARNING: ACL errors detected, no change to the previously active ACL rules was performed');
  // Redis 8.8 and later skip comments.
  assert.equal(A.loadFile('# users\nuser a on\n', 'redis-8.8.3').ok, true);
  assert.equal(A.loadFile('# users\nuser a on\n', 'redis-8.6.7').ok, false);
  // From 7.0 the server names the wrong word by its place among the rules.
  assert.equal(A.checkUserLine(['user', 'alice', 'on', 'bogus'].map(b), 'redis-7.2.16'), 'Error in user declaration \'alice\': Syntax error');
  assert.equal(A.checkUserLine(['user', 'alice', 'on', 'bogus'].map(b), 'redis-6.2.24'), 'Error in user declaration \'bogus\': Syntax error');
  assert.equal(A.checkUserLine(['user', 'alice', '+nosuch'].map(b), 'redis-7.2.16'), null);
  assert.deepEqual(A.startupUsers([['user', 'alice', '+nosuch'].map(b)], 'redis-7.2.16').log,
    ['Error loading ACL rule \'+nosuch\' for the user named \'alice\': Unknown command or category name in ACL', 'Critical error while loading ACLs. Exiting.']);
});

test('the Config Checker checks user lines with this library', () => {
  const C = require('../../config/config.js');
  const r = C.check('user alice on >pw ~* +@all\nuser bob on nopass +nosuchcmd\n', 'redis-7.2.16');
  assert.equal(r.ok, false);
  assert.equal(r.error.startup, true);
  assert.match(r.error.output, /Error loading ACL rule '\+nosuchcmd' for the user named 'bob'/);
  const f = C.check('acl-pubsub-default allchannels\nuser alice &chat\n', 'valkey-9.1.2');
  assert.equal(f.error.line, 2);
  assert.match(f.error.message, /Adding a pattern after the \* pattern/);
});

test('rules as people write them', () => {
  const id = 'redis-8.10.2';
  assert.deepEqual(A.readRules('ACL SETUSER app on ">two words" ~x', id).users[0], { name: 'app', args: ['on', '>two words', '~x'], line: 1 });
  const file = A.readRules('user a on\nuser b off\n', id);
  assert.equal(file.kind, 'aclfile');
  assert.deepEqual(file.users.map((u) => u.name), ['a', 'b']);
  assert.equal(A.readRules('user a on ">x y"\n', id).kind, 'config');
});

test('explain: login, rules and warnings', () => {
  const id = 'redis-8.10.2';
  const u = A.setUser(null, 'ops', ['on', 'nopass', '~*', '+@all', '-@dangerous', '+config|set'], id).user;
  const e = A.explain(u, id);
  assert.equal(e.login.state, 'nopass');
  assert.deepEqual(e.selectors[0].rules.map((r) => r.rule), ['+@all', '-@dangerous', '+config|set']);
  assert.ok(e.warnings.some((w) => w.code === 'nopass' && w.level === 'bad'));
  const ro = A.explain(A.setUser(null, 'ro', ['on', '>x', '%R~*', '-@all', '+@read', '-keys'], id).user, id);
  assert.equal(ro.login.state, 'on');
  assert.equal(ro.selectors[0].keys[0].access, 'read');
  assert.ok(!ro.warnings.some((w) => w.level === 'bad'));
});

test('MONITOR output and the least a client needs', () => {
  const text = [
    'OK',
    '1759734012.305002 [0 10.0.0.7:52310] "GET" "user:42:profile"',
    '1759734012.306118 [0 10.0.0.7:52310] "EXPIRE" "session:9f2c1e" "1800"',
    '1759734012.307550 [0 10.0.0.7:52310] "GET" "user:77:profile"',
    '1759734012.309322 [0 10.0.0.7:52310] "PUBLISH" "events:login" "42"',
    '1759734012.401220 [3 10.0.0.9:41002] "LPUSH" "jobs:email" "{\\"to\\":42}\\x00"',
    'GET plain'
  ].join('\n');
  const entries = A.parseMonitor(text);
  assert.equal(entries.length, 6);
  assert.deepEqual(entries[4].argv, ['LPUSH', 'jobs:email', '{"to":42}\0']);
  assert.equal(entries[4].db, 3);
  for (const id of A.versions().map((v) => v.id)) {
    const r = A.build(entries, id, { name: 'web' });
    assert.equal(r.error, null, id);
    assert.ok(r.check.length === 6 && r.check.every((c) => c.allowed), id + ' allows every line');
    const u = A.setUser(null, 'web', r.args, id).user;
    assert.equal(A.check(u, ['GET', 'other'].map(b), id).allowed, false, id + ' allows nothing else');
    assert.equal(A.check(u, ['DEL', 'user:42:profile'].map(b), id).allowed, false, id);
  }
  const r = A.build(entries, 'redis-8.10.2', { name: 'web' });
  assert.deepEqual(r.keys, ['%W~jobs:email', '%R~plain', '%W~session:9f2c1e', '%R~user:*']);
  assert.deepEqual(r.channels, ['&events:login']);
  assert.match(r.setuser, /^ACL SETUSER web reset on >CHANGE-ME /);
  assert.equal(A.build(entries, 'valkey-9.1.2').args.includes('db=0,3'), true);
});

test('glob patterns match the way the server matches them', () => {
  const m = (p, s) => A.globMatch(b(p), b(s), true);
  assert.equal(m('user:*', 'user:1'), true);
  assert.equal(m('user:?', 'user:10'), false);
  assert.equal(m('[a-c]x', 'bx'), true);
  assert.equal(m('[^a]x', 'ax'), false);
  assert.equal(m('a\\*', 'a*'), true);
  assert.equal(m('a\\*', 'ab'), false);
  assert.equal(m('[c-a]', 'b'), true);
  assert.equal(m('a[', 'a['), false);
});

test('SHA-256 of passwords', () => {
  assert.equal(A.sha256hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(A.sha256hex(b('secret')), '2bb80d537b1da3e38bd30361aa855686bde0eacd7162fef6a25fe97bf527a25b');
  assert.equal(A.sha256hex('x'.repeat(200)), require('crypto').createHash('sha256').update('x'.repeat(200)).digest('hex'));
});

test('the command line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kvacl-'));
  const cli = path.join(__dirname, '..', 'cli.js');
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  let r = run('explain', 'on', '>pw', '~app:*', '+@read', '--server', 'valkey-9.1');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /user user on #/);
  r = run('explain', 'on bogus', '--server', '8');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /Error in ACL SETUSER modifier 'bogus': Syntax error/);
  r = run('check', 'on nopass ~app:* +@read', '--', 'GET', 'app:1');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  r = run('check', 'on nopass ~app:* +@read', '--', 'SET', 'app:1', 'x');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /NOPERM User user has no permissions to run the 'set' command/);
  const mon = path.join(dir, 'monitor.txt');
  fs.writeFileSync(mon, '1759734012.305002 [0 10.0.0.7:52310] "GET" "user:42"\n1759734012.305003 [0 10.0.0.7:52310] "SET" "user:43" "x"\n');
  r = run('build', mon, '--name', 'web', '--json');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).args, ['reset', 'on', '>CHANGE-ME', '~user:*', 'resetchannels', '-@all', '+get', '+set']);
  const acl = path.join(dir, 'users.acl');
  fs.writeFileSync(acl, 'user app on nopass ~* +@all\nuser bad on nosuchthing\n');
  r = run('explain', '--file', acl);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /:2: Syntax error/);
  r = run('keys', 'MSET', 'a', '1', 'b', '2', '--server', '7.2');
  assert.equal(r.stdout.trim(), 'a  OW update\nb  OW update');
  r = run('explain', '--server', 'redis 5', 'on');
  assert.equal(r.status, 2);
  fs.rmSync(dir, { recursive: true });
});
