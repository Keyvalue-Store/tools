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

// ---- what the fixes after the first review cover ----

// The command line, with files in a folder of their own.
function cli() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kvacl-'));
  const file = (name, content) => { const p = path.join(dir, name); fs.writeFileSync(p, content); return p; };
  const run = (args, input) => spawnSync(process.execPath, [path.join(__dirname, '..', 'cli.js'), ...args], { encoding: 'utf8', input: input });
  return { file: file, run: run, done: () => fs.rmSync(dir, { recursive: true }) };
}

test('check with several users: each is checked, or the one --user names', () => {
  const c = cli();
  const acl = c.file('users.acl', 'user default off\nuser alice on nopass ~app:* +@read\nuser bob on nopass ~* +@all\n');
  let r = c.run(['check', '--file', acl, '--', 'FLUSHALL']);
  assert.equal(r.status, 1, 'refused for some users');
  assert.match(r.stdout, /^User default:\nDENIED {3}FLUSHALL/m);
  assert.match(r.stdout, /^User alice:\nDENIED {3}FLUSHALL/m);
  assert.match(r.stdout, /^User bob:\nallowed {2}FLUSHALL/m);
  r = c.run(['check', '--file', acl, '--', 'GET', 'app:1']);
  assert.equal(r.status, 1, 'default is off and may run nothing');
  r = c.run(['check', '--file', acl, '--user', 'bob', '--', 'FLUSHALL']);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.stdout.trim(), 'allowed  FLUSHALL');
  r = c.run(['check', '--file', acl, '--user', 'carol', '--', 'FLUSHALL']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /has no user carol\. Its users: default, alice, bob\./);
  r = c.run(['check', '--file', acl, '--json', '--', 'GET', 'app:1']);
  const j = JSON.parse(r.stdout);
  assert.deepEqual(j.checks.map((x) => [x.user, x.allowed]), [['default', false], ['alice', true], ['bob', true]]);
  // Config files too; the default user only when asked for.
  const conf = c.file('redis.conf', 'port 6379\nuser alice on nopass ~app:* +@read\nuser bob on nopass ~* +@all\n');
  r = c.run(['check', '--config', conf, '--', 'GET', 'app:1']);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /User alice:\nallowed {2}GET app:1\n\nUser bob:\nallowed {2}GET app:1/);
  r = c.run(['check', '--config', conf, '--user', 'default', '--', 'FLUSHALL']);
  assert.equal(r.status, 0, r.stdout);
  r = c.run(['check', '--config', c.file('empty.conf', 'port 6379\n'), '--', 'GET', 'k']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no user to check/);
  r = c.run(['check', 'on', 'nopass', '--user', 'bob', '--', 'GET', 'k']);
  assert.equal(r.status, 2);
  c.done();
});

test('MONITOR lines from IPv6 clients, unix sockets and scripts', () => {
  // As the servers print them (checked with Redis 8.10 and Valkey 9.1); IPv6
  // peers are [address]:port in every version.
  const e = A.parseMonitor([
    '1791293386.428309 [0 [::1]:52310] "SET" "a:1" "x"',
    '1791293386.431136 [2 unix:/run/redis/redis.sock] "EVAL" "redis.call(\'SET\',\'user:1\',\'x\')" "0"',
    '1791293386.431195 [2 lua] "SET" "user:1" "x"',
    '+1791293386.431203 [0 [fe80::1%eth0]:6000] "GET" "user:2"',
    '1791293386.5 [0 /tmp/a] b.sock] "PING"'
  ].join('\r\n'));
  assert.deepEqual(e.map((x) => [x.client, x.db, x.argv[0]]), [['[::1]:52310', 0, 'SET'], ['unix:/run/redis/redis.sock', 2, 'EVAL'], ['lua', 2, 'SET'], ['[fe80::1%eth0]:6000', 0, 'GET'], ['/tmp/a] b.sock', 0, 'PING']]);
  const r = A.build(e, 'redis-8.10.2');
  assert.deepEqual(r.commands.map((c) => c.command), ['EVAL', 'GET', 'PING', 'SET']);
  assert.ok(r.check.every((c) => c.allowed));
});

