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
    // Hash, revision, key count and size, and for 3.6 the storage version,
    // all as the etcdutl (etcdctl for 3.4) of the same version printed them.
    // etcd 3.6 counts the keys that exist now; 3.4 and 3.5 count every record.
    assert.deepEqual(snap.status, expected(s.name).snapshotStatus);
    assert.equal(snap.revision, snap.status.revision);
    assert.equal(snap.hash.ok, true);
  });

  test(s.name + ': pages in use and free, as bbolt counts them', () => {
    const snap = R.read(file(s.file));
    const b = expected(s.name).bbolt;
    assert.equal(snap.pagesFree, b.pages.free || 0);
    assert.equal(snap.pagesInUse, (b.pages.branch || 0) + (b.pages.leaf || 0) + (b.pages.meta || 0) + (b.pages.freelist || 0));
    assert.equal(snap.records, b.keyValuePairs);
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

// ---- Damaged and crafted files ----
//
// Copies of a fixture with bbolt's fields changed, as damage or a crafted
// file would change them, and small databases written from scratch.

const PS = 4096;
const view = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
// Where the current meta page's fields start: the one with the higher txid.
const metaAt = (b) => (view(b).getBigUint64(PS + 64, true) > view(b).getBigUint64(64, true) ? PS : 0) + 16;
// The checksum bbolt keeps after a meta page's fields: FNV-1a over them.
function sealMeta(b, at) {
  let h = 0xcbf29ce484222325n;
  for (let i = at; i < at + 56; i++) h = ((h ^ BigInt(b[i])) * 0x100000001b3n) & 0xffffffffffffffffn;
  view(b).setBigUint64(at + 56, h, true);
}
function pageHeader(b, id, flags, count, overflow) {
  const v = view(b);
  v.setBigUint64(id * PS, BigInt(id), true);
  v.setUint16(id * PS + 8, flags, true);
  v.setUint16(id * PS + 10, count, true);
  v.setUint32(id * PS + 12, overflow, true);
}
// The cluster snapshot, without its hash, with room for more pages after
// its own; the meta page counts them as in the database.
function grown(extra) {
  const body = file('etcd-3.6.15-cluster.db').subarray(0, -32);
  const b = new Uint8Array(body.length + extra * PS);
  b.set(body);
  const m = metaAt(b);
  view(b).setBigUint64(m + 40, BigInt(b.length / PS), true);
  sealMeta(b, m);
  return { b: b, first: body.length / PS, m: m };
}
// Where the root page keeps the id of a top-level bucket's root page.
function bucketRoot(b, name) {
  const v = view(b), root = Number(v.getBigUint64(metaAt(b) + 16, true)) * PS;
  for (let i = 0; i < v.getUint16(root + 10, true); i++) {
    const e = root + 16 + i * 16, k = e + v.getUint32(e + 4, true), n = v.getUint32(e + 8, true);
    if (Buffer.from(b.subarray(k, k + n)).toString() === name) return k + n;
  }
  throw new Error('no bucket ' + name);
}

test('a damaged file is refused at once, with a SnapshotError', () => {
  const good = file('etcd-3.6.15-cluster.db');
  // Everything after the meta pages turned to noise. A page's made-up
  // length used to mean seconds of work and half a gigabyte, then a RangeError.
  for (let seed = 1; seed <= 20; seed++) {
    const b = good.slice();
    let x = seed;
    for (let i = 2 * PS; i < b.length; i++) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; b[i] = x >>> 24; }
    assert.throws(() => R.read(b), R.SnapshotError, 'seed ' + seed);
  }
  // The key bucket's root page, 39, runs on over 4 billion pages, or lists
  // more records than fit in it.
  let b = good.slice();
  view(b).setUint32(39 * PS + 12, 0xffffffff, true);
  assert.throws(() => R.read(b), { name: 'SnapshotError', message: /^Page 39 runs on past the end of the file/ });
  b = good.slice();
  view(b).setUint16(39 * PS + 10, 0xffff, true);
  assert.throws(() => R.read(b), { name: 'SnapshotError', message: /^Page 39 lists more records than fit in it/ });
  // A page in the file but past the ones the database uses.
  const g = grown(1);
  pageHeader(g.b, g.first, 0x02, 0, 0);
  view(g.b).setBigUint64(g.m + 40, BigInt(g.first), true);
  sealMeta(g.b, g.m);
  view(g.b).setBigUint64(bucketRoot(g.b, 'key'), BigInt(g.first), true);
  assert.throws(() => R.read(g.b), { name: 'SnapshotError', message: new RegExp('^Page ' + g.first + ' lies past the pages the database says it uses') });
});

test('a stored freelist is counted, and one that runs on past the end is refused', () => {
  const plain = R.read(file('etcd-3.6.15-cluster.db'));
  for (const overflow of [0, 0xfffffff0]) {
    const { b, first, m } = grown(1);
    pageHeader(b, first, 0x10, 0, overflow);
    view(b).setBigUint64(m + 32, BigInt(first), true);
    sealMeta(b, m);
    if (overflow) {
      assert.throws(() => R.read(b), { name: 'SnapshotError', message: new RegExp('^Page ' + first + ' runs on past the end of the file') });
      continue;
    }
    const snap = R.read(b);
    assert.equal(snap.freelistStored, true);
    assert.equal(snap.pagesInUse, plain.pagesInUse + 1);
    assert.equal(snap.pagesFree, plain.pagesFree);
  }
});

test('a crafted tree that reaches a page twice is refused at once', () => {
  // 40 branch pages, each with two children that are both the next page:
  // 2^40 ways down to the last one, which read() used to follow one by one.
  const { b, first } = grown(40);
  for (let k = 0; k < 40; k++) {
    const id = first + k;
    if (k === 39) { pageHeader(b, id, 0x02, 0, 0); continue; }
    pageHeader(b, id, 0x01, 2, 0);
    for (let i = 0; i < 2; i++) view(b).setBigUint64(id * PS + 16 + i * 16 + 8, BigInt(id + 1), true);
  }
  view(b).setBigUint64(bucketRoot(b, 'key'), BigInt(first), true);
  assert.throws(() => R.read(b), { name: 'SnapshotError', message: /turns up twice in one tree/ });
  // A page that is its own child.
  pageHeader(b, first, 0x01, 1, 0);
  view(b).setBigUint64(first * PS + 16 + 8, BigInt(first), true);
  assert.throws(() => R.read(b), { name: 'SnapshotError', message: new RegExp('^Page ' + first + ' turns up twice in one tree') });
});

test('a gzipped file is refused with how to unpack it', () => {
  const gz = new Uint8Array(fs.readFileSync(path.join(FIX, 'etcd-3.6.15-nospace.db.gz')));
  assert.throws(() => R.read(gz), (e) => e instanceof R.SnapshotError && e.code === 'gzip' && /gzipped/.test(e.message) && /gunzip/.test(e.message));
});

// A small etcd database written from scratch: revisions of keys, in order,
// as { key, rev, value, lease, deleted }, and leases as { id, ttl }. Pages 0
// and 1 are the meta pages, 2 the root, then a leaf page for each bucket.
function makeSnapshot(revisions, leases) {
  const varint = (n) => { const out = []; let v = BigInt(n); do { let x = Number(v & 0x7fn); v >>= 7n; if (v) x |= 0x80; out.push(x); } while (v); return out; };
  const pb = (n, v) => (typeof v === 'number' ? [n << 3, ...varint(v)] : [n << 3 | 2, ...varint(v.length), ...v]);
  const be64 = (n) => Array.from({ length: 8 }, (_, i) => Number((BigInt(n) >> BigInt(56 - 8 * i)) & 0xffn));
  const bytes = (s) => [...Buffer.from(s)];
  const keyRecords = revisions.map((r) => [
    [...be64(r.rev), 0x5f, ...be64(0), ...(r.deleted ? [0x74] : [])],
    r.deleted ? [...pb(1, bytes(r.key)), ...pb(3, r.rev)]
      : [...pb(1, bytes(r.key)), ...pb(2, r.rev), ...pb(3, r.rev), ...pb(4, 1), ...pb(5, bytes(r.value || 'v')), ...(r.lease ? pb(6, r.lease) : [])]
  ]);
  const leaseRecords = leases.map((l) => [be64(l.id), [...pb(1, l.id), ...pb(2, l.ttl)]]);
  // A leaf page, as long as its records need, with a page number set later.
  const leaf = (records, flags) => {
    let size = 16 + 16 * records.length;
    for (const [k, v] of records) size += k.length + v.length;
    const p = new Uint8Array(Math.ceil(size / PS) * PS), v = view(p);
    v.setUint16(8, 0x02, true); v.setUint16(10, records.length, true); v.setUint32(12, p.length / PS - 1, true);
    let at = 16 + 16 * records.length;
    records.forEach(([k, val], i) => {
      const e = 16 + 16 * i;
      v.setUint32(e, flags, true); v.setUint32(e + 4, at - e, true); v.setUint32(e + 8, k.length, true); v.setUint32(e + 12, val.length, true);
      p.set(k, at); p.set(val, at + k.length);
      at += k.length + val.length;
    });
    return p;
  };
  const pages = [];
  let next = 3;
  const rootRecords = [['key', keyRecords], ['lease', leaseRecords]].map(([name, records]) => {
    const p = leaf(records, 0);
    pages.push([next, p]);
    const header = new Uint8Array(16);
    view(header).setBigUint64(0, BigInt(next), true);
    next += p.length / PS;
    return [bytes(name), [...header]];
  });
  pages.push([2, leaf(rootRecords, 0x01)]);
  const b = new Uint8Array(next * PS), v = view(b);
  for (const [id, p] of pages) { b.set(p, id * PS); v.setBigUint64(id * PS, BigInt(id), true); }
  for (const id of [0, 1]) {
    const m = id * PS + 16;
    pageHeader(b, id, 0x04, 0, 0);
    v.setUint32(m, 0xED0CDAED, true); v.setUint32(m + 4, 2, true); v.setUint32(m + 8, PS, true);
    v.setBigUint64(m + 16, 2n, true); v.setBigUint64(m + 32, 0xffffffffffffffffn, true);
    v.setBigUint64(m + 40, BigInt(next), true); v.setBigUint64(m + 48, BigInt(id + 1), true);
    sealMeta(b, m);
  }
  return b;
}

test('a resource whose keys are all deleted still shows, with its old revisions', () => {
  // Events that have all expired, and a few small keys that exist.
  const revisions = [];
  let rev = 1;
  for (let i = 0; i < 20; i++) {
    revisions.push({ key: '/registry/events/default/e' + i, rev: rev++, value: 'x'.repeat(500) });
    revisions.push({ key: '/registry/events/default/e' + i, rev: rev++, deleted: true });
  }
  for (let i = 0; i < 3; i++) revisions.push({ key: '/registry/pods/default/p' + i, rev: rev++ });
  const snap = R.read(makeSnapshot(revisions, []));
  assert.deepEqual([snap.liveKeys, snap.revisions, snap.tombstones], [3, 43, 20]);
  const events = snap.resources.find((r) => r.resource === 'events');
  assert.deepEqual([events.prefix, events.keys, events.bytes, events.revisions], ['/registry/events/', 0, 0, 40]);
  assert.ok(events.historyBytes > 20 * 500);
  assert.ok(R.findings(snap).some((f) => f.code === 'events'));
});

// ---- The page's session ----

const { KVRevisionsSession } = require('../app/session.js');
const bufferOf = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

test('the page\'s session: lease totals cover every lease, and prefixes say how many there are past 200', async () => {
  // 41 leases: 40 with two keys each and one with three, 83 keys in all;
  // and 250 keys under prefixes of their own.
  const revisions = [];
  let rev = 1;
  for (let i = 0; i < 3; i++) revisions.push({ key: '/registry/events/default/e' + i, rev: rev++, lease: 0x1000 });
  for (let i = 1; i <= 40; i++) for (let j = 0; j < 2; j++) revisions.push({ key: '/registry/leases/default/l' + i + '-' + j, rev: rev++, lease: 0x1000 + i });
  for (let i = 0; i < 250; i++) revisions.push({ key: '/many/p' + i + '/k', rev: rev++ });
  const leases = Array.from({ length: 41 }, (_, i) => ({ id: 0x1000 + i, ttl: 60 }));
  const s = KVRevisionsSession(R);
  const o = await s.open(bufferOf(makeSnapshot(revisions, leases)), 'made.db');
  assert.deepEqual([o.name, o.leaseCount, o.leaseKeys, o.leaseList.length, o.leaseList[0].id, o.leaseList[0].keys], ['made.db', 41, 83, 30, '1000', 3]);
  const p = s.prefixes(3, '');
  assert.equal(p.total, 252);
  assert.equal(p.rows.length, 200);
  assert.deepEqual(s.prefixes(1, '/registry/'), { total: 2, rows: R.prefixes(R.read(makeSnapshot(revisions, leases)), 1, '/registry/') });
});

test('the page\'s session: of two files opened at once, the one opened last stays open', async () => {
  const a = file('etcd-3.6.15-cluster.db'), b = file('etcd-3.4.45-small.db');
  const digest = (ms) => (body) => new Promise((resolve) => setTimeout(() => resolve(sha(body)), ms));
  // Whichever file's digest comes back first.
  for (const [slowA, slowB] of [[60, 0], [0, 60]]) {
    const s = KVRevisionsSession(R);
    const first = s.open(bufferOf(a), 'a.db', digest(slowA));
    const second = s.open(bufferOf(b), 'b.db', digest(slowB));
    const [oa, ob] = await Promise.all([first, second]);
    assert.equal(oa, null);
    assert.equal(ob.name, 'b.db');
    assert.equal(ob.file.bytes, b.length);
    assert.equal(s.overview().name, 'b.db');
    assert.equal(s.keys({ limit: 1 }).total, R.read(b).keys.size);
  }
});

// ---- The command line, more ----

const runCli = (args, options) => require('node:child_process').spawnSync(process.execPath, [path.join(__dirname, '..', 'cli.js')].concat(args), Object.assign({ encoding: 'utf8' }, options));

test('the command line: an alarm gives exit status 1 whatever it prints, and says why on stderr', () => {
  const tmp = path.join(require('node:os').tmpdir(), 'kvs-revisions-nospace-' + process.pid + '.db');
  fs.writeFileSync(tmp, file('etcd-3.6.15-nospace.db.gz'));
  try {
    const key = '/registry/leases/kube-node-lease/node-1';
    for (const args of [[], ['--json'], ['--keys'], ['--keys', '--json'], ['--prefixes'], ['--history', key], ['--value', key], ['--value', key, '--json']]) {
      const r = runCli([tmp].concat(args));
      assert.equal(r.status, 1, args.join(' '));
      if (args.length && args[0] !== '--json') assert.match(r.stderr, /^!! The NOSPACE alarm is raised$/m, args.join(' '));
    }
    const r = runCli([tmp, '--value', '/no/such/key']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no key "\/no\/such\/key"/);
  } finally { fs.unlinkSync(tmp); }
  // A sound snapshot exits with 0 and nothing on stderr.
  const r = runCli([path.join(FIX, 'etcd-3.6.15-cluster.db'), '--keys']);
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
});

test('the command line: a snapshot from standard input or a pipe, and a gzipped one', () => {
  const db = path.join(FIX, 'etcd-3.6.15-cluster.db');
  const want = runCli([db]).stdout.split('\n').slice(1).join('\n');
  // - reads standard input, here a socket.
  let r = runCli(['-'], { input: fs.readFileSync(db) });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^Standard input: a snapshot, 516 KiB, written by etcd 3\.6\n/);
  assert.equal(r.stdout.split('\n').slice(1).join('\n'), want);
  // ... or a file on disk.
  const fd = fs.openSync(db, 'r');
  try { r = runCli(['-'], { stdio: [fd, 'pipe', 'pipe'] }); } finally { fs.closeSync(fd); }
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.split('\n').slice(1).join('\n'), want);
  // A pipe named by a path has no size to go by.
  if (process.platform !== 'win32') {
    r = require('node:child_process').spawnSync('sh', ['-c', 'cat "$1" | "$2" "$3" /dev/stdin', 'sh', db, process.execPath, path.join(__dirname, '..', 'cli.js')], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^\/dev\/stdin: a snapshot, 516 KiB/);
  }
  r = runCli([path.join(FIX, 'etcd-3.6.15-nospace.db.gz')]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^This file is gzipped\. Unpack it first, for example with "gunzip backup\.db\.gz"/);
  assert.match(r.stderr, /zcat backup\.db\.gz \| node revisions\/cli\.js -/);
});

