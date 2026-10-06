// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// One open snapshot and the questions the page asks about it. The page runs
// this in a worker, so a big file doesn't freeze it; opened from a file on
// disk, where browsers allow no workers, it runs in the page. Every answer
// is plain data. Defines KVRevisionsSession(R), R being KVRevisions.

(function (root) {
  'use strict';

  function KVRevisionsSession(R) {
    let snap = null, quota = 2 * R.GiB, name = '';
    const lastOf = (e) => e.history[e.history.length - 1];
    const kindOf = (e) => (e.what && e.what.kind ? (e.what.apiVersion ? e.what.apiVersion + ' ' : '') + e.what.kind : '');
    const row = (e) => ({ key: e.key, live: e.live, revisions: e.revisions, bytes: e.bytes, historyBytes: e.historyBytes, modRevision: e.modRevision,
      createRevision: lastOf(e).createRevision, version: lastOf(e).version, lease: e.lease || '', kind: kindOf(e) });
    const need = () => { if (!snap) throw new Error('No snapshot is open.'); return snap; };
    function overview() {
      const s = need();
      const r = R.report(s, { quota: quota, top: 30, depth: 3 });
      // Where the database's space goes: current values, old revisions,
      // everything else in use (etcd's own records, bbolt's page structure,
      // half-filled pages), and free pages.
      const other = Math.max(0, s.bytesInUse - s.liveBytes - s.historyBytes);
      r.space = { values: s.liveBytes, history: s.historyBytes, other: other, free: s.pagesFree * s.pageSize, database: s.status.totalSize };
      r.name = name;
      r.leaseList = [...s.leases.values()].sort((a, b) => b.keys - a.keys).slice(0, 30);
      r.leaseCount = s.leases.size;
      r.kubernetesVersion = R.kubernetesSchema() ? R.kubernetesSchema().version : null;
      r.keyCount = s.keys.size;
      return r;
    }
    return {
      // Opens a file. digest: a function that works out the SHA-256 of
      // the file's body as hex faster than JavaScript does, if there is one.
      async open(buffer, fileName, digest) {
        snap = null;
        const s = R.read(new Uint8Array(buffer), { hash: false });
        if (s.hash) s.hash.check(digest ? await digest(s.hash.body) : undefined);
        snap = s;
        name = fileName;
        return overview();
      },
      setQuota(bytes) { quota = bytes; return overview(); },
      overview: overview,
      // Keys matching a filter: { query, show: all|history|deleted, sort:
      // key|bytes|revisions, prefix, offset, limit }.
      keys(q) {
        const s = need();
        const query = q.query || '', prefix = q.prefix || '';
        let list = [];
        for (const e of s.keys.values()) {
          if (prefix && !e.key.startsWith(prefix)) continue;
          if (query && !e.key.includes(query)) continue;
          if (q.show === 'history' && e.revisions < 2) continue;
          if (q.show === 'deleted' && e.live) continue;
          if (q.show === 'live' && !e.live) continue;
          list.push(e);
        }
        if (q.sort === 'bytes') list.sort((a, b) => b.bytes - a.bytes || b.historyBytes - a.historyBytes);
        else if (q.sort === 'revisions') list.sort((a, b) => b.revisions - a.revisions || b.historyBytes - a.historyBytes);
        else list.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
        const offset = q.offset || 0;
        return { total: list.length, rows: list.slice(offset, offset + (q.limit || 50)).map(row) };
      },
      prefixes(depth, under) { return R.prefixes(need(), depth, under).slice(0, 200); },
      // A key and every revision of it the file keeps.
      key(key) {
        const s = need();
        const e = s.keys.get(key);
        if (!e) return null;
        return Object.assign(row(e), {
          history: e.history.map((h) => ({ revision: h.main, sub: h.sub, deleted: h.deleted, version: h.version, createRevision: h.createRevision, lease: h.lease || '', bytes: h.valueBytes }))
        });
      },
      // One revision's value as text, and its changes from the revision before.
      value(key, index) {
        const e = need().keys.get(key);
        const h = e && e.history[index];
        if (!h || h.deleted) return null;
        const text = R.valueText(h.value).replace(/\n$/, '');
        let prev = null;
        for (let i = index - 1; i >= 0; i--) if (!e.history[i].deleted) { prev = i; break; }
        const out = { text: text, bytes: h.valueBytes, what: R.describeValue(h.value), previous: prev === null ? null : e.history[prev].main, changes: null };
        if (prev !== null) out.changes = R.diffLines(R.valueText(e.history[prev].value).replace(/\n$/, ''), text);
        const k = R.kubernetesObject(h.value);
        out.kubernetes = k ? { apiVersion: k.apiVersion, kind: k.kind, known: k.known, format: k.format } : null;
        return out;
      },
      csv() {
        const lines = ['key,live,revisions,bytes,history_bytes,create_revision,mod_revision,version,lease,kind'];
        const cell = (v) => { let t = String(v); if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
        const all = [...need().keys.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
        for (const e of all) {
          const r = row(e);
          lines.push([cell(r.key), r.live, r.revisions, r.bytes, r.historyBytes, r.createRevision, r.modRevision, r.version, r.lease, cell(r.kind)].join(','));
        }
        return lines.join('\n') + '\n';
      },
      reportJson() { return JSON.stringify(R.report(need(), { quota: quota, top: 50 }), null, 2) + '\n'; }
    };
  }

  root.KVRevisionsSession = KVRevisionsSession;
})(typeof self !== 'undefined' ? self : this);