test('a client\'s draft takes the commands its scripts ran', () => {
  // MONITOR prints EVAL and FCALL before the commands the script runs.
  const e = A.parseMonitor([
    '1.1 [0 10.0.0.7:1] "EVAL" "redis.call(\'SET\', KEYS[1], \'x\')" "1" "user:1"',
    '1.2 [0 lua] "SET" "user:1" "x"',
    '1.3 [0 10.0.0.9:2] "GET" "other:1"',
    '1.4 [0 lua] "INCR" "user:count"',
    '1.5 [0 10.0.0.9:2] "FCALL" "f" "1" "jobs:1"',
    '1.6 [0 lua] "LPUSH" "jobs:1" "x"',
    '1.7 [0 10.0.0.7:1] "GET" "user:2"'
  ].join('\n'));
  const mine = A.build(e, 'redis-8.10.2', { client: '10.0.0.7:1' });
  assert.deepEqual(mine.commands.map((c) => c.command), ['EVAL', 'GET', 'INCR', 'SET']);
  assert.ok(mine.check.every((c) => c.allowed), 'the script\'s SET is allowed');
  const theirs = A.build(e, 'redis-8.10.2', { client: '10.0.0.9:2' });
  assert.deepEqual(theirs.commands.map((c) => c.command), ['FCALL', 'GET', 'LPUSH']);
});

test('drafts from lines with too few arguments, and empty command lines', () => {
  const r = A.build(A.parseMonitor('SELECT\nGET k\n'), 'redis-8.10.2');
  assert.deepEqual(r.skipped.map((s) => s.reason), ['wrong number of arguments']);
  assert.deepEqual(r.args.slice(-2), ['-@all', '+get']);
  assert.equal(A.check(A.defaultUser('redis-8.10.2'), [], 'redis-8.10.2').allowed, false);
  const c = cli();
  const s = c.file('s.txt', 'SELECT\nGET k\n');
  const out = c.run(['build', s]);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /1 line skipped: line 1 \(wrong number of arguments\)/);
  c.done();
});

