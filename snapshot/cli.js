#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Command line for the Snapshot Viewer. Run "node snapshot/cli.js --help".

'use strict';
const fs = require('fs');
const R = require('./rdb.js');

const HELP = `Snapshot Viewer: what is inside a Redis or Valkey RDB snapshot.

Usage:
  node snapshot/cli.js dump.rdb                  Totals: keys by type and database, the biggest
                                                 keys, key prefixes, expiries
  node snapshot/cli.js dump.rdb --keys           Every key as CSV: db, key, type, encoding,
                                                 elements, bytes, expires
  node snapshot/cli.js dump.rdb --key user:42    One key's value (--db N for another database)
  node snapshot/cli.js dump.rdb --json-lines     Every key with its value, one JSON object a line
  node snapshot/cli.js --dump payload.bin        A DUMP payload: raw bytes, hex, or the quoted
                                                 text redis-cli prints ("-" reads standard input)

Options:
  --db N        Database for --key (default 0)
  --top N       How many of the biggest keys and prefixes to list (default 20)
  --json        Print the totals as JSON

The file is read piece by piece, so snapshots of any size work.`;

// Reads a file in windows of 16 MB, so the snapshot never has to fit in memory.
function fileSource(path) {
  const fd = fs.openSync(path, 'r');
  const size = fs.fstatSync(fd).size;
  const WINDOW = 16 * 1024 * 1024;
  let buf = Buffer.alloc(0), bufStart = 0, pos = 0;
  function fill(n) {
    if (pos + n > size) throw new R.RdbError('The file ends in the middle of a value', pos);
    if (pos >= bufStart && pos + n <= bufStart + buf.length) return;
    const len = Math.min(Math.max(n, WINDOW), size - pos);
    buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, pos);
    bufStart = pos;
  }
  return {
    get pos() { return pos; },
    size: size,
    byte() { fill(1); return buf[pos++ - bufStart]; },
    bytes(n) { fill(n); const o = pos - bufStart; pos += n; return new Uint8Array(buf.subarray(o, o + n)); },
    skip(n) { if (pos + n > size) throw new R.RdbError('The file ends in the middle of a value', pos); pos += n; },
    atEnd() { return pos >= size; },
    rest() { return size - pos; },
    crc() {
      let c = null, at = 0;
      const chunk = Buffer.alloc(Math.min(WINDOW, Math.max(1, pos)));
      while (at < pos) {
        const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, pos - at), at);
        c = R.crc64(chunk.subarray(0, n), c);
        at += n;
      }
      return c || [0, 0];
    },
    close() { fs.closeSync(fd); }
  };
}

