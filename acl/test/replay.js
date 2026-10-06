// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Replays fixtures/runs.json.gz, recorded from the real servers by
// generate/record.py, through acl.js and lists every place where acl.js
// says something different. The tests use it; run it by hand to see the
// differences:
//
//   node acl/test/replay.js [version ...] [--kind setuser,dryrun,...] [--max N]

'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const A = require('../acl.js');

function load(file) {
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(file || path.join(__dirname, 'fixtures', 'runs.json.gz'))).toString('utf8'));
}

// Redis 6.2 and 7.0 list single commands in hash table order, which changes
// from run to run: compare those as a set.
function canonical(line, versionId) {
  if (line == null || !/^redis-(6\.2|7\.0)\./.test(versionId)) return line;
  const tokens = line.split(' ');
  const out = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    const bare = t.replace(/^\(/, '');
    if (bare === '+@all' || bare === '-@all') {
      out.push(t);
      i++;
      while (i < tokens.length && /^[+-]@/.test(tokens[i]) && !tokens[i - 1].endsWith(')')) out.push(tokens[i++]);
      const rest = [];
      let closed = false;
      while (i < tokens.length && !closed) {
        if (tokens[i - 1].endsWith(')') && tokens[i].startsWith('(')) break;
        closed = tokens[i].endsWith(')');
        rest.push(tokens[i].replace(/\)$/, ''));
        i++;
      }
      rest.sort();
      out.push(...rest);
      if (closed) out[out.length - 1] += ')';
      continue;
    }
    out.push(t);
    i++;
  }
  return out.join(' ');
}

function listOf(user, vid) {
  const r = A.listLine(user, vid);
  return r.crash ? { crash: r.crash } : r.line;
}

function replaySetuser(vid, cases, out) {
  // After a case on the default user the recorder resets it and gives it
  // every right again; "reset" sets sanitize-payload where the version has it.
  let restored = null;
  for (const c of cases) {
    let user = c.name === 'default' ? (restored || A.defaultUser(vid)) : null;
    // A crash restarts the server, with a new default user.
    if (c.steps.some((st) => st.crash !== undefined)) restored = null;
    if (c.name === 'default') restored = A.setUser(A.defaultUser(vid), 'default', ['reset', 'on', 'nopass', '~*', '&*', '+@all'], vid).user;
    for (const step of c.steps) {
      const r = A.setUser(user, c.name, step.args, vid);
      const where = 'SETUSER ' + JSON.stringify(c.name) + ' ' + JSON.stringify(step.args);
      if (step.error !== undefined) {
        if (r.ok) out.push(where + ': server says ' + JSON.stringify(step.error) + ', acl.js accepts it');
        else if (r.error !== step.error) out.push(where + ':\n  server:  ' + JSON.stringify(step.error) + '\n  acl.js:  ' + JSON.stringify(r.error));
        continue;
      }
      if (!r.ok) { out.push(where + ': server accepts it, acl.js says ' + JSON.stringify(r.error)); break; }
      user = r.user;
      const mine = listOf(user, vid);
      if (step.crash !== undefined) {
        if (!mine || !mine.crash) out.push(where + ': the server crashed listing it (' + step.crash + '); acl.js lists ' + JSON.stringify(mine));
        break;
      }
      if (mine && mine.crash) { out.push(where + ': acl.js says the server crashes (' + mine.crash + '); it lists ' + JSON.stringify(step.list)); break; }
      if (canonical(mine, vid) !== canonical(step.list, vid)) out.push(where + ':\n  server:  ' + JSON.stringify(step.list) + '\n  acl.js:  ' + JSON.stringify(mine));
    }
  }
}

