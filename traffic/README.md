# Traffic Analyzer

Load the output of `MONITOR` from Redis or Valkey and see what the traffic is made of: commands per second, the command mix, reads against writes, the busiest keys and key patterns, which clients send what, how the keys would spread over a cluster, commands worth a second look, and a hit-rate curve that says how many keys a cache needs to hold for a given hit rate.

Try it in your browser at https://keyvaluestore.com/tools/traffic/, or open `traffic/app/index.html` from a copy of this repository.

Its logic is one JavaScript file, `traffic.js`, with no dependencies. The web page, the command line and the tests all load it.

## What MONITOR is

`MONITOR` is a debugging command. A client that sends it gets every command the server runs from then on, one line each, as it happens:

```
1791218550.753456 [0 10.0.0.12:54650] "SET" "session:9f86" "{\"user\":42}" "EX" "1800"
1791218550.754114 [0 10.0.0.13:40312] "EVALSHA" "8d1b0c9e..." "1" "rate:10.0.4.7" "60"
1791218550.754174 [0 lua] "INCR" "rate:10.0.4.7"
```

Each line has the time in seconds and microseconds, the database number, the client's address and port, and the command with its arguments in quotes. Quotes, backslashes, line breaks and tabs inside an argument are written as `\"`, `\\`, `\n` and `\t`, and any other byte that isn't printable ASCII as `\xHH`. Commands that a Lua script or a function ran show `lua` in place of the address, and clients on a Unix socket show `unix:` and the socket's path.

Some things never show up:

- **Admin commands**, such as `CONFIG`, `CLIENT LIST`, `SLOWLOG`, `DEBUG` and `SHUTDOWN`. The server leaves them out on purpose.
- **Passwords.** The arguments of `AUTH`, and the user name and password given to `HELLO`, come out as `"(redacted)"`.
- **Commands that never ran**, because the command doesn't exist or has the wrong number of arguments. Commands that run and then fail do show up.
- **`QUIT`**, before Redis 7.2.

Lines come in the order the server ran the commands. Commands inside `MULTI` show up when `EXEC` runs them, right before the `EXEC` line. A script's own line (`EVAL`, `EVALSHA` or `FCALL`) comes first, followed by the commands it ran.

`MONITOR` isn't free. The server formats every command for every client that's monitoring, and the Redis documentation measured one `MONITOR` client cutting a benchmark's throughput by more than half. Capture for seconds or a minute, not hours.

```sh
redis-cli -h 10.0.0.4 -p 6379 MONITOR > monitor.txt          # Ctrl-C to stop
timeout 30 valkey-cli -h 10.0.0.4 -p 6379 MONITOR > monitor.txt
```

## Why look at a capture

- **Find what keeps the server busy.** Which commands, how many a second, and when the peaks come.
- **Find hot keys.** One key taking a big share of the traffic. In a cluster, all of it lands on one primary, however many you add.
- **Size a cache.** The hit-rate curve shows how many keys a cache in front of the server, or the server itself with less memory, would need to hold.
- **Plan a move to a cluster.** Commands whose keys sit in different slots, use of databases other than 0, and how the load would spread over the primaries.
- **Catch risky habits.** `KEYS`, flushes, reads of whole collections, big values, keys set and then given an expiry in a second command, and scripts sent with `EVAL` every time.
- **See who sends what.** Commands per client address and connection.

## How the hit-rate curve works

A cache that evicts the least recently used key (LRU) holds the keys used most recently. When it's full and a new key comes in, the key unused for the longest time goes out.

There's a neat way to know, for every cache size at once, which reads a cache like that would serve. For each read, count how many different keys were used since the same key was used last. Call that number the read's distance. A cache that holds N keys still has the key if fewer than N other keys came along in between, so it serves every read with a distance below N. One pass over the capture gives every read's distance, and from those the hit rate for any size. The idea goes back to an IBM paper by Mattson, Gecsei, Slutz and Traiger from 1970. The analyzer counts distances with a Fenwick tree, so a capture with millions of commands takes seconds.

Deleting a key frees its place in the cache, and the next new key takes that place without pushing anything out. The analyzer keeps track of those holes, so the curve stays exact with deletes and flushes in the traffic.

What the curve assumes:

- Every read of a key the cache doesn't have loads it, the way an application with a cache in front does.
- Writes count as uses, so a key just written is the most recent.
- The first read of a key always misses. That's why the curve tops out below 100%: holding every key, the best possible hit rate is the share of reads that weren't a key's first.
- All keys take the same space. The curve counts keys, not bytes.
- Keys don't expire on their own while the capture runs.

Redis and Valkey don't run an exact LRU. With `maxmemory-policy allkeys-lru`, they pick a few keys at random (`maxmemory-samples`, 5 by default) and evict the one unused the longest. That comes close: in the check under "How it was tested", a real server's hit rate was within half a percentage point of the curve.

## Use it in the browser

Load a capture or drop it on the page. It's read in steps with a progress bar, then:

