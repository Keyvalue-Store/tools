#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Command line for the Mass Insert Builder. Run "node pipe/cli.js --help".

'use strict';
const fs = require('fs');
const P = require('./pipe.js');

const HELP = `Mass Insert Builder: CSV, JSON or command lines to a file for redis-cli --pipe.

Usage:
  node pipe/cli.js csv FILE --key 'user:\${id}' --type hash [options] > data.resp
  node pipe/cli.js json FILE --key 'user:\${id}' --type hash [options] > data.resp
  node pipe/cli.js commands FILE > data.resp      One command per line, quoted as in redis-cli
  node pipe/cli.js decode FILE                    Show a protocol file as readable commands and replies

  Then load it:  redis-cli --pipe < data.resp   (or valkey-cli --pipe)
  FILE can be "-" for standard input.

Options for csv and json:
  --key TEMPLATE      Key for each record. \${name} takes a field: 'user:\${id}', 'cart:{\${user}}:items'
  --type TYPE         string, hash, list, set or zset
  --value FIELD       The value for string, list and set
  --whole-row         For string: store the whole record as JSON
  --fields A,B,C      For hash: these fields only (default: every field not used in the key)
  --include-key-fields  For hash: keep the fields used in the key as well
  --score FIELD --member FIELD   For zset
  --ttl SECONDS       Expire each key after this many seconds
  --fresh             Delete each key before writing it, so loading twice does not add twice
  --db N              Start with SELECT N
  --delimiter X       CSV delimiter (default: guessed from the header line)
  --no-header         The CSV's first line is data; fields are column1, column2, ...`;

function main(argv) {
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') { console.log(HELP); return argv.length ? 0 : 2; }
  const mode = argv[0];
  const opt = {};
  let file = null;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error(a + ' needs a value'); return argv[++i]; };
    if (a === '--key') opt.key = next();
    else if (a === '--type') opt.type = next();
    else if (a === '--value') opt.value = next();
    else if (a === '--whole-row') opt.wholeRow = true;
    else if (a === '--fields') opt.fields = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--include-key-fields') opt.includeKeyFields = true;
    else if (a === '--score') opt.score = next();
    else if (a === '--member') opt.member = next();
    else if (a === '--ttl') opt.ttl = next();
    else if (a === '--fresh') opt.fresh = true;
    else if (a === '--db') opt.db = next();
    else if (a === '--delimiter') opt.delimiter = next().replace('\\t', '\t');
    else if (a === '--no-header') opt.header = false;
    else if (a === '--limit') opt.limit = parseInt(next(), 10);
    else if (a.startsWith('--')) { console.error('Unknown option ' + a + '. Try --help.'); return 2; }
    else file = a;
  }
  if (!file) { console.error('Name a file, or "-" for standard input.'); return 2; }
  const raw = fs.readFileSync(file === '-' ? 0 : file);

  if (mode === 'decode') {
    let bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.length);
    const looksText = !bytes.includes(13) && /^[\s0-9a-fA-F]+$|\\r\\n/.test(raw.toString('latin1').slice(0, 2000));
    if (looksText) bytes = P.bytesFromText(raw.toString('utf8')).bytes;
    const d = P.decode(bytes, opt.limit || 1e9);
    for (const v of d.values) {
      const c = P.asCommand(v);
      console.log(c !== null ? c : P.show(v));
    }
    const s = P.summarize(d.values);
    const counts = Object.keys(s.counts).sort((a, b) => s.counts[b] - s.counts[a]).map((k) => k + ' ' + s.counts[k]).join(', ');
    const n = (x, one, many) => x + ' ' + (x === 1 ? one : many);
    console.error(`${n(s.commands, 'command', 'commands')}${counts ? ' (' + counts + ')' : ''}, ${n(s.replies, 'reply', 'replies')}.${d.complete ? '' : ' Stopped before the end of the file.'}`);
    return 0;
  }

  let result;
  if (mode === 'commands') result = P.buildFromCommands(raw.toString('utf8'));
  else if (mode === 'csv' || mode === 'json') {
    const src = raw.toString('utf8');
    const { records, columns } = mode === 'csv' ? P.csvRecords(src, { delimiter: opt.delimiter, header: opt.header }) : P.jsonRecords(src);
    result = P.build(records, columns, opt);
    for (const s of result.skipped.slice(0, 20)) console.error(`Skipped record ${s.record}: ${s.reason}.`);
    if (result.skipped.length > 20) console.error(`... and ${result.skipped.length - 20} more skipped.`);
  } else { console.error('Unknown mode ' + mode + '. Use csv, json, commands or decode.'); return 2; }

  const bytes = result.output.bytes();
  if (process.stdout.isTTY) {
    console.error('The output is protocol data. Send it to a file or straight to the client:');
    console.error(`  node pipe/cli.js ${argv.join(' ')} | redis-cli --pipe`);
    return 2;
  }
  process.stdout.write(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length));
  const counts = Object.keys(result.output.counts).map((k) => k + ' ' + result.output.counts[k]).join(', ');
  console.error(`${result.output.commands} commands (${counts}), ${bytes.length} bytes${result.keys !== undefined ? ', ' + result.keys + ' keys' : ''}.`);
  return 0;
}

try { process.exitCode = main(process.argv.slice(2)); }
catch (e) { console.error(e.message); process.exitCode = 1; }
