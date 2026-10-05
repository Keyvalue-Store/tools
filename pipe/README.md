# Mass Insert Builder

Turn CSV, JSON or plain commands into a file in the Redis protocol, ready for `redis-cli --pipe` or `valkey-cli --pipe`, the fast way to load a lot of data into Redis or Valkey. It also reads protocol bytes back and shows them as commands and replies.

Try it in your browser at https://keyvaluestore.com/tools/pipe/, or open `pipe/app/index.html` from a copy of this repository.

Its logic is one JavaScript file, `pipe.js`, with no dependencies. The web page, the command line and the tests all load it.

## Why a protocol file

The slow way to load a million keys is a loop that sends a command and waits for the answer, a million times. Most of that time is spent waiting. A round trip of half a millisecond adds up to more than eight minutes.

`redis-cli --pipe` skips the waiting. It streams the commands as fast as the connection takes them, reads the replies as they come back, and at the end prints a count:

```
All data transferred. Waiting for the last reply...
Last reply received from server.
errors: 0, replies: 1000000
```

It wants its input already in the Redis protocol, called RESP: the format clients and servers use on the wire. A command is a list of strings, each one preceded by its length in bytes:

```
*3\r\n$3\r\nSET\r\n$7\r\nuser:42\r\n$3\r\nAna\r\n
```

That reads as "a list of 3 items: 3 bytes `SET`, 7 bytes `user:42`, 3 bytes `Ana`". Because every value carries its length, values can hold anything, including line breaks and binary bytes, and nothing needs escaping. That's also why writing the file by hand, or with a quick script, goes wrong easily: one length counted in characters instead of bytes, and every command after it is garbage. This tool counts bytes.

## Use it in the browser

1. **Paste your data, or load a file.** CSV (the delimiter is guessed: comma, tab, semicolon or pipe), JSON (a list of objects, or one object per line), or plain commands written as you'd type them in `redis-cli`.
2. **Say how each record is stored.** Write the key with `${field}` where a field goes, as in `user:${id}`. Then pick the data type:
   - **Hash** (`HSET`): every field not used in the key, or the fields you list.
   - **String** (`SET`): one field, or the whole record as JSON.
   - **List** (`RPUSH`), **Set** (`SADD`): one field per record, added to the key's list or set.
   - **Sorted set** (`ZADD`): a score field and a member field. Records whose score isn't a number are skipped and listed.
3. **Choose the extras.** An expiry in seconds, a database number, and whether to delete each key first, so loading the same file twice doesn't double your lists.
4. **Download `data.resp`** and load it:

```sh
redis-cli -h 10.0.0.4 -p 6379 --pipe < data.resp
valkey-cli -h 10.0.0.4 -p 6379 -a "$PASSWORD" --pipe < data.resp
```

The page shows the first commands in readable form and the first bytes of the file, with the line endings made visible.

Loading a cluster takes one more step. `--pipe` sends everything to the one server you name and doesn't follow cluster redirects, so split the data by primary first and load each part into its own primary. The [Hash Slot Calculator](../slots/) tells you which primary each key belongs to.

Nothing you paste or load leaves the page. The tool doesn't send anything anywhere, and the page's security policy stops it from fetching or loading anything from another site.

### Reading protocol bytes

The second part of the page does the opposite. Paste protocol data and see it as commands and replies, the way `redis-cli` prints them. It reads raw bytes, text with `\r\n` written out (as it appears in logs and documentation), plain hex, and hex dumps with offsets from `hexdump -C`, `xxd`, `od -t x1` and Wireshark's Follow TCP Stream shown as a hex dump. From Follow TCP Stream, both sides of the connection are kept in order, and the indented lines, the server's side, are read as replies. A dump of a whole captured packet doesn't work, since it starts with the network headers: copy the TCP payload, or follow the stream. It understands RESP2 and RESP3, including maps, sets, doubles, big numbers, verbatim strings, push messages and attributes.

## Use it from the command line

You need Node.js 20 or newer. Nothing to install.

```sh
$ node pipe/cli.js csv users.csv --key 'user:${id}' --type hash --ttl 3600 > users.resp
4000 commands (HSET 2000, EXPIRE 2000), 372495 bytes, 2000 keys.

$ redis-cli --pipe < users.resp

$ node pipe/cli.js json orders.jsonl --key 'order:${order}' --type string --whole-row | valkey-cli --pipe

$ node pipe/cli.js commands setup.txt > setup.resp
$ node pipe/cli.js decode setup.resp
```

Run `node pipe/cli.js --help` for every option. The summary and any skipped records go to standard error, so standard output stays clean protocol data.

## Use it in your own code

```js
const P = require('./pipe/pipe.js');
const { records, columns } = P.csvRecords(csvText);
const r = P.build(records, columns, { key: 'user:${id}', type: 'hash', ttl: 3600 });
fs.writeFileSync('users.resp', r.output.bytes());
```

In a page, load `pipe.js` with a script tag and use `window.KVPipe`.

## How it was tested

Files the tool built were loaded into real servers, Valkey 9.1.2 and Redis 8.10.2, both built from source, and every key was read back and compared with the source data.

| Data | Records | Commands | Result on each server |
|---|---|---|---|
| CSV to hashes, with an expiry, fields holding commas, quotes, line breaks and many scripts | 2,000 | 4,000 | `errors: 0`, every hash and expiry as expected |
| CSV with semicolons to 150 lists, loaded twice with "delete each key first" | 3,000 | 3,150 per load | `errors: 0`, every list in the original order, no doubles |
| JSON Lines to 300 sets | 2,500 | 2,500 | `errors: 0`, every set as expected |
| CSV to sorted sets, scores written eight ways, 113 bad scores | 2,000 | 1,887 | `errors: 0`, every score as expected, the 113 bad ones skipped |
| JSON records stored whole, with 20-digit IDs | 1,500 | 1,500 | `errors: 0`, every value byte for byte, every ID exact |
| Command lines with quotes, escapes and binary bytes | 1,000 | 1,000 | `errors: 0`, every value byte for byte |

The reader was checked against 39 real replies from each server in RESP2 and again in RESP3, 12 reply types between them, and against the push messages and attributes both servers sent after `HELLO 3`. Every file above read back as the commands that went in, 14,037 in all. A real `valkey-cli` session, dumped by `hexdump -C`, `xxd`, `od -t x1` and `tshark`, read back as the exact bytes from each.

`test/results/` has the full numbers. The tests replay the recorded replies and dumps in `test/fixtures/`, so they run without a server; the loads into the servers are recorded in the results files only.

```sh
node --test pipe/test/pipe.test.js
```

## Limits

- `--pipe` sends everything to one server and doesn't follow cluster redirects. For a cluster, split the data by primary first.
- JSON values that are lists or objects are stored as JSON text. Numbers are stored exactly as written in the file, so `1.50` stays `1.50`.
- Hex dumps must show single bytes in order. Dumps of 2-byte or 4-byte words, such as `od -x`, plain `hexdump` or `xxd -e`, show the bytes of each word reversed on most machines and won't read correctly.
- The browser holds the whole file in memory. For files over a few hundred megabytes, use the command line.

## License

Apache License 2.0. Copyright 2026 KeyValueStore.com. See `LICENSE` and `NOTICE` in the top folder.
