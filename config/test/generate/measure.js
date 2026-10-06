// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Writes test/results/servers.json: for each server version, how many
// recorded config files the Config Checker read, what the servers did with
// them, and how many of its answers differ (none, when the tests pass).
//
//   node config/test/generate/measure.js

'use strict';
// node --test runs every .js file under a test folder; this one only runs by hand.
if (process.env.NODE_TEST_CONTEXT) return;
const fs = require('fs');
const path = require('path');
const R = require('../replay.js');

const data = R.load();
const out = { recorded: 'Each server was started with every file; config.js read the same files.', versions: [] };
for (const [id, rec] of Object.entries(data.versions)) {
  const runs = R.runs(id, rec);
  const kinds = { stopsAtLine: 0, stopsAtStartup: 0, starts: 0 };
  let lines = 0, values = 0;
  for (const r of runs) {
    lines += r.file.split('\n').filter((l) => l.trim()).length;
    if (r.outcome.error) kinds.stopsAtLine++;
    else if ('failed' in r.outcome) kinds.stopsAtStartup++;
    else { kinds.starts++; values += Object.keys(rec.baseline).length; }
  }
  const differences = R.replay(id, rec).length;
  out.versions.push({ version: id, files: runs.length, lines: lines, serverStopsAtALine: kinds.stopsAtLine,
    serverStopsWhileStarting: kinds.stopsAtStartup, serverStarts: kinds.starts, settingValuesCompared: values, differences: differences });
}
out.total = {
  files: out.versions.reduce((a, v) => a + v.files, 0), lines: out.versions.reduce((a, v) => a + v.lines, 0),
  settingValuesCompared: out.versions.reduce((a, v) => a + v.settingValuesCompared, 0), differences: out.versions.reduce((a, v) => a + v.differences, 0)
};
const dest = path.join(__dirname, '..', 'results', 'servers.json');
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, JSON.stringify(out, null, 2) + '\n');
console.log(dest, JSON.stringify(out.total));
