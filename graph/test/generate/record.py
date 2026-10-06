# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 KeyValueStore.com
#
# Records how a real ordered store keeps the Graph Key Builder's keys. It
# takes the keys graph.js makes from test/fixtures/links.txt, puts them into
# SQLite as BLOB keys in a shuffled order, and asks SQLite for them back in
# key order and for every prefix scan a walk could make. SQLite compares BLOB
# keys byte by byte, the order RocksDB, LMDB and etcd keep by default. The
# answers go to test/fixtures/sqlite-<version>.json, which the tests replay.
#
# Usage, from the repository's top folder: python3 graph/test/generate/record.py

import json
import os
import random
import sqlite3
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
TEST = os.path.dirname(HERE)

JS = r"""
const fs = require('fs');
const G = require(process.argv[1]);
const p = G.parseEdges(fs.readFileSync(process.argv[2], 'utf8'));
const s = G.build(p.edges);
const n = G.names(s);
const prefixes = [];
for (const id of n.nodes) {
  prefixes.push(...G.prefixes(id, 'both'));
  for (const t of n.types) prefixes.push(...G.prefixes(id, 'both', t));
}
console.log(JSON.stringify({ keys: s.entries.map((e) => e.key), prefixes }));
"""


def upper_bound(prefix):
    # The smallest key after every key that starts with the prefix.
    b = bytearray(prefix)
    while b and b[-1] == 0xFF:
        b.pop()
    b[-1] += 1
    return bytes(b)


def main():
    out = subprocess.run(
        ['node', '-e', JS, os.path.join(TEST, '..', 'graph.js'), os.path.join(TEST, 'fixtures', 'links.txt')],
        check=True, capture_output=True, text=True).stdout
    data = json.loads(out)
    keys = list(data['keys'])
    random.Random(7).shuffle(keys)

    db = sqlite3.connect(':memory:')
    db.execute('CREATE TABLE kv (k BLOB PRIMARY KEY, v BLOB) WITHOUT ROWID')
    db.executemany('INSERT INTO kv VALUES (?, ?)', [(k.encode('utf-8'), b'') for k in keys])
    order = [r[0].decode('utf-8') for r in db.execute('SELECT k FROM kv ORDER BY k')]
    scans = []
    for p in data['prefixes']:
        lo = p.encode('utf-8')
        rows = db.execute('SELECT k FROM kv WHERE k >= ? AND k < ? ORDER BY k', (lo, upper_bound(lo)))
        scans.append({'prefix': p, 'keys': [r[0].decode('utf-8') for r in rows]})

    version = sqlite3.sqlite_version
    path = os.path.join(TEST, 'fixtures', 'sqlite-%s.json' % version)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump({'sqlite': version, 'order': order, 'scans': scans}, f, ensure_ascii=False, indent=1)
        f.write('\n')
    print('SQLite %s: %d keys, %d prefix scans -> %s' % (version, len(order), len(scans), os.path.relpath(path)))


if __name__ == '__main__':
    main()
