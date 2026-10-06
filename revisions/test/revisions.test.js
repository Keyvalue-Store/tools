// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Tests for the Revision Viewer. The fixtures are snapshots written by real
// etcd servers (3.6.15, 3.5.34 and 3.4.45) holding a small Kubernetes cluster's
// data, with what etcd's own tools said about each: snapshot status (from
// etcdutl, or etcdctl for 3.4),
// every live key as etcdctl get returns it, every revision of three keys
// that etcd could still serve, members, alarms, and bbolt's page counts.
// Run with: node --test

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const R = require('../revisions.js');

const FIX = path.join(__dirname, 'fixtures');
const file = (name) => {
  const b = fs.readFileSync(path.join(FIX, name));
  return new Uint8Array(name.endsWith('.gz') ? zlib.gunzipSync(b) : b);
};
const expected = (name) => JSON.parse(fs.readFileSync(path.join(FIX, name + '.expected.json'), 'utf8'));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

const SNAPSHOTS = [
  { name: 'etcd-3.6.15-cluster', file: 'etcd-3.6.15-cluster.db', etcd: '3.6' },
  { name: 'etcd-3.5.34-encrypted', file: 'etcd-3.5.34-encrypted.db', etcd: '3.5' },
  { name: 'etcd-3.6.15-nospace', file: 'etcd-3.6.15-nospace.db.gz', etcd: '3.6' },
  { name: 'etcd-3.4.45-small', file: 'etcd-3.4.45-small.db', etcd: '3.4' }
];

for (const s of SNAPSHOTS) {
  test(s.name + ': the figures etcdutl snapshot status prints', () => {
    const snap = R.read(file(s.file));
    const exp = expected(s.name).snapshotStatus;
    assert.equal(snap.status.hash, exp.hash);
    assert.equal(snap.status.totalSize, exp.totalSize);
    assert.equal(snap.revision, exp.revision);
    // etcd 3.4 and 3.5 count every record in the file; 3.6 counts the live keys.
    assert.equal(s.etcd === '3.6' ? snap.liveKeys : snap.status.totalKey, exp.totalKey);
    assert.equal(snap.hash.ok, true);
  });

  test(s.name + ': pages in use and free, as bbolt counts them', () => {
    const snap = R.read(file(s.file));
    const b = expected(s.name).bbolt;
    assert.equal(snap.pagesFree, b.pages.free || 0);
    assert.equal(snap.pagesInUse, (b.pages.branch || 0) + (b.pages.leaf || 0) + (b.pages.meta || 0) + (b.pages.freelist || 0));
    assert.equal(snap.status.totalKey, b.keyValuePairs);
  });

  test(s.name + ': every live key, as etcdctl get returns it', () => {
    const snap = R.read(file(s.file));
    const exp = expected(s.name);
    assert.equal(snap.liveKeys, exp.live.length);
    for (const kv of exp.live) {
      const e = snap.keys.get(kv.key);
      assert.ok(e && e.live, kv.key);
      const last = e.history[e.history.length - 1];
      assert.equal(last.main, kv.modRevision, kv.key);
      assert.equal(last.createRevision, kv.createRevision, kv.key);
      assert.equal(last.version, kv.version, kv.key);
      assert.equal(last.lease, kv.lease, kv.key);
      assert.equal(last.value.length, kv.valueBytes, kv.key);
      assert.equal(sha(last.value), kv.valueSha256, kv.key);
    }
  });

  test(s.name + ': every revision etcd could still serve is in the history', () => {
    const snap = R.read(file(s.file));
    const exp = expected(s.name);
    assert.equal(snap.compactedAt, exp.notes.compactedAt);
    let checked = 0;
    for (const [key, revs] of Object.entries(exp.history)) {
      const h = R.history(snap, key);
      for (const [rev, v] of Object.entries(revs)) {
        const x = h.find((y) => y.revision === Number(rev) && !y.deleted);
        assert.ok(x, key + ' @ ' + rev);
        assert.equal(x.version, v.version);
        assert.equal(sha(x.value), v.valueSha256);
        checked++;
      }
    }
    assert.ok(checked >= 10);
  });

  test(s.name + ': members and alarms', () => {
    const snap = R.read(file(s.file));
    const exp = expected(s.name);
    assert.deepEqual(snap.members.map((m) => ({ name: m.name, peerURLs: m.peerURLs, clientURLs: m.clientURLs })), exp.members);
    const alarms = exp.alarms.map((a) => {
      const m = /memberID:(\d+) alarm:(\w+)/.exec(a);
      return { member: BigInt(m[1]).toString(16), alarm: m[2] };
    });
    assert.deepEqual(snap.alarms, alarms);
  });
}

