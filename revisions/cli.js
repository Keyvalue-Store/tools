#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Command line for the Revision Viewer. Run "node revisions/cli.js --help".

'use strict';
const fs = require('fs');
const crypto = require('crypto');
const R = require('./revisions.js');

const HELP = `Revision Viewer: what fills an etcd snapshot or a member's database file.

Usage:
  node revisions/cli.js backup.db                    What to look at, space against the quota, space by
                                                     Kubernetes resource and by key prefix, the biggest keys
  node revisions/cli.js backup.db --keys             Every key as CSV
  node revisions/cli.js backup.db --prefixes         Space by key prefix (--depth N, --under PREFIX)
  node revisions/cli.js backup.db --history KEY      Every revision of a key the file keeps, with what
                                                     changed each time
  node revisions/cli.js backup.db --value KEY        A key's value; a Kubernetes object as kubectl get -o yaml
                                                     shows it (--revision N for an older one)

Make a snapshot with "etcdctl snapshot save backup.db". A member keeps its database in member/snap/db
under its data folder; copy it while etcd is stopped. Give - as the file to read standard input, so
a gzipped snapshot can be read without unpacking it to disk: zcat backup.db.gz | node revisions/cli.js -

Options:
  --quota SIZE    The cluster's --quota-backend-bytes, such as 8GiB (default 2GiB)
  --top N         How many keys and prefixes to list (default 20)
  --depth N       How many levels of a key make its prefix (default 3)
  --under PREFIX  Only keys under this prefix, for --prefixes
  --revision N    For --value: the value as it was at revision N
  --json          Print JSON

Exit status: 0; 1 when an alarm is raised, the database is near its quota or the hash doesn't
match, whatever it was asked to print, or when the key isn't there; 2 when the file can't be read.`;

const fmt = (n) => Number(n).toLocaleString('en-US');
const plural = (n, one, many) => fmt(n) + ' ' + (n === 1 ? one : many);
// Spreadsheets run a cell that starts with = + - or @ as a formula, so such a key gets a ' in front.
function csv(s) { s = String(s); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }

// Reads the whole file: bbolt pages point at each other, so the reader
// needs all of it. A file on disk is read in pieces, so files over 2 GiB
// work too. A pipe, or standard input (-), has no size to go by, so it is
// read until it ends.
function readAll(path) {
  const stdin = path === '-';
  if (stdin && require('tty').isatty(0)) throw new UsageError('- reads the snapshot from standard input. Pipe one in, such as: cat backup.db | node revisions/cli.js -');
  const fd = stdin ? 0 : fs.openSync(path, 'r');
  try {
    const st = fs.fstatSync(fd);
    if (st.isDirectory()) throw Object.assign(new Error('EISDIR'), { code: 'EISDIR' });
    if (st.isFile()) {
      const size = st.size;
      const out = new Uint8Array(size);
      const CHUNK = 64 * 1024 * 1024;
      let at = 0;
      while (at < size) {
        const n = fs.readSync(fd, out, at, Math.min(CHUNK, size - at), at);
        if (n <= 0) break;
        at += n;
      }
      return at < size ? out.subarray(0, at) : out;
    }
    let buf = new Uint8Array(1024 * 1024), len = 0;
    for (;;) {
      if (len === buf.length) { const more = new Uint8Array(buf.length * 2); more.set(buf); buf = more; }
      let n;
      try { n = fs.readSync(fd, buf, len, buf.length - len, null); } catch (e) {
        // A pipe set not to block says EAGAIN while it waits for more.
        if (e.code === 'EAGAIN') { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); continue; }
        if (e.code === 'EOF') break;
        throw e;
      }
      if (n === 0) break;
      len += n;
    }
    return buf.subarray(0, len);
  } finally { if (!stdin) fs.closeSync(fd); }
}

function open(path) {
  const snap = R.read(readAll(path), { hash: false });
  if (snap.hash) snap.hash.check(crypto.createHash('sha256').update(snap.hash.body).digest('hex'));
  return snap;
}

// Unified diff lines with three lines of context around each change.
function changes(a, b) {
  const d = R.diffLines(a, b);
  if (!d) return ['  (too long to compare line by line)'];
  const keep = new Set();
  d.forEach((l, i) => { if (l[0] !== ' ') for (let j = i - 3; j <= i + 3; j++) keep.add(j); });
  const out = [];
  let last = -1;
  d.forEach((l, i) => {
    if (!keep.has(i)) return;
    if (last >= 0 && i > last + 1) out.push('  ...');
    out.push(l);
    last = i;
  });
  return out.length ? out : ['  (no change in the value)'];
}

