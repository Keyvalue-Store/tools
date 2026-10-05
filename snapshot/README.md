# Snapshot Viewer

Open a Redis or Valkey RDB snapshot, the `dump.rdb` a server writes, and see what's in it: every key with its type, encoding, size in the file, expiry and value, plus totals by type, database and prefix and a list of the biggest keys. It also reads the payloads of the `DUMP` command.

Try it in your browser at https://keyvaluestore.com/tools/snapshot/, or open `snapshot/app/index.html` from a copy of this repository.

Its logic is one JavaScript file, `rdb.js`, with no dependencies. The web page, the command line and the tests all load it.

## What a snapshot is

Redis and Valkey keep their data in memory. To survive a restart, they write all of it to a file from time to time: the RDB snapshot, usually called `dump.rdb`. `BGSAVE` starts a child process that writes the file while the server keeps serving; `SAVE` writes it in the foreground. The `save` setting in the config decides how often it happens on its own.

The same format turns up in other places:

- **Replication.** A new replica gets a full copy of the data as a snapshot.
- **`redis-cli --rdb`.** Asks a running server for a fresh snapshot over the network, the way a replica would, and saves it to a file.
- **Append-only files.** Since Redis 7, and in Valkey, the `appendonlydir` folder holds a base file that is a snapshot when `aof-use-rdb-preamble` is on, as it is by default. Redis 4 to 6 could start the AOF file itself with a snapshot, the "RDB preamble", followed by commands.
- **`DUMP` and `RESTORE`.** `DUMP` returns one key's value in the snapshot format, followed by a 2-byte format version and a checksum.

Inside, the file is a list of records. It starts with `REDIS` or `VALKEY` and a version number, then a few fields about the server: its version, when the file was written, how much memory it used. Then, database by database, each key: an expiry if it has one, an idle time or access counter if the memory policy needs them, a byte for the type, the key, and the value. A byte with the value 255 marks the end, followed by a CRC64 checksum of everything before it.

Values are written close to how the server holds them in memory. A small hash, list, set or sorted set is one compact block, a listpack (or a ziplist, before Redis 7), and a small set made only of integers is an intset. Bigger ones are written element by element. Strings longer than 20 bytes are compressed with LZF when that saves space, and a string holding a whole number that fits in 32 bits is stored as that number.

The format has two branches now. Redis 7.4 started at version 12 and Redis 8.10 writes version 15, adding hash fields with their own expiry, NACKed stream messages, idempotent stream producers, arrays and hash templates. Valkey 9 jumped to version 80 with its own magic string, `VALKEY080`, and its own layout for hashes with field expiries. Both still read the shared versions up to 11. Type numbers from 22 up mean different things in the two branches, so the viewer reads the version first and decodes accordingly.

## Why look inside one

- **Find what fills the memory.** The biggest keys, the prefixes that take the most space and the share of each type, without running a single command against production. `--bigkeys` and `MEMORY USAGE` ask the live server; reading a snapshot puts no load on it at all.
- **Audit expiries.** How many keys never expire, and how much time the others had left.
- **Get one value back from a backup** without loading the whole backup into a server.
- **Check a backup.** A wrong checksum means the file was damaged or cut short.
- **See what a `DUMP` payload holds** before you `RESTORE` it somewhere.

## Use it in the browser

Load a snapshot or drop it on the page. The page reads it in steps and shows a progress bar, then:

- **The file.** Keys, size, how many keys expire, which server and version wrote it and when, how much memory the server used then, and whether the checksum is right. Function libraries, module data, cluster slot records and hash templates are listed when the file has them.
- **Where the bytes go.** Bytes in the file by data type, and by encoding.
- **The biggest keys**, by bytes in the file.
- **Prefixes.** Keys and bytes per prefix, the part of the key before its first colon.
- **Expiries.** Time left on expiring keys, counted from when the file was written.
- **Idle time or access frequency**, when the server's `maxmemory-policy` uses LRU or LFU, since the file records them then.
- **Downloads.** Every key as CSV (database, key, type, encoding, elements, bytes, expiry), or just the key names, which the [Keyspace Map](../keyspace/) reads to find the naming patterns.

