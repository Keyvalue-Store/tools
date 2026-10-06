#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Command line for the Config Checker. Run "node config/cli.js --help".

'use strict';
const fs = require('fs');
const C = require('./config.js');

const HELP = `Config Checker: reads a redis.conf or valkey.conf the way the server reads it at startup.

Usage:
  node config/cli.js redis.conf --server valkey-9.1   Whether that version starts with the file, the error
                                                      it stops with if not, what the file changes, and the
                                                      settings worth a second look
  node config/cli.js redis.conf                       Which of the versions start with the file
  node config/cli.js redis.conf --server 8 --minimal  The lines that change something, with current names
  node config/cli.js --get config.txt --server 7.2    Compare the output of CONFIG GET * with the defaults
  node config/cli.js --versions                       The versions it knows

Options:
  --server VERSION  redis-7.2, "valkey 9.1", 8 (the newest 8.x of either) or all (the default)
  --no-tls          For Redis 6.2 and 7.0: a build without TLS, where the TLS settings don't exist
  --compression     For Redis 8.10: a build with BUILD_COMPRESSION=yes
  --json            Print JSON

Exit status: 0 when the server starts with the file; 1 when it stops; 2 when the file can't be read
or the version is unknown.`;

function parseArgs(argv) {
  const opt = { files: [], server: 'all', tls: true, compression: false, json: false, minimal: false, get: null, versions: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(a + ' needs a value.');
      return argv[++i];
    };
    if (a === '--help' || a === '-h') opt.help = true;
    else if (a === '--server' || a === '--version') opt.server = next();
    else if (a === '--no-tls') opt.tls = false;
    else if (a === '--compression') opt.compression = true;
    else if (a === '--json') opt.json = true;
    else if (a === '--minimal') opt.minimal = true;
    else if (a === '--get') opt.get = next();
    else if (a === '--versions') opt.versions = true;
    else if (a.startsWith('--')) throw new Error('Unknown option ' + a + '. Run with --help.');
    else opt.files.push(a);
  }
  return opt;
}

// The versions the --server option names.
function chosen(spec) {
  if (spec === 'all') return C.versions().map((v) => v.id);
  const id = C.findVersion(spec);
  if (!id) throw new Error('No version matches "' + spec + '". Run with --versions to list them.');
  const asked = /(\d+\.\d+\.\d+)/.exec(spec);
  if (asked && !id.endsWith('-' + asked[1])) console.error('Checking as ' + C.versions().find((v) => v.id === id).label + ', the nearest version the checker knows.');
  return [id];
}

const show = (s) => C.fromBinary(s);
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);

function oneVersion(path, bytes, id, opt, out) {
  const r = C.check(bytes, id, { tls: opt.tls, compression: opt.compression });
  const say = (s) => out.push(s);
  if (opt.minimal) {
    for (const line of C.minimal(r)) say(line);
    return r;
  }
  if (r.ok) say(`${path} with ${r.label}: the server starts.`);
  else if (r.error.startup) say(`${path} with ${r.label}: the server reads the file, then stops while starting:`);
  else say(`${path} with ${r.label}: the server stops at line ${r.error.line === null ? 'the end of the file' : r.error.line}. It prints:`);
  if (!r.ok) for (const l of show(r.error.output).replace(/^\n/, '').replace(/\n$/, '').split('\n')) say('  ' + l);
  const later = r.problems.filter((p) => p !== r.error);
  if (later.length) {
    say('');
    say('It would stop at these lines too, once the ones before are fixed:');
    for (const p of later) say(`  line ${p.line === null ? '(end)' : p.line}: ${show(p.message)}${p.text ? '   >>> ' + show(p.text) : ''}`);
  }
  if (r.notes.length) {
    say('');
    say('Notes:');
    for (const n of r.notes) say('  ' + show(n.message));
  }
  if (r.unchecked.length) {
    say('');
    say('Not checked, since they depend on the machine:');
    for (const u of r.unchecked) say('  ' + (u.line ? 'line ' + u.line + ': ' : '') + show(u.message));
  }
  const first = (name) => (r.setBy.has(name) ? r.setBy.get(name)[0] : Infinity);
  const changed = [...r.values].filter(([name, value]) => r.setBy.has(name) || value !== r.defaults.get(name))
    .sort((a, b) => first(a[0]) - first(b[0]));
  say('');
  if (!changed.length) say('The file changes no settings.');
  else {
    say(`Settings the file sets (${changed.length}), as CONFIG GET would show them:`);
    const width = Math.min(34, Math.max(...changed.map(([n]) => n.length)));
    for (const [name, value] of changed) {
      const d = r.defaults.get(name);
      const lines = r.setBy.get(name);
      const where = lines ? (lines.length === 1 ? 'line ' + lines[0] : 'lines ' + lines.join(', ')) : 'at startup';
      say(`  ${name.padEnd(width)}  ${JSON.stringify(show(value))}${value === d ? ' (the default)' : ', default ' + JSON.stringify(show(d))}; ${where}`);
    }
  }
  const findings = C.advise(r);
  say('');
  say('What to look at:');
  if (!findings.length) say('  Nothing stands out.');
  const mark = { bad: '!!', warn: '! ', info: 'i ' };
  for (const f of findings) { say(`  ${mark[f.level]} ${f.title}`); say(`     ${f.text}`); }
  return r;
}