function summary(snap, path, opt) {
  const r = R.report(snap, opt);
  const out = [];
  const say = (s) => out.push(s);
  const etcd = snap.storageVersion ? 'etcd ' + snap.storageVersion.replace(/\.0$/, '') : snap.clusterVersion ? 'etcd ' + snap.clusterVersion.replace(/\.0$/, '') : 'etcd';
  say(`${path === '-' ? 'Standard input' : path}: ${snap.hash ? 'a snapshot' : 'a member\'s database file'}, ${R.human(snap.fileBytes)}, written by ${etcd}`);
  if (snap.hash) say(`SHA-256 at the end: ${snap.hash.ok ? 'matches' : 'DOES NOT MATCH; the file was changed or cut short'}`);
  say(`Revision ${fmt(snap.revision)}${snap.compactedAt ? ', compacted at ' + fmt(snap.compactedAt) : ', never compacted'}. ${plural(snap.liveKeys, 'key', 'keys')}, ${plural(snap.revisions, 'revision', 'revisions')} kept, ${plural(snap.tombstones, 'deletion', 'deletions')}.`);
  say(`Database ${R.human(r.size.database)}, ${(100 * r.size.quotaUsed).toFixed(r.size.quotaUsed < 0.01 ? 2 : 1)}% of a ${R.human(r.size.quota)} quota: ${R.human(r.size.inUse)} in use, ${R.human(r.size.free)} in free pages.`);
  say(`Data: ${R.human(snap.liveBytes)} of current values, ${R.human(snap.historyBytes)} of old revisions and deletions.`);
  const members = snap.members.map((m) => (m.name || m.id) + (m.learner ? ' (learner)' : '')).join(', ');
  say(`Members: ${members || 'none recorded'}. Alarms: ${snap.alarms.length ? snap.alarms.map((a) => a.alarm + ' on ' + a.member).join(', ') : 'none'}. Authentication ${snap.authEnabled ? 'on' : 'off'}. ${plural(snap.leases.size, 'lease', 'leases')}.`);
  say('');
  say('What to look at');
  if (!r.findings.length) say('  Nothing stands out.');
  const mark = { bad: '!!', warn: '! ', info: 'i ', ok: 'ok' };
  for (const f of r.findings) { say(`  ${mark[f.level]} ${f.title}`); say(`     ${f.text}`); }
  if (r.kubernetes) {
    say('');
    say('Kubernetes resources');
    say('  objects         now  old revisions  revisions  resource');
    for (const x of r.kubernetes.resources.slice(0, opt.top)) say(`  ${fmt(x.keys).padStart(7)} ${R.human(x.bytes).padStart(11)} ${R.human(x.historyBytes).padStart(14)} ${fmt(x.revisions).padStart(10)}  ${x.resource}`);
    if (r.kubernetes.resources.length > opt.top) say(`  and ${plural(r.kubernetes.resources.length - opt.top, 'more', 'more')}; --top shows more`);
  }
  say('');
  say(`Key prefixes, ${opt.depth} levels deep`);
  say('     keys         now  old revisions  prefix');
  for (const p of r.prefixes) say(`  ${fmt(p.liveKeys).padStart(7)} ${R.human(p.bytes).padStart(11)} ${R.human(p.historyBytes).padStart(14)}  ${p.prefix}`);
  say('');
  say('Biggest keys');
  say('        now  revisions  key');
  for (const k of r.biggestKeys.filter((x) => x.live)) say(`  ${R.human(k.bytes).padStart(9)} ${fmt(k.revisions).padStart(10)}  ${k.key}${k.kind ? '  (' + k.kind + ')' : ''}`);
  const most = r.mostRevisions.filter((x) => x.revisions > 1);
  if (most.length) {
    say('');
    say('Most revisions kept');
    say('  revisions  old revisions  key');
    for (const k of most) say(`  ${fmt(k.revisions).padStart(9)} ${R.human(k.historyBytes).padStart(14)}  ${k.key}${k.live ? '' : '  (deleted)'}`);
  }
  if (snap.problems.length) { say(''); say('Problems reading the file'); for (const p of snap.problems.slice(0, 20)) say('  ' + p); }
  return out.join('\n');
}

