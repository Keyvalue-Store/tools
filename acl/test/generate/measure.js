// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Writes test/results/servers.json: for each server version, how many
// recorded cases the ACL Builder replayed, what the servers did with them,
// and how many of its answers differ (none, when the tests pass).
//
//   node acl/test/generate/measure.js

'use strict';
// node --test runs every .js file under a test folder; this one only runs by hand.
if (process.env.NODE_TEST_CONTEXT) return;
const fs = require('fs');
const path = require('path');
const R = require('../replay.js');

const data = R.load();
const out = { recorded: 'Each case ran on the built server; acl.js replayed the same cases.', versions: [] };
for (const [id, rec] of Object.entries(data)) {
  const steps = rec.setuser.flatMap((c) => c.steps);
  const dry = (rec.dryrun || []).flatMap((u) => u.checks);
  const multi = rec.multi.flatMap((u) => u.checks);
  const d = R.differences(id, rec);
  out.versions.push({
    version: id,
    aclSetuserCalls: steps.length,
    accepted: steps.filter((s) => s.error === undefined).length,
    refused: steps.filter((s) => s.error !== undefined).length,
    aclListCrashes: steps.filter((s) => s.crash !== undefined).length,
    dryrunChecks: dry.length,
    dryrunDenied: dry.filter(([, r]) => typeof r === 'string' && r !== 'OK').length,
    multiChecks: multi.length,
    multiNoperm: multi.filter(([, r]) => r && r.error && r.error.startsWith('NOPERM')).length,
    getkeys: rec.getkeys.length,
    aclFiles: rec.aclfile.length,
    aclFilesRefused: rec.aclfile.filter((c) => c.error !== undefined).length,
    configFiles: rec.config.length,
    configFilesStopped: rec.config.filter((c) => c.exit !== undefined).length,
    differences: Object.values(d).reduce((a, l) => a + l.length, 0)
  });
}
const sum = (k) => out.versions.reduce((a, v) => a + v[k], 0);
out.total = {};
for (const k of ['aclSetuserCalls', 'aclListCrashes', 'dryrunChecks', 'multiChecks', 'getkeys', 'aclFiles', 'configFiles', 'differences']) out.total[k] = sum(k);
const dest = path.join(__dirname, '..', 'results', 'servers.json');
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, JSON.stringify(out, null, 2) + '\n');
console.log(dest, JSON.stringify(out.total));
