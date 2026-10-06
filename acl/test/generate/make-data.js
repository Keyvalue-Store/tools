// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Writes servers.js, what the ACL Builder knows about each server version,
// from test/fixtures/servers.json.gz (written by extract.py):
//
//   node acl/test/generate/make-data.js

'use strict';
// node --test runs every .js file under a test folder; this one only runs by hand.
if (process.env.NODE_TEST_CONTEXT) return;
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const src = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'servers.json.gz'))).toString('utf8'));

// COMMAND's key specs, made short: [flags, begin search, find keys].
function keySpec(raw) {
  const m = {};
  for (let i = 0; i + 1 < raw.length; i += 2) m[raw[i]] = raw[i + 1];
  const pairs = (list) => { const o = {}; for (let i = 0; i + 1 < list.length; i += 2) o[list[i]] = list[i + 1]; return o; };
  const bs = pairs(m.begin_search || []), fk = pairs(m.find_keys || []);
  const bsSpec = pairs(bs.spec || []), fkSpec = pairs(fk.spec || []);
  let begin, find;
  if (bs.type === 'index') begin = ['index', bsSpec.index];
  else if (bs.type === 'keyword') begin = ['keyword', bsSpec.keyword, bsSpec.startfrom];
  else begin = [bs.type || 'unknown'];
  if (fk.type === 'range') find = ['range', fkSpec.lastkey, fkSpec.keystep, fkSpec.limit];
  else if (fk.type === 'keynum') find = ['keynum', fkSpec.keynumidx, fkSpec.firstkey, fkSpec.keystep];
  else find = [fk.type || 'unknown'];
  return [(m.flags || []).join(' '), begin, find];
}

const defs = [];
const defIndex = new Map();
function def(cmd) {
  const [name, arity, flags, first, last, step, cats, , specs, subs] = cmd;
  const subIdx = (subs || []).map(def);
  const entry = [name, arity, flags.join(' '), first, last, step, (cats || []).map((c) => c.replace(/^@/, '')).join(' '), (specs || []).map(keySpec), subIdx];
  const key = JSON.stringify(entry);
  if (!defIndex.has(key)) { defIndex.set(key, defs.length); defs.push(entry); }
  return defIndex.get(key);
}

const versions = src.map((v) => {
  const [server, version] = v.version.split('-');
  // Cross-check: ACL CAT <category> lists what COMMAND says belongs to it.
  const members = new Map(v.categories.map((c) => [c, new Set()]));
  const walk = (cmd) => {
    for (const c of cmd[6] || []) members.get(c.replace(/^@/, '')).add(cmd[0]);
    for (const s of cmd[9] || []) walk(s);
  };
  v.commands.forEach(walk);
  for (const c of v.categories) {
    const want = [...members.get(c)].sort().join(' '), got = v.categoryMembers[c].slice().sort().join(' ');
    if (want !== got) throw new Error(v.version + ': ACL CAT ' + c + ' differs from COMMAND');
  }
  return {
    id: v.version, server: server, version: version, label: (server === 'redis' ? 'Redis ' : 'Valkey ') + version,
    categories: v.categories, commands: v.commands.map(def), getkeys: v.getkeys, channels: v.channels,
    messages: v.messages, userFlags: v.userFlags, pubsubDefault: v.pubsubDefault, newUser: v.newUser, defaultUser: v.defaultUser,
    dbidArgs: v.dbidArgs, allDbs: v.allDbs, protected: v.protected
  };
});

const lines = [];
lines.push('// SPDX-License-Identifier: Apache-2.0');
lines.push('// Copyright 2026 KeyValueStore.com');
lines.push('//');
lines.push('// What the ACL Builder knows about each Redis and Valkey version: every');
lines.push('// command and subcommand with its arity, flags, key positions, key specs');
lines.push('// and ACL categories (from COMMAND on the built servers), and from the');
lines.push('// source code which commands find their keys with a function of their own,');
lines.push('// which take Pub/Sub channels, and the messages the ACL code prints.');
lines.push('// Written by test/generate/make-data.js from test/generate/extract.py.');
lines.push('//');
lines.push('// commands: [name, arity, flags, first key, last key, step, categories,');
lines.push('// key specs [flags, begin search, find keys], subcommands], shared by the');
lines.push('// versions, which list the ones they have.');
lines.push('(function (root, factory) {');
lines.push('  \'use strict\';');
lines.push('  const data = factory();');
lines.push('  if (typeof module === \'object\' && module.exports) module.exports = data;');
lines.push('  else root.KVAclServers = data;');
lines.push('})(typeof globalThis !== \'undefined\' ? globalThis : this, function () {');
lines.push('  \'use strict\';');
lines.push('  return {');
lines.push('    commands: [');
defs.forEach((d, i) => lines.push('      ' + JSON.stringify(d) + (i < defs.length - 1 ? ',' : '')));
lines.push('    ],');
lines.push('    versions: [');
versions.forEach((v, i) => lines.push('      ' + JSON.stringify(v) + (i < versions.length - 1 ? ',' : '')));
lines.push('    ]');
lines.push('  };');
lines.push('});');
const out = path.join(__dirname, '..', '..', 'servers.js');
fs.writeFileSync(out, lines.join('\n') + '\n');
console.log(out, fs.statSync(out).size, 'bytes,', defs.length, 'command definitions,', versions.length, 'versions');
