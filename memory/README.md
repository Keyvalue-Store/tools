# Memory Calculator

Describe your keys and pick a server version. The calculator works out how much memory the server uses for them, the way that version stores them, and gives the growth of `used_memory` that INFO memory would show. It names the encoding each kind of value gets, shows the hash tables behind the keys and the TTLs, says which limit to raise when a value is stored in its big form, works out what packing small strings into hashes would save, and compares every version side by side.

It knows 15 versions: Redis 6.2.24, 7.0.15, 7.2.16, 7.4.11, 8.0.6, 8.2.10, 8.4.7, 8.6.7, 8.8.3 and 8.10.2, and Valkey 7.2.14, 8.0.11, 8.1.10, 9.0.6 and 9.1.2.

Try it in your browser at https://keyvaluestore.com/tools/memory/, or open `memory/app/index.html` from a copy of this repository.

Its logic is one JavaScript file, `memory.js`, with no dependencies. The web page, the command line and the tests all load it.

## Where the memory goes

A Redis or Valkey server keeps everything in memory, and every piece of it is a block it asked the allocator for. The allocator these servers are built with, jemalloc, hands out blocks in fixed sizes: 8, 16, 24 and so on up to 64 bytes, then four sizes in each doubling (80, 96, 112, 128, 160 ...). A request for 65 bytes gets 80. `used_memory` adds up the blocks, so the calculator works with the same sizes.

**A key.** Each key costs something before its value counts. Up to Redis 8.0 and Valkey 7.2, a key is a 24-byte entry in the keyspace's hash table, a copy of its name, and a 16-byte object that points at the value; Valkey 8.0 keeps the name inside the entry instead. Redis 8.2 and Valkey 8.1 moved the name into the object: one block, often 40 to 60 bytes, holds the object, the name and, when it fits, a short string value too. A 10-byte key with a 10-byte value takes 72 bytes on Redis 7.2 and 48 on Redis 8.10, before its share of the hash table.

**The hash tables.** The keyspace is a hash table, and its array of buckets grows by doubling: one 8-byte slot per key, rounded up to a power of two, so between 8 and 16 bytes a key. Valkey 8.1 and later use buckets of 64 bytes that hold seven keys each. A key with a TTL is also in a second table, of expiry times. When two keys land in the same bucket, Redis 8.2 and later need a 16-byte entry for the second one, and Valkey a 64-byte overflow bucket for an eighth; chance decides how many, so the calculator gives the expected number.

**The value.** Small hashes, sets, sorted sets and lists are stored packed in a single block, a listpack (a ziplist in Redis 6.2), or an intset for a set of numbers. Past a limit they turn into a hash table or a skiplist, which costs several times as much: every field becomes blocks of its own. The limits are settings (Redis 6.2 names them `-ziplist-` instead of `-listpack-`):

| Setting | Default | A value goes big when it has more than this many elements, or one longer than |
|---|---|---|
| `hash-max-listpack-entries`, `hash-max-listpack-value` | 512, 64 | 512 fields, 64 bytes |
| `set-max-intset-entries` | 512 | 512 numbers |
| `set-max-listpack-entries`, `set-max-listpack-value` | 128, 64 | 128 members, 64 bytes (Redis 7.2 and later, and Valkey) |
| `zset-max-listpack-entries`, `zset-max-listpack-value` | 128, 64 | 128 members, 64 bytes |
| `list-max-listpack-size` | -2 | 8 KB in one listpack; longer lists are chains of them |

Whatever the settings, a listpack never grows past 1 GB, and an intset holds at most 2^30 numbers: a write that would take one further turns it into a hash table or a skiplist.

A number such as `1759734012` is stored as an integer: in 6 bytes of a listpack instead of 12, or inside the key's object instead of a string of its own. Up to Redis 8.0 and Valkey 8.0, the numbers 0 to 9999 as string values cost nothing beyond the key: every key shares the same objects, unless `maxmemory` is set with an LRU or LFU `maxmemory-policy`.

