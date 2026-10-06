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

const bytes = (s) => Uint8Array.from(Buffer.from(s, 'latin1'));
const fileOf = (lines) => lines.map((l) => l + '\n').join('');
// Checks the short file of a checked file: it starts unless the original stops
// after reading the file, and every setting ends up the same, except one whose
// last line is left as a comment.
function shortFileAgrees(r, id, opts) {
  const short = C.minimal(r).join('\n') + '\n';
  const r2 = C.check(short, id, opts);
  const out = [];
  if (!r2.ok && !r.problems.some((p) => p.line === null)) out.push('the short file stops at ' + r2.error.line + ': ' + r2.error.message);
  const commented = (k) => r.setBy.has(k) && r.lines[r.setBy.get(k)[r.setBy.get(k).length - 1] - 1].status === 'error';
  for (const [k, v] of r.values) if (r2.values.get(k) !== v && !commented(k)) out.push(k + ' = ' + JSON.stringify(v) + ', short file ' + JSON.stringify(r2.values.get(k)));
  return out;
}

for (const [id, rec] of Object.entries(data.versions)) {
  test(id + ': every recorded file reads the way the server read it', () => {
    const problems = R.replay(id, rec);
    const shown = problems.slice(0, 10).map((p) => p.name + ': ' + p.problem).join('\n');
    assert.equal(problems.length, 0, problems.length + ' differences, such as:\n' + shown);
  });
  test(id + ': the short file of each recorded file gives the same settings', () => {
    // Each batch's whole file, the lines the server stopped at included, and every single case.
    const files = rec.batches.map((b) => fileOf(b.lines)).concat(rec.cases.map((c) => (c.raw !== undefined ? c.raw : fileOf(c.lines))));
    const problems = [];
    for (const file of files) {
      for (const p of shortFileAgrees(C.check(bytes(file), id, { tls: rec.tls }), id, { tls: rec.tls })) problems.push(p + ' in ' + JSON.stringify(file.slice(0, 120)));
    }
    assert.equal(problems.length, 0, problems.length + ' differences, such as:\n' + problems.slice(0, 5).join('\n'));
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
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), '# The settings of ' + good + ' that differ from the defaults of Valkey 9.1.2.\nmaxmemory 1073741824\nmaxmemory-policy allkeys-lru');
  r = run(path.join(dir, 'missing.conf'));
  assert.equal(r.status, 2);
  r = run(good, '--server', 'redis 5');
  assert.equal(r.status, 2);
  fs.rmSync(dir, { recursive: true });
});

// ---- the short file ----

test('the short file writes multi-value settings the way Redis 6.2 reads them', () => {
  const file = 'bind 127.0.0.1 ::1\nslaveof 10.0.0.2 6379\nsave 900 1\nsave 300 10\nclient-output-buffer-limit normal 1mb 2mb 3\n' +
    'client-output-buffer-limit pubsub -1 0 0\noom-score-adj-values 0 300 900\n';
  const r = C.check(file, 'redis-6.2.24');
  assert.deepEqual(C.minimal(r), ['bind 127.0.0.1 ::1', 'replicaof 10.0.0.2 6379', 'save 900 1', 'save 300 10',
    'client-output-buffer-limit normal 1048576 2097152 3', 'client-output-buffer-limit pubsub -1 0 0', 'oom-score-adj-values 0 300 900']);
  assert.deepEqual(shortFileAgrees(r, 'redis-6.2.24'), []);
  // A save line with the pairs in one argument clears the defaults and adds nothing.
  assert.deepEqual(C.minimal(C.check('save "900 1 300 10"\n', 'redis-6.2.24')), ['save ""']);
  // From 7.0 one line takes several pairs, and a count that wrapped goes back as the number that wraps to it.
  const r7 = C.check(file + 'save 60 2147483648\n', 'redis-7.4.11');
  assert.ok(C.minimal(r7).includes('save 900 1 300 10 60 2147483648'), C.minimal(r7).join('\n'));
  assert.deepEqual(shortFileAgrees(r7, 'redis-7.4.11'), []);
});

test('the short file keeps every byte of a value, in every version', () => {
  const file = 'requirepass "p\\xffq w"\nmasterauth "\\x00\\x01\\x7f\\xef\\xbb\\xbf"\nsyslog-ident "caf\\xc3\\xa9"\ndbfilename "a \\"b\\".rdb"\n';
  for (const { id } of C.versions()) {
    const r = C.check(file, id);
    const lines = C.minimal(r);
    assert.ok(lines.includes('requirepass "p\\xffq w"'), id + ': ' + lines.join(' | '));
    assert.ok(lines.includes('syslog-ident café'), id + ': ' + lines.join(' | '));
    assert.deepEqual(shortFileAgrees(r, id), [], id);
    assert.equal(C.check(lines.join('\n'), id).values.get('requirepass'), 'p\xffq w', id);
  }
});