Below that, browse the keys: filter by part of the name or by type, and pick a key to see its value the way `redis-cli` prints it, up to 1,000 elements.

The last part of the page reads a `DUMP` payload. Paste what `redis-cli` printed, quotes and `\x` escapes included, or the payload as hex.

To get a snapshot:

```sh
redis-cli -h 10.0.0.4 -p 6379 --rdb dump.rdb
valkey-cli -h 10.0.0.4 -p 6379 --rdb dump.rdb
redis-cli CONFIG GET dir        # the folder where the server keeps its own dump.rdb
```

`--rdb` makes the server fork and write a fresh snapshot, as it does for a new replica. On a busy primary with a lot of data, the fork needs spare memory, so prefer a replica or an existing backup.

Nothing you load leaves the page. The tool doesn't send anything anywhere, and the page's security policy stops it from fetching or loading anything from another site.

## Use it from the command line

You need Node.js 20 or newer. Nothing to install. The command line reads the file piece by piece, so snapshots of any size work.

```sh
$ node snapshot/cli.js dump.rdb
dump.rdb: 118.0 KB, RDB version 80, written by Valkey 9.1.2 on 2026-10-05T15:58:47Z
Checksum: ok

32 keys, 117.9 KB of keys and values, 3 with an expiry

By type
  list                4 keys    51.2 KB  5,011 elements
  stream              2 keys    30.1 KB  2,048 elements
  hash                5 keys    13.7 KB  911 elements
  ...

$ node snapshot/cli.js dump.rdb --key hash:ttl
hash, hashtable with field TTLs, 5 elements, 71 bytes in the file
1) "a" => "1"
2) "b" => "2"  (expires 2100-01-01T00:00:05Z)
...

$ node snapshot/cli.js dump.rdb --keys > keys.csv
$ node snapshot/cli.js dump.rdb --json-lines > all.jsonl
$ redis-cli --no-raw DUMP user:42 | node snapshot/cli.js --dump -
```

| Option | What it does |
|---|---|
| `--keys` | Every key as CSV: db, key, type, encoding, elements, bytes, expires |
| `--key NAME` | One key's value. `--db N` picks the database, 0 by default |
| `--json-lines` | Every key with its value, one JSON object a line. Text that isn't valid UTF-8 comes out as `{"base64": "..."}` |
| `--dump FILE` | Read a `DUMP` payload: raw bytes, hex, or the quoted text `redis-cli` prints. `-` reads standard input |
| `--top N` | How many of the biggest keys and prefixes to list, 20 by default |
| `--json` | Print the totals as JSON |

## Use it in your own code

```js
const R = require('./snapshot/rdb.js');
const bytes = fs.readFileSync('dump.rdb');
const info = R.read(R.bufferSource(bytes), {
  values: true,                       // decode values, not only sizes
  onKey(e) { console.log(e.db, R.showKey(e.key), e.type, e.encoding, e.size, e.expire); }
});
info.version;                         // 80
info.checksum.status;                 // 'ok'
R.readDump(payloadBytes).value;       // one value from DUMP
```

In a page, load `rdb.js` with a script tag and use `window.KVRdb`.

## What it reads

| RDB version | Written by |
|---|---|
| 6 | Redis 2.6 to 3.0 |
| 7 | Redis 3.2 |
| 8 | Redis 4.0 |
| 9 | Redis 5.0 to 6.2 |
| 10 | Redis 7.0 |
| 11 | Redis 7.2, Valkey 7.2 to 8.1 |
| 12 | Redis 7.4 to 8.4 |
| 13, 14, 15 | Redis 8.6, 8.8, 8.10 |
| 80 | Valkey 9.0 and later |

