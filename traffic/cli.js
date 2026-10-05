#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Command line for the Traffic Analyzer. Run "node traffic/cli.js --help".

'use strict';
const fs = require('fs');
const T = require('./traffic.js');

const HELP = `Traffic Analyzer: what the commands in a Redis or Valkey MONITOR capture add up to.

Usage:
  node traffic/cli.js monitor.txt               Totals: commands per second, the command mix,
                                                busiest keys, key patterns, clients, cluster
                                                spread, findings, and the LRU hit-rate curve
  node traffic/cli.js monitor.txt --keys        Every key as CSV: db, key, reads, writes, deletes
  node traffic/cli.js monitor.txt --curve       The hit-rate curve as CSV: cache size in keys,
                                                share of reads served
  node traffic/cli.js monitor.txt --seconds     Commands per second as CSV
  node traffic/cli.js monitor.txt --cache 5000  Share of reads a cache of 5,000 keys would serve
  node traffic/cli.js -                         Read the capture from standard input

Options:
  --top N         How many commands, keys, patterns and clients to list (default 15)
  --primaries N   Primaries for the cluster spread (default 3)
  --json          Print everything as JSON
  --no-curve      Skip the hit-rate curve, which needs memory for every key access

Record a capture with:
  redis-cli -h HOST -p PORT MONITOR > monitor.txt      (Ctrl-C to stop)
  timeout 60 valkey-cli -h HOST -p PORT MONITOR > monitor.txt

MONITOR slows a busy server down, so keep captures short.`;

