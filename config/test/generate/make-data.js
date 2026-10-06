// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Writes servers.js, what the Config Checker knows about each server
// version, from test/fixtures/servers.json.gz (written by extract.py):
//
//   node config/test/generate/make-data.js

'use strict';
// node --test runs every .js file under a test folder; this one only runs by hand.
if (process.env.NODE_TEST_CONTEXT) return;
const fs = require('fs');
const path = require('path');

const src = JSON.parse(require('zlib').gunzipSync(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'servers.json.gz'))).toString('utf8'));
const FLAG = {
  IMMUTABLE_CONFIG: 'I', MODIFIABLE_CONFIG: '', SENSITIVE_CONFIG: 'S', HIDDEN_CONFIG: 'H', DEBUG_CONFIG: 'D', PROTECTED_CONFIG: 'P',
  DENY_LOADING_CONFIG: 'L', VOLATILE_CONFIG: 'V', MULTI_ARG_CONFIG: 'A', DEPRECATED_CONFIG: 'X', ALIAS_CONFIG: '', MODULE_CONFIG: ''
};
const NUMFLAG = { MEMORY_CONFIG: 'm', PERCENT_CONFIG: 'p', OCTAL_CONFIG: 'o', UNSIGNED_CONFIG: 'u', SIGNED_MEMORY_CONFIG: 's' };
const flagText = (list) => list.map((f) => {
  if (!(f in FLAG)) throw new Error('unknown flag ' + f);
  return FLAG[f];
}).join('');

// The real defaults of what extract.py started the servers with.
const STARTED = { port: '6379', unixsocket: '', save: '3600 1 300 100 60 10000' };

const defs = [];
const defIndex = new Map();
function def(c, version) {
  // What the server said, or for a config our builds lack (TLS in 6.2 and
  // 7.0, compression in 8.10), what the source code says.
  let dflt = c.present ? c.default : c.sourceDefault;
  if (dflt === undefined || dflt === null) throw new Error('no default for ' + c.name + ' in ' + version);
  if (c.name in STARTED) dflt = STARTED[c.name];
  if (c.name === 'dir') dflt = null; // the folder the server starts in
  let info;
  switch (c.type) {
    case 'bool': info = [c.valid || '']; break;
    case 'string': case 'sds': info = [c.emptyToNull ? 1 : 0, c.valid || '']; break;
    case 'enum': info = [c.enum, c.valid || '']; break;
    case 'numeric': info = [c.numeric, String(c.lower), String(c.upper), c.numflags.map((f) => { if (!(f in NUMFLAG)) throw new Error(f); return NUMFLAG[f]; }).join(''), c.valid || '']; break;
    case 'special': info = [c.set]; break;
    default: throw new Error(c.type);
  }
  const entry = [c.name, c.alias || '', c.type, flagText(c.flags), info, dflt, c.build || ''];
  const key = JSON.stringify(entry);
  if (!defIndex.has(key)) { defIndex.set(key, defs.length); defs.push(entry); }
  return defIndex.get(key);
}

const allCommands = new Set();
for (const v of src) for (const c of v.commands) allCommands.add(c);
const commands = [...allCommands].sort();
const allSubcommands = new Set();
for (const v of src) for (const c of v.subcommands || []) allSubcommands.add(c);
const subcommands = [...allSubcommands].sort();
const bits = (list, have) => list.map((c) => (have.includes(c) ? '1' : '0')).join('').replace(/0+$/, '');

const versions = src.map((v) => {
  const [server, version] = v.version.split('-');
  const configs = v.configs.filter((c) => c.present || c.build).map((c) => def(c, v.version));
  // Directives Redis 6.2 handles outside its config table, with their defaults.
  const legacy = {};
  if (v.features.legacy) {
    for (const name of ['save', 'client-output-buffer-limit', 'oom-score-adj-values', 'notify-keyspace-events', 'bind', 'unixsocketperm', 'slaveof', 'logfile', 'watchdog-period']) {
      if (name in v.listed) legacy[name] = name === 'save' ? STARTED.save : v.listed[name];
    }
  }
  const used = new Set(v.configs.map((c) => c.enum).filter(Boolean));
  const enums = {};
  for (const name of Object.keys(v.enums).sort()) if (used.has(name)) enums[name] = v.enums[name];
  // Settings of modules built into the server, with the defaults CONFIG GET shows.
  if (v.features.internalModules) {
    for (const c of v.features.internalModules.configs) {
      if (!(c[0] in v.listed)) throw new Error('no default for ' + c[0] + ' in ' + v.version);
      c[2] = v.listed[c[0]];
    }
  }
  return {
    id: v.version, server: server, version: version, label: (server === 'redis' ? 'Redis ' : 'Valkey ') + version,
    features: v.features, configs: configs, legacy: legacy, enums: enums, notify: v.notify, deprecated: v.deprecated,
    commands: bits(commands, v.commands), subcommands: bits(subcommands, v.subcommands || []),
    consts: v.consts
  };
});

const lines = [];
lines.push('// SPDX-License-Identifier: Apache-2.0');
lines.push('// Copyright 2026 KeyValueStore.com');
lines.push('//');
lines.push('// What the Config Checker knows about each Redis and Valkey version: every');
lines.push('// config\'s name, type, limits and default, the commands, and how the');
lines.push('// version\'s config code behaves where versions differ. Commands and');
lines.push('// subcommands are bit strings over the lists at the top. Read from each');
lines.push('// version\'s source code and from the built servers by');
lines.push('// test/generate/extract.py; written by test/generate/make-data.js.');
lines.push('//');
lines.push('// defs: [name, alias, type, flags, type details, default, build], where');
lines.push('// flags are I immutable, S sensitive, H hidden, D debug, P protected,');
lines.push('// L not while loading, V volatile, A takes several arguments; numeric');
lines.push('// details are [C type, lower, upper, m memory p percent o octal');
lines.push('// u unsigned s signed memory, validator]; a default of null is the');
lines.push('// folder the server starts in; build "tls" means only in builds with TLS,');
lines.push('// "compression" only in builds with BUILD_COMPRESSION=yes.');
lines.push('(function (root, factory) {');
lines.push('  \'use strict\';');
lines.push('  const data = factory();');
lines.push('  if (typeof module === \'object\' && module.exports) module.exports = data;');
lines.push('  else root.KVConfigServers = data;');
lines.push('})(typeof globalThis !== \'undefined\' ? globalThis : this, function () {');
lines.push('  \'use strict\';');
lines.push('  return {');
lines.push('    commands: ' + JSON.stringify(commands) + ',');
lines.push('    subcommands: ' + JSON.stringify(subcommands) + ',');
lines.push('    defs: [');
defs.forEach((d, i) => lines.push('      ' + JSON.stringify(d) + (i < defs.length - 1 ? ',' : '')));
lines.push('    ],');
lines.push('    versions: [');
versions.forEach((v, i) => lines.push('      ' + JSON.stringify(v) + (i < versions.length - 1 ? ',' : '')));
lines.push('    ]');
lines.push('  };');
lines.push('});');
const out = path.join(__dirname, '..', '..', 'servers.js');
fs.writeFileSync(out, lines.join('\n') + '\n');
console.log(out, fs.statSync(out).size, 'bytes,', defs.length, 'definitions,', versions.length, 'versions,', commands.length, 'commands,', subcommands.length, 'subcommands');
