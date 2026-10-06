# KeyValueStore.com tools

Free tools for the key-value stores you run: Redis and Valkey, DynamoDB, etcd, and the ideas underneath them. Each tool runs in your browser at [keyvaluestore.com/tools](https://keyvaluestore.com/tools/), from the command line with Node.js, or inside your own code.

| Tool | What it does | Folder |
|---|---|---|
| [Hash Slot Calculator](https://keyvaluestore.com/tools/slots/) | Which cluster slot and primary a key lands on, CROSSSLOT checks for multi-key commands, and how a key list spreads | [`slots/`](slots/) |
| [Typed JSON Converter](https://keyvaluestore.com/tools/typed-json/) | DynamoDB's typed JSON to plain JSON and back, every digit of every number kept | [`typed-json/`](typed-json/) |
| [Mass Insert Builder](https://keyvaluestore.com/tools/pipe/) | CSV, JSON or commands to a protocol file for `redis-cli --pipe`, and protocol bytes back to readable commands | [`pipe/`](pipe/) |
| [Keyspace Map](https://keyvaluestore.com/tools/keyspace/) | A key list from `--scan` as a tree of prefixes and naming patterns, with naming slips flagged | [`keyspace/`](keyspace/) |
| [Consistent Hashing Playground](https://keyvaluestore.com/tools/ring/) | Modulo, hash ring, rendezvous and jump hash compared when a node joins or leaves | [`ring/`](ring/) |
| [Snapshot Viewer](https://keyvaluestore.com/tools/snapshot/) | A Redis or Valkey `dump.rdb` or `DUMP` payload opened: keys by type, the biggest keys, prefixes, expiries and every value | [`snapshot/`](snapshot/) |
| [Traffic Analyzer](https://keyvaluestore.com/tools/traffic/) | A `MONITOR` capture broken down: commands per second, the command mix, hot keys, clients, cluster spread, risky commands, and the cache size for a given hit rate | [`traffic/`](traffic/) |
| [Value Inspector](https://keyvaluestore.com/tools/inspect/) | A stored value decoded: JSON, MessagePack, CBOR, BSON, Protocol Buffers, PHP, igbinary, Java, pickle or Ruby Marshal, inside base64, gzip, zlib, LZ4 or Snappy, with nothing in it run | [`inspect/`](inspect/) |
| [Memory Calculator](https://keyvaluestore.com/tools/memory/) | How much memory Redis and Valkey use for your keys on 15 versions: encodings, hash tables, TTLs, the limits that change everything, and packing small strings into hashes | [`memory/`](memory/) |
| [Config Checker](https://keyvaluestore.com/tools/config/) | A redis.conf or valkey.conf read the way each of 15 versions reads it at startup: the error and line it stops at, every setting as CONFIG GET reports it, and what to look at | [`config/`](config/) |
| [ACL Builder](https://keyvaluestore.com/tools/acl/) | ACL rules applied the way each of 15 versions applies them: ACL SETUSER's error or ACL LIST's line, what the user may do, ACL DRYRUN for commands, and least-privilege users drafted from MONITOR | [`acl/`](acl/) |
| [Expression Tester](https://keyvaluestore.com/tools/expressions/) | DynamoDB key conditions, filters, conditions, updates and projections checked the way DynamoDB checks them, with its error messages, then run on your items | [`expressions/`](expressions/) |
| [Revision Viewer](https://keyvaluestore.com/tools/revisions/) | An etcd snapshot opened: what fills it, Kubernetes resources and old revisions, free pages, Secrets in the clear, and every revision of a key, printed the way kubectl prints it | [`revisions/`](revisions/) |

Each folder's README is the tool's manual, with a plain-language explanation of the technology behind it.

## How the tools are built

- **One library file each.** Each tool's logic is one JavaScript file with no dependencies. The web page, the command line and the tests all load that same file. There's nothing to install and nothing to build.
- **Your data stays with you.** The tools don't send anything anywhere, and each web page's security policy stops it from fetching or loading anything from another site: no fetch, no beacons, no scripts, styles or images from elsewhere.
- **Checked against the real thing.** Each tool was checked against real servers or reference code: 15 versions of Redis and Valkey built from source, DynamoDB Local, etcd 3.4 to 3.6 with Kubernetes' own Go packages, the AWS SDK, the Python `mmh3` package, the code printed in the jump hash paper, and values written by Python, PHP, Java and Ruby themselves. The tests replay the recorded answers, which are in each tool's `test/fixtures/`, and the full measurements are in `test/results/`.

## Run them

From a copy of this repository, with Node.js 20 or newer:

```sh
node slots/cli.js --help
node typed-json/cli.js --help
node pipe/cli.js --help
node keyspace/cli.js --help
node ring/cli.js --help
node snapshot/cli.js --help
node traffic/cli.js --help
node inspect/cli.js --help
node memory/cli.js --help
node config/cli.js --help
node acl/cli.js --help
node expressions/cli.js --help
node revisions/cli.js --help
```

Each tool's page is in its `app/` folder. Open `app/index.html` straight from the folder, or serve the repository with any static web server.

## Run the tests

```sh
node --test
```

Node finds every test under the tool folders. They need no server and no network, since they replay the answers recorded from the servers.

## License

Everything in this repository is under the Apache License 2.0, unless a file says otherwise. Copyright 2026 KeyValueStore.com. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).

Redis, Valkey, DynamoDB, etcd and Kubernetes are trademarks of their owners. They're named only to say which systems the tools work with, and KeyValueStore.com isn't connected with or endorsed by any of them.