function report(r) {
  const obj = (m) => Object.fromEntries([...m].map(([k, v]) => [k, show(v)]));
  return {
    version: r.version, label: r.label, starts: r.ok,
    error: r.error ? { line: r.error.line, text: r.error.text === null || r.error.text === undefined ? null : show(r.error.text), message: show(r.error.message), output: show(r.error.output), startup: !!r.error.startup } : null,
    problems: r.problems.map((p) => ({ line: p.line, text: p.text ? show(p.text) : null, message: show(p.message) })),
    notes: r.notes.map((n) => ({ name: n.name || null, message: show(n.message) })),
    unchecked: r.unchecked.map((u) => ({ line: u.line || null, name: u.name || null, message: show(u.message) })),
    settings: Object.fromEntries([...r.values].filter(([name]) => r.setBy.has(name) || r.values.get(name) !== r.defaults.get(name))
      .map(([name, value]) => [name, { value: show(value), default: show(r.defaults.get(name)), lines: r.setBy.get(name) || [] }])),
    values: obj(r.values),
    lines: r.lines.map((l) => ({ line: l.line, kind: l.kind, status: l.status, name: l.name, message: l.message ? show(l.message) : null })),
    findings: C.advise(r),
    renamed: Object.fromEntries([...r.renamed].map(([k, v]) => [k, show(v)]))
  };
}

function allVersions(path, bytes, ids, opt, out) {
  const results = ids.map((id) => C.check(bytes, id, { tls: opt.tls, compression: opt.compression }));
  const say = (s) => out.push(s);
  const width = Math.max(...results.map((r) => r.label.length));
  say(`${path}:`);
  for (const r of results) {
    let what = 'starts';
    if (!r.ok) {
      what = r.error.startup ? (r.error.line ? 'stops at line ' + r.error.line + ': ' : 'stops while starting: ') + show(r.error.short || r.error.message)
        : 'stops at ' + (r.error.line === null ? 'the end' : 'line ' + r.error.line) + ': ' + show(r.error.message);
    }
    if (what.length > 110) what = what.slice(0, 107) + '...';
    say(`  ${r.label.padEnd(width)}  ${what}`);
  }
  say('');
  say('For one version in detail: --server, such as --server ' + results[results.length - 1].version);
  return results;
}

function configGet(path, ids, opt) {
  const text = fs.readFileSync(path, 'utf8');
  const map = C.parseConfigGet(text);
  if (!map.size) throw new Error(path + ' has no CONFIG GET output in it.');
  const id = ids.length === 1 ? ids[0] : C.guessVersion(map);
  const cmp = C.compareConfigGet(map, id);
  if (opt.json) return { out: [JSON.stringify(cmp, null, 2)], status: 0 };
  const out = [];
  const label = C.versions().find((v) => v.id === id).label;
  out.push(`${path}: ${map.size} settings, compared with the defaults of ${label}${ids.length === 1 ? '' : ' (the version whose settings match best; --server picks another)'}.`);
  const changed = cmp.rows.filter((r) => r.changed);
  out.push('');
  out.push(changed.length ? `Different from the defaults (${changed.length}):` : 'Nothing differs from the defaults.');
  const width = Math.min(34, Math.max(0, ...changed.map((r) => r.name.length)));
  for (const r of changed) out.push(`  ${r.name.padEnd(width)}  ${JSON.stringify(r.value)}, default ${JSON.stringify(show(r.default))}`);
  const missing = cmp.rows.filter((r) => r.value === null && !r.hidden);
  if (missing.length) {
    out.push('');
    out.push(`Not in the output (${missing.length}), so maybe another version: ${missing.map((r) => r.name).join(', ')}`);
  }
  if (cmp.unknown.length) {
    out.push('');
    out.push(`Not settings of ${label} (${cmp.unknown.length}): ${cmp.unknown.join(', ')}`);
  }
  return { out: out, status: 0 };
}

function main(argv) {
  let opt;
  try { opt = parseArgs(argv); } catch (e) { console.error(e.message); return 2; }
  if (opt.help) { console.log(HELP); return 0; }
  if (opt.versions) {
    for (const v of C.versions()) console.log(v.id.padEnd(16) + v.label);
    return 0;
  }
  let ids;
  try { ids = chosen(opt.server); } catch (e) { console.error(e.message); return 2; }
  if (opt.get) {
    try {
      const r = configGet(opt.get, ids, opt);
      console.log(r.out.join('\n'));
      return r.status;
    } catch (e) { console.error(e.message); return 2; }
  }
  if (opt.files.length !== 1) { console.error('Give one config file. Run with --help.'); return 2; }
  const path = opt.files[0];
  let bytes;
  try { bytes = new Uint8Array(fs.readFileSync(path)); } catch (e) { console.error('Can\'t read ' + path + ': ' + e.message); return 2; }
  const out = [];
  if (ids.length > 1 && !opt.minimal) {
    const results = allVersions(path, bytes, ids, opt, out);
    if (opt.json) console.log(JSON.stringify(results.map(report), null, 2));
    else console.log(out.join('\n'));
    return results.every((r) => r.ok) ? 0 : 1;
  }
  const r = oneVersion(path, bytes, ids[ids.length - 1], opt, out);
  if (opt.json) console.log(JSON.stringify(report(r), null, 2));
  else console.log(out.join('\n'));
  return r.ok ? 0 : 1;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { main, report };