- **Totals.** Commands, how long the capture ran, the average and the busiest second, keys, connections, and the share of reads, writes, scripts and pub/sub.
- **Commands per second**, as a chart. Point at it to see each second.
- **The command mix**: every command, its kind and its share.
- **The busiest keys**, with reads, writes and deletes.
- **Key patterns.** Keys grouped the way the [Keyspace Map](../keyspace/) groups them, with numbers, IDs, dates and the like folded into placeholders such as `<id>`.
- **Clients**, by address: commands, connections and what each sends most.
- **Spread over a cluster.** How the key accesses would land on 1 to 16 primaries with the slots `redis-cli --cluster create` would give them, and the busiest slots.
- **Worth a look.** The findings described below, each with examples from the capture.
- **Cache hit rate.** The curve, the cache size for 50%, 80%, 90%, 95% and 99% of the best hit rate, and a box to try any size.
- **Downloads.** Every key with its counts as CSV, commands per second as CSV, and the curve as CSV.

You can also paste lines instead of loading a file.

Nothing you load leaves the page. The tool doesn't send anything anywhere, and the page's security policy stops it from fetching or loading anything from another site.

## What it looks out for

| Finding | When it shows up |
|---|---|
| KEYS | Any `KEYS` command. It walks the whole keyspace while every other client waits. |
| FLUSHALL and FLUSHDB | Any of them. |
| Whole-collection reads | `HGETALL`, `HKEYS`, `HVALS`, `SMEMBERS`, `SUNION`, `SINTER`, `SDIFF`, and `LRANGE`, `ZRANGE` or `ZREVRANGE` from 0 to -1. Slow on big collections. |
| Large values | An argument of 100 KB or more. |
| Commands across cluster slots | A command whose keys hash to different slots. A cluster refuses it with `CROSSSLOT`. |
| A hot key | One key with 10% or more of all key accesses, in captures with at least 100. |
| SET, then EXPIRE | `SET` without an expiry, followed on the same connection by `EXPIRE`, `PEXPIRE`, `EXPIREAT` or `PEXPIREAT` on the same key, outside a transaction. `SET ... EX` does both at once. |
| Scripts sent with EVAL | At least 10 `EVAL` calls, making up more than half the script calls. |
| Connection setup | `AUTH`, `HELLO`, `SELECT`, `CLIENT SETNAME` and `CLIENT SETINFO` adding up to 10% or more of the commands, which usually means connections opened over and over. |
| Databases other than 0 | Commands in another database. Redis Cluster only has database 0. |
| Commands not in the table | Commands that aren't in Valkey 9.1 or Redis 8.10, often from a module. They're counted, but their keys aren't. |

## Use it from the command line

You need Node.js 20 or newer. Nothing to install. The file is read piece by piece, and `-` reads standard input, so a capture can go straight in:

```sh
$ node traffic/cli.js monitor.txt
monitor.txt: 1,723 commands in 45.0 s, from 2026-10-05 17:06:33 to 2026-10-05 17:07:19 UTC
Average 38.3 commands a second, peak 70 at 17:06:53
Reads 40.7%, writes 44.3%, scripts 4.4%, pub/sub 0.4%, other 10.2%
504 keys, 1,546 key accesses (772 reads, 749 writes, 25 deletes), 29 connections from 7 addresses

Commands
     count   share  kind     command
       302   17.5%  read     GET
       234   13.6%  write    INCR
...
LRU cache hit rate (772 reads, 247 of them the first use of a key, which no cache can serve)
  Holding all 504 keys serves 68.0% of reads, the best possible.
  Reaching 50% of that takes 6 keys, 80% takes 60, 90% takes 131, 95% takes 208, 99% takes 313.

$ node traffic/cli.js monitor.txt --cache 100
$ node traffic/cli.js monitor.txt --keys > keys.csv
$ timeout 30 redis-cli MONITOR | node traffic/cli.js -
```

| Option | What it does |
|---|---|
| `--keys` | Every key as CSV: db, key, reads, writes, deletes |
| `--curve` | The hit-rate curve as CSV: keys in the cache, share of reads served |
| `--seconds` | Commands per second as CSV |
| `--cache N` | The share of reads a cache of N keys would serve |
| `--top N` | How many commands, keys, patterns and clients to list, 15 by default |
| `--primaries N` | Primaries for the cluster spread, 3 by default |
| `--json` | Everything as JSON |
| `--no-curve` | Skip the hit-rate curve, which keeps a record of every key access |

## Use it in your own code

```js
const T = require('./traffic/traffic.js');
const an = T.analyzer();
an.addText(fs.readFileSync('monitor.txt', 'utf8'));   // or addChunk(text, isLast) piece by piece
const r = an.result({ top: 20, primaries: 3 });
r.byCommand[0];          // { name: 'GET', count: 302, kind: 'read', bytes: 7645 }
r.findings;              // [{ id: 'hot-key', title: 'A hot key', count: 190, examples: [...], text: '...' }, ...]
const c = an.curve();
c.hitRate(1000);         // share of reads a cache of 1,000 keys serves
T.parseLine('1791218550.753456 [0 10.0.0.12:54650] "GET" "k"');   // { sec, usec, db, client, args }
```

In a page, load `traffic.js` with a script tag and use `window.KVTraffic`.

