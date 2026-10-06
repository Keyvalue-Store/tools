// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Replays the files in fixtures/runs.json.gz, recorded from the real
// servers by generate/record.py, through config.js, and lists every place
// where config.js says something different. The tests use it; run it by
// hand to see the differences:
//
//   node config/test/replay.js [version ...]

'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const C = require('../config.js');

// Settings whose value depends on how the test started the server, not on the file.
const ENV = new Set(['dir', 'unixsocket', 'port']);
// Settings the server adjusts at startup to the machine it runs on.
const MACHINE = new Set(['maxclients']);

function load() {
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'fixtures', 'runs.json.gz'))).toString('utf8'));
}

// A recorded file's bytes: the strings in the recording hold one byte per character.
const bytes = (s) => Uint8Array.from(Buffer.from(s, 'latin1'));
const fileOf = (lines) => lines.map((l) => l + '\n').join('');

// The names CONFIG GET lists that are other names for a setting.
const aliasCache = new Map();
function aliases(versionId) {
  if (!aliasCache.has(versionId)) aliasCache.set(versionId, new Set(C.getVersion(versionId).defs.filter((c) => c.alias).map((c) => c.alias)));
  return aliasCache.get(versionId);
}

// Compares what config.js says about a file with what the server did.
function compare(versionId, rec, file, outcome, opts) {
  const out = [];
  let r;
  try {
    r = C.check(bytes(file), versionId, opts);
  } catch (e) {
    return ['threw ' + (e.stack || e)];
  }
  const v = C.getVersion(versionId);
  if (outcome.error) {
    const want = outcome.error;
    if (!r.error) return ['server stopped with "' + (want.message || want.stderr) + '" at line ' + want.line + '; config.js says the file is fine'];
    if (r.error.startup) return ['server stopped with "' + (want.message || want.stderr) + '"; config.js says it stops at startup: ' + r.error.message];
    if (want.stderr !== undefined) {
      if (r.error.output !== want.stderr) out.push('output differs:\n  server:    ' + JSON.stringify(want.stderr) + '\n  config.js: ' + JSON.stringify(r.error.output));
    } else {
      if (r.error.line !== want.line) out.push('line ' + r.error.line + ' instead of ' + want.line + ' (' + want.message + ' / ' + r.error.message + ')');
      if (r.error.message !== want.message) out.push('message ' + JSON.stringify(r.error.message) + ' instead of ' + JSON.stringify(want.message));
      if (want.line !== null && r.error.text !== want.text) out.push('text ' + JSON.stringify(r.error.text) + ' instead of ' + JSON.stringify(want.text));
      if (!out.length) {
        const label = (versionId.startsWith('valkey') ? 'Version ' : 'Redis ') + v.version;
        const text = '\n*** FATAL CONFIG FILE ERROR (' + label + ') ***\n' +
          (want.line !== null ? 'Reading the configuration file, at line ' + want.line + '\n>>> \'' + want.text + '\'\n' : '') + want.message + '\n';
        if (r.error.output !== text) out.push('output ' + JSON.stringify(r.error.output) + ' instead of ' + JSON.stringify(text));
      }
    }
    return out;
  }
  if (outcome.values) {
    if (r.error) return ['server started; config.js says: line ' + r.error.line + ' ' + JSON.stringify(r.error.message)];
    // The server started, but the file's own limits kept CONFIG GET from answering.
    if (outcome.values.__error) return [];
    const al = aliases(versionId);
    for (const [name, value] of r.values) {
      if (ENV.has(name) || MACHINE.has(name)) continue;
      const want = name in outcome.values ? outcome.values[name] : rec.baseline[name];
      if (want === undefined) { out.push(name + ': CONFIG GET has no such setting'); continue; }
      if (value !== want) out.push(name + ' = ' + JSON.stringify(value) + ', server says ' + JSON.stringify(want));
    }
    for (const name of Object.keys(rec.baseline)) {
      if (!r.values.has(name) && !al.has(name) && !ENV.has(name)) out.push(name + ': config.js has no value for it');
    }
    return out;
  }
  if ('failed' in outcome) {
    const log = outcome.log || [];
    if (r.error && r.error.startup) {
      const lines = r.error.log || [r.error.message];
      const missing = lines.filter((l) => !log.includes(l));
      if (missing.length) out.push('startup log differs: server ' + JSON.stringify(log) + ', config.js ' + JSON.stringify(lines));
      return out;
    }
    if (r.error) return ['server stopped at startup (' + JSON.stringify(log) + '); config.js says line ' + r.error.line + ' ' + JSON.stringify(r.error.message)];
    // The server stopped for a reason outside its config file loader. config.js must at least say it can't check that.
    if (!r.unchecked.length && !r.notes.length) out.push('server stopped at startup (' + JSON.stringify(log) + '); config.js says the file is fine');
    return out;
  }
  return ['nothing recorded'];
}