function listAll(users, vid) {
  const names = [...users.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return names.map((n) => listOf(users.get(n), vid));
}

function replayAclfile(vid, cases, out) {
  for (const c of cases) {
    const r = A.loadFile(c.file, vid, { filename: 'users.acl' });
    const where = 'ACL LOAD ' + JSON.stringify(c.file);
    if (c.crash !== undefined) {
      // The crash comes with ACL LOAD itself or with the ACL LIST after it.
      const listed = r.ok ? listAll(r.users, vid) : [];
      if (!r.crash && !listed.some((l) => l && l.crash)) out.push(where + ': the server crashed (' + c.crash + '); acl.js says ' + JSON.stringify(r.error || 'OK'));
      continue;
    }
    if (r.crash) { out.push(where + ': acl.js says it crashes; server says ' + JSON.stringify(c.error || 'OK')); continue; }
    if (c.error !== undefined) {
      if (r.ok) out.push(where + ': server says ' + JSON.stringify(c.error) + ', acl.js loads it');
      else if (r.error !== c.error) out.push(where + ':\n  server:  ' + JSON.stringify(c.error) + '\n  acl.js:  ' + JSON.stringify(r.error));
      continue;
    }
    if (!r.ok) { out.push(where + ': server loads it, acl.js says ' + JSON.stringify(r.error)); continue; }
    if (!Array.isArray(c.list)) continue;
    const mine = listAll(r.users, vid).map((l) => canonical(l, vid));
    const theirs = (Array.isArray(c.list) ? c.list : []).map((l) => canonical(l, vid));
    if (JSON.stringify(mine) !== JSON.stringify(theirs)) out.push(where + ':\n  server:  ' + JSON.stringify(theirs) + '\n  acl.js:  ' + JSON.stringify(mine));
  }
}

// What a server printed when it stopped while reading a config file.
const FATAL = '\n*** FATAL CONFIG FILE ERROR';
const ACL_LOG = /^(Spaces not allowed in ACL usernames|Error loading ACL rule .*|Critical error while loading ACLs\. Exiting\.|Configuring .* with users defined in .* but not both\.)$/;
function exitOf(text) {
  const i = text.indexOf(FATAL);
  if (i >= 0) {
    const m = /\nReading the configuration file, at line (\d+)\n>>> '(.*)'\n([\s\S]*)\n$/.exec(text.slice(i));
    return { fatal: m ? { line: Number(m[1]), message: m[3] } : text.slice(i) };
  }
  const log = [];
  for (const line of text.split('\n')) {
    const m = /^\d+:[A-Z] \d+ \w+ \d+ [\d:.]+ (.) (.*)$/.exec(line);
    if (m && m[1] === '#' && ACL_LOG.test(m[2])) log.push(m[2]);
  }
  return { log: log };
}

function replayConfig(vid, cases, out) {
  const K = require('../../config/config.js');
  for (const c of cases) {
    const where = 'config ' + JSON.stringify(c.config);
    const lines = c.config.split('\n').slice(0, -1);
    // The user lines, split the way the config loader splits them.
    let fatal = null;
    const users = [];
    const seen = new Set();
    let aclfile = false, pubsub = null;
    const state = {};
    lines.forEach((text, i) => {
      if (fatal) return;
      const argv = A.splitArgs(text, A.getVersion(vid).f.split);
      if (argv[0] === 'aclfile') aclfile = true;
      if (argv[0] === 'acl-pubsub-default') pubsub = argv[1];
      if (argv[0] !== 'user') return;
      if (!/^redis-6\./.test(vid) && seen.has(argv[1])) { fatal = { line: i + 1, message: 'Error in user declaration \'' + A._internal.cstr(argv[1]) + '\': Duplicate user found. A user can only be defined once in config files' }; return; }
      const e = A.checkUserLine(argv, vid, { pubsubDefault: pubsub, state: state });
      if (e) { fatal = { line: i + 1, message: e }; return; }
      seen.add(argv[1]);
      users.push(argv);
    });
    if (c.exit !== undefined) {
      const want = exitOf(c.exit);
      if (want.fatal) {
        if (!fatal) out.push(where + ': server stops with ' + JSON.stringify(want.fatal) + ', acl.js finds no error');
        else if (fatal.line !== want.fatal.line || fatal.message !== want.fatal.message) out.push(where + ':\n  server:  ' + JSON.stringify(want.fatal) + '\n  acl.js:  ' + JSON.stringify(fatal));
        continue;
      }
      if (fatal) { out.push(where + ': server stops at startup ' + JSON.stringify(want.log) + '; acl.js says ' + JSON.stringify(fatal)); continue; }
      if (aclfile) continue;
      const r = A.startupUsers(users, vid, { pubsubDefault: pubsub });
      const mine = r.log || [];
      if (JSON.stringify(mine) !== JSON.stringify(want.log)) out.push(where + ':\n  server:  ' + JSON.stringify(want.log) + '\n  acl.js:  ' + JSON.stringify(mine));
      continue;
    }
    if (fatal) { out.push(where + ': server starts; acl.js says ' + JSON.stringify(fatal)); continue; }
    const r = A.startupUsers(users, vid, { pubsubDefault: pubsub });
    if (r.log) { out.push(where + ': server starts; acl.js says it stops with ' + JSON.stringify(r.log)); continue; }
    if (c.crash) {
      if (!listAll(r.users, vid).some((l) => l && l.crash)) out.push(where + ': server crashed listing users: ' + c.crash + '; acl.js lists them');
      continue;
    }
    const mine = listAll(r.users, vid).map((l) => canonical(l, vid));
    const theirs = (Array.isArray(c.list) ? c.list : []).map((l) => canonical(l, vid));
    if (JSON.stringify(mine) !== JSON.stringify(theirs)) out.push(where + ':\n  server:  ' + JSON.stringify(theirs) + '\n  acl.js:  ' + JSON.stringify(mine));
  }
}

// A user made the way the recorder made it: ACL SETUSER fzu reset rules...
function userOf(rules, vid) {
  const r = A.setUser(null, 'fzu', ['reset'].concat(rules), vid);
  return r.ok ? r.user : null;
}

function replayDryrun(vid, cases, out) {
  for (const c of cases) {
    const u = userOf(c.rules, vid);
    if (!u) { out.push('user ' + JSON.stringify(c.rules) + ': acl.js refuses the rules'); continue; }
    for (const [argv, want] of c.checks) {
      const r = A.check(u, argv, vid, { db: c.db || 0 });
      const mine = r.dryrun.error !== undefined ? { error: r.dryrun.error } : r.dryrun.reply;
      if (JSON.stringify(mine) !== JSON.stringify(want)) out.push('DRYRUN ' + JSON.stringify(c.rules) + (c.db ? ' db ' + c.db : '') + ' ' + JSON.stringify(argv) + ':\n  server:  ' + JSON.stringify(want) + '\n  acl.js:  ' + JSON.stringify(mine));
    }
  }
}

function replayMulti(vid, cases, out) {
  for (const c of cases) {
    const u = userOf(c.rules, vid);
    if (!u) { out.push('user ' + JSON.stringify(c.rules) + ': acl.js refuses the rules'); continue; }
    for (const [argv, want] of c.checks) {
      const r = A.check(u, argv, vid, { multi: true });
      const mine = r.reply ? { error: r.reply.error.replace(/^ERR /, '') } : 'QUEUED';
      if (JSON.stringify(mine) !== JSON.stringify(want)) out.push('MULTI ' + JSON.stringify(c.rules) + ' ' + JSON.stringify(argv) + ':\n  server:  ' + JSON.stringify(want) + '\n  acl.js:  ' + JSON.stringify(mine));
    }
  }
}

function replayGetkeys(vid, cases, out) {
  const six = /^redis-6\./.test(vid);
  for (const [argv, want] of cases) {
    const r = A.getKeys(argv, vid);
    const mine = r.error !== undefined ? { error: r.error } : six ? r.keys.map((k) => k[0]) : r.keys;
    let theirs = want;
    // The server checks the arity of COMMAND GETKEYS itself first.
    if (want && want.error && /^wrong number of arguments for 'command/.test(want.error)) continue;
    if (JSON.stringify(mine) !== JSON.stringify(theirs)) out.push('GETKEYS ' + JSON.stringify(argv) + ':\n  server:  ' + JSON.stringify(theirs) + '\n  acl.js:  ' + JSON.stringify(mine));
  }
}

const KINDS = { setuser: replaySetuser, aclfile: replayAclfile, config: replayConfig, dryrun: replayDryrun, multi: replayMulti, getkeys: replayGetkeys };

// Every difference for one version's recording, as text lines.
function differences(vid, rec, kinds) {
  const out = {};
  for (const kind of kinds || Object.keys(KINDS)) {
    if (!rec[kind] || !KINDS[kind]) continue;
    const list = [];
    KINDS[kind](vid, rec[kind], list);
    out[kind] = list;
  }
  return out;
}

module.exports = { load: load, differences: differences, canonical: canonical, KINDS: KINDS };

if (require.main === module) {
  const args = process.argv.slice(2);
  let kinds = null, max = 10, file = null;
  const vids = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--kind') kinds = args[++i].split(',');
    else if (args[i] === '--max') max = Number(args[++i]);
    else if (args[i] === '--file') file = args[++i];
    else vids.push(args[i]);
  }
  const all = load(file);
  for (const vid of vids.length ? vids : Object.keys(all)) {
    const d = differences(vid, all[vid], kinds);
    for (const [kind, list] of Object.entries(d)) {
      console.log(vid, kind, list.length ? list.length + ' differences' : 'same');
      for (const line of list.slice(0, max)) console.log('  ' + line.replace(/\n/g, '\n  '));
    }
  }
}