const strict = new TextDecoder('utf-8', { fatal: true });
const fmt = (n) => Number(n).toLocaleString('en-US');
const plural = (n, one, many) => fmt(n) + ' ' + (n === 1 ? one : many);
function bytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}
// Spreadsheets run a cell that starts with = + - or @ as a formula, so
// such a key gets a ' in front, the usual guard.
function csv(s) { if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
// A whole number from an option, or NaN when it isn't one.
const number = (s) => (/^\d+$/.test(s || '') ? parseInt(s, 10) : NaN);
// A key for CSV: its text when it is valid UTF-8, otherwise redis-cli's quoted form.
function csvKey(b) { try { return csv(strict.decode(b)); } catch (e) { return csv(R.showBytes(b)); } }

// JSON for one value. Text that is valid UTF-8 stays text; other bytes
// become {"base64": "..."}.
function jsonBytes(b) {
  if (b === null) return null;
  try { return strict.decode(b); } catch (e) { return { base64: Buffer.from(b).toString('base64') }; }
}
function jsonNumber(x) {
  if (typeof x === 'bigint') return x.toString();
  if (x === Infinity) return 'inf';
  if (x === -Infinity) return '-inf';
  if (Number.isNaN(x)) return 'nan';
  return x;
}
function jsonValue(e) {
  const v = e.value;
  if (v === null || v === undefined) return null;
  switch (e.type) {
    case 'string': return jsonBytes(v);
    case 'list': case 'set': return v.map(jsonBytes);
    case 'zset': return v.map((p) => [jsonBytes(p[0]), jsonNumber(p[1])]);
    case 'hash': return v.map((p) => (p[2] ? [jsonBytes(p[0]), jsonBytes(p[1]), jsonNumber(p[2])] : [jsonBytes(p[0]), jsonBytes(p[1])]));
    case 'array': return v.map((p) => [jsonNumber(p[0]), p[1] instanceof Uint8Array ? jsonBytes(p[1]) : jsonNumber(p[1])]);
    case 'gcra': return jsonNumber(v);
    case 'stream': return {
      entries: v.entries.map((x) => [x[0], x[1].map((f) => [jsonBytes(f[0]), jsonBytes(f[1])])]),
      lastId: v.lastId,
      groups: v.groups.map((g) => ({ name: jsonBytes(g.name), lastId: g.lastId, pending: g.pending.length, consumers: g.consumers.map((c) => jsonBytes(c.name)) }))
    };
  }
  return null;
}

async function main(argv) {
  let file = null, mode = 'summary', keyName = null, db = 0, top = 20, json = false, dump = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { console.log(HELP); return 0; }
    else if (a === '--keys') mode = 'keys';
    else if (a === '--json-lines') mode = 'lines';
    else if (a === '--json') json = true;
    else if (a === '--key' || a === '--db' || a === '--top' || a === '--dump') {
      if (i + 1 >= argv.length) { console.error(a + ' needs a value after it. Try --help.'); return 2; }
      const v = argv[++i];
      if (a === '--key') { mode = 'key'; keyName = v; }
      else if (a === '--dump') dump = v;
      else if (a === '--db') db = number(v);
      else top = number(v);
    }
    else if (a.startsWith('--')) { console.error('Unknown option ' + a + '. Try --help.'); return 2; }
    else file = a;
  }
  if (!(db >= 0)) { console.error('--db needs a database number.'); return 2; }
  if (!(top >= 1)) { console.error('--top needs a number of 1 or more.'); return 2; }

  if (dump) {
    const raw = fs.readFileSync(dump === '-' ? 0 : dump);
    // redis-cli's quoted form is printable ASCII in quotes, and hex is hex
    // digits. Anything else, such as what redis-cli --raw printed, is the
    // payload's own bytes.
    const asText = raw.toString('latin1');
    const looksText = /^\s*"[\x20-\x7e]*"\s*$/.test(asText) || /^\s*(0x)?[0-9a-fA-F\s]+$/.test(asText);
    const payload = looksText ? R.bytesFromText(raw.toString('utf8')).bytes : new Uint8Array(raw);
    const d = R.readDump(payload);
    console.log(`${d.type}, ${d.encoding}${d.detail ? ' (' + d.detail + ')' : ''}, ${d.type === 'string' ? plural(d.length, 'byte', 'bytes') : plural(d.length, 'element', 'elements')}; RDB version ${d.version}; checksum ${d.checksum}`);
    if (json) console.log(JSON.stringify(jsonValue(d)));
    else console.log(R.show(d, d.value, 1e9));
    return d.checksum === 'mismatch' ? 1 : 0;
  }

  if (!file) { console.error('Name a snapshot file. Try --help.'); return 2; }
  const src = fileSource(file);
  const sum = R.summary({ top: top });
  let info = null;
  const target = keyName === null ? null : Buffer.from(keyName);
  let found = null, nowSet = false;
  // Lines for standard output, written after each step as fast as the
  // reader takes them, so a pipe never makes them pile up in memory.
  const out = process.stdout;
  let pending = mode === 'keys' ? ['db,key,type,encoding,elements,bytes,expires\n'] : [];
  async function flush() {
    if (!pending.length) return;
    const ok = out.write(pending.join(''));
    pending = [];
    if (!ok) await new Promise((done) => out.once('drain', done));
  }
  const p = R.parser(src, {
    values: mode === 'lines',
    onKey(e) {
      if (mode === 'summary') {
        if (!nowSet) { nowSet = true; const ct = R.auxValue(p.info, 'ctime'); if (ct) sum.setNow(Number(ct) * 1000); }
        sum.add(e);
      } else if (mode === 'keys') {
        pending.push([e.db, csvKey(e.key), e.type, csv(e.encoding), e.length === null ? '' : e.length, e.size, e.expire === null ? '' : csv(R.fmtTime(e.expire))].join(',') + '\n');
      } else if (mode === 'lines') {
        const o = { db: e.db, key: jsonBytes(e.key), type: e.type };
        if (e.expire !== null) o.expire = jsonNumber(e.expire);
        o.value = jsonValue(e);
        if (e.module) o.module = e.module;
        pending.push(JSON.stringify(o) + '\n');
      } else if (mode === 'key' && e.db === db && Buffer.compare(Buffer.from(e.key), target) === 0) {
        found = e;
      }
    }
  });
  if (mode === 'key') {
    // Find the key first, then decode only its value.
    while (!p.done && !found) p.step(10000);
    if (!found) { console.error('No key ' + JSON.stringify(keyName) + ' in database ' + db + '.'); return 1; }
    const again = fileSource(file);
    again.skip(found.valueOffset);
    const value = R.readValueFrom(again, found, p.info);
    again.close();
    console.log(`${found.type}, ${found.encoding}${found.detail ? ' (' + found.detail + ')' : ''}, ${found.type === 'string' ? plural(found.length, 'byte', 'bytes') : plural(found.length, 'element', 'elements')}, ${plural(found.size, 'byte', 'bytes')} in the file${found.expire !== null ? ', expires ' + R.fmtTime(found.expire) : ''}`);
    console.log(R.show(found, value, 1e9));
    return 0;
  }
  while (!p.done) {
    if (src.atEnd()) throw new R.RdbError('The file ends before its end marker', src.pos);
    p.step(mode === 'lines' ? 500 : mode === 'keys' ? 10000 : 100000);
    await flush();
  }
  info = p.info;
  src.close();
  const damaged = info.checksum && info.checksum.status === 'mismatch';
  if (mode !== 'summary') {
    if (damaged) console.error('The checksum at the end of the file does not match, so the file may be damaged.');
    return damaged ? 1 : 0;
  }

  const s = sum.result();
  if (json) {
    const totals = Object.assign({}, s, {
      file: { name: file, bytes: src.size, magic: info.magic, version: info.version, checksum: info.checksum, trailing: info.trailing },
      aux: info.aux, functions: info.functions.map(R.functionName), moduleAux: info.moduleAux,
      largest: s.largest.map((x) => Object.assign({}, x, { key: R.showKey(x.key) })),
      longest: s.longest.map((x) => Object.assign({}, x, { key: R.showKey(x.key) }))
    });
    console.log(JSON.stringify(totals, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
    return damaged ? 1 : 0;
  }
  const ver = R.auxValue(info, 'valkey-ver') ? 'Valkey ' + R.auxValue(info, 'valkey-ver') : R.auxValue(info, 'redis-ver') ? 'Redis ' + R.auxValue(info, 'redis-ver') : 'unknown server';
  const ctime = R.auxValue(info, 'ctime');
  console.log(`${file}: ${bytes(src.size)}, RDB version ${info.version}, written by ${ver}${ctime ? ' on ' + R.fmtTime(Number(ctime) * 1000) : ''}`);
  console.log(`Checksum: ${info.checksum ? info.checksum.status : 'none in this version'}${info.trailing ? '. ' + fmt(info.trailing) + ' bytes follow the snapshot (an AOF file with an RDB preamble keeps its commands there)' : ''}`);
  console.log(`\n${plural(s.keys, 'key', 'keys')}, ${bytes(s.bytes)} of keys and values, ${fmt(s.expiring)} with an expiry${s.expired ? ' (' + fmt(s.expired) + ' already expired when the file was written)' : ''}`);
  console.log('\nBy type');
  for (const [t, v] of Object.entries(s.byType).sort((a, b) => b[1].bytes - a[1].bytes)) {
    console.log(`  ${t.padEnd(8)} ${plural(v.keys, 'key ', 'keys').padStart(17)} ${bytes(v.bytes).padStart(10)}${t === 'string' || t === 'module' ? '' : '  ' + plural(v.elements, 'element', 'elements')}`);
  }
  console.log('\nBy encoding');
  for (const [t, v] of Object.entries(s.byEncoding).sort((a, b) => b[1].bytes - a[1].bytes)) console.log(`  ${t.padEnd(44)} ${plural(v.keys, 'key ', 'keys').padStart(17)} ${bytes(v.bytes).padStart(10)}`);
  if (Object.keys(s.byDb).length > 1 || !s.byDb[0]) {
    console.log('\nBy database');
    for (const [d, v] of Object.entries(s.byDb)) console.log(`  db${d.padEnd(5)} ${plural(v.keys, 'key ', 'keys').padStart(17)} ${bytes(v.bytes).padStart(10)}  ${fmt(v.expiring)} expiring`);
  }
  console.log(`\nBiggest keys`);
  for (const x of s.largest.slice(0, top)) console.log(`  ${bytes(x.size).padStart(10)}  ${x.type.padEnd(7)} ${x.length === null ? ''.padStart(19) : (fmt(x.length).padStart(10) + ' ' + (x.type === 'string' ? 'bytes   ' : 'elements'))}  db${x.db} ${R.showKey(x.key)}`);
  console.log(s.prefixOverflow ? `\nPrefixes (more than ${fmt(s.prefixCount)}; ${plural(s.prefixOverflow, 'key', 'keys')} with ${bytes(s.prefixOverflowBytes)} under the rest aren't listed)` : `\nPrefixes (${fmt(s.prefixCount)} in all)`);
  for (const x of s.prefixes.slice(0, top)) console.log(`  ${plural(x.keys, 'key ', 'keys').padStart(17)} ${bytes(x.bytes).padStart(10)}  ${x.prefix}`);
  if (s.expiring && s.snapshotTime) {
    console.log('\nTime left on expiring keys, from when the file was written');
    for (const [b, n] of Object.entries(s.ttl)) if (n) console.log(`  ${b.padEnd(16)} ${fmt(n).padStart(12)}`);
  }
  if (s.idle) { console.log('\nIdle time (written because maxmemory-policy uses LRU)'); for (const [b, n] of Object.entries(s.idle)) console.log(`  ${b.padEnd(16)} ${fmt(n).padStart(12)}`); }
  if (s.freq) { console.log('\nAccess frequency counter (written because maxmemory-policy uses LFU)'); for (const [b, n] of Object.entries(s.freq)) console.log(`  ${b.padEnd(16)} ${fmt(n).padStart(12)}`); }
  if (s.fieldTtls) console.log(`\nHash fields with their own expiry: ${fmt(s.fieldTtls)}`);
  if (Object.keys(s.modules).length) console.log('\nModule values: ' + Object.entries(s.modules).map(([m, n]) => m + ' ' + fmt(n)).join(', '));
  if (info.functions.length) console.log('\nFunction libraries: ' + info.functions.map(R.functionName).join(', '));
  const slotAux = info.aux.filter((a) => a[0] === 'slot-info').length;
  if (info.slotInfo || slotAux) console.log(`\nCluster: sizes recorded for ${fmt(info.slotInfo || slotAux)} slots`);
  return damaged ? 1 : 0;
}

// Stop quietly when the output is piped into something like head that closes early.
process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); throw e; });
main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
  console.error(e.code === 'ENOENT' ? 'No such file: ' + e.path : e.code === 'EISDIR' ? 'That is a folder, not a file.' : 'Could not read the file: ' + e.message);
  process.exitCode = 2;
});