function main(argv) {
  const opt = { top: 20, depth: 3, quota: 2 * R.GiB };
  let path = null, mode = 'summary', key = null, revision = null, under = '', json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new UsageError(a + ' needs a value after it. Try --help.');
      return argv[++i];
    };
    if (a === '--help' || a === '-h') { console.log(HELP); return 0; }
    else if (a === '--keys') mode = 'keys';
    else if (a === '--prefixes') mode = 'prefixes';
    else if (a === '--json') json = true;
    else if (a === '--history') { mode = 'history'; key = value(); }
    else if (a === '--value') { mode = 'value'; key = value(); }
    else if (a === '--revision') revision = Number(value());
    else if (a === '--under') under = value();
    else if (a === '--top') opt.top = Number(value());
    else if (a === '--depth') opt.depth = Number(value());
    else if (a === '--quota') opt.quota = R.parseSize(value());
    else if (a.startsWith('--')) throw new UsageError('Unknown option ' + a + '. Try --help.');
    else path = a;
  }
  if (!path) throw new UsageError('Name a snapshot file. Try --help.');
  if (!(opt.top >= 1) || !Number.isInteger(opt.top)) throw new UsageError('--top needs a whole number of 1 or more.');
  if (!(opt.depth >= 1) || !Number.isInteger(opt.depth)) throw new UsageError('--depth needs a whole number of 1 or more.');
  if (!(opt.quota > 0)) throw new UsageError('--quota needs a size, such as 8GiB.');
  if (revision !== null && !(Number.isInteger(revision) && revision > 0)) throw new UsageError('--revision needs a revision number.');

  const snap = open(path);
  // An alarm, a full database or a hash that doesn't match gives exit
  // status 1 whatever is printed, so a script checking a backup can rely on
  // it. The summary shows why; with the other options, stderr says.
  const bad = R.findings(snap, opt.quota).filter((f) => f.level === 'bad');
  const done = () => {
    for (const f of bad) console.error('!! ' + f.title);
    return bad.length ? 1 : 0;
  };

  if (mode === 'summary') {
    console.log(json ? JSON.stringify(R.report(snap, opt), null, 2) : summary(snap, path, opt));
    return bad.length ? 1 : 0;
  }
  if (mode === 'keys') {
    const rows = [...snap.keys.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const all = rows.map((e) => {
      const last = e.history[e.history.length - 1];
      return { key: e.key, live: e.live, revisions: e.revisions, bytes: e.bytes, historyBytes: e.historyBytes, createRevision: last.createRevision, modRevision: e.modRevision,
        version: last.version, lease: e.lease || null, kind: e.what && e.what.kind ? (e.what.apiVersion ? e.what.apiVersion + ' ' : '') + e.what.kind : null };
    });
    if (json) { console.log(JSON.stringify(all, null, 2)); return done(); }
    const lines = ['key,live,revisions,bytes,history_bytes,create_revision,mod_revision,version,lease,kind'];
    for (const k of all) lines.push([csv(k.key), k.live, k.revisions, k.bytes, k.historyBytes, k.createRevision, k.modRevision, k.version, k.lease || '', csv(k.kind || '')].join(','));
    process.stdout.write(lines.join('\n') + '\n');
    return done();
  }
  if (mode === 'prefixes') {
    const list = R.prefixes(snap, opt.depth, under);
    if (json) { console.log(JSON.stringify(list, null, 2)); return done(); }
    console.log('prefix,keys,live_keys,bytes,history_bytes,revisions');
    for (const p of list) console.log([csv(p.prefix), p.keys, p.liveKeys, p.bytes, p.historyBytes, p.revisions].join(','));
    return done();
  }
  const h = R.history(snap, key);
  if (!h) { console.error('The file has no key ' + JSON.stringify(key) + '.'); done(); return 1; }
  if (mode === 'history') {
    if (json) {
      console.log(JSON.stringify(h.map((x) => ({ revision: x.revision, sub: x.sub, deleted: x.deleted, version: x.version, createRevision: x.createRevision, lease: x.lease || null, bytes: x.bytes })), null, 2));
      return done();
    }
    let prev = null;
    console.log(`${key}: ${plural(h.length, 'revision', 'revisions')} kept${snap.compactedAt ? '. The file was compacted at revision ' + fmt(snap.compactedAt) + ', which keeps the value each key had then and the ones after' : ''}`);
    for (const x of h) {
      console.log('');
      if (x.deleted) { console.log(`Revision ${fmt(x.revision)}: deleted`); prev = null; continue; }
      console.log(`Revision ${fmt(x.revision)}: version ${x.version}, ${R.human(x.bytes)}${x.lease ? ', lease ' + x.lease : ''}${x.version === 1 ? ', created' : ''}`);
      const t = R.valueText(x.value).replace(/\n$/, '');
      for (const l of prev === null ? t.split('\n').map((s) => '  ' + s) : changes(prev, t)) console.log(l);
      prev = t;
    }
    return done();
  }
  // --value
  const pick = revision === null ? h[h.length - 1] : h.filter((x) => x.revision <= revision).pop();
  if (!pick || pick.deleted) {
    console.error(revision === null ? 'The key was deleted at revision ' + fmt(h[h.length - 1].revision) + '.' : 'The file keeps no value of this key at revision ' + fmt(revision) + '.');
    done();
    return 1;
  }
  if (json) {
    const k = R.kubernetesObject(pick.value);
    process.stdout.write((k && k.known ? R.toJson(k.object, 2) : JSON.stringify(R.valueText(pick.value))) + '\n');
  } else process.stdout.write(R.valueText(pick.value).replace(/\n?$/, '\n'));
  return done();
}

class UsageError extends Error {}

// Stop quietly when the output is piped into something like head that closes early.
process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); throw e; });
try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  if (e instanceof UsageError) console.error(e.message);
  else if (e instanceof R.SnapshotError) {
    console.error(e.message);
    if (e.code === 'gzip') console.error('Or unpack it on the way in: zcat backup.db.gz | node revisions/cli.js -');
  }
  else if (e.code === 'ENOENT') console.error('No such file: ' + e.path);
  else if (e.code === 'EISDIR') console.error('That is a folder, not a file.');
  else console.error('Could not read the file: ' + e.message);
  process.exitCode = 2;
}
