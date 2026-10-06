#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Command line for the Memory Calculator. Run "node memory/cli.js --help".

'use strict';
const fs = require('fs');
const M = require('./memory.js');

const HELP = `Memory Calculator: how much memory Redis and Valkey use for your keys, version by version.

Usage:
  node memory/cli.js "GROUP" ["GROUP" ...]   The memory these keys take on one server
  node memory/cli.js --file dataset.txt      The same, one group per line ("-" reads stdin)
  node memory/cli.js ... --compare           Every version side by side
  node memory/cli.js ... --pack N            String keys packed into hashes of N fields instead
  node memory/cli.js --versions              The versions it knows

A group is a line such as:
  1m strings key=24 value=100 ttl=30%
  50000 hashes key=16 fields=20 field=8 value=int:42
  1000 sets key=12 members=200 member=int:1000000
  200 zsets key=10 members=1000 member=12 score=1759734012.5
  100 lists key=8 items=5000 item=60 writes=each
Lengths are in bytes, or 8kb (8192) and 1mb. Counts take k, m and b: 2.5m.
int:N is a number, which the server can store as one; for fields and members
it means the numbers N, N+1, N+2 and so on. "text" in quotes gives a sample
instead of a length. ttl= is a share (30%, all, none) or a number of keys.
writes=each means one element per command (HSET, SADD ... per element) instead
of one command per key, which can size the hash tables differently. In a file,
a # starts a comment.

Options:
  --server VERSION  redis-7.2, "valkey 9.1", valkey (the newest Valkey), 8 (the
                    newest 8.x of either); default: the newest Redis
  --set NAME=VALUE  A setting other than the default, such as hash-max-listpack-entries=1024
                    or maxmemory-policy=allkeys-lru (more than one --set is fine)
  --json            Print JSON

--pack raises hash-max-listpack-entries and hash-max-listpack-value as far as
the hashes need to stay listpacks, and says so.

Exit status: 0 on success, 2 for a problem with the input.`;

function parseArgs(argv) {
  const opt = { groups: [], file: null, server: null, compare: false, pack: null, settings: {}, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(a + ' needs a value.');
      return argv[++i];
    };
    if (a === '--help' || a === '-h') opt.help = true;
    else if (a === '--versions') opt.versions = true;
    else if (a === '--server') opt.server = next();
    else if (a === '--file') {
      if (opt.file !== null) throw new Error('One --file at a time.');
      opt.file = next();
    } else if (a === '--compare') opt.compare = true;
    else if (a === '--pack') {
      const v = next();
      if (!/^\d+$/.test(v) || Number(v) < 1) throw new Error('--pack takes how many fields a hash gets, such as 100.');
      opt.pack = Number(v);
    } else if (a === '--set') {
      const m = /^([a-z-]+)=(.+)$/i.exec(next());
      if (!m) throw new Error('--set takes NAME=VALUE.');
      const name = m[1].toLowerCase();
      const key = Object.keys(M.settingNames).find((k) => M.settingNames[k] === name || M.settingNames[k].replace('listpack', 'ziplist') === name);
      if (!key) throw new Error('Unknown setting ' + m[1] + '. Known: ' + Object.values(M.settingNames).join(', ') + '.');
      if (key === 'maxmemoryPolicy') opt.settings[key] = m[2];
      else {
        if (!/^-?\d+$/.test(m[2])) throw new Error(m[1] + ' takes a whole number.');
        opt.settings[key] = Number(m[2]);
      }
    } else if (a === '--json') opt.json = true;
    else if (a.startsWith('-') && a !== '-') throw new Error('Unknown option ' + a + (a === '--version' ? '. The server version goes after --server.' : '.'));
    else opt.groups.push(a);
  }
  if (opt.pack !== null && opt.compare) throw new Error('--pack and --compare go one at a time.');
  return opt;
}

function version(spec) {
  if (!spec) return M.versions().filter((v) => v.server === 'redis').pop().id;
  const id = M.findVersion(spec);
  if (!id) throw new Error('No version matches "' + spec + '". Run with --versions to list them.');
  return id;
}

// The groups from the arguments and the file, with errors that say where.
function readGroups(opt) {
  const groups = [], errors = [];
  opt.groups.forEach((text, i) => {
    const p = M.parse(text);
    const many = /[\r\n]/.test(text.trim());
    for (const e of p.errors) errors.push('Group ' + (i + 1) + (many ? ', line ' + e.line : '') + ': ' + e.message);
    groups.push(...p.groups);
  });
  if (opt.file !== null) {
    const name = opt.file === '-' ? 'stdin' : opt.file;
    let text;
    try {
      text = fs.readFileSync(opt.file === '-' ? 0 : opt.file, 'utf8');
    } catch (e) {
      throw new Error("Can't read " + name + ': ' + (e.code === 'ENOENT' ? 'no such file.' : e.code === 'EISDIR' ? "it's a folder." : e.message));
    }
    const p = M.parse(text);
    for (const e of p.errors) errors.push(name + ', line ' + e.line + ': ' + e.message);
    if (!p.groups.length && !p.errors.length) errors.push(name + ' has no keys in it: one group a line, such as 1000 strings key=20 value=100.');
    groups.push(...p.groups);
  }
  if (!errors.length && groups.length && groups.every((g) => g.count === 0)) errors.push('Every group has 0 keys.');
  return { groups: groups, errors: errors };
}

function bytes(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0, x = n;
  while (Math.abs(x) >= 1024 && i < u.length - 1) { x /= 1024; i++; }
  return (i ? x.toFixed(x < 10 ? 2 : x < 100 ? 1 : 0) : String(Math.round(x))) + ' ' + u[i];
}
const whole = (n) => Math.round(n).toLocaleString('en-US');
const label = (id) => M.versions().find((v) => v.id === id).label;
const TYPE = { string: 'strings', hash: 'hashes', set: 'sets', zset: 'sorted sets', list: 'lists' };