const fmt = (n) => Number(n).toLocaleString('en-US');
const pct = (x) => (100 * x).toFixed(1) + '%';
const plural = (n, one, many) => fmt(n) + ' ' + (n === 1 ? one : many);
const strict = new TextDecoder('utf-8', { fatal: true });
function csv(s) { return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
// A key for CSV: its text when it is valid UTF-8, otherwise quoted with \xHH escapes.
function csvKey(b) { try { return csv(strict.decode(b)); } catch (e) { return csv(T.showKey(b)); } }
function clock(ms) { return new Date(ms).toISOString().replace('T', ' ').slice(0, 19); }
function duration(s) {
  if (s < 1) return Math.round(s * 1000) + ' ms';
  if (s < 120) return s.toFixed(1) + ' s';
  if (s < 7200) return (s / 60).toFixed(1) + ' min';
  return (s / 3600).toFixed(1) + ' h';
}

async function main(argv) {
  let file = null, mode = 'summary', top = 15, primaries = 3, json = false, curve = true, cache = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { console.log(HELP); return 0; }
    else if (a === '--keys') mode = 'keys';
    else if (a === '--curve') mode = 'curve';
    else if (a === '--seconds') mode = 'seconds';
    else if (a === '--cache') { mode = 'cache'; cache = parseInt(argv[++i], 10); }
    else if (a === '--top') top = parseInt(argv[++i], 10);
    else if (a === '--primaries') primaries = parseInt(argv[++i], 10);
    else if (a === '--json') json = true;
    else if (a === '--no-curve') curve = false;
    else if (a.startsWith('--')) { console.error('Unknown option ' + a + '. Try --help.'); return 2; }
    else file = a;
  }
  if (!file) { console.error('Name a capture file, or - for standard input. Try --help.'); return 2; }
  if ((mode === 'curve' || mode === 'cache') && !curve) { console.error('--curve and --cache need the curve.'); return 2; }
  if (mode === 'cache' && !(cache >= 0)) { console.error('--cache needs a number of keys.'); return 2; }
  if (!(primaries >= 1 && primaries <= 16384)) { console.error('--primaries needs a number from 1 to 16384.'); return 2; }

  // Read in pieces, so captures of any length work.
  const an = T.analyzer({ curve: curve });
  const decoder = new TextDecoder('utf-8');
  const stream = file === '-' ? process.stdin : fs.createReadStream(file, { highWaterMark: 4 * 1024 * 1024 });
  for await (const chunk of stream) an.addChunk(decoder.decode(chunk, { stream: true }), false);
  an.addChunk(decoder.decode(), true);
  const r = an.result({ top: top, primaries: primaries });
  if (!r.commands) {
    console.error('No MONITOR lines found.' + (r.unparsedExamples.length ? ' The first line reads: ' + r.unparsedExamples[0] : ''));
    return 1;
  }

  if (mode === 'keys') {
    console.log('db,key,reads,writes,deletes');
    const lines = [];
    an.eachKey((db, key, reads, writes, deletes) => {
      lines.push([db, csvKey(T.fromLatin1(key)), reads, writes, deletes].join(','));
      if (lines.length === 10000) { process.stdout.write(lines.join('\n') + '\n'); lines.length = 0; }
    });
    if (lines.length) process.stdout.write(lines.join('\n') + '\n');
    return 0;
  }
  if (mode === 'seconds') {
    console.log(r.series.step === 1 ? 'time,commands' : `time,commands in ${r.series.step} s`);
    r.series.counts.forEach((n, i) => console.log(clock((r.series.start + i * r.series.step) * 1000) + ',' + n));
    return 0;
  }
  const c = curve ? an.curve() : null;
  if (mode === 'curve') {
    console.log('keys,hit_rate');
    for (const [k, h] of c.points) console.log(k + ',' + h.toFixed(6));
    return 0;
  }
  if (mode === 'cache') {
    console.log(`A cache of ${plural(cache, 'key', 'keys')} would serve ${pct(c.hitRate(cache))} of the ${fmt(c.reads)} reads. Holding every key, the best possible is ${pct(c.best)}.`);
    return 0;
  }

  if (json) {
    const out = Object.assign({}, r, {
      file: file,
      keys: Object.assign({}, r.keys, { top: r.keys.top.map((k) => Object.assign({}, k, { key: T.showKey(k.key) })) }),
      curve: c ? { accesses: c.accesses, reads: c.reads, coldReads: c.coldReads, keys: c.keys, best: c.best, partial: c.partial, sizes: c.sizes, points: c.points } : null
    });
    console.log(JSON.stringify(out, null, 2));
    return 0;
  }

  const name = file === '-' ? 'standard input' : file;
  console.log(`${name}: ${plural(r.commands, 'command', 'commands')} in ${duration(r.duration)}, from ${clock(r.start)} to ${clock(r.end)} UTC`);
  console.log(`Average ${r.average.toLocaleString('en-US', { maximumFractionDigits: 1 })} commands a second, peak ${fmt(r.peak.count)} at ${clock(r.peak.time * 1000).slice(11)}`);
  const k = r.kinds;
  console.log(`Reads ${pct(k.read / r.commands)}, writes ${pct(k.write / r.commands)}, scripts ${pct(k.script / r.commands)}, pub/sub ${pct(k.pubsub / r.commands)}, other ${pct(k.other / r.commands)}`);
  console.log(`${plural(r.keys.distinct, 'key', 'keys')}, ${plural(r.keys.accesses, 'key access', 'key accesses')} (${plural(r.keys.reads, 'read', 'reads')}, ${plural(r.keys.writes, 'write', 'writes')}, ${plural(r.keys.deletes, 'delete', 'deletes')}), ${plural(r.connections, 'connection', 'connections')} from ${plural(r.hostCount, 'address', 'addresses')}`);
  if (r.unparsed) console.log(`${plural(r.unparsed, 'line', 'lines')} weren't MONITOR lines and were skipped, such as: ${r.unparsedExamples[0]}`);

  console.log('\nCommands');
  console.log('     count   share  kind     command');
  for (const x of r.byCommand.slice(0, top)) console.log(`  ${fmt(x.count).padStart(8)}  ${pct(x.count / r.commands).padStart(6)}  ${x.kind.padEnd(7)}  ${x.name}`);
  if (r.byCommand.length > top) console.log(`  and ${plural(r.byCommand.length - top, 'other command', 'other commands')}`);

  if (r.byDb.length > 1) console.log('\nBy database: ' + r.byDb.map((d) => `db${d.db} ${fmt(d.count)}`).join(', '));

  if (r.keys.distinct) {
    console.log('\nBusiest keys');
    console.log('  accesses     reads    writes   deletes  key');
    for (const x of r.keys.top) console.log(`  ${fmt(x.total).padStart(8)}  ${fmt(x.reads).padStart(8)}  ${fmt(x.writes).padStart(8)}  ${fmt(x.deletes).padStart(8)}  ${x.db ? 'db' + x.db + ' ' : ''}${T.showKey(x.key)}`);
    console.log(`\nKey patterns (${fmt(r.patternCount)} in all${r.separator ? ', split at "' + r.separator + '"' : ''})`);
    console.log('      keys  accesses     reads    writes  pattern');
    for (const x of r.patterns) console.log(`  ${fmt(x.keys).padStart(8)}  ${fmt(x.accesses).padStart(8)}  ${fmt(x.reads).padStart(8)}  ${fmt(x.writes).padStart(8)}  ${x.pattern}`);
  }

  console.log('\nClients');
  console.log('  commands  connections  address  (top commands)');
  for (const h of r.hosts) console.log(`  ${fmt(h.count).padStart(8)}  ${(h.host === 'lua' ? '' : fmt(h.connections)).padStart(11)}  ${h.host === 'lua' ? 'lua (commands run by scripts)' : h.host}  (${h.top.map((t) => t[0] + ' ' + fmt(t[1])).join(', ')})`);

  if (r.cluster.keyAccesses) {
    console.log(`\nCluster spread over ${plural(r.cluster.primaries, 'primary', 'primaries')}, by key accesses`);
    r.cluster.ranges.forEach(([a, b], i) => console.log(`  primary ${String(i + 1).padEnd(3)} slots ${(a + '-' + b).padEnd(12)} ${pct(r.cluster.perPrimary[i] / r.cluster.keyAccesses).padStart(6)}`));
    console.log(`  Busiest slots: ${r.cluster.hotSlots.slice(0, 5).map((s) => s.slot + ' (' + fmt(s.accesses) + ')').join(', ')}`);
  }

  if (r.findings.length) {
    console.log('\nWorth a look');
    for (const f of r.findings) {
      console.log(`  ${f.title} (${plural(f.count, 'time', 'times')})`);
      if (f.examples.length) console.log(`    ${f.examples.join('  |  ')}`);
      console.log(`    ${f.text}`);
    }
  }

  if (c && c.reads) {
    console.log(`\nLRU cache hit rate (${fmt(c.reads)} reads, ${fmt(c.coldReads)} of them the first use of a key, which no cache can serve)`);
    if (c.partial) console.log(`  Covers the first ${fmt(c.accesses)} key accesses only.`);
    console.log(`  Holding all ${fmt(c.keys)} keys serves ${pct(c.best)} of reads, the best possible.`);
    const sizes = c.sizes.filter((s) => s.keys !== null).map((s) => `${Math.round(s.share * 100)}% takes ${fmt(s.keys)}`);
    if (sizes.length) console.log(`  Reaching ${sizes[0].replace('takes', 'of that takes')} ${c.sizes[0].keys === 1 ? 'key' : 'keys'}${sizes.length > 1 ? ', ' + sizes.slice(1).join(', ') : ''}.`);
    console.log('        keys  hit rate');
    const shown = new Set();
    for (let n = 1; n < c.keys; n *= 10) for (const m of [1, 2, 5]) if (n * m < c.keys) shown.add(n * m);
    shown.add(c.keys);
    for (const n of Array.from(shown).sort((a, b) => a - b)) console.log(`  ${fmt(n).padStart(10)}  ${pct(c.hitRate(n)).padStart(8)}`);
  }
  return 0;
}

// Stop quietly when the output is piped into something like head that closes early.
process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); throw e; });
main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
  console.error(e.code === 'ENOENT' ? 'No such file: ' + e.path : e.stack);
  process.exitCode = 2;
});
