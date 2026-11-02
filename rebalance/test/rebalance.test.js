// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Tests for the Cluster Rebalancing Planner. The fixture holds real clusters
// recorded by test/generate/record.py: CLUSTER NODES before each step, the
// planner's script run against the cluster, and CLUSTER NODES after it. The
// replay tests check that the planner, given the same input today, asks for
// exactly the ownership the real cluster ended with. Run with: node --test

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync, spawnSync } = require('node:child_process');
const R = require('../rebalance.js');

const ID = (c) => c.repeat(40);
const line = (c, port, flags, primary, slots) =>
  `${ID(c)} 10.0.0.${port % 100}:${port}@${port + 10000} ${flags} ${primary ? ID(primary) : '-'} 0 0 1 connected${slots ? ' ' + slots : ''}`;
const THREE_PLUS_EMPTY = [
  line('a', 7001, 'myself,master', null, '0-5460'),
  line('b', 7002, 'master', null, '5461-10922'),
  line('c', 7003, 'master', null, '10923-16383'),
  line('d', 7004, 'master', null, ''),
  line('e', 7005, 'slave', 'a', ''),
  line('f', 7006, 'slave', 'b', ''),
  line('9', 7007, 'slave', 'c', '')
].join('\n');

function owners(nodesText) {
  const own = new Array(R.SLOTS).fill(null);
  for (const n of R.parseClusterNodes(nodesText).nodes) if (n.primary) for (const [a, b] of n.ranges) for (let s = a; s <= b; s++) own[s] = n.id;
  return own;
}
function ranges(p, id) { return R.rangesOf(p.owner.map((o, s) => o === id ? s : -1).filter((s) => s >= 0)); }

test('parses every field and slot form of CLUSTER NODES', () => {
  const text = [
    `${ID('a')} 10.0.0.1:6379@16379,cache-1.example myself,master - 0 1726238317239 3 connected 0-100 200 [300->-${ID('b')}] [301-<-${ID('c')}]`,
    `${ID('b')} :0@0 master,noaddr - 1726238317000 1726238317239 4 disconnected`,
    `${ID('c')} 10.0.0.3:6379@16379 slave,fail? ${ID('a')} 0 0 3 connected`,
    `${ID('d')} 10.0.0.4:6379@16379 replica ${ID('a')} 0 0 3 connected`,
    `${ID('e')} 10.0.0.5:6379@16379 master,fail,nofailover - 0 0 5 connected`
  ].join('\n');
  const { nodes, errors } = R.parseClusterNodes(text);
  assert.deepEqual(errors, []);
  const [a, b, c, d, e] = nodes;
  assert.equal(a.host, '10.0.0.1'); assert.equal(a.port, 6379); assert.equal(a.cport, 16379); assert.equal(a.hostname, 'cache-1.example');
  assert.ok(a.myself && a.primary && !a.replica);
  assert.equal(a.configEpoch, 3);
  assert.deepEqual(a.ranges, [[0, 100], [200, 200]]);
  assert.deepEqual(a.migrating, [{ slot: 300, to: ID('b') }]);
  assert.deepEqual(a.importing, [{ slot: 301, from: ID('c') }]);
  assert.ok(b.noaddr && !b.connected);
  assert.ok(c.replica && c.suspect && c.primaryId === ID('a'));
  assert.ok(d.replica);
  assert.ok(e.failed && e.flags.includes('nofailover'));
});

