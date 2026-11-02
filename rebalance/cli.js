#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Command line for the Cluster Rebalancing Planner. Run
// "node rebalance/cli.js --help".

'use strict';
const fs = require('fs');
const R = require('./rebalance.js');

const HELP = `Cluster Rebalancing Planner: which slots to move between the primaries of a
Redis or Valkey cluster, and a script that moves them. It reads files only;
nothing connects to your cluster until you run the script yourself.

Usage:
  node rebalance/cli.js NODES.txt [options]     NODES.txt holds CLUSTER NODES output ("-" reads stdin)

Load (optional; without one, each primary gets its share of the 16384 slots):
  --slot-load FILE   Lines of "slot,bytes" or "slot bytes" (also "N-M bytes", spread evenly)
  --key-sizes FILE   Lines of a key and its size, such as "user:42 5120"; keys are hashed to slots

Options:
  --weight ID=W      Give a primary W times the normal share (ID: node id, 6+ character prefix, or host:port)
  --drain ID         Move every slot off this primary (same as --weight ID=0)
  --threshold P      Leave the cluster alone when every primary is within P percent of its target (default 2)
  --max-slots N      Move at most N slots
  --script FILE      Write the shell script that carries out the plan ("-" for stdout)
  --cli NAME         Program the script calls: redis-cli (default) or valkey-cli
  --batch N          Keys per MIGRATE in the script (default 100)
  --json             Print the plan as JSON

Exit status: 0 when a plan was made or nothing needs to move, 1 when the cluster
is not safe to rebalance (the reasons are printed), 2 for a usage or input error.`;

function readText(file) { return fs.readFileSync(file === '-' ? 0 : file, 'utf8'); }
function fmt(n) { return Math.round(n).toLocaleString('en-US'); }

function main(argv) {
  const opt = { weights: {}, drain: [], files: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const need = () => { if (i + 1 >= argv.length) throw new Error(a + ' needs a value. Try --help.'); return argv[++i]; };
    if (a === '--help' || a === '-h') { console.log(HELP); return 0; }
    else if (a === '--slot-load') opt.slotLoad = need();
    else if (a === '--key-sizes') opt.keySizes = need();
    else if (a === '--weight') {
      const v = need(), m = /^(.+)=([0-9]+(?:\.[0-9]+)?)$/.exec(v);
      if (!m) throw new Error('--weight takes ID=NUMBER, such as --weight 10.0.0.4:7000=2');
      opt.weights[m[1]] = Number(m[2]);
    }
    else if (a === '--drain') opt.drain.push(need());
    else if (a === '--threshold') { opt.threshold = Number(need()); if (!(opt.threshold >= 0)) throw new Error('--threshold takes a number of percent, 0 or more'); }
    else if (a === '--max-slots') { opt.maxSlots = Number(need()); if (!Number.isInteger(opt.maxSlots) || opt.maxSlots < 1) throw new Error('--max-slots takes a whole number, 1 or more'); }
    else if (a === '--script') opt.script = need();
    else if (a === '--cli') { opt.cli = need(); if (!/^[A-Za-z0-9._\/-]+$/.test(opt.cli)) throw new Error('--cli takes a program name or path'); }
    else if (a === '--batch') { opt.batch = Number(need()); if (!Number.isInteger(opt.batch) || opt.batch < 1) throw new Error('--batch takes a whole number, 1 or more'); }
    else if (a === '--json') opt.json = true;
    else if (a.startsWith('--')) { console.error('Unknown option ' + a + '. Try --help.'); return 2; }
    else opt.files.push(a);
  }
  if (opt.files.length !== 1) { console.error(opt.files.length ? 'Give one CLUSTER NODES file.' : HELP); return 2; }
  if (opt.slotLoad && opt.keySizes) { console.error('Use --slot-load or --key-sizes, not both.'); return 2; }

  const cluster = R.parseClusterNodes(readText(opt.files[0]));
  if (cluster.errors.length) {
    for (const e of cluster.errors) console.error((e.line ? 'line ' + e.line + ': ' : '') + e.message + (e.text ? ': ' + e.text : ''));
    return 2;
  }
  if (!cluster.nodes.length) { console.error('No nodes found. Use the output of CLUSTER NODES.'); return 2; }

  let load = null, loadNote = '';
  if (opt.slotLoad || opt.keySizes) {
    const r = opt.slotLoad ? R.parseSlotLoad(readText(opt.slotLoad)) : R.parseKeySizes(readText(opt.keySizes));
    if (r.errors.length) {
      for (const e of r.errors.slice(0, 20)) console.error('line ' + e.line + ': ' + e.message + ': ' + e.text);
      if (r.errors.length > 20) console.error('... and ' + (r.errors.length - 20) + ' more');
      return 2;
    }
    load = r.load;
    if (opt.keySizes) loadNote = r.keys + ' keys';
  }

  const p = R.plan(cluster, { weights: opt.weights, drain: opt.drain, threshold: opt.threshold, maxSlots: opt.maxSlots, load });
  if (opt.json) {
    const out = Object.assign({}, p);
    delete out.owner;
    console.log(JSON.stringify(out, null, 2));
  } else {
    for (const pr of p.problems) console.log((pr.code === 'option' ? 'Cannot plan: ' : 'Not safe: ') + pr.message + '. ' + pr.fix + '.');
    if (!p.problems.length) {
      console.log('Balancing by ' + (load ? 'load' + (loadNote ? ' (' + loadNote + ')' : '') : 'slot count') + '.');
      console.log('primary\t\tweight\tslots before\tslots after' + (load ? '\tload before\tload after\ttarget' : '\ttarget'));
      p.before.forEach((b, i) => {
        const a = p.after[i];
        console.log(b.node + '\t' + b.weight + '\t' + b.slots + '\t\t' + a.slots + '\t\t' + (load ? fmt(b.load) + '\t\t' + fmt(a.load) + '\t\t' + fmt(b.target) : b.target));
      });
      if (p.balanced) console.log('Nothing to move: every primary is within ' + (opt.threshold === undefined ? 2 : opt.threshold) + '% of its target.');
      for (const m of p.moves) console.log('Move ' + m.slots + ' slots' + (load ? ' (' + fmt(m.load) + ')' : '') + ' from ' + m.fromNode + ' to ' + m.toNode + ': ' + R.formatRanges(m.ranges));
      if (p.moves.length) console.log('In all ' + p.movedSlots + ' slots' + (load ? ', ' + fmt(p.movedLoad) + ' of ' + fmt(p.total) : '') + '.');
      if (p.capped) console.log('Stopped at --max-slots; run the planner again afterwards to continue.');
    }
    for (const n of p.notes) console.log('Note: ' + n + '.');
  }
  if (opt.script && !p.problems.length) {
    const text = R.script(cluster, p, { cli: opt.cli, batch: opt.batch });
    if (opt.script === '-') process.stdout.write(text);
    else fs.writeFileSync(opt.script, text, { mode: 0o755 });
  }
  return p.problems.length ? 1 : 0;
}

try { process.exitCode = main(process.argv.slice(2)); }
catch (e) { console.error(e.message); process.exitCode = 2; }