function table(rows) {
  const w = rows[0].map((_, j) => Math.max(...rows.map((r) => String(r[j]).length)));
  return rows.map((r) => r.map((c, j) => (j === 0 ? String(c).padEnd(w[j]) : String(c).padStart(w[j]))).join('  ').trimEnd()).join('\n');
}

function report(r) {
  const lines = [];
  lines.push(label(r.version) + ': used_memory grows by ' + bytes(r.total) + ' (' + whole(r.total) + ' bytes)' +
    (r.sd >= 1 ? ', give or take ' + bytes(r.sd) : '') + ' for ' + whole(r.keys) + (r.keys === 1 ? ' key.' : ' keys.'));
  const rows = [['Keys', 'Encoding', 'Per key', 'Total']];
  for (const g of r.groups) {
    const enc = g.ttlKeys && g.encodingTtl !== g.encoding ? g.encoding + ' (' + g.encodingTtl + ' with a TTL)' : g.encoding;
    rows.push([whole(g.count) + ' ' + TYPE[g.type], enc, g.count ? whole(g.perKey) + ' B' : '-', bytes(g.bytes)]);
  }
  rows.push(['Keyspace table', whole(r.tables.keys.buckets) + ' ' + r.tables.keys.kind, '', bytes(r.tables.keys.bytes)]);
  if (r.ttlKeys) rows.push(['Expires table', whole(r.tables.expires.buckets) + ' ' + r.tables.expires.kind, '', bytes(r.tables.expires.bytes)]);
  if (r.tables.database) rows.push(['Database structs', '', '', bytes(r.tables.database)]);
  lines.push(table(rows));
  return lines.join('\n');
}

// Strings packed into hashes of n fields, with the hash limits raised as
// far as they need to be for the hashes to stay listpacks.
function packed(groups, id, settings, n) {
  const strings = groups.filter((g) => g.type === 'string');
  if (!strings.length) throw new Error('--pack packs string keys into hashes, and there are no strings.');
  const cur = Object.assign({}, M.defaults, settings);
  const vl = Math.max(...strings.map((g) => M.longest(g.value, 1)));
  const need = {};
  if (n > cur.hashMaxListpackEntries) need.hashMaxListpackEntries = n;
  if (vl > cur.hashMaxListpackValue) need.hashMaxListpackValue = vl;
  const after = groups.flatMap((g) => (g.type === 'string' ? M.pack(g, n) : [g]));
  return { groups: after, need: need, settings: Object.assign({}, settings, need) };
}

function main() {
  let opt;
  try {
    opt = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    return 2;
  }
  if (opt.help || (!opt.versions && !opt.groups.length && opt.file === null)) {
    console.log(HELP);
    return opt.help ? 0 : 2;
  }
  if (opt.versions) {
    for (const v of M.versions()) console.log(v.id.padEnd(16), v.label);
    return 0;
  }
  try {
    const id = version(opt.server);
    const { groups, errors } = readGroups(opt);
    if (errors.length) {
      for (const e of errors) console.error(e);
      return 2;
    }
    if (opt.pack !== null) {
      const before = M.estimate(groups, id, opt.settings);
      const p = packed(groups, id, opt.settings, opt.pack);
      const after = M.estimate(p.groups, id, p.settings);
      const needs = Object.keys(p.need).map((k) => (M.settingName(k, id) || M.settingNames[k]) + ' ' + p.need[k]);
      if (opt.json) {
        console.log(JSON.stringify({ before: before, after: after, groups: p.groups, settings: p.settings, needs: needs }, null, 2));
        return 0;
      }
      console.log('As they are:\n' + report(before) + '\n');
      console.log('Strings packed ' + opt.pack + ' to a hash' + (needs.length ? ', with ' + needs.join(' and ') : '') + ':\n' +
        M.format(p.groups) + '\n\n' + report(after) + '\n');
      const saved = before.total - after.total;
      console.log((saved >= 0 ? 'Saves ' : 'Costs ') + bytes(Math.abs(saved)) + ' (' + (before.total ? Math.abs(100 * saved / before.total).toFixed(1) : '0') + '%).' +
        (needs.length ? ' The hashes stay listpacks only with ' + needs.join(' and ') + '; bigger listpacks are slower to search.' : '') +
        (groups.some((g) => g.type === 'string' && (g.ttl || g.ttlCount)) ? ' A hash has one TTL for all its fields, so the strings\' TTLs are gone.' : ''));
      return 0;
    }
    if (opt.compare) {
      const all = M.compare(groups, opt.settings);
      if (opt.json) {
        console.log(JSON.stringify(all, null, 2));
        return 0;
      }
      const base = all.find((r) => r.version === id);
      const rows = [['Version', 'used_memory', 'Per key', 'vs ' + label(id)]];
      for (const r of all) {
        const d = base.total ? (r.total - base.total) / base.total * 100 : 0;
        rows.push([label(r.version), bytes(r.total), (r.total / Math.max(1, r.keys)).toFixed(1) + ' B',
          r.version === id ? '' : Math.abs(d) < 0.05 ? 'the same' : (d > 0 ? '+' : '') + d.toFixed(1) + '%']);
      }
      console.log(table(rows));
      return 0;
    }
    const r = M.estimate(groups, id, opt.settings);
    console.log(opt.json ? JSON.stringify(r, null, 2) : report(r));
    return 0;
  } catch (e) {
    console.error(e.message);
    return 2;
  }
}

process.exitCode = main();
