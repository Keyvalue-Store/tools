# Hash Slot Calculator

Find which slot of a Redis or Valkey cluster a key lands in, and which primary holds it. Check a multi-key command for CROSSSLOT errors before your code sends it, and see how a whole list of keys spreads across the cluster.

Try it in your browser at https://keyvaluestore.com/tools/slots/, or open `slots/app/index.html` from a copy of this repository.

Its logic is one JavaScript file, `slots.js`, with no dependencies. The web page, the command line and the tests all load it.

## How hash slots work

A Redis or Valkey cluster spreads its keys over several primaries. It doesn't do that key by key. It splits the key space into 16,384 slots and gives each primary a range of them. A cluster of three primaries usually has slots 0 to 5460 on the first, 5461 to 10922 on the second and 10923 to 16383 on the third.

A key's slot comes from a checksum. The server takes the key's bytes, runs CRC16 over them (the XMODEM variant) and keeps the last 14 bits, a number from 0 to 16383. `somekey` always lands in slot 11058, on every Redis or Valkey cluster in the world. Which primary holds slot 11058 depends on your cluster.

Moving data between primaries means moving whole slots. That's why adding a primary to a cluster is cheap to plan: you hand it some slots, and every key in those slots goes with them.

### Hash tags

Sometimes keys have to sit together. A command that touches several keys, such as `MGET` or `MSET`, only runs if every key is in the same slot. The same goes for transactions and Lua scripts. If the keys are spread out, the cluster answers:

```
(error) CROSSSLOT Keys in request don't hash to the same slot
```

A hash tag fixes that. If a key has a `{`, and a `}` somewhere after it, with at least one byte in between, only the part between them is hashed. `user:{42}:name` and `user:{42}:plan` both hash `42`, so they share slot 8000 and can be used in one command.

Three details catch people out. Only the first `{` counts, and only the first `}` after it. Empty braces, as in `foo{}{bar}`, don't count at all, so the whole key is hashed. And a tag that many keys share puts all of them on one primary, which can turn it into a hot spot.

## Use it in the browser

The page has four parts:

1. **Find a key's slot.** Type a key. You get its slot, the primary that holds it, the CRC16 value, and the key with the hashed part marked.
2. **Check a command.** Paste a command, such as `MSET user:{42}:name Ana user:{42}:plan pro`. The page picks out the keys the way the server does, and tells you whether a cluster would run it or answer CROSSSLOT.
3. **See how a key list spreads.** Paste a list of keys or load a file, one key per line. You get the keys per primary, the busiest slots, the most used hash tags and every key's slot, which you can download as CSV.
4. **Cluster layout.** By default the page assumes a new cluster of three primaries, split the way `--cluster create` splits it. Change the number, or paste the output of `CLUSTER NODES` from your own cluster.

To get a list of keys from a server without slowing it down, use `--scan`, never `KEYS *`:

```sh
redis-cli -h 10.0.0.4 -p 6379 --scan > keys.txt
valkey-cli -h 10.0.0.4 -p 6379 --scan --pattern 'user:*' > keys.txt
```

The page reads the output as it is. It also reads quoted output, the form `redis-cli` prints in a terminal, as in `1) "user:\xe2\x82\xac"`. If your keys can contain any byte, use quoted output: add `--no-raw`. Raw output stops each key at its first zero byte, and a key with a line break in it can't be told apart from two keys.

Nothing you paste or load leaves the page. The tool doesn't send anything anywhere, and the page's security policy stops it from fetching or loading anything from another site.

## Use it from the command line

You need Node.js 20 or newer. Nothing to install: clone the repository and run the file.

```sh
$ node slots/cli.js somekey 'user:{42}:cart'
11058	somekey
8000	user:{42}:cart

$ node slots/cli.js --check 'MGET a b c'
15495	a
3300	b
7365	c
CROSSSLOT: the keys are in 3 different slots.

$ redis-cli --scan | node slots/cli.js --file - --nodes nodes.txt --summary
```

| Option | What it does |
|---|---|
| `--file FILE` | Read keys from a file, one per line. `-` reads standard input |
| `--check "COMMAND"` | Check one command. Exit status 0 means one slot, 1 means CROSSSLOT, 2 means an error |
| `--nodes FILE` | Output of `CLUSTER NODES`, to show the primary for each key |
| `--split N` | Or assume a new cluster of N primaries, split evenly |
| `--summary` | With `--file`, print totals per primary, the busiest slots and hash tags |
| `--raw` | Take keys exactly as written: no quote decoding, no `1) ` stripping |
| `--json` | Print JSON |