// Every recorded run of a version: { name, file, outcome }.
function runs(versionId, rec) {
  const out = [];
  rec.batches.forEach((b, bi) => {
    b.runs.forEach((outcome, j) => {
      const removed = new Set(b.removed.slice(0, j));
      out.push({ name: 'batch ' + bi + ' run ' + j, file: fileOf(b.lines.filter((_, i) => !removed.has(i))), outcome: outcome });
    });
  });
  for (const c of rec.cases) out.push({ name: c.name, file: c.raw !== undefined ? c.raw : fileOf(c.lines), outcome: c.result });
  return out;
}

// A batch's whole file, read at once, must list the lines the server
// stopped at in the order it stopped at them, and end with the values the
// server had once they were gone.
function wholeBatch(versionId, rec, b, opts) {
  const out = [];
  const file = fileOf(b.lines);
  const r = C.check(bytes(file), versionId, opts);
  const lines = r.problems.filter((p) => !p.startup && p.line !== null).map((p) => p.line - 1);
  const errors = b.runs.filter((o) => o.error && o.error.line).length;
  if (JSON.stringify(lines.slice(0, errors)) !== JSON.stringify(b.removed)) out.push('problems at batch lines ' + JSON.stringify(lines) + ', server stopped at ' + JSON.stringify(b.removed));
  b.runs.forEach((o, k) => {
    if (o.error && o.error.line && r.problems[k] && r.problems[k].message !== o.error.message) out.push('problem ' + k + ' says ' + JSON.stringify(r.problems[k].message) + ', server ' + JSON.stringify(o.error.message));
  });
  const last = b.runs[b.runs.length - 1];
  if (last.values && !last.values.__error && lines.length === errors) {
    for (const [name, value] of r.values) {
      if (ENV.has(name) || MACHINE.has(name)) continue;
      const want = name in last.values ? last.values[name] : rec.baseline[name];
      if (want !== undefined && value !== want) out.push('whole file: ' + name + ' = ' + JSON.stringify(value) + ', server says ' + JSON.stringify(want));
    }
  }
  return out;
}

function replay(versionId, rec) {
  const opts = { tls: rec.tls };
  const problems = [];
  // Defaults: an empty file gives what CONFIG GET says on a fresh server.
  problems.push(...compare(versionId, rec, '', { values: {} }, opts).map((p) => ({ name: 'defaults', file: '', problem: p })));
  rec.batches.forEach((b, bi) => {
    for (const p of wholeBatch(versionId, rec, b, opts)) problems.push({ name: 'batch ' + bi + ' whole', file: fileOf(b.lines), problem: p });
  });
  for (const run of runs(versionId, rec)) {
    for (const p of compare(versionId, rec, run.file, run.outcome, opts)) problems.push({ name: run.name, file: run.file, problem: p });
  }
  return problems;
}

module.exports = { load, replay, runs, compare };

// node --test runs every .js file under a test folder; this one only reports when run by hand.
if (require.main === module && !process.env.NODE_TEST_CONTEXT) {
  const data = load();
  const want = process.argv.slice(2);
  let total = 0;
  for (const [id, rec] of Object.entries(data.versions)) {
    if (want.length && !want.includes(id)) continue;
    const problems = replay(id, rec);
    const count = runs(id, rec).length;
    total += problems.length;
    console.log('== ' + id + ': ' + problems.length + ' differences in ' + count + ' files');
    for (const p of problems.slice(0, Number(process.env.SHOW || 400))) {
      // The lines of the file the problem is about: the setting it names, or the whole file if it's short.
      const name = /^([a-z0-9.-]+)[ :]/.exec(p.problem);
      const lines = p.file.split('\n');
      let shown = lines.length <= 4 ? p.file : lines.filter((l) => name && l.toLowerCase().startsWith(name[1] + ' ')).join('\n');
      if (shown.length > 300) shown = shown.slice(0, 300) + '...';
      console.log('- ' + p.name + ': ' + p.problem + (shown ? '\n    ' + JSON.stringify(shown) : ''));
    }
  }
  process.exitCode = total ? 1 : 0;
}