**Hash fields with their own TTL.** `HEXPIRE` and its relatives (Redis 7.4 and later, Valkey 9.0 and later) give single fields of a hash an expiry. In Redis a small hash becomes a `listpackex`: every field gets a third entry in the listpack for its expiry (10 bytes for a time, 2 for none) and the hash a small struct around it. In a hash table each field with an expiry carries 16 bytes of metadata, and the hash keeps its fields in time order in "ebuckets": nothing extra up to 16 fields, then a small radix tree and a segment for every 16. The database keeps the hashes the same way. Valkey turns the hash into a hash table at its first field with an expiry, adds 8 bytes to each such field, and keeps them in a "volatile set": a sorted array of pointers up to 127 fields, then a table of its own. The calculator takes every field's expiry to be the same time, as one `HPEXPIREAT` gives them; fields with many different times need more buckets.

**Streams.** A stream keeps its entries in listpacks of up to 100 entries or 4 KB (`stream-node-max-entries`, `stream-node-max-bytes`), in a radix tree keyed by the first entry's ID. Each listpack starts with the field names, so an entry that has the same fields stores only its values and a few bytes of ID; the newest listpack is made 4 KB big up front. Consumer groups add a struct each, a radix tree of pending entries, and for each consumer a struct, its name and its own tree of the entries it holds. Each pending entry is a 24- to 64-byte record in both trees, and Redis 8.2 and later also index it by ID with a list of the groups that hold it. The radix trees' sizes depend on the IDs: the calculator takes `per-ms` entries a millisecond, one by default, and in Redis 8.4, which also indexes pending entries by delivery time, each group's deliveries in the same millisecond.

**Packing small strings into hashes.** A million small strings each pay for a key, an object and a slot in the keyspace. Keep them as fields of hashes instead, a few hundred to a hash, and they share one key: `user:1234567` becomes field `67` of hash `user:12345`. The hashes stay listpacks while they have no more than `hash-max-listpack-entries` fields, and the fields, being numbers, take 2 or 3 bytes each. That often saves 70 to 90 percent. A hash has one TTL for all its fields, though.

**What changed between versions.** Redis 7.2 keeps small sets of strings in listpacks; before, a set that wasn't all numbers was a hash table. Valkey 8.0 put the key inside the keyspace table's entry. Redis 8.2 and Valkey 8.1 moved it into the value's object instead, and Valkey 8.1 replaced its hash tables with its own, of 64-byte buckets. Redis 8.6 and Valkey 8.1 keep a hash field and its value in one block, and Redis 8.6 and Valkey 9.1 keep a sorted set's members inside its skiplist nodes. Valkey 9.1 fits string values of up to about 100 bytes into the key's object. The same keys can take a third less on one version than on another: ten million keys of 13 bytes with 8-byte values need 85 bytes a key on Redis 7.2 and 55 on Valkey 9.1.

## What the calculator shows

- **The growth of `used_memory`** for your keys, in total and per key, with how much of it chance decides.
- **Each kind of key**: how its values are stored, the bytes per key and in total.
- **The tables** of the keyspace and of the expiry times, and the structs a database makes for its first key.
- **What to change**: a limit to raise when values are stored in their big form, by the name the chosen version gives it, and what a TTL costs a key.
- **Every version** side by side.
- **Packing**: string keys as fields of hashes, with 64 to 1000 fields a hash, and the settings each needs.
- **RAM to plan for**: `used_memory` with an empty server's own, the process as the operating system sees it, and the peak during a snapshot, with the fragmentation and copy-on-write you expect.

## Use it in the browser