All the value types those versions write: strings (raw, integer, LZF-compressed); lists as linked lists, ziplists and quicklists of ziplists or listpacks, including compressed and plain nodes; sets as hashtables, intsets and listpacks; sorted sets with text or binary scores, as ziplists, listpacks and skiplists; hashes as hashtables, ziplists and listpacks, with field expiries in both the Redis and the Valkey layout, and Redis's template hashes; streams in all five versions, with consumer groups, pending entries, NACKs and idempotent producers; Redis arrays; and module values, which are listed by module name, since their contents are in the module's own format. It also reads function libraries, module data, cluster slot records and Valkey's slot import records.

It doesn't read hashes stored as zipmaps, which only Redis 2.4 and older wrote, or the formats of Redis 4.0 and 7.0 release candidates.

## How it was tested

Seven real servers, built from source in October 2026: Valkey 9.1.2 and Redis 8.10.2, 7.2.16, 6.2.24, 5.0.14, 3.2.13 and 2.8.24, which between them write RDB versions 80, 15, 11, 9, 7 and 6. A script loaded the same dataset into each: strings of every encoding, lists from 5 to 5,000 elements with compressed and plain nodes, sets, sorted sets with infinite scores, hashes with and without field expiries, streams with consumer groups, deleted entries and pending entries, three databases and keys with expiries. Where the server had them it added NACKed stream messages, idempotent producers, arrays, template hashes, a vector set and a function library. Each server then saved a snapshot, and the script asked it about every key through ordinary commands: the value, `OBJECT ENCODING`, `PEXPIRETIME`, `DEBUG OBJECT` and `XINFO STREAM FULL`, plus the key's `DUMP` payload.

- **Values.** For all 234 keys in the seven snapshots, the viewer's value, type and expiry matched what the server said, and for every hash, list, set and sorted set the encoding matched `OBJECT ENCODING`. That covers the old encodings too: linked lists, ziplists and sorted sets with text scores from Redis 2.8 and 3.2.
- **Sizes.** The bytes the viewer counts for each value matched `DEBUG OBJECT`'s `serializedlength`, with two Redis 8.10.2 exceptions below.
- **DUMP payloads.** Every key's payload decoded to the same value, with a correct checksum.
- **Access data.** With `allkeys-lfu`, the counters in a Valkey 9.1.2 snapshot matched `OBJECT FREQ` for all 77 keys. With `allkeys-lru`, the idle times in a Redis 8.10.2 snapshot were within 2 seconds of `OBJECT IDLETIME` for all 105 keys.
- **Other files.** Snapshots from a Redis 8.10.2 and a Valkey 9.1.2 cluster node, a Valkey snapshot written with `rdbchecksum no` and `rdbcompression no`, and an AOF file with an RDB preamble from Redis 6.2.24 all read correctly, and so did a copy fetched with `redis-cli --rdb`.

Redis 8.10.2's `serializedlength` differs from the bytes in the file in two cases. For template hashes it reports the size of their `DUMP` form, which includes the field names that the file keeps in a shared template. For hashes with field expiries it leaves out the 8-byte minimum expiry those values start with. The viewer counts what's in the file.

The snapshots and the servers' answers are in `test/fixtures/`, all but the Redis 5.0.14 one, which uses the same format as 6.2.24. The tests replay them, so they run without a server:

```sh
node --test snapshot/test/rdb.test.js
```

## Limits

- The page holds the whole file in memory and lists up to a million keys; the totals always cover every key. For bigger snapshots, use the command line.
- Bytes in the file aren't bytes in memory. Compression and compact encodings make the file smaller than the data in RAM. The `used-mem` field shows how much memory the server used when it wrote the file.
- Module values are shown by module name and size only.
- A key whose expiry had passed but that the server hadn't removed yet is still in the file; the viewer marks it as already expired.

## License

Apache License 2.0. Copyright 2026 KeyValueStore.com. See `LICENSE` and `NOTICE` in the top folder.