test('the cluster snapshot: Kubernetes objects are recognized', () => {
  const snap = R.read(file('etcd-3.6.15-cluster.db'));
  const kinds = new Set(snap.kinds.map((k) => k.kind));
  for (const k of ['Pod', 'Lease', 'Event', 'ConfigMap', 'Secret', 'Deployment', 'Service', 'EndpointSlice', 'Namespace', 'Node', 'Certificate']) assert.ok(kinds.has(k), k);
  const cert = snap.kinds.find((k) => k.kind === 'Certificate');
  assert.equal(cert.format, 'json');
  assert.equal(cert.apiVersion, 'cert-manager.io/v1');
  const pod = R.describeValue(snap.keys.get('/registry/pods/shop/web-0').history.slice(-1)[0].value);
  assert.equal(pod.name, 'web-0');
  assert.equal(pod.namespace, 'shop');
  assert.ok(pod.managedFieldsBytes > 0);
  assert.equal(snap.secrets.total, 4);
  assert.equal(snap.secrets.plain, 4);
  const res = new Map(snap.resources.map((r) => [r.resource, r]));
  assert.ok(res.get('leases').historyBytes > 0);
  assert.ok(res.has('certificates.cert-manager.io'));
  assert.ok(R.findings(snap).some((f) => f.code === 'secrets' && f.level === 'warn'));
});

test('the encrypted snapshot: Secrets encrypted at rest, and authentication on', () => {
  const snap = R.read(file('etcd-3.5.34-encrypted.db'));
  assert.equal(snap.secrets.encrypted, 4);
  assert.equal(snap.secrets.plain, 0);
  assert.deepEqual([...snap.secrets.providers], [['aescbc:v1', 4]]);
  assert.equal(snap.authEnabled, true);
  assert.deepEqual(snap.users.sort(), ['kube-apiserver', 'root']);
  assert.equal(snap.storageVersion, null);
  assert.equal(snap.clusterVersion, '3.5.0');
  const f = R.findings(snap);
  assert.ok(f.some((x) => x.code === 'secrets' && x.level === 'ok'));
  assert.ok(f.some((x) => x.code === 'auth'));
});

test('the full snapshot: the NOSPACE alarm is reported first', () => {
  const snap = R.read(file('etcd-3.6.15-nospace.db.gz'));
  const f = R.findings(snap, 1024 * 1024);
  assert.equal(f[0].code, 'nospace');
  assert.ok(f.some((x) => x.code === 'quota'));
});

test('a member\'s own database file: no hash, a file larger than its data', () => {
  const member = R.read(file('etcd-3.6.15-cluster-member.db.gz'));
  const snap = R.read(file('etcd-3.6.15-cluster.db'));
  assert.equal(member.hash, null);
  assert.ok(member.fileBytes > member.status.totalSize);
  const live = (s) => [...s.keys.values()].filter((e) => e.live).map((e) => e.key + '@' + e.modRevision).sort();
  assert.deepEqual(live(member), live(snap));
});

test('a changed byte breaks the hash, and a cut file is refused', () => {
  const b = file('etcd-3.6.15-cluster.db').slice();
  b[20000] ^= 0xff;
  assert.equal(R.read(b).hash.ok, false);
  assert.throws(() => R.read(file('etcd-3.6.15-cluster.db').subarray(0, 300)), R.SnapshotError);
  assert.throws(() => R.read(new Uint8Array(8192)), /not an etcd snapshot/);
});

test('SHA-256 matches Node\'s', () => {
  for (const n of [0, 1, 55, 56, 63, 64, 65, 1000, 4097]) {
    const b = crypto.randomBytes(n);
    assert.equal(Buffer.from(R.sha256(new Uint8Array(b))).toString('hex'), sha(b));
  }
});

