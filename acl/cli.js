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
  node acl/cli.js check --file users.acl -- COMMAND ARG...
                                              The same for each user of the file (or --config), or
                                              only the one --user names
  node acl/cli.js build monitor.txt [--name app] [--exact] [--client ADDR]
                                              Draft the least a client needs from what MONITOR showed it
                                              doing, and check every line against it
  node acl/cli.js keys COMMAND ARG...         The keys and their flags, as COMMAND GETKEYSANDFLAGS says
  node acl/cli.js --versions                  The versions it knows

Options:
  --server VERSION  redis-7.2, "valkey 9.1", 8 (the newest 8.x of either); default: the newest Redis
  --user NAME       With --file or --config: only this user
  --name NAME       The user's name, for RULES (default: user) and for build (default: app)
  --db N            The client's database, for Valkey 9.1's db= rules (default 0)
  --pubsub-default allchannels|resetchannels
                    The server's acl-pubsub-default (default: the version's own default)
  --exact           For build: one key pattern per key, not one per prefix
  --client ADDR     For build: only the lines of this client, and the commands its scripts ran
  --password PASS   For build: the password to put in the rules (default: a placeholder)
  --json            Print JSON

A file name can be - to read stdin.

Exit status: 0 when the rules are valid and the commands allowed (for every user it checks); 1 when
the server refuses the rules or a command; 2 for a problem with the input.`;

// A problem with what was asked: exit status 2.
class InputError extends Error {}
const fail = (message) => { throw new InputError(message); };

const VALUES = {
  '--server': 'server', '--version': 'server', '--db': 'db', '--file': 'file', '--config': 'config', '--commands': 'commands',
  '--name': 'name', '--client': 'client', '--password': 'password', '--pubsub-default': 'pubsub', '--user': 'user'
};
const FLAGS = { '--help': 'help', '-h': 'help', '--versions': 'versions', '--json': 'json', '--exact': 'exact' };

function parseArgs(argv) {
  const opt = { mode: null, rules: [], command: null, file: null, config: null, commands: null, server: null, db: 0, json: false,
    name: null, exact: false, client: null, password: null, pubsub: null, user: null };
  let i = 0;
  if (argv[0] && !argv[0].startsWith('-')) opt.mode = argv[i++];
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { opt.command = argv.slice(i + 1); break; }
    if (FLAGS[a]) { opt[FLAGS[a]] = true; continue; }
    if (VALUES[a]) {
      if (i + 1 >= argv.length) fail(a + ' needs a value.');
      opt[VALUES[a]] = argv[++i];
      continue;
    }
    // No rule starts with --, so this is a mistyped option.
    if (a.startsWith('--')) fail('Unknown option ' + a + '. Run with --help to see the options.');
    opt.rules.push(a);
  }
  if (typeof opt.db === 'string') {
    if (!/^\d+$/.test(opt.db) || Number(opt.db) > 2147483647) fail('--db takes a database number, such as 0.');
    opt.db = Number(opt.db);
  }
  if (opt.pubsub !== null) {
    opt.pubsub = opt.pubsub.toLowerCase();
    if (opt.pubsub !== 'allchannels' && opt.pubsub !== 'resetchannels') fail('--pubsub-default takes allchannels or resetchannels.');
  }
  const stdin = [opt.file, opt.config, opt.commands, opt.mode === 'build' ? opt.rules[0] : null].filter((f) => f === '-');
  if (stdin.length > 1) fail('Only one file can be - (stdin).');
  return opt;
}

function version(spec) {
  if (!spec) return A.versions().filter((v) => v.server === 'redis').pop().id;
  const id = A.findVersion(spec);
  if (!id) fail('No version matches "' + spec + '". Run with --versions to list them.');
  return id;
}

// Arguments are text; the library takes bytes (one character per byte).
const bin = (s) => A.toBinary(s);
// Bytes for the terminal: UTF-8 shows as text, and control characters and
// bytes that aren't UTF-8 show as \xHH, so a file can't send escape
// sequences to the terminal.
const show = (s) => A.readable(s);
const showText = (s) => show(bin(s));
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);

// Each file read once, stdin included.
const files = new Map();
function read(path) {
  if (!files.has(path)) {
    try { files.set(path, path === '-' ? fs.readFileSync(0) : fs.readFileSync(path)); }
    catch (e) { fail('Can\'t read ' + path + ': ' + e.message); }
  }
  return files.get(path);
}

function explainUser(u, id, opts, out) {
  const e = A.explain(u, id, opts);
  out.push(e.line ? show(e.line) : 'user ' + show(u.name) + ': listing it crashes the server (' + e.crash + ')');
  out.push('  Login: ' + e.login.text);
  if (e.everyone.length) out.push('  Any user may run ' + e.everyone.join(', ') + ', whatever the rules say.');
  e.selectors.forEach((s) => {
    out.push('  ' + s.title + ':');
    for (const r of s.rules) out.push('    ' + show(r.rule).padEnd(22) + ' ' + show(r.text));
    out.push('    Commands: ' + show(s.commands.text));
    if (s.keysText) out.push('    Keys: ' + s.keysText);
    else for (const k of s.keys) out.push('    Keys: ' + show(k.text));
    if (s.channelsText) out.push('    Channels: ' + s.channelsText);
    else for (const c of s.channels) out.push('    Channels: ' + show(c.text));
    if (s.databases) out.push('    Databases: ' + s.databases.text);
  });
  for (const w of e.warnings) out.push('  ' + (w.level === 'bad' ? 'Problem' : w.level === 'warn' ? 'Warning' : 'Note') + ': ' + w.title + '. ' + show(w.text));
  return e;
}

// The user the rules make: one argument may hold all the rules, unless the
// server takes it as one rule (a password with a space, say).
function userFromRules(opt, id, opts) {
  let name = opt.name !== null ? bin(opt.name) : 'user';
  let args = opt.rules.map(bin);
  if (opt.rules.length === 1 && /\s/.test(opt.rules[0]) && !A.setUser(null, name, args, id, opts).ok) {
    const parsed = A.readRules(opt.rules[0], id);
    const first = parsed.users[0];
    if (parsed.error || !first || !first.name) fail('Can\'t read the rules: ' + (parsed.error || (first && first.error) || 'there are none') + '.');
    if (opt.name === null) name = first.name;
    args = first.args;
  } else if (args.length >= 3 && /^acl$/i.test(opt.rules[0]) && /^setuser$/i.test(opt.rules[1])) {
    if (opt.name === null) name = args[2];
    args = args.slice(3);
  } else if (args.length >= 2 && /^user$/i.test(opt.rules[0])) {
    if (opt.name === null) name = args[1];
    args = args.slice(2);
  }
  return A.setUser(null, name, args, id, opts);
}

function run(argv) {
  const opt = parseArgs(argv);
  if (opt.help) { console.log(HELP); return 0; }
  if (opt.versions) {
    for (const v of A.versions()) console.log(v.id.padEnd(16) + ' ' + v.label);
    return 0;
  }
  if (!opt.mode) { console.log(HELP); return 2; }
  if (!['explain', 'check', 'build', 'keys'].includes(opt.mode)) fail('Unknown command ' + opt.mode + '. Run with --help.');
  const id = version(opt.server);
  const opts = { db: opt.db, pubsubDefault: opt.pubsub || undefined };
  const out = [];
  const json = {};
  let status = 0;
  const label = A.versions().find((v) => v.id === id).label;

  if (opt.mode === 'explain' || opt.mode === 'check') {
    const sources = (opt.rules.length ? 1 : 0) + (opt.file !== null ? 1 : 0) + (opt.config !== null ? 1 : 0);
    if (!sources) fail('Give the rules, or an ACL file with --file, or a config file with --config.');
    if (sources > 1) fail('Give the rules, --file or --config: only one of them.');
    if (opt.user !== null && opt.file === null && opt.config === null) fail('--user picks a user of --file or --config. To name the user of RULES, use --name.');
    if (opt.mode === 'check') {
      if (opt.command && opt.commands !== null) fail('Give a command after -- or a file with --commands, not both.');
      if (opt.command ? !opt.command.length : opt.commands === null) fail('Give a command after --, or a file with --commands.');
    } else if (opt.command || opt.commands !== null) fail('explain checks no commands; check does.');
    const source = showText(opt.file !== null ? opt.file : opt.config || '');
    let users = [], all = null;
    if (opt.file !== null) {
      const r = A.loadFile(read(opt.file), id, Object.assign({ filename: bin(opt.file === '-' ? 'users.acl' : opt.file) }, opts));
      if (r.crash) { out.push(`ACL LOAD of ${source} crashes ${label}: ${r.crash}.`); status = 1; json.crash = r.crash; }
      else if (!r.ok) {
        out.push(`ACL LOAD of ${source} with ${label} fails:`);
        out.push('  (error) ERR ' + show(r.error));
        for (const w of r.where.slice(0, 5)) out.push('  Line ' + w.line + ': ' + show(w.text));
        if (r.where.length > 5) out.push('  And ' + (r.where.length - 5) + ' more lines.');
        status = 1;
        json.error = r.error;
        json.lines = r.where;
      } else {
        users = r.declared.map((n) => r.users.get(n));
        all = r.users;
        if (!users.length && opt.user === null) out.push(`${source} declares no users. After ACL LOAD only the default user is there: add --user default to see it.`);
      }
    } else if (opt.config !== null) {
      const r = A.loadConfig(read(opt.config), id, opts);
      if (r.fatal) {
        out.push(`${source}:${r.fatal.line}: ${label} stops reading the file:`);
        out.push(`  >>> '${show(r.fatal.text)}'`);
        out.push('  ' + show(r.fatal.message));
        status = 1;
        json.error = r.fatal.message;
        json.line = r.fatal.line;
      } else if (r.startup) {
        out.push(`${label} reads the file, then stops while starting:`);
        for (const l of r.startup.log) out.push('  ' + show(l));
        status = 1;
        json.error = r.startup.message;
      } else {
        users = r.users;
        all = r.all;
        if (!users.length && opt.user === null) out.push(`${source} has no user lines. Add --user default to see the default user.`);
      }
    } else {
      const r = userFromRules(opt, id, opts);
      if (!r.ok) {
        out.push(`ACL SETUSER with ${label}:`);
        out.push('  (error) ERR ' + show(r.error));
        status = 1;
        json.error = r.error;
      } else users = [r.user];
    }
    if (opt.user !== null && all) {
      const u = all.get(bin(opt.user));
      if (!u) fail(`${source} has no user ${showText(opt.user)}. Its users: ${[...all.keys()].map(show).join(', ')}.`);
      users = [u];
    }
    if (opt.mode === 'explain') {
      json.users = [];
      users.forEach((u, i) => {
        if (i) out.push('');
        json.users.push(explainUser(u, id, opts, out));
      });
    } else if (status === 0) {
      if (!users.length) fail('There is no user to check. Add --user default to check the default user.');
      const lines = opt.commands !== null ? A.parseMonitor(read(opt.commands)) : [{ argv: opt.command.map(bin), db: null }];
      if (!lines.length) fail('There are no commands in ' + showText(opt.commands) + '.');
      json.users = users.map((u) => ({ name: u.name }));
      json.checks = [];
      users.forEach((u, n) => {
        if (users.length > 1) {
          if (n) out.push('');
          out.push('User ' + show(u.name) + ':');
        }
        for (const e of lines) {
          const r = A.check(u, e.argv, id, Object.assign({}, opts, { db: e.db != null ? e.db : opt.db }));
          json.checks.push({ user: u.name, command: e.argv, allowed: r.allowed, reason: r.reason, dryrun: r.dryrun, reply: r.reply, crash: r.crash });
          const cmd = e.argv.map((a) => show(A.quote(a))).join(' ');
          if (r.crash) {
            status = 1;
            out.push('CRASH    ' + cmd);
            out.push('         ' + label + ' crashes: ' + r.crash + '.');
          } else if (r.allowed && !r.reply) out.push('allowed  ' + cmd);
          else {
            if (!r.allowed) status = 1;
            out.push((r.allowed ? 'allowed  ' : 'DENIED   ') + cmd);
            if (r.dryrun && r.dryrun.reply && r.dryrun.reply !== 'OK') out.push('         ACL DRYRUN: "' + show(r.dryrun.reply) + '"');
            if (r.dryrun && r.dryrun.error) out.push('         ACL DRYRUN: (error) ERR ' + show(r.dryrun.error));
            if (r.reply) out.push('         The command gets: (error) ' + show(r.reply.error));
          }
        }
      });
    }
  } else if (opt.mode === 'build') {
    if (opt.rules.length !== 1) fail(opt.rules.length ? 'build reads one file of MONITOR output.' : 'Give a file of MONITOR output, or - for stdin.');
    const entries = A.parseMonitor(read(opt.rules[0]));
    const client = opt.client !== null ? bin(opt.client) : null;
    if (client === 'lua') fail('lua isn\'t a client: MONITOR shows the commands of scripts that way. Pick the client that ran EVAL or FCALL, and its scripts\' commands come with it.');
    if (client !== null && !entries.some((e) => e.client === client)) {
      const clients = [...new Set(entries.map((e) => e.client).filter((c) => c && c !== 'lua'))];
      fail('No line comes from ' + showText(opt.client) + '. ' + (clients.length ? 'The clients: ' + clients.map(show).join(', ') + '.' : 'The file names no clients.'));
    }
    const b = A.build(entries, id, Object.assign({}, opts, {
      name: bin(opt.name !== null ? opt.name : 'app'), keys: opt.exact ? 'exact' : 'prefix', client: client,
      password: opt.password !== null ? bin(opt.password) : null
    }));
    Object.assign(json, b);
    out.push(`For ${label}, from ${plural(b.lines, 'command line', 'command lines')}${client !== null ? ' of ' + show(client) : ''}:`);
    out.push('');
    out.push(show(b.setuser));
    out.push('');
    out.push(b.placeholder ? 'In an ACL file, with the SHA-256 of the password in place of <sha256-of-your-password>:' : 'In an ACL file (the password as its SHA-256):');
    out.push(show(b.aclfile));
    out.push('');
    out.push('Commands: ' + b.commands.map((c) => c.command + ' (' + c.count + ')').join(', '));
    const denied = b.check.filter((c) => !c.allowed);
    out.push(denied.length ? plural(denied.length, 'line is', 'lines are') + ' still refused:' : 'Every line it read is allowed with these rules.');
    for (const c of denied) out.push('  line ' + c.line + ': ' + c.argv.map((a) => show(A.quote(a))).join(' ') + ' (' + c.reason + ')');
    if (b.skipped.length) out.push(plural(b.skipped.length, 'line', 'lines') + ' skipped: ' + b.skipped.slice(0, 5).map((s) => 'line ' + s.line + ' (' + s.reason + ')').join(', ') + (b.skipped.length > 5 ? ', ...' : ''));
    if (b.approximate) out.push('Some keys or channels have spaces, which ACL patterns can\'t hold; ? stands in for them.');
    if (b.manyPatterns) {
      out.push(`The draft has ${b.manyPatterns} key and channel patterns. The server tries them one by one for each key or channel a command names, so a list this long slows every command down.` +
        (opt.exact ? ' Without --exact, keys that share a prefix share a pattern.' : ' Keys with no separator such as : get a pattern each.'));
    }
    if (b.placeholder) {
      out.push('Replace CHANGE-ME with a long random password (ACL GENPASS makes one). ACL LOAD refuses the ACL file line until the');
      out.push('password\'s SHA-256 is in it: run the ACL SETUSER command, then copy the line ACL LIST prints.');
    }
    if (denied.length || b.error) status = 1;
  } else {
    const argv = opt.rules.concat(opt.command || []).map(bin);
    if (!argv.length) fail('Give a command, such as: node acl/cli.js keys SET k v');
    const r = A.getKeys(argv, id);
    Object.assign(json, r);
    if (r.error) { out.push('(error) ERR ' + r.error); status = 1; }
    else for (const [k, f] of r.keys) out.push(show(k) + '  ' + f.join(' '));
  }
  // Strings in the results are bytes: each is decoded once, here.
  if (opt.json) console.log(JSON.stringify(Object.assign({ version: id }, json), (k, v) => (typeof v === 'string' ? A.fromBinary(v) : v), 2));
  else if (out.length) console.log(out.join('\n'));
  return status;
}

if (require.main === module) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof InputError ? showText(e.message) : showText(e.message || String(e)));
    process.exitCode = 2;
  }
}
module.exports = { run: run };
