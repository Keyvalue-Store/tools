# Graph Key Builder

Paste a list of links and see the keys the graph takes in an ordered key-value store, such as RocksDB, LMDB, Badger or etcd. Then follow the links from any node, hop by hop, and see each prefix scan a graph layer would run, with the keys it reads.

Try it in your browser at https://keyvaluestore.com/tools/graph/, or open `graph/app/index.html` from a copy of this repository.

Its logic is one JavaScript file, `graph.js`, with no dependencies. The web page, the command line and the tests all load it.

## How a graph fits in a key-value store

A graph is things, called nodes, and the links between them: this service calls that one, this person knows that one. Graph databases store links natively. But many graph engines keep their data in a key-value store underneath, Dgraph in Badger and NebulaGraph in RocksDB among them, and so do plenty of apps that need a few links next to their records.

The trick is the key layout. An ordered store keeps its keys sorted, so keys that start the same way sit next to each other, and one prefix scan reads them all: seek to the first one, read until the prefix stops matching. The tool uses this layout:

| Key | What it holds |
|---|---|
| `n/web` | The node's own record. Its fields would go in the value, `{}` here |
| `o/web/calls/auth` | A link, filed under the node it leaves |
| `i/auth/calls/web` | The same link, filed under the node it reaches |

Each link is stored twice, so it can be followed either way. That's two writes per link, which belong in one transaction so the two copies never disagree.

Following the links out of `web` is one scan of the prefix `o/web/`. Only links of one type is one scan of `o/web/calls/`. A walk of two hops scans `web`, then every node it found. So the cost of a walk is one scan per node reached on the hop before, and the keys each scan reads. A node with a million links reads a million keys when you walk through it.

Two details make the scans exact. A `/` or `%` inside a name is written `%2F` or `%25`, so the scan for `o/alice/` can't pick up a node called `alice/x`. And the stores compare keys byte by byte in UTF-8, which the tool does too. JavaScript's own string sort disagrees with that for some characters: it puts 😀 before ～, and a store puts it after.

The same layout works beyond RocksDB and its kin. In DynamoDB the node is the partition key and the rest is the sort key, so `begins_with` in a Query is the prefix scan. etcd scans a prefix with a range request. Redis and Valkey don't keep keys in order, so there the usual way is a set per node and link type, or one sorted set per node read with `ZRANGE ... BYLEX`.

## Use it in the browser

Paste links, one a line: `from type to`, or `from,type,to` when names have spaces. Two names make a link of type `link`. Lines starting with `#` are skipped. The page shows:

- **Every key,** in the order the store keeps them, with its value.
- **A walk** from the node you pick: out along the links, back along them or both ways, of one type or any, for up to 10 hops. Each hop lists the prefixes it scanned, how many keys each read and the nodes they lead to.

## Use it from the command line

You need Node.js 20 or newer. Nothing to install.

```sh
$ printf 'web calls auth\nweb calls cart\ncart reads cart-db\nauth reads user-db\n' > links.txt
$ node graph/cli.js walk links.txt --from web
Following links out from web, up to 2 hops.

Hop 1: 1 prefix scan, 2 keys read
  o/web/  ->  auth, cart

Hop 2: 2 prefix scans, 2 keys read
  o/auth/  ->  user-db
  o/cart/  ->  cart-db

Reached 4 nodes with 3 prefix scans, reading 4 keys.
```

`node graph/cli.js keys links.txt` prints every key in store order. Give `-` as the file to read standard input.

| Option for walk | What it does |
|---|---|
| `--from NODE` | Where the walk starts |
| `--hops N` | How many hops to follow, 1 to 10 (default 2) |
| `--in`, `--both` | Follow links backwards, or both ways |
| `--type TYPE` | Follow only links of this type |

## Use it in your own code

```js
const G = require('./graph/graph.js');
const store = G.build(G.parseEdges('web calls auth\nweb calls cart').edges);
store.entries.map((e) => e.key);       // every key, in byte order
G.scan(store, 'o/web/');               // the keys of web's links
G.walk(store, 'web', { hops: 2 });     // hop by hop, with every scan
```

In a page, load `graph.js` with a script tag and use `window.KVGraph`.

## How it was tested

The keys from a test graph went into SQLite 3.45.1 as BLOB keys, in a shuffled order. SQLite compares BLOB keys byte by byte, the order RocksDB, LMDB and etcd keep by default. The names in the graph have a slash, a percent sign, a space, capitals, a hyphen, and letters outside ASCII from 2 to 4 bytes long. SQLite gave back all 51 keys in the order the tool gives them, and for all 150 prefix scans a walk of that graph could make, the same keys as the tool.

`test/generate/record.py` records those answers into `test/fixtures/`, and the tests replay them, so they run without SQLite:

```sh
node --test graph/test/graph.test.js
```

## Limits

- One layout, the one above. Real systems vary it: shorter prefixes, numbers for names, the fields of a link in its value.
- Nodes have no fields here, and links have no values. The tool is about where keys go and what reading them costs.
- The page lists the first 500 keys. The command line prints them all.

## License

Apache License 2.0. Copyright 2026 KeyValueStore.com. See `LICENSE` and `NOTICE` in the top folder.