test('history and diffs of a renewed lease', () => {
  const snap = R.read(file('etcd-3.6.15-cluster.db'));
  const h = R.history(snap, '/registry/leases/kube-node-lease/node-1');
  assert.ok(h.length >= 11);
  const a = R.valueText(h[h.length - 2].value), b = R.valueText(h[h.length - 1].value);
  assert.match(a, /^apiVersion: coordination\.k8s\.io\/v1\nkind: Lease\n/);
  const d = R.diffLines(a, b);
  // Only the renew time changes between two heartbeats.
  assert.deepEqual(d.filter((l) => l[0] === '-' || l[0] === '+').map((l) => l.slice(0, 15)), ['-  renewTime: "', '+  renewTime: "']);
});

// Every Kubernetes object in the cluster snapshot, with the JSON that
// Kubernetes' own Go packages (1.37.1) make of the stored bytes and the YAML
// that kubectl prints, recorded by test/generate/make-snapshots.py.
const lines = (name) => zlib.gunzipSync(fs.readFileSync(path.join(FIX, name))).toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const sorted = (x) => {
  if (Array.isArray(x)) return x.map(sorted);
  if (x && typeof x === 'object') { const o = {}; for (const k of Object.keys(x).sort()) o[k] = sorted(x[k]); return o; }
  return x;
};

test('Kubernetes objects: the same JSON as Kubernetes\' own code, and the same YAML as kubectl', () => {
  const snap = R.read(file('etcd-3.6.15-cluster.db'));
  const values = new Map();
  for (const e of snap.keys.values()) for (const h of e.history) if (!h.deleted) values.set(sha(h.value), h.value);
  const rows = lines('kubernetes-objects.jsonl.gz');
  const kinds = new Set();
  let yaml = 0;
  for (const r of rows) {
    const v = values.get(r.sha256);
    assert.ok(v, 'the snapshot holds ' + r.sha256);
    const k = R.kubernetesObject(v);
    const name = r.json.kind + ' ' + r.json.metadata.name;
    assert.ok(k && k.known, name);
    kinds.add(k.apiVersion + ' ' + k.kind);
    assert.deepEqual(sorted(JSON.parse(R.toJson(k.object))), sorted(r.json), name);
    if (r.error) continue;
    assert.equal(R.toYaml(k.object), r.yaml, name);
    assert.equal(R.valueText(v), r.yaml, name);
    yaml++;
  }
  assert.ok(rows.length >= 140 && yaml >= 138);
  for (const k of ['v1 Pod', 'v1 Node', 'apps/v1 Deployment', 'coordination.k8s.io/v1 Lease', 'apiextensions.k8s.io/v1 CustomResourceDefinition',
    'apiregistration.k8s.io/v1 APIService', 'certificates.k8s.io/v1 CertificateSigningRequest', 'cert-manager.io/v1 Certificate', 'argoproj.io/v1alpha1 Rollout']) assert.ok(kinds.has(k), k);
});

test('Kubernetes objects kubectl cannot print: still shown, with the odd characters escaped', () => {
  const rows = lines('kubernetes-objects.jsonl.gz').filter((r) => r.error);
  assert.deepEqual(rows.map((r) => r.json.metadata.name).sort(), ['yaml-break-in-key', 'yaml-unprintable']);
  const snap = R.read(file('etcd-3.6.15-cluster.db'));
  const y = R.valueText(snap.keys.get('/registry/configmaps/default/yaml-unprintable').history[0].value);
  assert.match(y, /\n {2}c1: "a\\x9Fb"\n {2}del: "a\\x7Fb"\n {2}nonchar: "\\uFFFF"\n/);
});

test('YAML: 240 random objects full of awkward strings print as kubectl prints them', () => {
  const rows = lines('yaml-cases.jsonl.gz');
  assert.equal(rows.length, 240);
  for (const r of rows) {
    const k = R.kubernetesObject(new Uint8Array(Buffer.from(r.value, 'base64')));
    assert.equal(R.toYaml(k.object), r.yaml);
  }
});