test('the short file keeps include, rename-command, user, loadmodule, dir and module lines in place', () => {
  const file = 'maxmemory 1gb\ninclude /etc/redis/base.conf\nmaxmemory 2gb\nhz 20\nloadmodule /opt/search.so\nsearch.timeout 500\n' +
    'rename-command KEYS ""\nuser alice on >pw ~* +@all\ndir /var/lib/redis\nport 7000\n';
  assert.deepEqual(C.minimal(C.check(file, 'valkey-9.1.2')), ['include /etc/redis/base.conf', 'maxmemory 2147483648', 'hz 20',
    'loadmodule /opt/search.so', 'search.timeout 500', 'rename-command KEYS ""', 'user alice on >pw ~* +@all', 'dir /var/lib/redis', 'port 7000']);
  // Redis 6.2 reads dir and cluster-config-file outside its table.
  assert.deepEqual(C.minimal(C.check('dir /data\ncluster-config-file n.conf\n', 'redis-6.2.24')), ['dir /data', 'cluster-config-file n.conf']);
});

test('the short file keeps the lines the server stops at as comments', () => {
  const mistakes = '# Typed in a hurry\nmaxmemory 2 gb\nmaxmemory-policy lru\nsave 900\nappendfsync everysecond\ntimeout -5\nhz 1000\nrequirepass "secret\ntcp-backlog 511 # the default\n';
  const lines = C.minimal(C.check(mistakes, 'redis-8.10.2'));
  assert.deepEqual(lines.slice(0, 2), ['# Line 2 stops Redis 8.10.2: wrong number of arguments', '# maxmemory 2 gb']);
  assert.ok(lines.includes('hz 500'));
  assert.ok(lines.includes('# Line 8 stops Redis 8.10.2: Unbalanced quotes in configuration line'));
  assert.ok(lines.includes('# requirepass "secret'));
  assert.equal(lines.filter((l) => !l.startsWith('#')).length, 1);
  // Reasons it stops after the last line come first; odd bytes in a comment show as \xHH.
  assert.deepEqual(C.minimal(C.check('foo.bar 1\nmaxmemory 1mb\n', 'valkey-9.1.2')), ['# Valkey 9.1.2 stops after reading the original file: no module takes foo.bar',
    '# Line 1 stops Valkey 9.1.2: A module\'s setting, and no module is loaded.', '# foo.bar 1', 'maxmemory 1048576']);
  assert.deepEqual(C.minimal(C.check(bytes('\xef\xbb\xbfmaxmemory 2gb\n'), 'redis-7.2.16')), ['# Line 1 stops Redis 7.2.16: Bad directive or wrong number of arguments', '# \\xef\\xbb\\xbfmaxmemory 2gb']);
});

test('from 7.0, each save line after an include starts the list again', () => {
  const file = 'save 900 1\ninclude /etc/redis/other.conf\nsave 300 10\nsave 60 5\n';
  assert.equal(C.check(file, 'redis-7.4.11').values.get('save'), '60 5');
  assert.equal(C.check(file, 'valkey-9.1.2').values.get('save'), '60 5');
  assert.equal(C.check(file, 'redis-6.2.24').values.get('save'), '900 1 300 10 60 5');
  assert.deepEqual(C.minimal(C.check(file, 'redis-7.4.11')), ['include /etc/redis/other.conf', 'save 60 5']);
});

test('quote() and visible() work on bytes', () => {
  assert.equal(C.quote('abc'), 'abc');
  assert.equal(C.quote(''), '""');
  assert.equal(C.quote('a b'), '"a b"');
  assert.equal(C.quote('p\xffq'), '"p\\xffq"');
  assert.equal(C.quote('#x'), '"#x"');
  assert.equal(C.quote('a"b\\c'), '"a\\"b\\\\c"');
  assert.equal(C.quote('\x00\t\x1b'), '"\\x00\\t\\x1b"');
  assert.equal(C.quote(C.toBinary('café')), C.toBinary('café'));
  assert.equal(C.quote('2gb', true), '"2gb"');
  // Every version reads a quoted value back as the same bytes.
  const odd = '\x00\x01 "\'\\\x7f\x80\xc3\xa9\xef\xbb\xbf\xff';
  for (const { id } of C.versions()) {
    const name = C.getVersion(id).byName.get('masterauth').name;
    assert.equal(C.check(bytes('masterauth ' + C.quote(odd) + '\n'), id).values.get(name), odd, id);
  }
  assert.equal(C.visible(C.toBinary('café')), 'café');
  assert.equal(C.visible('\xef\xbb\xbfx'), '\\xef\\xbb\\xbfx');
  assert.equal(C.visible('a\x1b[31mb\x9b'), 'a\\x1b[31mb\\x9b');
  assert.equal(C.visible('a\nb\r', '\n'), 'a\nb\\x0d');
  assert.equal(C.visible('\xc2\xa0'), '\\xc2\\xa0');
});

