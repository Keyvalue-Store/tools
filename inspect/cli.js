#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Command line for the Value Inspector. Run "node inspect/cli.js --help".

'use strict';
const fs = require('fs');
const I = require('./inspect.js');

const HELP = `Value Inspector: what format a stored value is in, and what it says.

Usage:
  node inspect/cli.js value.bin                Decode a file that holds the value as raw bytes
  node inspect/cli.js --text '"\\x80\\x04..."'    Decode text the way it was pasted: redis-cli's
                                               quoted form, hex, or plain text
  node inspect/cli.js -                        Read the value from standard input

  redis-cli --no-raw GET session:42 | node inspect/cli.js -
  valkey-cli --no-raw HGET user:42 avatar | node inspect/cli.js -

Options:
  --json        Print the layers and the decoded value as JSON
  --hex         Also print a hex dump of the innermost bytes
  --out FILE    Write the innermost bytes, after base64, hex and decompression, to FILE

It reads JSON, JWT, MessagePack, CBOR, BSON, Protocol Buffers, PHP serialize and
sessions, igbinary, Java serialization, Python pickle and Ruby Marshal, inside
base64, hex, gzip, zlib, LZ4 or Snappy. Nothing in the value is ever run.`;

function main(argv) {
  let file = null, text = null, json = false, dump = false, out = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { console.log(HELP); return 0; }
    else if (a === '--text' || a === '--out') {
      if (i + 1 >= argv.length) { console.error(a + ' needs a value after it. Try --help.'); return 2; }
      if (a === '--text') text = argv[++i]; else out = argv[++i];
    }
    else if (a === '--json') json = true;
    else if (a === '--hex') dump = true;
    else if (a.startsWith('--')) { console.error('Unknown option ' + a + '. Try --help.'); return 2; }
    else if (file !== null) { console.error('Name one file at a time. Try --help.'); return 2; }
    else file = a;
  }
  if (text === null && file === null) { console.error('Name a file, - for standard input, or use --text. Try --help.'); return 2; }

  let bytes, form = 'bytes', note = null;
  if (text !== null) ({ bytes, form } = I.fromInput(text));
  else {
    const raw = new Uint8Array(fs.readFileSync(file === '-' ? 0 : file));
    // redis-cli's quoted form is plain ASCII in double quotes, with at most
    // the newline redis-cli adds after it. A raw value that happens to start
    // and end with a quote has other bytes in it.
    const asText = I.utf8(raw);
    if (asText !== null && /^"[\x20-\x7e]*"\r?\n?$/.test(asText)) {
      const r = I.fromInput(asText);
      bytes = r.bytes; form = r.form;
    } else bytes = raw;
  }
  let a = I.analyze(bytes);
  // redis-cli adds a newline to what it prints; try without it when the
  // value didn't make sense with it.
  if ((a.result.id === 'binary' || a.result.id === 'text') && bytes.length > 1 && bytes[bytes.length - 1] === 10) {
    const b = I.analyze(bytes.subarray(0, bytes.length - 1));
    if (b.result.id !== 'binary' && b.result.id !== 'text') { a = b; note = 'Left out the newline at the end.'; }
  }
  const r = a.result;
  if (out) fs.writeFileSync(out, a.bytes);

  if (json) {
    console.log(JSON.stringify({
      input: { bytes: bytes.length, form: form },
      layers: a.layers.map((l) => ({ format: l.id, name: l.name, bytes: l.size, decoded: l.out, check: l.check, facts: l.facts })),
      format: r.id, name: r.name, notes: (note ? [note] : []).concat(r.notes || []),
      image: r.image || undefined,
      value: r.value ? I.plain(r.value) : null,
      alternatives: (r.alternatives || []).map((x) => ({ format: x.id, name: x.name, value: I.plain(x.value) }))
    }, null, 2));
    return 0;
  }
  const chain = a.layers.map((l) => l.name + (l.check ? ' (' + (l.check === 'ok' ? 'checksum ok' : l.check === 'size ok' ? 'size matches' : 'checksum does not match') + ')' : '')).concat([r.name]);
  console.log(chain.join(' > ') + `, ${bytes.length.toLocaleString('en-US')} bytes${form === 'quoted' ? ' read from redis-cli\'s quoted form' : form === 'hex' ? ' read from hex' : ''}`);
  for (const l of a.layers) for (const f of l.facts) console.log('  ' + l.name + ': ' + f);
  if (r.value) console.log('\n' + I.show(r.value));
  const notes = (note ? [note] : []).concat(r.notes || []);
  if (notes.length) console.log('\n' + notes.join('\n'));
  if (r.alternatives && r.alternatives.length) for (const x of r.alternatives) console.log('\nIt also reads as ' + x.name + ':\n' + I.show(x.value));
  if (dump || r.id === 'binary') console.log('\n' + I.hexdump(a.bytes));
  return 0;
}

process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); throw e; });
try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  console.error(e.code === 'ENOENT' ? 'No such file: ' + e.path : e.code === 'EISDIR' ? 'That is a folder, not a file.' : 'Could not read the value: ' + e.message);
  process.exitCode = 2;
}