1. **Describe your keys.** For each kind: the type, how many keys, how long their names are (or type an example name, in quotes if it's all digits), and what they hold: a length in bytes, or a number. Hash fields and set members can be numbers counting up from the one you give. Say what share of the keys has a TTL.
2. **Pick the server.** The figures change as you type. Open *Server settings* if you changed the limits.
3. **Read the advice**, compare versions, and look at packing if you have many small strings.

*As text* shows the keys in the form the command line takes, to copy or paste.

## Use it from the command line

```sh
node memory/cli.js "1m strings key=24 value=100 ttl=30%"                       # one server, the newest Redis
node memory/cli.js "50000 hashes key=16 fields=20 field=8 value=int:42" --server valkey-9.1
node memory/cli.js --file keys.txt --compare                                     # every version
node memory/cli.js "10m strings key=13 value=8" --pack 100                       # packed into hashes of 100 fields
node memory/cli.js "200 zsets key=10 members=1000 member=12 score=0.5" --set zset-max-listpack-entries=1024
node memory/cli.js "20000 hashes fields=50 field=8 value=20 field-ttl=10" --compare
node memory/cli.js "10 streams key=12 entries=1m fields=3 field=8 value=30 groups=2 consumers=4 pending=500"
```

Each group is a line: how many keys, the type (`strings`, `hashes`, `sets`, `zsets`, `lists`, `streams`), then:

| Word | Meaning |
|---|---|
| `key=N` | The length of the key names in bytes, or `key="an example"` |
| `value=`, `field=`, `member=`, `item=` | A length in bytes, `int:N` for a number, or `"an example"` |
| `fields=`, `members=`, `items=` | How many in each hash, set or list |
| `score=X` | A typical score of a sorted set (0 if not given) |
| `ttl=30%` | The share of keys with a TTL (`all`, `none`), or a number of keys such as `ttl=5000` |
| `writes=each` | Collections written one element at a time instead of one command per key |
| `field-ttl=N` | For hashes: how many fields of each hash have a TTL of their own (`all`), all expiring at the same time. Versions without `HEXPIRE` leave it out and say so |
| `entries=`, `fields=` | For streams: entries in each stream, fields in each entry |
| `groups=`, `consumers=`, `pending=` | For streams: consumer groups, consumers in each group, and entries delivered and not yet acknowledged in each group |
| `group=`, `consumer=`, `per-ms=` | For streams: the lengths of group and consumer names (8), and how many entries share a millisecond of their ID (1) |

For fields and members, `int:N` means the numbers N, N+1, N+2 and so on. Counts take `k`, `m` and `b` for thousand, million and billion: `2.5m`. Lengths are in bytes, or `kb` and `mb` of 1024 bytes: `8kb` is 8192. A word left out takes a default, such as `key=20`. In a file, `#` starts a comment.

| Option | Meaning |
|---|---|
| `--server VERSION` | `redis-7.2`, `"valkey 9.1"`, `valkey` (the newest Valkey), `8` (the newest 8.x of either), or a full version such as `8.4.7`. The default is the newest Redis |
| `--compare` | Every version side by side |
| `--pack N` | String keys packed into hashes of N fields. It raises `hash-max-listpack-entries` and `hash-max-listpack-value` as far as the hashes need to stay listpacks, and says so |
| `--set NAME=VALUE` | A setting other than the default, such as `hash-max-listpack-entries=1024` or `maxmemory-policy=allkeys-lru` |
| `--file PATH` | Groups from a file, one per line (`-` reads stdin) |
| `--json` | Print JSON |
| `--versions` | List the versions |

## Use it in your own code

```js
const M = require('./memory/memory.js');
const keys = M.parse('1m strings key=24 value=100 ttl=30%').groups;
const r = M.estimate(keys, 'valkey-9.1.2');
r.total;                 // expected growth of used_memory, in bytes
r.sd;                    // how much of it chance decides (one standard deviation)
r.groups[0].encoding;    // 'raw', 'embstr', 'int', 'listpack', 'hashtable' ...
r.tables;                // { keys, expires, database }
M.compare(keys);         // the same for every version
M.pack(keys[0], 100);    // the strings as hashes of 100 fields
M.format(keys);          // back to text
M.settingName('hashMaxListpackEntries', 'redis-6.2.24');   // 'hash-max-ziplist-entries'
```

A group can also be written out: `{ type: 'hash', count: 50000, key: 16, fields: 20, field: { len: 8 }, value: { int: '42' }, ttl: 0.3, writes: 'once' }`. `ttl` is a share from 0 to 1; `ttlCount: 5000` gives a number of keys instead. Settings go in the third argument: `M.estimate(keys, id, { hashMaxListpackEntries: 1024 })`. A group or setting that doesn't make sense throws an error that says why. In a page, load `memory.js` with a script tag and use `window.KVMemory`.

## How it was tested

`test/generate/record.py` starts each of the 15 servers, built from source with their own jemalloc, and writes keys of thousands of shapes to them: strings of every length around the limits where the encoding changes, with and without TTLs, numbers, values of 32 KB and more; many keys at once, around the sizes where the hash tables double; hashes, sets, sorted sets and lists below and above every limit, written in one command or one element at a time, with numbers and text of many lengths, and sorted set scores of every kind; hashes with some or all fields given an expiry by `HPEXPIREAT` (on the 9 versions that have it); streams from one entry to thousands, around the listpack limits, with numbers, several fields, many entries a millisecond, consumer groups, consumers and pending entries; mixes of all of them; and other settings. For each case it reads `used_memory` from INFO memory, writes the keys from a connection of its own, closes it, waits until the server has rehashed everything, and reads it again.

It also records what chance decided: how many keys shared a bucket and how many overflow buckets the tables needed. Given those, `memory.js` gives the same growth to the byte for every case. There are two exceptions. The skiplist of a big sorted set gives its nodes random sizes nobody can see from outside, and Valkey 9 places fields and hashes with an expiry in tables by their memory address, whose overflow buckets can't be seen either: those cases agree within a few standard deviations, and on average to a small fraction of one, and a sorted set of one member takes exactly what one node at some level takes. Estimated without knowing what chance decided, the cases scatter around the expected values as they should: 99.8 percent of them within three standard deviations.

The recorded cases are in `test/fixtures/`, and the tests replay them, so they run without any server:

```sh
node --test memory/test/memory.test.js
```

`KV_FIXTURE=other.json.gz` replays another recording. `node memory/test/replay.js` lists any differences, and `test/generate/measure.js` writes the counts to `test/results/servers.json`.

## Limits

- **How the keys were written.** The figures are for keys written by clients. A server that loaded its data from an RDB file at startup sizes some tables at once and keeps lists as the file had them, so it can differ by a few percent. Values grown by APPEND or SETRANGE keep spare room the calculator doesn't count.
- **What it doesn't cover.** Module types such as JSON, list compression (`list-compress-depth`), and streams that were trimmed or had entries deleted or acknowledged: it counts streams as `XADD`, `XGROUP` and `XREADGROUP` leave them.
- **Expiry times and stream IDs.** Fields with a TTL are taken to expire at one time, and stream IDs to come `per-ms` a millisecond. Many different expiry times, or IDs spread over hours, take more radix tree nodes and buckets than that.
- **Standalone servers.** In cluster mode every hash slot has its own table, and Redis up to 7.2 keeps extra data for each key.
- **The build.** It assumes a 64-bit Linux build with the bundled jemalloc. Built with another allocator, or on a Mac with Apple silicon, where Redis 8.2 and later fit longer strings in the key's object, the figures differ.
- **One shape per group.** Real data varies. Describe it as several groups, or use typical sizes: the totals stay close, though a value near a size class or a limit can move a lot.
- **RAM.** `used_memory` is what the server asked for. What the machine needs on top, for fragmentation, copy-on-write during saves and buffers, depends on the workload, and the figures for it are your guesses.

## License

Apache License 2.0. Copyright 2026 KeyValueStore.com. See `LICENSE` and `NOTICE` in the top folder. `memory.js` includes a version of `fpconv_dtoa` from the fpconv library that Redis and Valkey bundle, under the Boost Software License 1.0, whose text is in the file.

Redis is a registered trademark of Redis Ltd. Valkey is a trademark of the Linux Foundation. They're named only to say which servers the tool works with, and KeyValueStore.com isn't connected with or endorsed by either.