test('a file that starts with a byte order mark', () => {
  const withBom = bytes('\xef\xbb\xbfmaxmemory 2gb\n');
  const r = C.check(withBom, 'redis-7.2.16');
  assert.equal(r.error.line, 1);
  assert.equal(C.visible(r.error.output, '\n'), "\n*** FATAL CONFIG FILE ERROR (Redis 7.2.16) ***\nReading the configuration file, at line 1\n>>> '\\xef\\xbb\\xbfmaxmemory 2gb'\nBad directive or wrong number of arguments\n");
  // The page keeps the mark in the text, which gives the same answer as the bytes.
  const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(withBom);
  assert.equal(C.check(text, 'redis-7.2.16').error.output, r.error.output);
  assert.equal(C.check(text + '\n', 'redis-7.2.16').ok, false);
});

// ---- large inputs ----

test('large inputs take time in proportion to their size', () => {
  const timed = (f) => { const t = Date.now(); f(); return Date.now() - t; };
  // Each took from seconds to hours before.
  const nul = new Uint8Array(16 * 1024 * 1024).fill(65);
  for (let i = 0; i < nul.length; i += 1000) nul[i] = 0;
  assert.ok(timed(() => C.check(nul, 'redis-8.10.2')) < 3000, 'NUL bytes and no line break');
  const saves = Array.from({ length: 60000 }, (_, i) => 'save ' + (i + 1) + ' 1').join('\n');
  assert.ok(timed(() => C.check(saves, 'redis-8.10.2')) < 5000, '60,000 save lines');
  assert.ok(timed(() => C.check('maxmemory' + ' '.repeat(400000) + 'x\n', 'redis-8.10.2')) < 2000, 'spaces inside a line');
  assert.ok(timed(() => C.check('latency-tracking-info-percentiles ' + '1'.repeat(200000) + 'x\n', 'redis-8.10.2')) < 2000, 'digits that are not a number');
  const lines = Array.from({ length: 200000 }, (_, i) => 'x' + i).join('\n');
  assert.equal(C.parseConfigGet(lines).size, 100000);
});

// ---- CONFIG GET ----

const raw = (obj) => Object.entries(obj).map(([k, v]) => k + '\n' + v).join('\n') + '\n';
test('CONFIG GET: the build comes from the names unless the options say', () => {
  const b62 = data.versions['redis-6.2.24'].baseline;
  let g = C.readConfigGet(raw(b62), null);
  assert.equal(g.version, 'redis-6.2.24');
  assert.equal(g.tls, false);
  assert.ok(!g.missing.some((x) => x.name.startsWith('tls-')));
  g = C.readConfigGet(raw(b62), 'redis-6.2.24', { tls: true });
  assert.ok(g.missing.some((x) => x.name === 'tls-port'));
  const b810 = Object.assign({}, data.versions['redis-8.10.2'].baseline, { 'repl-compression': '0', 'repl-compression-max-latency': '100' });
  g = C.readConfigGet(raw(b810), 'redis-8.10.2');
  assert.equal(g.compression, true);
  assert.deepEqual(g.unknown, []);
  g = C.readConfigGet(raw(b810), 'redis-8.10.2', { compression: false });
  assert.deepEqual(g.unknown, ['repl-compression', 'repl-compression-max-latency']);
});

test('CONFIG GET: too little of it, or something else', () => {
  let g = C.readConfigGet('maxmemory\n1073741824\nmaxmemory-policy\nallkeys-lru\n', null);
  assert.equal(g.kind, 'partial');
  assert.equal(g.sure, false);
  assert.deepEqual(g.missing, []);
  assert.deepEqual(g.changed.map((x) => x.name).sort(), ['maxmemory', 'maxmemory-policy']);
  assert.equal(C.readConfigGet('hello world\nthis is not\nconfig get\noutput at all\n', null).kind, 'other');
  assert.equal(C.readConfigGet('maxmemory 2gb\nappendonly yes\nsave 900 1\n', null).kind, 'config-file');
  assert.equal(C.readConfigGet('# nothing\n', null).kind, 'none');
  assert.equal(C.readConfigGet(raw(data.versions['valkey-9.1.2'].baseline), null).kind, 'full');
});

