# Keyspace Map

Paste a list of keys from Redis, Valkey or any key-value store and see what's in it: the prefixes as a tree with counts, the naming patterns behind the keys with IDs and hashes folded together, how many bytes the key names take, and naming slips worth a look.

Try it in your browser at https://keyvaluestore.com/tools/keyspace/, or open `keyspace/app/index.html` from a copy of this repository.

Its logic is one JavaScript file, `keyspace.js`, with no dependencies. The web page, the command line and the tests all load it.

## What a keyspace map shows

A key-value store has no tables. Everything sits in one flat list of keys, and the only structure is the one people build into the names, such as `user:1042:profile` or `session:9f86d081884c7d65`. After a few years and a few teams, nobody is quite sure what's in there. Which features own most of the keys? Did someone ship `usr:` instead of `user:`? Are there keys nobody remembers?

The map answers that from the names alone:

- **Separator.** It works out which character splits the names into parts, usually `:`, sometimes `/` or `.`.
- **Patterns.** Parts that vary are folded into placeholders, so a million user keys become one line, `user:<id>:profile`, with a count. The placeholders are `<id>` for numbers, `<hex>` for hashes, `<uuid>`, `<date>`, `<email>`, `<ip>` and `<token>` for long random strings. A level holding many one-off names, such as user names, becomes `<*>`. Placeholders use angle brackets, because braces in a key mean a hash tag, and those stay: `cart:{<id>}:items`.
- **Tree.** The same keys as a tree of prefixes, biggest first, so you can see that `user:` holds 55% of the keyspace and open it to see why.
- **Slips.** Keys with no separator at all, prefixes that differ only in case (`user` and `User`), prefixes one letter apart (`user` and `usr`), empty parts (`cache::home`), keys over 256 bytes, and keys with control characters or bytes that aren't valid UTF-8.

## Get the key list without hurting the server

Use `--scan`, never `KEYS *`. `KEYS` walks the whole keyspace in one go and blocks every other client until it's done. `--scan` walks it a slice at a time.

```sh
redis-cli -h 10.0.0.4 -p 6379 --scan > keys.txt
valkey-cli -h 10.0.0.4 -p 6379 --scan --pattern 'user:*' > user-keys.txt
```

On a cluster, run it against each primary, since each one only lists its own keys. If keys can contain any byte, add `--no-raw`: the client then quotes every key, as in `"bin:\x00\xff"`, and the map reads that form too. Raw output cuts a key off at its first zero byte.

## Use it in the browser

Paste the keys or load the file. The map updates as you type. You can set the separator yourself, and switch off either kind of folding to see the names as they are. The patterns download as CSV.

Nothing you paste or load leaves the page. The tool doesn't send anything anywhere, and the page's security policy stops it from fetching or loading anything from another site.

## Use it from the command line

You need Node.js 20 or newer. Nothing to install.

```sh
$ redis-cli --scan | node keyspace/cli.js -
9161 keys, 229849 bytes of key names, separator ":".

Patterns
     3000   32.7%  user:<id>:profile   e.g. user:1397036:profile
     2000   21.8%  user:<id>:settings   e.g. user:8988260:settings
     1500   16.4%  session:<hex>   e.g. session:87c09f3e9a4059272840cc1bc75b4061
      800    8.7%  cart:{<id>}:items   e.g. cart:{649683}:items
...
Worth a look
  Keys with no ":": 3. For example: config, version, maintenance
  Prefixes that differ only in case: 1. For example: user / User
  Prefixes one letter apart: 1. For example: user / usr
```

| Option | What it does |
|---|---|
| `--sep X` | Set the separator. `none` treats each key as one part |
| `--no-fold` | Keep IDs, hashes and dates as written |
| `--no-busy` | Keep levels of one-off names instead of folding them into `<*>` |
| `--raw` | Take each line exactly as written |
| `--top N`, `--depth N` | How many patterns and tree levels to print |
| `--json` | Print JSON |

## Use it in your own code

```js
const K = require('./keyspace/keyspace.js');
const keys = K.parseKeyList(text);
const map = K.analyze(keys);       // { separator, total, totalBytes, patterns, findings, root }
K.tree(map.root);                  // the tree as plain objects
```

In a page, load `keyspace.js` with a script tag and use `window.KVKeyspace`.

## How it was tested

Keys with known patterns went into real servers, Valkey 9.1.2 and Redis 8.10.2, loaded with the Mass Insert Builder: 9,161 keys from 13 patterns, including hash-tagged IDs, UUIDs, dates, IP addresses, a level of random names, three keys with no separator and two planted naming slips. They were then listed back with `--scan`, both raw and quoted.

On both servers, from both kinds of output, the map found exactly the 13 patterns with exactly the right counts, the separator, the three keys with no separator, the `user`/`User` case pair and the `user`/`usr` near miss. The count under each top-level prefix matched the server's own `SCAN MATCH` for that prefix.

The Valkey output, raw and quoted, is in `test/fixtures/`, and the tests replay it, so they run without a server:

```sh
node --test keyspace/test/keyspace.test.js
```

## Limits

- The map reads names, not values or memory. A pattern with few keys can still hold most of the data if its values are large. The byte figure counts key names only.
- Folding works from what a part looks like. A level of words that happen to vary, such as product names, may show as `<*>`, and a 20-character word with digits may show as `<token>`. Switch folding off to see the names as written.
- Near-miss prefixes are checked among the 3,000 biggest top-level prefixes.

## License

Apache License 2.0. Copyright 2026 KeyValueStore.com. See `LICENSE` and `NOTICE` in the top folder.