test('reports lines it cannot read, with the line number', () => {
  const bad = [
    'not a node line',
    `${ID('a').slice(1)} 10.0.0.1:1@2 master - 0 0 1 connected`,
    `${ID('a')} 10.0.0.1 master - 0 0 1 connected`,
    `${ID('a')} 10.0.0.1:1@2 boss - 0 0 1 connected`,
    `${ID('a')} 10.0.0.1:1@2 master xyz 0 0 1 connected`,
    `${ID('a')} 10.0.0.1:1@2 master - 0 0 1 sleeping`,
    `${ID('a')} 10.0.0.1:1@2 master - 0 0 1 connected 5-3`,
    `${ID('a')} 10.0.0.1:1@2 master - 0 0 1 connected 16384`,
    `${ID('a')} 10.0.0.1:1@2 master - 0 0 1 connected [5->-zz]`
  ];
  bad.forEach((l, i) => {
    const r = R.parseClusterNodes('# comment\n\n' + l);
    assert.equal(r.errors.length, 1, l);
    assert.equal(r.errors[0].line, 3, l);
  });
  const dup = R.parseClusterNodes(line('a', 1, 'master', null, '0-16383') + '\n' + line('a', 2, 'master', null, ''));
  assert.match(dup.errors[0].message, /appears twice/);
});

test('refuses uncovered slots, open slots, failed and address-less primaries', () => {
  const cases = [
    [[line('a', 1, 'master', null, '0-16000')], 'uncovered', /383 slots have no owner \(the first is 16001\)/],
    [[line('a', 1, 'master', null, `0-16383 [7->-${ID('b')}]`), line('b', 2, 'master', null, '')], 'open-slot', /STABLE/],
    [[line('a', 1, 'master', null, '0-16383'), line('b', 2, 'master', null, `[7-<-${ID('a')}]`)], 'open-slot', /importing/],
    [[line('a', 1, 'master', null, '0-8000'), line('b', 2, 'master,fail', null, '8001-16383')], 'failed', /fail/],
    [[line('a', 1, 'master', null, '0-8000'), line('b', 2, 'master,fail?', null, '8001-16383')], 'failed', /fail\?/],
    [[line('a', 1, 'master', null, '0-16383'), `${ID('b')} :0@0 master,noaddr - 0 0 1 connected`], 'noaddr', /no usable address/],
    [[line('a', 1, 'master', null, '0-9000'), line('b', 2, 'master', null, '9000-16383')], 'double-owner', /9000/],
    [[line('a', 1, 'master', null, '0-16383'), line('b', 2, 'slave', 'a', '5')], 'replica-slots', /not a primary/]
  ];
  for (const [lines, code, msg] of cases) {
    const p = R.plan(R.parseClusterNodes(lines.join('\n')));
    const hit = p.problems.find((x) => x.code === code);
    assert.ok(hit, code + ' expected, got ' + JSON.stringify(p.problems));
    assert.match(hit.message + ' ' + hit.fix, msg);
    assert.equal(p.moves.length, 0);
  }
  const uncovered = R.plan(R.parseClusterNodes(line('a', 1, 'master', null, '1-16383')));
  assert.match(uncovered.problems[0].fix, /--cluster fix/);
});

test('refuses unknown or ambiguous node ids and replicas in options', () => {
  const c = R.parseClusterNodes(THREE_PLUS_EMPTY);
  assert.match(R.plan(c, { drain: ['10.0.0.9:9'] }).problems[0].message, /no node 10.0.0.9:9/);
  assert.match(R.plan(c, { weights: { eeeeee: 2 } }).problems[0].message, /replica/);
  assert.match(R.plan(c, { drain: ['abc'] }).problems[0].message, /no node abc/);
  const twins = R.parseClusterNodes([`${'ab'.repeat(3)}${'0'.repeat(34)} 1.1.1.1:1@2 master - 0 0 1 connected 0-8191`,
    `${'ab'.repeat(3)}${'1'.repeat(34)} 1.1.1.2:1@2 master - 0 0 1 connected 8192-16383`].join('\n'));
  assert.match(R.plan(twins, { drain: ['ababab'] }).problems[0].message, /more than one/);
  assert.match(R.plan(c, { drain: [ID('a'), ID('b'), ID('c'), ID('d')] }).problems[0].message, /weight 0/);
});