// ---- files that aren't config files, and the report ----

test('binary files are named, text is not', () => {
  assert.match(C.sniff(bytes('REDIS0011\xfa\tredis-ver\x057.2.4')), /snapshot/);
  assert.match(C.sniff(bytes('VALKEY080\xfa')), /snapshot/);
  assert.match(C.sniff(bytes('*2\r\n$6\r\nSELECT\r\n$1\r\n0\r\n')), /append-only/);
  assert.match(C.sniff(bytes('\x1f\x8b\x08\x00')), /gzip/);
  assert.equal(C.sniff(Uint8Array.from({ length: 4096 }, (_, i) => (i * 7919) % 256)), 'a binary file');
  assert.equal(C.sniff(bytes('maxmemory 2gb\nrequirepass "a\x00b"\n# caf\xe9\n')), null);
  assert.equal(C.sniff('maxmemory 2gb\n'), null);
});

test('the report as JSON has every line, with its text', () => {
  const r = C.check('include /etc/x.conf\nmaxmemory 2 gb\nhz 20\n', 'redis-7.0.15', { tls: false });
  const rep = C.report(r);
  assert.deepEqual(rep.build, { tls: false, compression: false });
  assert.deepEqual(rep.lines.map((l) => [l.line, l.status, l.text]), [[1, 'unchecked', 'include /etc/x.conf'], [2, 'error', 'maxmemory 2 gb'], [3, 'ok', 'hz 20'], [4, 'ok', '']]);
  assert.deepEqual(rep.unchecked, [{ line: 1, name: null, message: 'include /etc/x.conf' }]);
  assert.deepEqual(rep.settings.hz, { value: '20', default: '10', lines: [3] });
});

test('the command line: short files, CONFIG GET and odd bytes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kvconfig-'));
  const cli = path.join(__dirname, '..', 'cli.js');
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'latin1' });
  const file = path.join(dir, 'redis.conf');
  fs.writeFileSync(file, 'slaveof 10.0.0.2 6379\nsave 900 1\nsave 300 10\nsyslog-ident "\\x1b]0;title\\x07"\nmaxmemory 2 gb\n');
  let r = run(file, '--minimal');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--minimal needs --server/);
  r = run(file, '--server', '6.2', '--minimal');
  assert.equal(r.status, 1);
  assert.deepEqual(r.stdout.trim().split('\n').slice(1), ['replicaof 10.0.0.2 6379', 'save 900 1', 'save 300 10', 'syslog-ident "\\x1b]0;title\\x07"',
    '# Line 5 stops Redis 6.2.24: wrong number of arguments', '# maxmemory 2 gb']);
  r = run(file, '--server', '7.2', '--minimal', '--json');
  const short = JSON.parse(r.stdout);
  assert.equal(short.version, 'redis-7.2.16');
  assert.equal(short.lines[2], 'syslog-ident "\\x1b]0;title\\x07"');
  // Nothing from the file reaches the terminal as a control byte.
  for (const args of [[file, '--server', '7.2'], [file], [file, '--server', '7.2', '--json']]) {
    r = run(...args);
    assert.ok(!/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(r.stdout), args.join(' ') + ': ' + JSON.stringify(r.stdout.slice(0, 200)));
  }
  // CONFIG GET with the build options, and text that isn't CONFIG GET output.
  const get = path.join(dir, 'config.txt');
  fs.writeFileSync(get, raw(data.versions['redis-6.2.24'].baseline));
  r = run('--get', get);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Redis 6\.2\.24 built without TLS/);
  assert.doesNotMatch(r.stdout, /tls-port/);
  r = run('--get', get, '--server', '6.2', '--json');
  assert.equal(JSON.parse(r.stdout).build.tls, false);
  fs.writeFileSync(get, 'maxmemory\n0\n');
  r = run('--get', get);
  assert.match(r.stdout, /Too few settings to tell the version/);
  assert.match(r.stdout, /It has its default/);
  r = run('--get', file);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /looks like a config file/);
  const rdb = path.join(dir, 'dump.rdb');
  fs.writeFileSync(rdb, Buffer.from('REDIS0011\xfa\tredis-ver', 'latin1'));
  r = run(rdb);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /snapshot/);
  fs.rmSync(dir, { recursive: true });
});
