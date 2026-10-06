#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Command line for the ACL Builder. Run "node acl/cli.js --help".

'use strict';
const fs = require('fs');
const A = require('./acl.js');

const HELP = `ACL Builder: ACL rules the way each Redis and Valkey version applies them.

Usage:
  node acl/cli.js explain RULES...            What a user with these rules can do, the line ACL LIST
                                              prints, and what deserves a second look. RULES are the
                                              arguments of ACL SETUSER: on ">pass word" ~app:* +@read
  node acl/cli.js explain --file users.acl    Each user of an ACL file (ACL LOAD's errors if it has any)
  node acl/cli.js explain --config redis.conf The user lines of a config file
  node acl/cli.js check RULES... -- COMMAND ARG...
                                              Whether a user with these rules may run the command: the
                                              reply ACL DRYRUN gives and the error the command gets
  node acl/cli.js check RULES... --commands cmds.txt
                                              The same for each line of a file (MONITOR output works)
  node acl/cli.js build monitor.txt [--name app] [--exact] [--client ADDR]
                                              Draft the least a client needs from what MONITOR showed it
                                              doing ("-" reads stdin), and check every line against it
  node acl/cli.js keys COMMAND ARG...         The keys and their flags, as COMMAND GETKEYSANDFLAGS says
  node acl/cli.js --versions                  The versions it knows

Options:
  --server VERSION  redis-7.2, "valkey 9.1", 8 (the newest 8.x of either); default: the newest Redis
  --db N            The client's database, for Valkey 9.1's db= rules (default 0)
  --pubsub-default allchannels|resetchannels
                    The server's acl-pubsub-default (default: the version's own default)
  --password PASS   For build: the password to put in the rules (default: a placeholder)
  --json            Print JSON

Exit status: 0 when the rules are valid and the commands allowed; 1 when the server refuses the rules
or a command; 2 for a problem with the input.`;

function parseArgs(argv) {
  const opt = { mode: null, rules: [], command: null, file: null, config: null, commands: null, server: null, db: 0, json: false, name: 'app', exact: false, client: null, password: null, pubsub: null };
  let i = 0;
  if (argv[0] && !argv[0].startsWith('--')) opt.mode = argv[i++];
  for (; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(a + ' needs a value.');
      return argv[++i];
    };
    if (a === '--') { opt.command = argv.slice(i + 1); break; }
    if (a === '--help' || a === '-h') opt.help = true;
    else if (a === '--versions') opt.versions = true;
    else if (a === '--server' || a === '--version') opt.server = next();
    else if (a === '--db') opt.db = Number(next());
    else if (a === '--json') opt.json = true;
    else if (a === '--file') opt.file = next();
    else if (a === '--config') opt.config = next();
    else if (a === '--commands') opt.commands = next();
    else if (a === '--name') { opt.name = next(); opt.nameGiven = true; }
    else if (a === '--exact') opt.exact = true;
    else if (a === '--client') opt.client = next();
    else if (a === '--password') opt.password = next();
    else if (a === '--pubsub-default') opt.pubsub = next();
    else opt.rules.push(a);
  }
  return opt;
}

function version(spec) {
  if (!spec) return A.versions().filter((v) => v.server === 'redis').pop().id;
  const id = A.findVersion(spec);
  if (!id) throw new Error('No version matches "' + spec + '". Run with --versions to list them.');
  return id;
}

const bin = (s) => A.toBinary(s);
const show = (s) => A.fromBinary(s);
const read = (path) => (path === '-' ? fs.readFileSync(0) : fs.readFileSync(path));