test('balances slot counts onto an empty primary with contiguous runs from range ends', () => {
  const c = R.parseClusterNodes(THREE_PLUS_EMPTY);
  const p = R.plan(c);
  assert.deepEqual(p.problems, []);
  assert.deepEqual(p.before.map((x) => x.slots), [5461, 5462, 5461, 0]);
  assert.deepEqual(p.after.map((x) => x.slots), [4096, 4096, 4096, 4096]);
  assert.equal(p.movedSlots, 4096);
  assert.equal(p.moves.length, 3);
  for (const m of p.moves) { assert.equal(m.to, ID('d')); assert.equal(m.ranges.length, 1); }
  assert.deepEqual(ranges(p, ID('a')), [[0, 4095]]);
  assert.deepEqual(ranges(p, ID('b')), [[5461, 9556]]);
  assert.deepEqual(ranges(p, ID('c')), [[10923, 15018]]);
  assert.deepEqual(ranges(p, ID('d')), [[4096, 5460], [9557, 10922], [15019, 16383]]);
});

test('targets use the largest remainder, so they always add up to 16384', () => {
  for (let n = 1; n <= 12; n++) {
    const lines = [];
    for (let i = 0; i < n; i++) lines.push(`${(i + 1).toString(16).padStart(40, '0')} 10.0.1.${i}:7000@17000 master - 0 0 1 connected${i === 0 ? ' 0-16383' : ''}`);
    const p = R.plan(R.parseClusterNodes(lines.join('\n')));
    const t = p.before.map((x) => x.target);
    assert.equal(t.reduce((a, b) => a + b, 0), 16384);
    assert.ok(Math.max(...t) - Math.min(...t) <= 1);
    assert.deepEqual(p.after.map((x) => x.slots), t);
  }
});

test('weights and drain', () => {
  const c = R.parseClusterNodes(THREE_PLUS_EMPTY);
  const w = R.plan(c, { weights: { '10.0.0.4:7004': 2 } });
  assert.deepEqual(w.after.map((x) => x.slots), [3277, 3277, 3277, 6553]);
  const d = R.plan(c, { drain: ['bbbbbb'] });
  assert.deepEqual(d.after.map((x) => x.slots), [5462, 0, 5461, 5461]);
  assert.ok(d.moves.every((m) => m.from === ID('b')));
  const both = R.plan(c, { drain: [ID('c')], weights: { [ID('d')]: 0.5 } });
  assert.deepEqual(both.after.map((x) => x.slots), [6554, 6553, 0, 3277]);
});

test('threshold leaves a nearly balanced cluster alone', () => {
  const near = R.parseClusterNodes([line('a', 1, 'master', null, '0-8299'), line('b', 2, 'master', null, '8300-16383')].join('\n'));
  const p = R.plan(near);
  assert.ok(p.balanced);
  assert.equal(p.moves.length, 0);
  const strict = R.plan(near, { threshold: 1 });
  assert.ok(!strict.balanced);
  assert.deepEqual(strict.after.map((x) => x.slots), [8192, 8192]);
  assert.deepEqual(strict.moves[0].ranges, [[8192, 8299]]);
});

test('a cap on slots moved stops early and says so', () => {
  const p = R.plan(R.parseClusterNodes(THREE_PLUS_EMPTY), { maxSlots: 100 });
  assert.equal(p.movedSlots, 100);
  assert.ok(p.capped);
  assert.equal(p.after.reduce((a, x) => a + x.slots, 0), 16384);
});

test('byte balance follows the load, not the slot count', () => {
  const c = R.parseClusterNodes(THREE_PLUS_EMPTY);
  const load = new Float64Array(R.SLOTS).fill(1);
  for (let s = 0; s < 1000; s++) load[s] = 20;
  const p = R.plan(c, { load });
  const total = load.reduce((a, b) => a + b, 0);
  assert.equal(p.total, total);
  const share = total / 4;
  for (const x of p.after) assert.ok(Math.abs(x.load - share) <= 20, x.node + ' ' + x.load + ' vs ' + share);
  // The primary holding the heavy slots keeps far fewer slots than the others.
  assert.ok(p.after[0].slots < p.after[1].slots / 2);
  // Moved load adds up.
  assert.equal(p.movedLoad, p.moves.reduce((a, m) => a + m.load, 0));
});