test('sizes as --quota and the page take them', () => {
  assert.equal(R.parseSize('8GiB'), 8 * R.GiB);
  assert.equal(R.parseSize(' 6 gib '), 6 * R.GiB);
  assert.equal(R.parseSize('8589934592'), 8 * R.GiB);
  assert.equal(R.parseSize('1.5Gi'), 1.5 * R.GiB);
  assert.equal(R.parseSize('8G'), 8e9);
  assert.equal(R.parseSize('100MB'), 1e8);
  for (const bad of ['', 'GiB', '8 GiBs', '-1', '8XB', 'eight']) assert.ok(Number.isNaN(R.parseSize(bad)), bad);
});

// ---- The README ----

test('the code sample in the README runs as written', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const samples = [...readme.matchAll(/```js\n([\s\S]*?)```/g)].map((m) => m[1]);
  assert.ok(samples.length >= 1);
  // A folder holding backup.db and the revisions folder, as the sample expects.
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'kvs-revisions-readme-'));
  const link = path.join(dir, 'revisions');
  try {
    fs.copyFileSync(path.join(FIX, 'etcd-3.6.15-cluster.db'), path.join(dir, 'backup.db'));
    fs.symlinkSync(path.join(__dirname, '..'), link, 'junction');
    samples.forEach((code, i) => {
      const script = path.join(dir, 'sample-' + i + '.js');
      fs.writeFileSync(script, code);
      const r = require('node:child_process').spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
    });
  } finally {
    if (fs.existsSync(link)) fs.unlinkSync(link);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
