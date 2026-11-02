# Cluster Rebalancing Planner

Work out which hash slots to move between the primaries of a Redis or Valkey cluster so each one carries its share, by slot count or by bytes, and get a shell script that moves them. Use it to fill a primary you just added, to empty one you want to remove, or to even out a cluster whose keys have drifted.

Try it in your browser at https://keyvaluestore.com/tools/rebalance/, or open `rebalance/app/index.html` from a copy of this repository.

Its logic is one JavaScript file, `rebalance.js`, with no dependencies. The web page, the command line and the tests all load it. It reads text you give it and never connects to your cluster. The script it writes does connect, but only when you run it.

## How slots move

A cluster splits its keys into 16,384 slots and gives each primary some of them (the [Hash Slot Calculator](../slots/) explains how a key finds its slot). Moving data between primaries means moving slots, one at a time, with every key in them. For each slot the standard procedure is:

1. `CLUSTER SETSLOT <slot> IMPORTING <donor-id>` on the primary that receives the slot.
2. `CLUSTER SETSLOT <slot> MIGRATING <receiver-id>` on the primary that gives it.
3. `CLUSTER GETKEYSINSLOT <slot> <count>` on the donor, then `MIGRATE` with those keys, repeated until the slot is empty.
4. `CLUSTER SETSLOT <slot> NODE <receiver-id>` on the receiver, then the donor, then the other primaries.

While a slot is in steps 1 to 3, clients that ask the donor for a key that has already moved get an `ASK` redirect to the receiver, so reads and writes keep working. `redis-cli --cluster rebalance` and `--cluster reshard` run the same procedure. What they don't do is show you the plan first, balance by bytes, or let you read and schedule the work.

That's what this tool is for. You see the plan, the per-primary numbers before and after, and the exact commands, before anything touches the cluster.

## How it plans

1. **Targets.** Each primary gets a share in proportion to its weight, 1 unless you change it. Balancing by slot count, the 16,384 slots are split as whole numbers with the largest remainder method, so the targets always add up. Balancing by bytes, the target is the total times the primary's share.
2. **Threshold.** If every primary is already within the threshold of its target, 2 percent by default as in `redis-cli --cluster rebalance`, nothing moves.
3. **Moves.** Primaries above target give slots, starting with the biggest surplus. A donor gives slots from the top of its highest range downward, so what it keeps and what it gives stay in long runs. Each slot goes to whichever primary is furthest below target.
4. **By bytes.** A donor gives a slot only if that leaves it closer to its target than keeping it would, and a receiver only takes a slot while it is short by at least half of it. A slot can't be split, so a slot that holds a lot of data stays put when moving it would overshoot, and a smaller slot further down goes instead.
5. **A cap.** With a limit on slots moved, it stops there and says so. Run the planner again afterwards to continue.

Before planning it checks that the cluster is safe to change and refuses, with the reason and what to run, when:

- some slots have no owner (`redis-cli --cluster fix HOST:PORT`, or `CLUSTER ADDSLOTS`);
- a slot is migrating or importing, shown as `[slot->-id]` or `[slot-<-id]` (finish it with `--cluster fix`, or `CLUSTER SETSLOT <slot> STABLE` on both nodes);
- two primaries claim the same slot, or a replica lists slots;
- a primary is marked `fail` or `fail?`, or has no usable address;
- an option names a node that isn't in the output, or a replica, or names an id prefix that matches several nodes.

It also notes primaries with no replica and links the output shows as disconnected.

### What balancing by bytes needs

Bytes come from one of two lists:

- **Keys and sizes.** Each line a key and a number, such as `user:42 5120`. The tool hashes each key to its slot and adds up the slots. `MEMORY USAGE` gives a key's size; `redis-cli --bigkeys` and `--memkeys` give sizes for the biggest. Keys may be quoted the way `redis-cli` prints them.
- **Slots and sizes.** Each line a slot and a number, such as `1234,52000`. A range such as `100-199 1200000` is spread evenly.

Any number works, not only bytes: keys per slot, requests per slot from the [Traffic Analyzer](../traffic/), or anything else you want spread evenly.

## Use it in the browser

