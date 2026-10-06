// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Writes test/results/etcd-and-kubernetes.json: how the Revision Viewer's
// answers compare with etcd's own tools and with Kubernetes' own code, on
// every recorded snapshot and object.
//
//   node revisions/test/generate/measure.js

'use strict';
// node --test runs every .js file under a test folder; this one only runs by hand.
if (process.env.NODE_TEST_CONTEXT) return;
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const R = require('../../revisions.js');

const FIX = path.join(__dirname, '..', 'fixtures');
const file = (name) => { const b = fs.readFileSync(path.join(FIX, name)); return new Uint8Array(name.endsWith('.gz') ? zlib.gunzipSync(b) : b); };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const lines = (name) => zlib.gunzipSync(fs.readFileSync(path.join(FIX, name))).toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const sorted = (x) => {
  if (Array.isArray(x)) return x.map(sorted);
  if (x && typeof x === 'object') { const o = {}; for (const k of Object.keys(x).sort()) o[k] = sorted(x[k]); return o; }
  return x;
};

const out = { snapshots: [], kubernetesObjects: null, yamlCases: null };
for (const [name, f, etcd] of [['etcd-3.6.15-cluster', 'etcd-3.6.15-cluster.db', '3.6'], ['etcd-3.6.15-nospace', 'etcd-3.6.15-nospace.db.gz', '3.6'],
  ['etcd-3.5.34-encrypted', 'etcd-3.5.34-encrypted.db', '3.5'], ['etcd-3.4.45-small', 'etcd-3.4.45-small.db', '3.4']]) {
  const snap = R.read(file(f));
  const exp = JSON.parse(fs.readFileSync(path.join(FIX, name + '.expected.json'), 'utf8'));
  let liveOk = 0, histOk = 0, hist = 0;
  for (const kv of exp.live) {
    const e = snap.keys.get(kv.key);
    const last = e && e.history[e.history.length - 1];
    if (e && e.live && last.main === kv.modRevision && last.createRevision === kv.createRevision && last.version === kv.version && last.lease === kv.lease && sha(last.value) === kv.valueSha256) liveOk++;
  }
  for (const [key, revs] of Object.entries(exp.history)) {
    const h = R.history(snap, key) || [];
    for (const [rev, v] of Object.entries(revs)) {
      hist++;
      const x = h.find((y) => y.revision === Number(rev) && !y.deleted);
      if (x && x.version === v.version && sha(x.value) === v.valueSha256) histOk++;
    }
  }
  const b = exp.bbolt;
  out.snapshots.push({
    snapshot: name, etcd: etcd,
    statusHash: { etcd: exp.snapshotStatus.hash, viewer: snap.status.hash },
    totalSize: { etcd: exp.snapshotStatus.totalSize, viewer: snap.status.totalSize },
    totalKey: { etcd: exp.snapshotStatus.totalKey, viewer: etcd === '3.6' ? snap.liveKeys : snap.status.totalKey },
    revision: { etcd: exp.snapshotStatus.revision, viewer: snap.revision },
    liveKeys: { etcd: exp.live.length, matched: liveOk },
    oldRevisions: { etcd: hist, matched: histOk },
    pages: { bbolt: { free: b.pages.free || 0, inUse: (b.pages.branch || 0) + (b.pages.leaf || 0) + (b.pages.meta || 0) + (b.pages.freelist || 0), keyValuePairs: b.keyValuePairs },
      viewer: { free: snap.pagesFree, inUse: snap.pagesInUse, keyValuePairs: snap.status.totalKey } }
  });
}

const snap = R.read(file('etcd-3.6.15-cluster.db'));
const values = new Map();
for (const e of snap.keys.values()) for (const h of e.history) if (!h.deleted) values.set(sha(h.value), h.value);
const rows = lines('kubernetes-objects.jsonl.gz');
let json = 0, yaml = 0, cannot = 0;
const kinds = new Set();
for (const r of rows) {
  const k = R.kubernetesObject(values.get(r.sha256));
  kinds.add(k.apiVersion + ' ' + k.kind);
  if (JSON.stringify(sorted(JSON.parse(R.toJson(k.object)))) === JSON.stringify(sorted(r.json))) json++;
  if (r.error) cannot++;
  else if (R.toYaml(k.object) === r.yaml) yaml++;
}
out.kubernetesObjects = { reference: 'k8s.io/api, apimachinery, apiextensions-apiserver and kube-aggregator 1.37.1, through test/generate/k8scodec', objects: rows.length,
  kinds: kinds.size, jsonMatched: json, yamlMatched: yaml, kubectlCannotPrint: cannot };
const cases = lines('yaml-cases.jsonl.gz');
let same = 0;
for (const r of cases) if (R.toYaml(R.kubernetesObject(new Uint8Array(Buffer.from(r.value, 'base64'))).object) === r.yaml) same++;
out.yamlCases = { objects: cases.length, yamlMatched: same };

const dest = path.join(__dirname, '..', 'results', 'etcd-and-kubernetes.json');
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out, null, 2));