## What it reads

Lines in the format above, as `redis-cli` and `valkey-cli` print them, from Redis 2.6 on and every Valkey. A leading `OK` is skipped, and so are a `+` at the start of a line, which shows up when `MONITOR` is read straight off the socket, and Windows line endings. Lines that don't fit the format are counted and skipped, and the first few are shown.

To know which arguments are keys and whether a command reads or writes, it carries a table of every command and subcommand of Valkey 9.1.2 and Redis 8.10.2, 463 in all, with the key positions and flags `COMMAND` reports. Twenty-eight commands keep their keys in places a table can't describe, such as `EVAL`'s key count, `ZUNIONSTORE`'s destination, the keys after `STREAMS` in `XREAD`, `SORT ... STORE` and `MIGRATE ... KEYS`, and those have their own rules. Reads are commands the server marks read-only, deletes are `DEL`, `UNLINK` and `GETDEL`, and the other commands the server marks as writes count as writes. Scripts aren't counted as key accesses, since the commands they run come right after them as `lua` lines. Pub/sub channels aren't keys, and neither are the arguments of `WATCH`, which doesn't touch the value.

## How it was tested

Five servers, built from source in October 2026: Valkey 9.1.2 and Redis 8.10.2, 7.2.16, 6.2.24 and 2.8.24. A script ran the same kind of workload on each from six addresses on the loopback network: three web servers reading users, sessions, carts and prices, a background worker with a job queue in database 2, streams and pub/sub, a nightly job sweeping through users with `HGETALL`, `KEYS` and a `FLUSHDB` in database 9, and a cron host opening a new connection every time. The mix had 61 different commands, among them transactions, Lua scripts loaded and inline, a function, binary and UTF-8 keys, a 110 KB value, blocking pops, a script command that fails, and admin commands. `valkey-cli` or `redis-cli` recorded `MONITOR` the whole time. The script kept what every connection sent and asked the server `COMMAND GETKEYS` for every command, and a cluster node `CLUSTER KEYSLOT` for every key.

- **Reading.** All 4,757 lines of the five captures read back byte for byte as sent, each in its connection's order, and the lines every script ran came right after the script.
- **Keys.** For every command, the keys matched `COMMAND GETKEYS`. Redis 2.8 has no `GETKEYS`, so Valkey 9.1.2 answered for its commands. Another 60 command forms with keys in unusual places matched `GETKEYS` on both Valkey 9.1.2 and Redis 8.10.2.
- **Totals.** The counts per command, per key and per client, and every finding, matched counts worked out from what was sent.
- **Slots.** Key slots matched `CLUSTER KEYSLOT` for all 1,492 keys.
- **The curve.** It matched a simulated LRU cache at ten sizes for each capture, and at every size on 20 random workloads full of deletes and flushes.
- **A real cache.** Valkey 9.1.2 with `allkeys-lru`, 4 MB of memory and the default 5 samples ran 720,000 reads from a skewed workload over 300,000 keys, setting each key it missed, while `MONITOR` recorded. It held about 21,850 keys and served 57.3% of the reads. The curve built from the capture says 57.6% for that many keys. With 10 samples the server served 57.5%, and the curve says 57.6%.
- **Speed.** A capture of 3 million commands over a million different keys took 11 seconds on the command line with Node.js 22, using 333 MB of memory.

What `MONITOR` left out matched the list above. Every command the server flags as admin was missing, on all five servers, though the flags changed over the years: Redis 2.8.24 showed `CLIENT LIST` and `SLOWLOG GET`, which it doesn't flag as admin, and Redis 6.2.24 left out `CLIENT SETNAME`, since `CLIENT` as a whole was an admin command then. `QUIT` showed up on Valkey 9.1.2, Redis 8.10.2 and 7.2.16, but not on 6.2.24 or 2.8.24. A command a script ran that failed, `EXPIRE` with a time that isn't a number, still showed up. In a separate check on Valkey 9.1.2 and Redis 8.10.2, an `INCR` that failed showed up, while an unknown command, a `GET` without its key and `DEBUG SLEEP` didn't, and `HELLO 3 AUTH default secret` came out as `"HELLO" "3" "AUTH" "(redacted)" "(redacted)"`.

The captures and what each connection sent are in `test/fixtures/`, and the measurements in `test/results/`. The tests replay them, so they run without a server:

```sh
node --test traffic/test/traffic.test.js
```

## Limits

- A capture is a sample. A minute on a Tuesday afternoon may not look like a Monday morning.
- `MONITOR` shows requests, not replies, so it can't tell how big a returned collection or value was, only how big the arguments sent were. Large values are only seen when they're written.
- The hit-rate curve counts keys of any size alike, and leaves out expiry by TTL.
- The page keeps every key in memory. For very large captures, use the command line. The curve keeps a record of up to 30 million key accesses and covers the first 30 million in longer captures.
- Keys of module commands aren't counted, since the table only has the commands of Valkey and Redis themselves.

## License

Apache License 2.0. Copyright 2026 KeyValueStore.com. See `LICENSE` and `NOTICE` in the top folder.
