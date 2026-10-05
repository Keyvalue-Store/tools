# Consistent Hashing Playground

Spread keys over a set of nodes four ways, then add a node or take one away and count what moves. It compares plain modulo hashing, a hash ring with virtual nodes, rendezvous hashing and jump consistent hash, side by side.

Try it in your browser at https://keyvaluestore.com/tools/ring/, or open `ring/app/index.html` from a copy of this repository.

It's one JavaScript file with no dependencies. The same file runs the web page, the command line and the tests.

## Why consistent hashing exists

A store or cache that runs on several servers has to decide which server holds each key. The obvious rule is modulo: hash the key, divide by the number of servers, keep the remainder. With 5 servers, a key whose hash ends in remainder 3 goes to server 3.

That works until the number of servers changes. Add a sixth server and the divisor changes from 5 to 6, so almost every key gets a new remainder. In the playground, about 83% of keys move. For a cache, every moved key is a miss that lands on the database. For a store, it's data copied across the network. And most of those moves are between servers that never changed, which is pure waste.

Consistent hashing is the family of rules that move only what has to move. Add a sixth server, and about a sixth of the keys move, all of them to the new server. Take a server away, and only its keys move. Four ways to do it:

- **Hash ring.** Hash each server onto a circle, and each key too. A key belongs to the first server clockwise from it. A new server takes over only the stretch of circle just before it. With one point per server the stretches vary a lot in length, so the load is uneven. Each server therefore gets many points, called virtual nodes, which even it out. This is the scheme from Karger and others in 1997, and the one Amazon's Dynamo paper made famous.
- **Rendezvous hashing.** For each key, score every server by hashing the key and the server together, and pick the highest score. Even with no tuning, and simple, but it looks at every server for every key.
- **Jump consistent hash.** A short loop from Lamping and Veach at Google, 2014, that jumps a key forward through numbered buckets. No memory, very even, very fast. The catch: the buckets are numbered, so it can only add or remove the last one. It suits shards that are numbered, not servers that come and go.
- **Modulo,** for comparison.

Redis Cluster and Valkey Cluster use none of these directly. They put keys into 16,384 fixed slots and move whole slots between servers, which gets the same effect by hand. The [Hash Slot Calculator](../slots/) works out those slots.

## Use it in the browser

Pick the number of nodes, the virtual nodes per node on the ring, the number of keys, and the change: add a node, or remove one. The page shows:

- **The ring,** after the change, with each node's virtual nodes as ticks and a sample of keys as dots. Keys that moved are drawn larger.
- **A table** with, for each method, the share of keys that moved, how many moved between two nodes that both stayed, and how far the busiest node is above an even share.
- **Keys per node** after the change, for each method, against an even share.

Try one virtual node per node and watch the ring's load fall apart, then raise it.

## Use it from the command line

You need Node.js 20 or newer. Nothing to install.

```sh
$ node ring/cli.js --nodes 5 --add
100000 keys, adding node-6 to 5 nodes. A perfect method moves 16.7% of them.

Method        Keys moved   Moved between nodes that stayed   Busiest node after, vs even share
Modulo             83.3%        66724                        1.01x
Hash ring          14.6%            0                        1.14x
Rendezvous         16.5%            0                        1.01x
Jump hash          16.7%            0                        1.01x
```

| Option | What it does |
|---|---|
| `--nodes N` | Nodes before the change, up to 1,000 |
| `--add`, `--remove K` | Add a node, or remove node K |
| `--keys N` | How many made-up keys (default 100,000) |
| `--file FILE` | Your own keys, one per line |
| `--vnodes N` | Virtual nodes per node on the ring (default 160) |
| `--json` | Print JSON |

## Use it in your own code

```js
const R = require('./ring/ring.js');
const place = R.ALGORITHMS.ring.build(['cache-a', 'cache-b', 'cache-c'], { vnodes: 160 });
place('user:42');                 // index of the node that holds the key
R.jump(R.key64('user:42'), 8);    // jump hash bucket, 0 to 7
```

In a page, load `ring.js` with a script tag and use `window.KVRing`. All four methods hash with MurmurHash3, the 32-bit x86 version, which is in the file.

## How it was tested

- **MurmurHash3.** 10,000 strings with random seeds, including text in many scripts, hashed the same as the Python `mmh3` package, version 5.3.1.
- **Jump hash.** 20,000 random 64-bit keys and bucket counts gave the same buckets as the C code printed in Lamping and Veach's paper, compiled with gcc.
- **Behaviour.** With 100,000 keys and 3, 5 or 10 nodes, adding or removing a node never moved a key between two nodes that stayed, for the ring, rendezvous or jump hash. Rendezvous and jump hash moved within half a point of the ideal share each time. Modulo moved 67% to 91% of keys.
- **Virtual nodes.** On 10 nodes, the busiest node held 2.84 times an even share with one virtual node each, 1.46 times with 10, and 1.08 times with 160.

`test/results/` has the full figures, and `test/fixtures/` the reference answers, so the tests run without Python or a compiler:

```sh
node --test ring/test/ring.test.js
```

## Limits

- Nodes all count the same here. Real systems often weigh them by capacity, which the ring does by giving bigger nodes more virtual nodes.
- The page draws up to 8 nodes, so each can have its own colour. The command line takes up to 1,000.
- The made-up keys are `key:0`, `key:1` and so on. Real keys hash just as evenly, since the hash doesn't care what they mean, but you can load your own with `--file`.

## License

Apache License 2.0. Copyright 2026 KeyValueStore.com. See `LICENSE` and `NOTICE` in the top folder.