test('the command line reads files, arguments and stdin as bytes', () => {
  const c = cli();
  const sha = (s) => require('crypto').createHash('sha256').update(s).digest('hex');
  const line = 'user alice on >päss ~café:* +@all\n';
  for (const opt of ['--config', '--file']) {
    const r = c.run(['explain', opt, c.file('u' + opt.slice(2), line)]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp('#' + sha('päss') + ' ~café:\\* '));
  }
  const cmds = c.file('f.txt', 'GET café:1\n');
  let r = c.run(['check', 'on', 'nopass', '~café:*', '+@all', '--commands', cmds]);
  assert.equal(r.status, 0, r.stdout);
  r = c.run(['check', 'on', 'nopass', '~café:*', '+@all', '--commands', cmds, '--json']);
  assert.deepEqual(JSON.parse(r.stdout).checks[0].command, ['GET', 'café:1']);
  const mon = c.file('m.txt', '1.1 [0 10.0.0.7:1] "GET" "user:42"\n');
  r = c.run(['build', mon, '--password', 'pässwörd', '--name', 'jörg', '--json']);
  const j = JSON.parse(r.stdout);
  assert.equal(j.args[2], '>pässwörd');
  assert.equal(j.name, 'jörg');
  assert.equal(j.aclfile, 'user jörg on #' + sha('pässwörd') + ' %R~user:42 resetchannels -@all +get');
  r = c.run(['build', mon, '--password', 'a€b']);
  assert.match(r.stdout, /">a\\xe2\\x82\\xacb"/);
  r = c.run(['explain', 'on', 'bögus', '--json']);
  assert.equal(JSON.parse(r.stdout).error, 'Error in ACL SETUSER modifier \'bögus\': Syntax error');
  // stdin once: a declared default user is there.
  r = c.run(['explain', '--file', '-'], 'user default on nopass ~* +@all\nuser app on nopass ~app:* +get\n');
  assert.match(r.stdout, /^user default on nopass/m);
  assert.match(r.stdout, /^user app on nopass/m);
  // A file can't send escape sequences to the terminal.
  r = c.run(['explain', '--file', c.file('esc.acl', 'user \x1b[31mbob on nopass\n')]);
  assert.ok(!r.stdout.includes('\x1b'));
  assert.match(r.stdout, /user \\x1b\[31mbob on nopass/);
  c.done();
});

test('config lines: acl-pubsub-default, aclfile and lines the server can\'t read', () => {
  // The messages as Redis 6.2, 7.0, 7.2 and 8.10 and Valkey 8.0 and 9.1 print them.
  const fatal = (text, id) => { const r = A.loadConfig(text, id); return r.fatal && [r.fatal.line, r.fatal.message]; };
  const pattern = 'Adding a pattern after the * pattern (or the \'allchannels\' flag) is not valid and does not have any effect. Try \'resetchannels\' to start with an empty list of channels';
  assert.deepEqual(fatal('acl-pubsub-default allchannels\nuser alice on nopass &chat +@all ~*\n', 'redis-7.2.16'), [2, 'Error in user declaration \'on\': ' + pattern]);
  assert.deepEqual(fatal('acl-pubsub-default allchannels\nuser alice on nopass &chat +@all ~*\n', 'redis-6.2.24'), [2, 'Error in user declaration \'&chat\': ' + pattern]);
  // Set after the user line: the line passes, and the server stops at startup.
  const late = A.loadConfig('user alice on nopass &chat +@all ~*\nacl-pubsub-default allchannels\n', 'valkey-9.1.2');
  assert.equal(late.fatal, null);
  assert.deepEqual(late.startup.log, ['Error loading ACL rule \'&chat\' for the user named \'alice\': ' + pattern, 'Critical error while loading ACLs. Exiting.']);
  assert.deepEqual(fatal('user alice on ">pw ~* +@all\n', 'redis-8.10.2'), [1, 'Unbalanced quotes in configuration line']);
  assert.deepEqual(fatal('port 6379\nrequirepass "x\n', 'redis-8.10.2'), [2, 'Unbalanced quotes in configuration line']);
  assert.deepEqual(fatal('user alice on\nuser alice off\n', 'redis-7.0.15'), [2, 'Error in user declaration \'alice\': Duplicate user found. A user can only be defined once in config files']);
  assert.equal(fatal('user alice on\nuser alice off\n', 'redis-6.2.24'), null);
  assert.deepEqual(fatal('acl-pubsub-default foo\n', 'redis-6.2.24'), [1, 'argument must be one of the following: allchannels, resetchannels']);
  assert.deepEqual(fatal('acl-pubsub-default foo\n', 'valkey-8.0.11'), [1, 'argument(s) must be one of the following: allchannels, resetchannels']);
  assert.deepEqual(fatal('acl-pubsub-default allchannels resetchannels\n', 'redis-7.2.16'), [1, 'wrong number of arguments']);
  assert.deepEqual(fatal('user\n', 'redis-8.10.2'), [1, 'Bad directive or wrong number of arguments']);
  assert.deepEqual(fatal('\xef\xbb\xbfuser alice on\n', 'redis-8.10.2'), [1, 'Bad directive or wrong number of arguments']);
  const both = (id) => A.loadConfig('user alice on nopass ~* +@all\naclfile /etc/users.acl\n', id).startup.message;
  assert.match(both('redis-8.10.2'), /^Configuring Redis with users defined in redis\.conf and at the same setting an ACL file path is invalid\./);
  assert.match(both('valkey-7.2.14'), /^Configuring Redis with users defined in redis\.conf/);
  assert.match(both('valkey-9.1.2'), /^Configuring Valkey with users defined in valkey\.conf .* directly in your valkey\.conf, but not both\.$/);
  assert.equal(A.loadConfig('user alice on\naclfile ""\n', 'redis-8.10.2').startup, null);
  const ok = A.loadConfig('acl-pubsub-default allchannels\nuser a on nopass ~* +@all\nuser b off\n', 'redis-8.10.2');
  assert.deepEqual(ok.users.map((u) => u.name), ['a', 'b']);
  assert.equal(ok.users[0].selectors[0].allchannels, true);
  // The command line and the kind readRules works out.
  assert.equal(A.readRules('acl-pubsub-default allchannels\nuser alice on &chat\n', 'redis-8.10.2').kind, 'config');
  const c = cli();
  let r = c.run(['explain', '--config', c.file('p.conf', 'acl-pubsub-default allchannels\nuser alice on nopass &chat +@all ~*\n'), '--server', '7.2']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /p\.conf:2: Redis 7\.2\.16 stops reading the file:\n {2}>>> 'user alice on nopass &chat \+@all ~\*'\n {2}Error in user declaration 'on'/);
  r = c.run(['explain', '--config', c.file('q.conf', 'user alice on ">pw ~* +@all\n')]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /Unbalanced quotes in configuration line/);
  c.done();
});

test('a byte order mark stays, and shows', () => {
  const file = new Uint8Array(Buffer.from('\ufeffuser default off\nuser alice on nopass ~* +@all\n'));
  const read = A.readRules(file, 'redis-8.10.2');
  assert.equal(read.kind, 'aclfile');
  const r = A.loadFile(read.text, 'redis-8.10.2');
  assert.equal(r.ok, false);
  assert.match(r.error, /^users\.acl:1 should start with user keyword followed by the username\./);
  assert.deepEqual(r.where, [{ line: 1, text: '\xef\xbb\xbfuser default off' }]);
  assert.equal(A.readable(r.where[0].text), '\\xef\\xbb\\xbfuser default off');
  // What readable() keeps and what it escapes.
  assert.equal(A.readable(b('café ☕ 日本')), 'café ☕ 日本');
  assert.equal(A.readable('a\x1b[0m\x00\x7f'), 'a\\x1b[0m\\x00\\x7f');
  assert.equal(A.readable('caf\xe9 \xc3'), 'caf\\xe9 \\xc3');
  assert.equal(A.readable(b('a\u202eb\u00adc')), 'a\\xe2\\x80\\xaeb\\xc2\\xadc');
  assert.equal(A.readable('\xed\xa0\x80'), '\\xed\\xa0\\x80');
  const c = cli();
  const out = c.run(['explain', '--file', c.file('bom.acl', Buffer.from(file))]);
  assert.equal(out.status, 1);
  assert.match(out.stdout, /Line 1: \\xef\\xbb\\xbfuser default off/);
  c.done();
});

test('large inputs: deep patterns, many keys, long lines', () => {
  // Redis 7.0 follows a * pattern as deep as it goes (it matched 50,000
  // levels and crashed at about 87,000); the others stop at 1000 levels.
  const deep = (n, id) => {
    const u = A.setUser(null, 'u', ['on', 'nopass', '~' + '*a'.repeat(n), '+get'], id).user;
    return A.check(u, ['GET', 'a'.repeat(n)], id);
  };
  assert.equal(deep(20000, 'redis-7.0.15').allowed, true);
  assert.equal(deep(20000, 'redis-7.2.16').allowed, false);
  const crash = deep(90000, 'redis-7.0.15');
  assert.equal(crash.reason, 'crash');
  assert.match(crash.crash, /stack overflow/);
  assert.equal(A.globMatch('*a'.repeat(20000), 'a'.repeat(20000) + 'b', false), false);
  // Patterns without wildcards are found by name; one pattern still has to
  // carry both permissions a command needs.
  const split = A.setUser(null, 'u', ['on', 'nopass', '%R~a', '%W~\\a', '+@all'], 'redis-8.10.2').user;
  assert.equal(A.check(split, ['GET', 'a'], 'redis-8.10.2').allowed, true);
  assert.equal(A.check(split, ['SET', 'a', '1'], 'redis-8.10.2').allowed, true);
  assert.equal(A.check(split, ['GETSET', 'a', '1'], 'redis-8.10.2').allowed, false);
  // 30,000 keys with no separator: quick, and a note that it's a long list.
  const lines = [];
  for (let i = 0; i < 30000; i++) lines.push(['GET', 'key' + i]);
  const t = Date.now();
  const r = A.build(lines, 'redis-8.10.2', { keys: 'exact' });
  assert.ok(Date.now() - t < 20000, 'took ' + (Date.now() - t) + ' ms');
  assert.equal(r.keys.length, 30000);
  assert.equal(r.manyPatterns, 30000);
  assert.ok(r.check.every((c) => c.allowed));
  // A long file of NULs with no newline: each piece of it is dropped.
  const t2 = Date.now();
  assert.equal(A.loadFile('user a on' + '\0'.repeat(20000000), 'redis-8.10.2').ok, true);
  assert.ok(Date.now() - t2 < 3000, 'took ' + (Date.now() - t2) + ' ms');
});

test('the ACL file line of a draft with no password', () => {
  const r = A.build([['GET', 'k']], 'redis-8.10.2');
  assert.equal(r.placeholder, true);
  assert.equal(r.aclfile, 'user app on #<sha256-of-your-password> %R~k resetchannels -@all +get');
  // ACL LOAD refuses it (Redis 6.2 and 7.2 and Valkey 9.1 do the same).
  for (const id of ['redis-6.2.24', 'redis-8.10.2', 'valkey-9.1.2']) {
    assert.match(A.loadFile(r.aclfile + '\n', id).error, /users\.acl:1: The password hash must be exactly 64 characters and contain only lowercase hexadecimal characters/, id);
  }
  const p = A.build([['GET', 'k']], 'redis-8.10.2', { password: 's3cret' });
  assert.equal(p.placeholder, false);
  assert.equal(p.aclfile, 'user app on #' + A.sha256hex('s3cret') + ' %R~k resetchannels -@all +get');
});

test('rules as people write them: a password hash on its own line', () => {
  const hash = A.sha256hex('password');
  const r = A.readRules('ACL SETUSER app on\n# a comment\n#' + hash + '\n~app:* +get', 'redis-8.10.2');
  assert.deepEqual(r.users[0], { name: 'app', args: ['on', '#' + hash, '~app:*', '+get'], line: 1 });
});

test('the command line refuses what it can\'t read', () => {
  const c = cli();
  const two = (args, re) => { const r = c.run(args); assert.equal(r.status, 2, args.join(' ') + ': ' + r.stdout + r.stderr); if (re) assert.match(r.stderr, re); };
  two(['explain', 'on', '--nmae', 'x'], /Unknown option --nmae/);
  two(['keys'], /Give a command/);
  two(['check', 'on', 'nopass', '+@all', '--'], /Give a command after --/);
  two(['check', 'on', 'nopass', '+@all'], /Give a command after --/);
  two(['check', 'on', '--db', 'abc', '--', 'GET', 'k'], /--db takes a database number/);
  two(['explain', 'on', '--pubsub-default', 'nope'], /--pubsub-default takes allchannels or resetchannels/);
  two(['explain', 'on', '--file', 'x.acl']);
  two(['build'], /Give a file of MONITOR output/);
  const mon = c.file('m.txt', '1.1 [0 10.0.0.7:1] "GET" "k"\n');
  two(['build', mon, '--client', '10.0.0.8:1'], /No line comes from 10\.0\.0\.8:1\. The clients: 10\.0\.0\.7:1\./);
  two(['build', mon, '--client', 'lua'], /lua isn't a client/);
  two(['explain', '--file', c.file('nosuch.dir', '') + '/x']);
  // An argument the server takes as one rule stays one: a password with a space.
  let r = c.run(['explain', '>pass word']);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, new RegExp('#' + A.sha256hex('pass word') + ' '));
  r = c.run(['explain', 'on nopass ~app:* +@read']);
  assert.match(r.stdout, /^user user on nopass sanitize-payload ~app:\* resetchannels -@all \+@read$/m);
  r = c.run(['explain', 'ACL SETUSER web on nopass', '--name', 'api']);
  assert.match(r.stdout, /^user api on nopass/m);
  c.done();
});