test('an object of a kind kubernetes.js doesn\'t know shows its field numbers', () => {
  // A protobuf envelope for example.com/v1 Widget: TypeMeta, then the raw object.
  const enc = (n, b) => [n << 3 | 2, b.length, ...b];
  const s = (t) => [...Buffer.from(t)];
  const typeMeta = [...enc(1, s('example.com/v1')), ...enc(2, s('Widget'))];
  const raw = enc(1, enc(1, s('w-1')));
  const value = new Uint8Array([0x6b, 0x38, 0x73, 0x00, ...enc(1, typeMeta), ...enc(2, raw)]);
  const k = R.kubernetesObject(value);
  assert.deepEqual([k.apiVersion, k.kind, k.known, k.object], ['example.com/v1', 'Widget', false, null]);
  assert.equal(R.valueText(value), 'example.com/v1 Widget w-1\n1 {\n  1: "w-1"\n}\n');
});

test('numbers in JSON keep their form: a custom resource as kube-apiserver reads it, raw JSON as written', () => {
  const k = R.kubernetesObject(new Uint8Array(Buffer.from('{"apiVersion":"x.io/v1","kind":"T","metadata":{"name":"a"},"spec":{"a":1.5e6,"b":1.0,"c":2e-7,"d":12345678901234567890,"e":0.5,"f":-0}}')));
  assert.equal(R.toYaml(k.object), 'apiVersion: x.io/v1\nkind: T\nmetadata:\n  name: a\nspec:\n  a: 1500000\n  b: 1\n  c: 2e-07\n  d: 12345678901234567000\n  e: 0.5\n  f: 0\n');
  assert.equal(R.toJson(R.parseJson('{"a":1.50,"b":[1e3,-0]}')), '{"a":1.50,"b":[1e3,-0]}');
});

test('the command line', () => {
  const { spawnSync } = require('node:child_process');
  const cli = path.join(__dirname, '..', 'cli.js');
  const run = (args) => spawnSync(process.execPath, [cli].concat(args), { encoding: 'utf8' });
  const db = path.join(FIX, 'etcd-3.6.15-cluster.db');
  let r = run([db]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /SHA-256 at the end: matches/);
  assert.match(r.stdout, /4 of 4 Secrets are stored in the clear/);
  r = run([db, '--json']);
  const rep = JSON.parse(r.stdout);
  assert.equal(rep.status.totalSize, expected('etcd-3.6.15-cluster').snapshotStatus.totalSize);
  r = run([db, '--value', '/registry/leases/kube-node-lease/node-2']);
  const snap = R.read(file('etcd-3.6.15-cluster.db'));
  const h = R.history(snap, '/registry/leases/kube-node-lease/node-2');
  assert.equal(r.stdout, R.valueText(h[h.length - 1].value));
  r = run([db, '--value', '/registry/leases/kube-node-lease/node-2', '--revision', String(h[0].revision)]);
  assert.equal(r.stdout, R.valueText(h[0].value));
  r = run([db, '--history', '/registry/leases/kube-node-lease/node-2']);
  assert.equal((r.stdout.match(/^\+  renewTime: /gm) || []).length, h.length - 1);
  r = run([db, '--keys']);
  assert.equal(r.stdout.split('\n')[0], 'key,live,revisions,bytes,history_bytes,create_revision,mod_revision,version,lease,kind');
  assert.equal(r.stdout.trim().split('\n').length, snap.keys.size + 1);
  assert.equal(run([db, '--value', '/no/such/key']).status, 1);
  // A full database exits with 1; so does a damaged one; a file that isn't etcd's with 2.
  const tmp = path.join(require('node:os').tmpdir(), 'kvs-revisions-' + process.pid + '.db');
  fs.writeFileSync(tmp, file('etcd-3.6.15-nospace.db.gz'));
  r = run([tmp, '--quota', '1MiB']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /!! The NOSPACE alarm is raised/);
  fs.writeFileSync(tmp, Buffer.from('not a database at all, just some text that is long enough. '.repeat(40)));
  r = run([tmp]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not an etcd snapshot/);
  fs.unlinkSync(tmp);
  assert.equal(run([db, '--top', 'x']).status, 2);
});