1. Paste the output of `CLUSTER NODES` from any node, or load a file.
2. Choose slot counts or bytes, and paste the sizes for bytes.
3. Change a primary's weight, or press Drain to empty it. Set the threshold and a limit if you want them.
4. Read the plan: slots or bytes per primary before and after, and each move. Download the script, or open it on the page.

Nothing you paste leaves the page.

## Use it from the command line

You need Node.js 22 or newer. Nothing to install: clone the repository and run the file.

```sh
$ redis-cli -h 10.0.0.1 -p 6379 CLUSTER NODES > nodes.txt
$ node rebalance/cli.js nodes.txt --script rebalance.sh
Balancing by slot count.
primary		weight	slots before	slots after	target
10.0.0.1:6379	1	5461		4096		4096
10.0.0.2:6379	1	5462		4096		4096
10.0.0.3:6379	1	5461		4096		4096
10.0.0.4:6379	1	0		4096		4096
Move 1366 slots from 10.0.0.2:6379 to 10.0.0.4:6379: 9557-10922
Move 1365 slots from 10.0.0.1:6379 to 10.0.0.4:6379: 4096-5460
Move 1365 slots from 10.0.0.3:6379 to 10.0.0.4:6379: 15019-16383
In all 4096 slots.
$ sh rebalance.sh
```

| Option | What it does |
|---|---|
| `--slot-load FILE` | Balance by load: lines of `slot,bytes`, `slot bytes` or `N-M bytes` |
| `--key-sizes FILE` | Balance by load: lines of a key and its size |
| `--weight ID=W` | Give a primary W times the normal share. ID is a node id, a prefix of 6 or more characters, or `host:port` |
| `--drain ID` | Move every slot off a primary, the same as `--weight ID=0` |
| `--threshold P` | Leave the cluster alone when every primary is within P percent of its target (default 2) |
| `--max-slots N` | Move at most N slots |
| `--script FILE` | Write the script that carries out the plan; `-` prints it |
| `--cli NAME` | The program the script calls, `redis-cli` (default) or `valkey-cli` |
| `--batch N` | Keys per `MIGRATE` (default 100) |
| `--json` | Print the plan as JSON |

Exit status 0 means a plan was made or nothing needs to move, 1 that the cluster isn't safe to rebalance (the reasons are printed and no script is written), 2 a usage or input error.

## The script

The script is plain POSIX shell, meant to be read before it is run. It works through one range of slots at a time. For each range it sends the `IMPORTING` commands for every slot to the receiver in one `redis-cli` call, then the `MIGRATING` commands to the donor, then moves the keys of each slot with `MIGRATE` until the donor counts none left, then checks that every slot of the range is empty on the donor, and only then sends the `NODE` commands to the receiver, the donor and the other primaries. Every command has to answer `OK`, and every round of `MIGRATE` has to leave fewer keys than before, or the script stops. A slot never changes owner while the donor still holds a key in it: the donor would drop that key.

Things to know before you run it:

- Run it from a machine that can reach every primary at the addresses `CLUSTER NODES` shows. Set `REDISCLI_AUTH` if the cluster has a password. `MIGRATE` passes `MIGRATE_AUTH` to the receiver, which defaults to `REDISCLI_AUTH`. `CLI`, `BATCH` and `TIMEOUT` can be set the same way.
- A whole range is open, in `IMPORTING` and `MIGRATING`, while its keys move. Clients keep working through `ASK` redirects, but a client library that doesn't follow `ASK` will see errors for those slots until the range is done.
- If the script stops part way, some slots stay open. `redis-cli --cluster fix HOST:PORT` closes them. Then take `CLUSTER NODES` again and plan again.
- Keys go from `GETKEYSINSLOT` to `MIGRATE` one per line, so the script can't move a key with an empty name or a line break in it. It stops at that slot, before the slot changes owner, and says so; move that key by hand, then run `--cluster fix` and plan again.
- A primary that gives away its last slot may become a replica of the primary that took it, or lose its own replica to that primary, when `cluster-allow-replica-migration` is on (the default). It can then refuse the last `SETSLOT NODE` commands: Redis answers that `SETSLOT` is only for primaries, Valkey 8 closes the connection and Valkey 9 answers `NOREPLICAS`. The script then waits up to 30 seconds for the donor to be a replica, or a primary that holds no slot and has none half moved, and goes on only if it is; the cluster tells the donor the new owner. Any other refusal stops the script. Remove the node afterwards with `--cluster del-node` if you meant to.
- Replicas follow their primary. The plan doesn't move replicas between primaries.

