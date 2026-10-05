#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Command line for the Typed JSON Converter. Run "node typed-json/cli.js --help".

'use strict';
const fs = require('fs');
const T = require('./typedjson.js');

const HELP = `Typed JSON Converter: DynamoDB's typed JSON to plain JSON, and back.

Usage:
  node typed-json/cli.js [FILE]     Convert FILE, or standard input when FILE is "-" or missing.
                                    The direction is picked from what the file holds.

Options:
  --to-plain             Typed JSON to plain JSON, whatever the file looks like
  --to-typed             Plain JSON to typed JSON
  --sets strings|numbers|both
                         Lists of unique strings or numbers become string or number sets
  --batch TABLE          Write batch-write-item requests for TABLE, 25 items per line
  --compact              No indentation

Reads one JSON document, or one per line (JSON Lines), including Scan and Query
output, GetItem output, exports to S3 in DynamoDB JSON and DynamoDB Streams records.`;

function main(argv) {
  const opt = { direction: 'auto' };
  let file = '-';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { console.log(HELP); return 0; }
    else if (a === '--to-plain') opt.direction = 'toPlain';
    else if (a === '--to-typed') opt.direction = 'toTyped';
    else if (a === '--sets') {
      opt.sets = argv[++i];
      if (!['strings', 'numbers', 'both'].includes(opt.sets)) { console.error('--sets takes strings, numbers or both'); return 2; }
    }
    else if (a === '--batch') { opt.output = 'batch'; opt.table = argv[++i]; opt.direction = opt.direction === 'auto' ? 'toTyped' : opt.direction; }
    else if (a === '--compact') opt.indent = 0;
    else if (a.startsWith('--')) { console.error('Unknown option ' + a + '. Try --help.'); return 2; }
    else file = a;
  }
  if (opt.output === 'batch' && !opt.table) { console.error('--batch needs a table name'); return 2; }
  if (file === '-' && process.stdin.isTTY) { console.log(HELP); return 2; }
  const text = fs.readFileSync(file === '-' ? 0 : file, 'utf8');
  const r = T.convert(text, opt);
  process.stdout.write(r.text);
  const what = r.direction === 'toPlain' ? 'typed JSON to plain JSON' : 'plain JSON to typed JSON';
  const count = r.shape === 'batch' ? `${r.count} batch-write-item request${r.count === 1 ? '' : 's'}`
    : `${r.stats.items} item${r.stats.items === 1 ? '' : 's'}`;
  console.error(`Converted ${count}, ${what}${r.shapeName ? ', read as ' + r.shapeName : ''}.`);
  if (r.stats.binary) console.error(`${r.stats.binary} binary value${r.stats.binary === 1 ? ' was' : 's were'} kept as base64 text.`);
  if (r.stats.precision.length) console.error(`DynamoDB keeps 38 significant digits. These numbers have more: ${r.stats.precision.slice(0, 10).join(', ')}`);
  return 0;
}

try { process.exitCode = main(process.argv.slice(2)); }
catch (e) { console.error(e.message); process.exitCode = 1; }