## Use it in your own code

In Node:

```js
const slots = require('./slots/slots.js');
slots.keySlot('user:{42}:cart');                 // 8000
slots.checkCommand('MGET a b').crossSlot;        // true
slots.evenSplit(3);                              // the ranges --cluster create gives 3 primaries
```

In a page, load `slots.js` with a script tag and use `window.KVSlots`.

## How it was tested

The tool was checked against real servers, Valkey 9.1.2 and Redis 8.10.2, both built from source, in October 2026. The results files in `test/results/` hold the full numbers.

- **Slots.** 10,029 keys went through `CLUSTER KEYSLOT` on both servers: random text with stray braces, hash-tagged keys, UTF-8 in many scripts, raw binary and 29 edge cases. The tool gave the same slot as both servers for every key.
- **Which arguments are keys.** For 868 commands on Valkey and 924 on Redis, the tool picked out the same keys as the server's `COMMAND GETKEYS`. They cover 58 of Valkey's 60 multi-key commands and 62 of Redis's 64, including options that change which arguments are keys, such as `SORT` with `BY`, `GET`, `LIMIT` and two `STORE`s. The other two, `SSUBSCRIBE` and `SUNSUBSCRIBE`, take shard channels, which `GETKEYS` doesn't list, so they were checked on the clusters instead.
- **Where the servers disagree.** A `SORT` destination named `LIMIT`, `GET`, `BY` or `STORE` is read again as an option by Valkey 9.1.2 but not by Redis 8.10.2. The tool shows the Redis reading and adds a note with Valkey's. Both servers' answers for 8 such commands are in `test/fixtures/sort-store-names.jsonl`.
- **CROSSSLOT.** 686 multi-key commands went to a live three-primary Valkey cluster and 742 to a Redis one, about half of them across slots. The tool predicted every answer, with one exception: Valkey ran all 9 cross-slot `MSETEX` commands instead of refusing them (see below).
- **Shard channels.** `SSUBSCRIBE` went to each cluster 40 times and `SUNSUBSCRIBE` 20 times, half of them with channels in different slots. Both servers refused `SSUBSCRIBE` across slots, as the tool predicts. Valkey refused `SUNSUBSCRIBE` across slots too, but Redis 8.10.2 ran it on any node, whatever the slots, so the tool adds a note about the difference.
- **Even split.** The ranges the tool gives a new cluster matched what `valkey-cli --cluster create` assigned to real clusters of 3 to 10 primaries.
- **Pasted output.** Real `valkey-cli --scan` output, raw and quoted, read back as the exact keys that were stored.

The tests replay the recorded answers in `test/fixtures/`, so they run without a server. The fixtures hold every command checked with `GETKEYS`, with the cluster's CROSSSLOT answer where it was sent to one, and 1,457 of the 10,029 keys: every seventh one and all the edge cases. The shard channel checks are only in the results files.

```sh
node --test slots/test/slots.test.js
```

### Valkey 9.1.2 and MSETEX

`MSETEX`, new in Valkey 9.1 and Redis 8.4, sets several keys with one expiry. Redis 8.10.2 routes it like any other command: keys in different slots get CROSSSLOT, and a command sent to the wrong node gets MOVED.

Valkey 9.1.2 does neither. In our test cluster it ran all 9 cross-slot `MSETEX` commands, and whichever node received the command wrote the keys itself, even keys whose slots belong to another node. It answered 1, "all keys set", and a later `GET` through normal routing found nothing. The same happens with a single key sent to the wrong node. The transcript is in `test/results/msetex-routing.txt`. The cause is in the Valkey source: the command is declared without the function that cluster routing uses to find its keys, so routing sees no keys at all.

So the tool adds a note to every `MSETEX`. Keep its keys in one slot with a hash tag, and on Valkey 9.1 make sure your client sends it to the primary that owns that slot.

## Limits

- The tool knows which arguments are keys for every multi-key command in Redis 8.10.2 and Valkey 9.1.2. Commands it doesn't know are read as single-key commands, and the page says so. That includes commands from modules, such as `JSON.MGET` in Redis builds that load the JSON module.
- A slot is the same on every cluster, but the primary for it depends on the layout you give the tool. Pasted `CLUSTER NODES` output is a snapshot: slots move when a cluster is resharded.
- Slots that are being migrated show up as `[slot->-node]` in `CLUSTER NODES`. The tool ignores those markers and counts the slot where it is now.

## License

Apache License 2.0. Copyright 2026 KeyValueStore.com. See `LICENSE` and `NOTICE` in the top folder.