## Use it in your own code

In Node:

```js
const R = require('./rebalance/rebalance.js');
const cluster = R.parseClusterNodes(text);
const plan = R.plan(cluster, { drain: ['10.0.0.2:6379'] });
plan.problems;                 // [] when safe
plan.moves;                    // [{ from, to, ranges: [[a, b]], slots }]
R.script(cluster, plan, { cli: 'valkey-cli' });
```

In a page, load `rebalance.js` with a script tag and use `window.KVRebalance`.

## How it was tested

The planner was checked against real clusters in November 2026, on Redis 6.2.24, 7.4.11 and 8.10.2 and Valkey 8.0.11 and 9.1.2, all built from source. For each version, `test/generate/record.py` started seven nodes: three primaries with the slots split the way `--cluster create` splits them, a replica for each, and one primary with no slots. It wrote 4,000 keys of 20 to 10,000 bytes, the 300 biggest under five shared hash tags, then ran three steps on the same cluster:

| Step | What the planner was asked | Slots moved | Script time |
|---|---|---|---|
| add-empty | Balance slot counts, which fills the empty primary | 4,096 | 8 to 26 s |
| by-bytes | Balance by `MEMORY USAGE` of every key | 406 to 418 | 12 to 17 s |
| drain | Drain one of the first primaries, weight 2 for the new one | 3,964 to 3,972 | 23 to 41 s |

Each step ran the script the planner wrote, with that version's own `redis-cli` or `valkey-cli`, waited until every node agreed on who owns each slot, and read every key back from its new owner.

- **The cluster ended where the plan said.** In all 15 steps, the slot owners every node reported afterwards were exactly the owners in the plan, slot for slot.
- **No key was lost or changed.** All 4,000 keys read back with their exact values after every step, and the primaries held 4,000 keys between them.
- **By bytes.** Before the by-bytes step the fullest primary was 26 to 27 percent above its share of the bytes. Afterwards every primary was within 0.1 percent of its target, moving about 6.6 percent of the bytes.
- **Draining.** On all five versions the drained primary ended as a replica of a primary that took its slots. On Valkey 8.0 and 9.1 it refused the last `SETSLOT` commands as it did so, which is why the script accepts a refusal from a donor that is left with nothing.
- **Keys it can't move.** A key with an empty name in slot 0, and a key `{t}a` newline `{t}b`, each in a slot being drained on Redis 7.4.11 (and the empty name on Valkey 9.1.2): the script stopped with exit status 1 at that slot, before it changed owner, and the key was still on the donor with its value. An independent review found that the first version of the script ended such a slot early and let the donor drop the key; that is fixed.

The tests replay the recorded `CLUSTER NODES` output, before and after each step, through the planner. They also cover every slot form and flag of `CLUSTER NODES`, each refusal, weights, draining, the threshold, the cap, byte balance and the script's text. They run without a server.

```sh
node --test rebalance/test/rebalance.test.js
KV_BIN=/opt/kv python3 rebalance/test/generate/record.py   # needs the servers from scripts/build-servers.sh
```

## Limits

- The plan is for the cluster as `CLUSTER NODES` showed it. If slots move in between, plan again.
- Bytes are what you give it. `MEMORY USAGE` per key is the most accurate source, and it misses memory a key doesn't own, such as the server's own overhead per slot.
- A single slot can't be split, so one very large slot, often from a hash tag many keys share, limits how even a byte balance can get.
- It moves slots between primaries that already exist. Adding a node to the cluster (`CLUSTER MEET` or `--cluster add-node`) and removing one come before and after it.

## License

Apache License 2.0. Copyright 2026 KeyValueStore.com. See `LICENSE` and `NOTICE` in the top folder.
