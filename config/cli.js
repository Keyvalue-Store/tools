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
  node config/cli.js redis.conf --server 8 --minimal  The short file: the lines that change something, with
                                                      current names, for that version
  node config/cli.js --get config.txt --server 7.2    Compare the output of CONFIG GET * with the defaults
  node config/cli.js --versions                       The versions it knows

Options:
  --server VERSION  redis-7.2, "valkey 9.1", 8 (the newest 8.x of either) or all (the default)
  --no-tls          For Redis 6.2 and 7.0: a build without TLS, where the TLS settings don't exist
  --compression     For Redis 8.10: a build with BUILD_COMPRESSION=yes
  --minimal         Print the short file; needs --server with one version
  --json            Print JSON

With --get, the build is worked out from the names in the output unless --no-tls or --compression
says otherwise.

Exit status: 0 when the server starts with the file; 1 when it stops; 2 when the file can't be read,
isn't a config file (with --get, isn't CONFIG GET output) or the version is unknown.`;

function parseArgs(argv) {
  const opt = { files: [], server: null, tls: true, compression: false, json: false, minimal: false, get: null, versions: false };
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
  if (spec === null || spec === 'all') return C.versions().map((v) => v.id);
  const id = C.findVersion(spec);
  if (!id) throw new Error('No version matches "' + spec + '". Run with --versions to list them.');
  const asked = /(\d+\.\d+\.\d+)/.exec(spec);
  if (asked && !id.endsWith('-' + asked[1])) console.error('Checking as ' + C.versions().find((v) => v.id === id).label + ', the nearest version the checker knows.');
  return [id];
}

// Bytes as text for the terminal: control bytes, characters that don't
// show and bytes that aren't UTF-8 come out as \xHH, so a file can't send
// escape sequences to the terminal. keep: '\n' for text of several lines.
const show = (s, keep) => C.visible(s, keep);
const name = (path) => show(C.toBinary(path));
// A value in double quotes, written the way a config file would have it.
const quoted = (s) => C.fromBinary(C.quote(s, true));
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
// The longest of some names, up to cap. A loop rather than Math.max(...list).
const widest = (list, cap) => Math.min(cap, list.reduce((w, s) => Math.max(w, s.length), 0));
// JSON for the terminal: JSON.stringify leaves C1 control characters and
// DEL as they are, and some terminals act on them.
const json = (x) => JSON.stringify(x, null, 2).replace(/[\x7f-\x9f]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
// What a build of a version is, when it isn't the usual one.
function build(id, tls, compression) {
  const v = C.getVersion(id);
  const parts = [];
  if (!tls && v.defs.some((c) => c.build === 'tls')) parts.push('without TLS');
  if (compression && v.defs.some((c) => c.build === 'compression')) parts.push('with BUILD_COMPRESSION=yes');
  return parts.length ? ' built ' + parts.join(' and ') : '';
}

function oneVersion(path, bytes, id, opt, out) {
  const r = C.check(bytes, id, { tls: opt.tls, compression: opt.compression });
  const say = (s) => out.push(s);
  const label = r.label + build(id, opt.tls, opt.compression);
  if (r.ok) say(`${name(path)} with ${label}: the server starts.`);
  else if (r.error.startup) say(`${name(path)} with ${label}: the server reads the file, then stops while starting:`);
  else say(`${name(path)} with ${label}: the server stops at line ${r.error.line === null ? 'the end of the file' : r.error.line}. It prints:`);
  if (!r.ok) for (const l of show(r.error.output, '\n').replace(/^\n/, '').replace(/\n$/, '').split('\n')) say('  ' + l);
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
  const first = (n) => (r.setBy.has(n) ? r.setBy.get(n)[0] : Infinity);
  const changed = [];
  for (const [n, value] of r.values) if (r.setBy.has(n) || value !== r.defaults.get(n)) changed.push([n, value]);
  changed.sort((a, b) => first(a[0]) - first(b[0]));
  say('');
  if (!changed.length) say('The file changes no settings.');
  else {
    say(`Settings the file sets (${changed.length}), as CONFIG GET would show them:`);
    const width = widest(changed.map(([n]) => n), 34);
    for (const [n, value] of changed) {
      const d = r.defaults.get(n);
      const lines = r.setBy.get(n);
      const where = lines ? (lines.length === 1 ? 'line ' + lines[0] : 'lines ' + lineList(lines)) : 'at startup';
      say(`  ${n.padEnd(width)}  ${quoted(value)}${value === d ? ' (the default)' : ', default ' + quoted(d)}; ${where}`);
    }
  }
  const findings = C.advise(r);
  say('');
  say('What to look at:');
  if (!findings.length) say('  Nothing stands out.');
  const mark = { bad: '!!', warn: '! ', info: 'i ' };
  for (const f of findings) { say(`  ${mark[f.level]} ${show(f.title)}`); say(`     ${show(f.text)}`); }
  return r;
}
// Line numbers, the first few and the last when there are many.
const lineList = (lines) => (lines.length <= 8 ? lines.join(', ') : lines.slice(0, 5).join(', ') + ' and ' + (lines.length - 6) + ' more, up to ' + lines[lines.length - 1]);

// The short file, as the page's "Download the short file" gives it.
function shortFile(path, bytes, id, opt) {
  const r = C.check(bytes, id, { tls: opt.tls, compression: opt.compression });
  const lines = C.minimal(r);
  if (opt.json) return { r: r, text: json({ version: r.version, label: r.label, starts: r.ok, build: r.options, lines: lines }) };
  const head = '# The settings of ' + name(path) + ' that differ from the defaults of ' + r.label + build(id, opt.tls, opt.compression) + '.';
  return { r: r, text: [head].concat(lines).join('\n') };
}

function report(r) {
  return C.report(r);
}

function allVersions(path, bytes, ids, opt, out) {
  const results = ids.map((id) => C.check(bytes, id, { tls: opt.tls, compression: opt.compression }));
  const say = (s) => out.push(s);
  const width = widest(results.map((r) => r.label), Infinity);
  say(`${name(path)}:`);
  for (const r of results) {
    let what = 'starts';
    if (!r.ok) {
      what = r.error.startup ? (r.error.line ? 'stops at line ' + r.error.line + ': ' : 'stops while starting: ') + show(r.error.short || r.error.message)
        : 'stops at ' + (r.error.line === null ? 'the end' : 'line ' + r.error.line) + ': ' + show(r.error.message);
    }
    if (what.length > 110) what = what.slice(0, 107) + '...';
    say(`  ${r.label.padEnd(width)}  ${what}`);
  }
  const note = [];
  if (!opt.tls) note.push('Redis 6.2 and 7.0 as built without TLS');
  if (opt.compression) note.push('Redis 8.10 as built with BUILD_COMPRESSION=yes');
  if (note.length) say('  (' + note.join('; ') + ')');
  say('');
  say('For one version in detail: --server, such as --server ' + results[results.length - 1].version);
  return results;
}

function configGet(path, ids, opt) {
  const text = fs.readFileSync(path, 'utf8');
  // The build comes from the names unless an option says.
  const build0 = { tls: opt.tls === false ? false : undefined, compression: opt.compression ? true : undefined };
  const g = C.readConfigGet(text, ids.length === 1 ? ids[0] : null, build0);
  if (g.kind === 'none') throw new Error(name(path) + ' has no CONFIG GET output in it.');
  if (g.kind === 'config-file') throw new Error(name(path) + ' looks like a config file, not CONFIG GET output. To check it: node config/cli.js ' + name(path));
  if (g.kind === 'other') throw new Error(name(path) + ' doesn\'t look like CONFIG GET output: ' + (g.known ? 'only ' + g.known + ' of its ' + g.settings + ' names are settings of ' + g.label : 'none of its names are settings') + '.');
  const changed = g.changed;
  const missing = g.missing;
  if (opt.json) {
    return { out: [json({ version: g.version, label: g.label, kind: g.kind, guessed: g.guessed, sure: g.sure, build: { tls: g.tls, compression: g.compression },
      settings: g.settings, changed: changed.map((r) => ({ name: r.name, value: r.value, default: C.fromBinary(r.default) })),
      missing: missing.map((r) => r.name), unknown: g.unknown, rows: g.rows.map((r) => ({ name: r.name, value: r.value, default: r.default === null ? null : C.fromBinary(r.default), hidden: r.hidden, changed: r.changed })) })], status: 0 };
  }
  const out = [];
  const label = g.label + build(g.version, g.tls, g.compression);
  let how = '';
  if (g.guessed) how = g.sure ? ' (the version whose settings match best; --server picks another)' : '. Too few settings to tell the version; --server picks another';
  out.push(`${name(path)}: ${plural(g.settings, 'setting', 'settings')}, compared with the defaults of ${label}${how}.`);
  out.push('');
  if (changed.length) out.push(`Different from the defaults (${changed.length}):`);
  else out.push(g.kind === 'full' ? 'Nothing differs from the defaults.' : (g.settings === 1 ? 'It has its default.' : 'They have their defaults.'));
  const width = widest(changed.map((r) => r.name), 34);
  for (const r of changed) out.push(`  ${show(C.toBinary(r.name)).padEnd(width)}  ${quoted(C.toBinary(r.value))}, default ${quoted(r.default)}`);
  if (missing.length) {
    out.push('');
    out.push(`Not in the output (${missing.length}), so maybe another version: ${missing.map((r) => r.name).join(', ')}`);
  }
  if (g.unknown.length) {
    out.push('');
    out.push(`Not settings of ${label} (${g.unknown.length}): ${g.unknown.map((n) => show(C.toBinary(n))).join(', ')}`);
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
  if (opt.minimal && ids.length !== 1) { console.error('--minimal needs --server with one version, such as --server redis-7.2: the short file depends on the version.'); return 2; }
  const path = opt.files[0];
  let bytes;
  try { bytes = new Uint8Array(fs.readFileSync(path)); } catch (e) { console.error('Can\'t read ' + name(path) + ': ' + e.message); return 2; }
  const what = C.sniff(bytes);
  if (what) { console.error(name(path) + ' looks like ' + what + ', not a config file.'); return 2; }
  if (opt.minimal) {
    const s = shortFile(path, bytes, ids[0], opt);
    console.log(s.text);
    return s.r.ok ? 0 : 1;
  }
  const out = [];
  if (ids.length > 1) {
    const results = allVersions(path, bytes, ids, opt, out);
    if (opt.json) console.log(json(results.map(report)));
    else console.log(out.join('\n'));
    return results.every((r) => r.ok) ? 0 : 1;
  }
  const r = oneVersion(path, bytes, ids[0], opt, out);
  if (opt.json) console.log(json(report(r)));
  else console.log(out.join('\n'));
  return r.ok ? 0 : 1;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { main, report };
