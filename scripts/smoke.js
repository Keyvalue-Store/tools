// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Checks an unpacked release before it goes out: every tool's command line
// starts and prints its help, and the tools that take text get real work
// with answers known in advance. It runs the same on Linux, macOS and
// Windows, with the Node.js that runs it.
//
// Usage: node scripts/smoke.js PATH/TO/keyvaluestore-tools
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = process.argv[2];
if (!dir || !fs.existsSync(path.join(dir, 'package.json'))) {
  console.error('Give the path of the unpacked keyvaluestore-tools folder.');
  process.exit(2);
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kv-smoke-'));
let failed = 0;

function run(tool, args, input) {
  const r = spawnSync(process.execPath, [path.join(dir, tool, 'cli.js'), ...args], {
    input: input || '', encoding: 'utf8', timeout: 60000,
  });
  return { status: r.status, out: r.stdout || '', err: (r.stderr || '') + (r.error ? String(r.error) : '') };
}

function check(name, ok, r) {
  if (ok) {
    console.log('ok    ' + name);
  } else {
    failed++;
    console.log('FAIL  ' + name + ' (exit ' + r.status + ')\n' + r.out + r.err);
  }
}

// Every tool in the package starts and prints its help.
const tools = fs.readdirSync(dir).filter((t) => fs.existsSync(path.join(dir, t, 'cli.js'))).sort();
if (tools.length === 0) {
  console.error('No tools in ' + dir);
  process.exit(1);
}
for (const tool of tools) {
  const r = run(tool, ['--help']);
  check(tool + ' --help', r.status === 0 && r.out.includes('Usage'), r);
  for (const file of ['README.md', 'app/index.html']) {
    const ok = fs.existsSync(path.join(dir, tool, file));
    check(tool + ' has ' + file, ok, { status: '-', out: '', err: '' });
  }
}

// Real work, with known answers.
let r = run('slots', ['foo', '--json']);
check('slots: foo is in slot 12182', r.status === 0 && /"slot":\s*12182/.test(r.out), r);

r = run('slots', ['--check', 'MGET a b']);
check('slots: MGET a b is CROSSSLOT', r.status === 1 && r.out.includes('CROSSSLOT'), r);

r = run('typed-json', ['--compact'], '{"id":{"S":"7"},"n":{"N":"12345678901234567890.5"}}');
check('typed-json: every digit kept', r.status === 0 && r.out.includes('{"id":"7","n":12345678901234567890.5}'), r);

r = run('keyspace', ['-', '--json'], 'user:1\nuser:2\nuser:3\nsession:abc\n');
check('keyspace: user:<id> found', r.status === 0 && r.out.includes('"user:<id>"'), r);

r = run('memory', ['1000 strings key=24 value=100', '--json']);
check('memory: an estimate for 1000 strings', r.status === 0 && /"keys":\s*1000/.test(r.out), r);

const conf = path.join(tmp, 'redis.conf');
fs.writeFileSync(conf, 'port 6379\nmaxmemory 1gb\n');
r = run('config', [conf, '--server', 'valkey-9.1']);
check('config: maxmemory 1gb read as 1073741824', r.status === 0 && r.out.includes('1073741824'), r);

r = run('acl', ['check', 'on', 'nopass', '~app:*', '+@read', '--', 'SET', 'app:1', 'x']);
check('acl: SET denied to a read-only user', r.status === 1 && r.out.includes('NOPERM'), r);

r = run('graph', ['walk', '-', '--from', 'alice'], 'alice follows bob\nbob follows carol\n');
check('graph: alice reaches carol in 2 hops', r.status === 0 && r.out.includes('carol'), r);

r = run('pipe', ['commands', '-'], 'SET a 1\n');
check('pipe: SET a 1 as protocol', r.status === 0 && r.out.includes('*3\r\n$3\r\nSET\r\n$1\r\na\r\n$1\r\n1\r\n'), r);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? '\n' + failed + ' failed' : '\nall ' + tools.length + ' tools passed');
process.exit(failed ? 1 : 0);