function explainUser(u, id, opts, out) {
  const e = A.explain(u, id, opts);
  out.push(e.line ? show(e.line) : 'user ' + show(u.name) + ': listing it crashes the server (' + e.crash + ')');
  out.push('  Login: ' + e.login.text);
  if (e.everyone.length) out.push('  Any user may run ' + e.everyone.join(', ') + ', whatever the rules say.');
  e.selectors.forEach((s) => {
    out.push('  ' + s.title + ':');
    for (const r of s.rules) out.push('    ' + show(r.rule).padEnd(22) + ' ' + r.text);
    out.push('    Commands: ' + s.commands.text);
    if (s.keysText) out.push('    Keys: ' + s.keysText);
    else for (const k of s.keys) out.push('    Keys: ' + show(k.text));
    if (s.channelsText) out.push('    Channels: ' + s.channelsText);
    else for (const c of s.channels) out.push('    Channels: ' + show(c.text));
    if (s.databases) out.push('    Databases: ' + s.databases.text);
  });
  for (const w of e.warnings) out.push('  ' + (w.level === 'bad' ? 'Problem' : w.level === 'warn' ? 'Warning' : 'Note') + ': ' + w.title + '. ' + show(w.text));
  return e;
}

function run(argv) {
  const opt = parseArgs(argv);
  if (opt.help || (!opt.mode && !opt.versions)) { console.log(HELP); return opt.help ? 0 : 2; }
  if (opt.versions) {
    for (const v of A.versions()) console.log(v.id.padEnd(16) + ' ' + v.label);
    return 0;
  }
  const id = version(opt.server);
  const opts = { db: opt.db, pubsubDefault: opt.pubsub || undefined };
  const out = [];
  const json = {};
  let status = 0;
  const label = A.versions().find((v) => v.id === id).label;

  if (opt.mode === 'explain' || opt.mode === 'check') {
    let users = [];
    if (opt.file) {
      const r = A.loadFile(read(opt.file), id, Object.assign({ filename: opt.file }, opts));
      if (r.crash) { out.push(`ACL LOAD of ${opt.file} crashes ${label}: ${r.crash}.`); status = 1; }
      else if (!r.ok) { out.push(`ACL LOAD of ${opt.file} with ${label} fails:`); out.push('  (error) ERR ' + show(r.error)); status = 1; json.error = show(r.error); }
      else users = [...r.users.values()].filter((u) => u.name !== 'default' || /^user default /m.test(show(A.toBinary(read(opt.file)))));
    } else if (opt.config) {
      const text = bin(read(opt.config).toString('latin1'));
      const kv = A.getVersion(id);
      const lines = [];
      const state = {};
      let failed = false;
      show(text).split('\n').forEach((l, n) => {
        if (failed) return;
        const argv = A.splitArgs(bin(l.trim()), kv.f.split);
        if (!argv || argv.length < 2 || argv[0].toLowerCase() !== 'user') return;
        const e = A.checkUserLine(argv, id, Object.assign({ state: state }, opts));
        if (e) { out.push(`${opt.config}:${n + 1}: the server stops reading the file: ${show(e)}`); failed = true; status = 1; return; }
        lines.push(argv);
      });
      if (!failed) {
        const r = A.startupUsers(lines, id, opts);
        if (r.log) { out.push(`${label} reads the file, then stops while starting:`); for (const l of r.log) out.push('  ' + show(l)); status = 1; }
        else users = lines.map((argv) => r.users.get(argv[1]));
      }
    } else {
      // The rules as separate arguments, or all in one quoted argument.
      let name = opt.nameGiven ? opt.name : 'user', args = opt.rules.map(bin);
      if (opt.rules.length === 1 && /\s/.test(opt.rules[0])) {
        const parsed = A.readRules(opt.rules[0], id);
        if (parsed.error || !parsed.users.length || !parsed.users[0].name) throw new Error('Can\'t read the rules: ' + (parsed.error || 'no user'));
        name = opt.nameGiven ? opt.name : parsed.users[0].name;
        args = parsed.users[0].args;
      } else if (args.length >= 3 && /^acl$/i.test(opt.rules[0]) && /^setuser$/i.test(opt.rules[1])) { name = args[2]; args = args.slice(3); }
      else if (args.length >= 2 && /^user$/i.test(opt.rules[0])) { name = args[1]; args = args.slice(2); }
      const r = A.setUser(null, name, args, id, opts);
      if (!r.ok) {
        out.push(`ACL SETUSER with ${label}:`);
        out.push('  (error) ERR ' + show(r.error));
        status = 1;
        json.error = show(r.error);
      } else users = [r.user];
    }
    json.users = [];
    for (const u of users) {
      if (opt.mode === 'explain') json.users.push(explainUser(u, id, opts, out));
      else json.users.push({ name: show(u.name) });
      if (users.length > 1) out.push('');
    }
    if (opt.mode === 'check' && users.length === 1) {
      const u = users[0];
      const lines = opt.commands ? A.parseMonitor(read(opt.commands).toString('latin1')).map((e) => ({ argv: e.argv, db: e.db, line: e.line })) : opt.command ? [{ argv: opt.command.map(bin), db: null, line: null }] : [];
      if (!lines.length) throw new Error('Give a command after --, or a file with --commands.');
      json.checks = [];
      for (const e of lines) {
        const r = A.check(u, e.argv, id, Object.assign({}, opts, { db: e.db != null ? e.db : opt.db }));
        json.checks.push({ command: e.argv.map(show), allowed: r.allowed, reason: r.reason, dryrun: r.dryrun, reply: r.reply });
        const cmd = e.argv.map((a) => show(A.quote(a))).join(' ');
        if (r.allowed && !r.reply) out.push('allowed  ' + cmd);
        else {
          if (!r.allowed) status = 1;
          out.push((r.allowed ? 'allowed  ' : 'DENIED   ') + cmd);
          if (r.dryrun && r.dryrun.reply && r.dryrun.reply !== 'OK') out.push('         ACL DRYRUN: "' + show(r.dryrun.reply) + '"');
          if (r.dryrun && r.dryrun.error) out.push('         ACL DRYRUN: (error) ERR ' + show(r.dryrun.error));
          if (r.reply) out.push('         The command gets: (error) ' + show(r.reply.error));
        }
      }
    }
  } else if (opt.mode === 'build') {
    if (!opt.rules[0]) throw new Error('Give a file of MONITOR output, or - for stdin.');
    const entries = A.parseMonitor(read(opt.rules[0]).toString('latin1'));
    const b = A.build(entries, id, Object.assign({}, opts, { name: opt.name, keys: opt.exact ? 'exact' : 'prefix', client: opt.client, password: opt.password }));
    Object.assign(json, b);
    out.push(`For ${label}, from ${entries.length} command lines:`);
    out.push('');
    out.push(show(b.setuser));
    out.push('');
    out.push('In an ACL file (the password as its SHA-256):');
    out.push(show(b.aclfile));
    out.push('');
    out.push('Commands: ' + b.commands.map((c) => c.command + ' (' + c.count + ')').join(', '));
    const denied = b.check.filter((c) => !c.allowed);
    out.push(denied.length ? denied.length + ' lines are still refused:' : 'Every line it read is allowed with these rules.');
    for (const c of denied) out.push('  line ' + c.line + ': ' + c.argv.map((a) => show(A.quote(a))).join(' ') + ' (' + c.reason + ')');
    if (b.skipped.length) out.push(b.skipped.length + ' lines skipped: ' + b.skipped.slice(0, 5).map((s) => 'line ' + s.line + ' (' + s.reason + ')').join(', ') + (b.skipped.length > 5 ? ', ...' : ''));
    if (b.approximate) out.push('Some keys or channels have spaces, which ACL patterns can\'t hold; ? stands in for them.');
    if (!opt.password) out.push('Replace CHANGE-ME with a long random password (ACL GENPASS makes one).');
    if (denied.length || b.error) status = 1;
  } else if (opt.mode === 'keys') {
    const argv = opt.rules.concat(opt.command || []).map(bin);
    const r = A.getKeys(argv, id);
    Object.assign(json, r);
    if (r.error) { out.push('(error) ERR ' + r.error); status = 1; }
    else for (const [k, f] of r.keys) out.push(show(k) + '  ' + f.join(' '));
  } else {
    throw new Error('Unknown command ' + opt.mode + '. Run with --help.');
  }
  if (opt.json) console.log(JSON.stringify(Object.assign({ version: id }, json), (k, v) => (typeof v === 'string' ? show(v) : v), 2));
  else console.log(out.join('\n'));
  return status;
}

if (require.main === module) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exitCode = 2;
  }
}
module.exports = { run: run };
