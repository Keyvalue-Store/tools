#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Command line for the Hash Slot Calculator. Run "node slots/cli.js --help".

'use strict';
const fs = require('fs');
const S = require('./slots.js');

const HELP = `Hash Slot Calculator: which Redis or Valkey cluster slot a key lands in.

Usage:
  node slots/cli.js KEY [KEY ...]       Slot of each key
  node slots/cli.js --file keys.txt     Slot of every key in a file, one per line ("-" reads stdin)
  node slots/cli.js --check "MGET a b"  Would a cluster accept this command, or answer CROSSSLOT?

Options:
  --nodes FILE   Output of CLUSTER NODES, to show which primary holds each key
  --split N      Or assume a new cluster of N primaries, split the way --cluster create splits it
  --summary      With --file: totals per primary, busiest slots and hash tags
  --raw          Take keys exactly as written (do not decode "quoted" keys or strip "1) ")
  --json         Print JSON

Exit status for --check: 0 when every key is in one slot, 1 for CROSSSLOT, 2 for an error.`;

function main(argv) {
  const opt = { keys: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { console.log(HELP); return 0; }
    else if (a === '--file') opt.file = argv[++i];
    else if (a === '--check') opt.check = argv[++i];
    else if (a === '--nodes') opt.nodes = argv[++i];
    else if (a === '--split') opt.split = parseInt(argv[++i], 10);
    else if (a === '--summary') opt.summary = true;
    else if (a === '--raw') opt.raw = true;
    else if (a === '--json') opt.json = true;
    else if (a.startsWith('--')) { console.error('Unknown option ' + a + '. Try --help.'); return 2; }
    else opt.keys.push(a);
  }

  if (opt.check !== undefined) {
    const r = S.checkCommand(opt.check);
    if (r.error) { console.error(r.error); return 2; }
    if (opt.json) {
      console.log(JSON.stringify({ command: r.command, crossSlot: r.crossSlot, slots: r.slots,
        keys: r.keys.map((k) => ({ key: S.displayKey(k.bytes), slot: k.slot, hashTag: k.tagged })), notes: r.notes }, null, 2));
    } else {
      if (!r.keys.length) console.log((r.multiKey ? 'This ' + r.command + ' has no keys' : r.command + ' takes no keys') + ', so any node can run it.');
      for (const k of r.keys) console.log(k.slot + '\t' + S.displayKey(k.bytes));
      if (r.keys.length) console.log(r.crossSlot ? 'CROSSSLOT: the keys are in ' + r.slots.length + ' different slots.'
        : 'OK: every key is in slot ' + r.slots[0] + '.');
      if (!r.known) console.log('Note: ' + r.command + ' is not a multi-key command this tool knows; it was checked as a single-key command.');
      for (const n of r.notes) console.log('Note: ' + n);
    }
    return r.crossSlot ? 1 : 0;
  }

  let nodes = null;
  if (opt.nodes) {
    nodes = S.parseClusterNodes(fs.readFileSync(opt.nodes, 'utf8'));
    if (!nodes.length) { console.error('No primaries with slots found in ' + opt.nodes + '. Use the output of CLUSTER NODES.'); return 2; }
  } else if (opt.split) nodes = S.evenSplit(opt.split);

  let keys;
  if (opt.file) {
    const bytes = fs.readFileSync(opt.file === '-' ? 0 : opt.file);
    keys = S.parseKeyBuffer(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length), opt.raw);
  } else keys = opt.keys.map((k) => opt.raw ? S.toBytes(k) : S.parseKeyLine(k));
  if (!keys.length) { console.log(HELP); return 2; }

  const r = S.analyze(keys, nodes);
  if (opt.summary) {
    const out = {
      keys: r.total, slotsUsed: r.usedSlots, keysWithHashTag: r.tagged,
      perPrimary: nodes ? nodes.map((n, i) => ({ primary: n.node, keys: r.perNode[i] })) : undefined,
      keysInUnownedSlots: nodes ? r.unowned : undefined,
      busiestSlots: r.topSlots.map(([slot, count]) => ({ slot, keys: count })),
      commonHashTags: r.topTags.map(([tag, count]) => ({ tag, keys: count }))
    };
    if (opt.json) console.log(JSON.stringify(out, null, 2));
    else {
      console.log(`${r.total} keys in ${r.usedSlots} slots, ${r.tagged} with a hash tag.`);
      if (nodes) {
        for (let i = 0; i < nodes.length; i++) console.log(`${r.perNode[i]}\t${(100 * r.perNode[i] / r.total).toFixed(1)}%\t${nodes[i].node}`);
        if (r.unowned) console.log(`${r.unowned}\tin slots no primary owns`);
      }
      console.log('Busiest slots:');
      const keysWord = (n) => n + (n === 1 ? ' key' : ' keys');
      for (const [slot, count] of r.topSlots) console.log(`  ${slot}\t${keysWord(count)}`);
      if (r.topTags.length) {
        console.log('Most used hash tags:');
        for (const [tag, count] of r.topTags) console.log(`  {${tag}}\t${keysWord(count)}`);
      }
    }
    return 0;
  }
  if (opt.json) {
    console.log(JSON.stringify(r.rows.map((row) => ({ key: S.displayKey(row.bytes), slot: row.slot,
      primary: nodes ? (row.node >= 0 ? nodes[row.node].node : null) : undefined })), null, 2));
  } else {
    for (const row of r.rows) {
      const node = nodes ? '\t' + (row.node >= 0 ? nodes[row.node].node : 'no owner') : '';
      console.log(row.slot + node + '\t' + S.displayKey(row.bytes));
    }
  }
  return 0;
}

try { process.exitCode = main(process.argv.slice(2)); }
catch (e) { console.error(e.message); process.exitCode = 2; }