test('a donor keeps a slot that would leave it further below target than above', () => {
  const c = R.parseClusterNodes([line('a', 1, 'master', null, '0-8191'), line('b', 2, 'master', null, '8192-16383')].join('\n'));
  const load = new Float64Array(R.SLOTS);
  load[8191] = 100; load[0] = 10; load[9000] = 70;
  const p = R.plan(c, { load, threshold: 0 });
  // Target 90 each. Giving slot 8191 (100) would leave a 80 short where it
  // is 20 over now, so it stays; slot 0 (10) goes instead.
  assert.deepEqual(p.after.map((x) => x.load), [100, 80]);
  assert.deepEqual(p.moves.map((m) => m.ranges), [[[0, 0]]]);
});

test('reads slot loads and key sizes', () => {
  const s = R.parseSlotLoad('# slot bytes\n5,100\n6 50\n10-13 400\n');
  assert.equal(s.errors.length, 0);
  assert.equal(s.load[5], 100); assert.equal(s.load[6], 50); assert.equal(s.load[12], 100);
  assert.equal(R.parseSlotLoad('16384,1').errors.length, 1);
  assert.equal(R.parseSlotLoad('abc').errors[0].line, 1);
  const k = R.parseKeySizes('user:1 10\n20 user:2\n"a b",5\n"\\x41{t}" 7\n{t}x 3\nbad\n');
  assert.equal(k.keys, 5);
  assert.equal(k.errors.length, 1);
  assert.equal(k.load[R.keySlot('user:1')], 10);
  assert.equal(k.load[R.keySlot('user:2')], 20);
  assert.equal(k.load[R.keySlot('a b')], 5);
  assert.equal(k.load[R.keySlot('t')], 10);
});

test('key slots match the Hash Slot Calculator', () => {
  const S = require('../../slots/slots.js');
  for (const k of ['somekey', 'foo{hash_tag}', '{user1000}.following', 'foo{}{bar}', 'foo{{bar}}zap', '', 'ü€']) assert.equal(R.keySlot(k), S.keySlot(k), k);
});

test('the script quotes hosts, walks every range and updates every primary', () => {
  const c = R.parseClusterNodes(THREE_PLUS_EMPTY);
  const p = R.plan(c);
  const sh = R.script(c, p, { cli: 'valkey-cli', batch: 50 });
  assert.match(sh, /^#!\/bin\/sh\n/);
  assert.match(sh, /CLI=\$\{CLI:-valkey-cli\}/);
  assert.match(sh, /BATCH=\$\{BATCH:-50\}/);
  assert.match(sh, /setslots "\$1" "\$2" IMPORTING "\$5" \| on_node "\$6" "\$7"/);
  assert.match(sh, /setslots "\$1" "\$2" MIGRATING "\$8" \| on_node "\$3" "\$4"/);
  assert.match(sh, /CLUSTER GETKEYSINSLOT "\$1" "\$BATCH"/);
  assert.match(sh, /MIGRATE "\$4" "\$5" "" 0 "\$TIMEOUT" KEYS/);
  assert.match(sh, /PRIMARIES='10\.0\.0\.1 7001 10\.0\.0\.2 7002 10\.0\.0\.3 7003 10\.0\.0\.4 7004'/);
  assert.ok(sh.includes("move_range 4096 5460 '10.0.0.1' 7001 " + ID('a') + " '10.0.0.4' 7004 " + ID('d')));
  assert.equal((sh.match(/^move_range /gm) || []).length, 3);
  const r = spawnSync('sh', ['-n'], { input: sh });
  assert.equal(r.status, 0, String(r.stderr));
  const odd = R.parseClusterNodes(`${ID('a')} it's:1@2 master - 0 0 1 connected 0-16382\n${ID('b')} b:2@3 master - 0 0 1 connected 16383`);
  const p2 = R.plan(odd, { drain: [ID('b')] });
  assert.match(R.script(odd, p2), /move_range 16383 16383 'b' 2 /);
  assert.match(R.script(odd, R.plan(odd, { drain: [ID('a')] })), /'it'\\''s'/);
});

test('the command line plans, writes the script and sets the exit status', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'kvrebal-'));
  const cli = path.join(__dirname, '..', 'cli.js');
  fs.writeFileSync(path.join(dir, 'nodes.txt'), THREE_PLUS_EMPTY);
  const out = execFileSync('node', [cli, path.join(dir, 'nodes.txt'), '--script', path.join(dir, 'plan.sh')], { encoding: 'utf8' });
  assert.match(out, /Move 1365 slots from 10\.0\.0\.1:7001 to 10\.0\.0\.4:7004: 4096-5460/);
  assert.match(out, /In all 4096 slots/);
  assert.ok(fs.statSync(path.join(dir, 'plan.sh')).mode & 0o100);
  const json = JSON.parse(execFileSync('node', [cli, path.join(dir, 'nodes.txt'), '--json', '--drain', '10.0.0.2:7002'], { encoding: 'utf8' }));
  assert.equal(json.movedSlots, 5462);
  fs.writeFileSync(path.join(dir, 'open.txt'), THREE_PLUS_EMPTY.replace('0-5460', `0-5460 [5->-${ID('d')}]`));
  const open = spawnSync('node', [cli, path.join(dir, 'open.txt'), '--script', path.join(dir, 'no.sh')], { encoding: 'utf8' });
  assert.equal(open.status, 1);
  assert.match(open.stdout, /Not safe: slot 5 is migrating/);
  assert.ok(!fs.existsSync(path.join(dir, 'no.sh')));
  assert.equal(spawnSync('node', [cli, path.join(dir, 'nodes.txt'), '--weight', 'x'], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync('node', [cli, path.join(dir, 'nodes.txt'), '--bogus'], { encoding: 'utf8' }).status, 2);
  fs.writeFileSync(path.join(dir, 'bad.txt'), 'nonsense');
  assert.equal(spawnSync('node', [cli, path.join(dir, 'bad.txt')], { encoding: 'utf8' }).status, 2);
  fs.rmSync(dir, { recursive: true });
});

const FIXTURE = path.join(__dirname, 'fixtures', 'clusters.json.gz');
const recorded = fs.existsSync(FIXTURE) ? JSON.parse(zlib.gunzipSync(fs.readFileSync(FIXTURE))) : [];

test('the fixture covers several Redis and Valkey versions', () => {
  assert.ok(recorded.length >= 5, 'expected at least five recorded versions, found ' + recorded.length);
  assert.ok(recorded.some((r) => r.version.startsWith('redis-')) && recorded.some((r) => r.version.startsWith('valkey-')));
});

for (const run of recorded) {
  for (const step of run.steps) {
    test(`${run.version} ${step.name}: the real cluster ended with the planned owners and every key`, () => {
      const before = R.parseClusterNodes(step.nodesBefore);
      assert.deepEqual(before.errors, []);
      assert.deepEqual(R.parseClusterNodes(step.nodesAfter).errors, []);
      const opts = {};
      for (let i = 0; i < step.args.length; i += 2) {
        if (step.args[i] === '--drain') opts.drain = (opts.drain || []).concat(step.args[i + 1]);
        else if (step.args[i] === '--weight') {
          const [ref, w] = step.args[i + 1].split('=');
          opts.weights = Object.assign(opts.weights || {}, { [ref]: Number(w) });
        } else throw new Error('unexpected option ' + step.args[i]);
      }
      if (step.keySizes) opts.load = R.parseKeySizes(step.keySizes).load;
      const p = R.plan(before, opts);
      assert.deepEqual(p.problems, []);
      assert.ok(p.movedSlots > 0);
      assert.equal(p.movedSlots, step.planned.movedSlots);
      assert.deepEqual(p.owner, owners(step.nodesAfter));
      assert.equal(step.readBack, step.keys);
      assert.equal(step.keysOnPrimaries, step.keys);
      assert.deepEqual(step.wrong, []);
    });
  }
}
