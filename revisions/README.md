# Revision Viewer

Open an etcd snapshot, or a member's own database file, and see what fills it: how close it is to the quota, which keys and Kubernetes resources take the space, how much is old revisions that compaction would remove, how much is free pages that a defrag would give back, Secrets stored in the clear, leases, members and alarms. Pick any key to see every revision the file keeps and what changed in each. Kubernetes objects show the way `kubectl get -o yaml` shows them.

Try it in your browser at https://keyvaluestore.com/tools/revisions/, or open `revisions/app/index.html` from a copy of this repository.

Its logic is one JavaScript file, `revisions.js`, with no dependencies. The web page, the command line and the tests all load it. `kubernetes.js` holds the field names of every kind of object Kubernetes keeps in etcd; without it, objects show their protobuf field numbers instead.

## What etcd keeps

etcd is the database behind Kubernetes. Every object in a cluster, from each Pod to each Secret, is a key in etcd under `/registry/`, and kube-apiserver is the only thing that reads and writes it.

etcd never overwrites a value. Each write adds a new **revision** of the key and leaves the old one where it was, so a client can read the past or watch every change. The old revisions stay until **compaction** removes them. kube-apiserver compacts every five minutes, so a healthy cluster's etcd holds about five minutes of history, but a busy key can pile up many revisions in that time: a node's heartbeat lease changes every ten seconds.

Compaction frees space inside the file without making the file smaller. The space becomes **free pages** that etcd reuses for new writes. Only **defragmenting** a member gives them back to the disk.

All of this counts toward the **quota**, 2 GiB unless the cluster sets `--quota-backend-bytes`. When the database reaches it, etcd raises the NOSPACE alarm and takes only reads and deletes until someone compacts, defragments and clears the alarm. For a Kubernetes cluster that means nothing can change: no new Pods, no updated leases, no events.

The data lives in one file, `member/snap/db` in each member's data folder, in a format called bbolt: fixed-size pages holding B+trees. `etcdctl snapshot save` writes a copy of it with a SHA-256 hash at the end. That copy is what backups keep, and it is what this tool reads.

## What the viewer shows

- **What to look at.** The NOSPACE and CORRUPT alarms, a database near its quota, a hash that doesn't match, Secrets stored in the clear, values over 1 MiB (etcd refuses requests over 1.5 MiB by default), and the usual causes of a big database: free pages, old revisions, events and managedFields taking a large share.
- **Where the space goes.** The database split into current values, old revisions and deletions, bbolt's page structure and half-filled pages, and free pages.
- **Kubernetes resources and kinds.** Space per resource, now and in old revisions, and per kind, with how much of it is managedFields.
- **Key prefixes.** Keys grouped by the first parts of their names, to drill into.
- **The biggest keys and the keys with the most revisions.**
- **Members, alarms, authentication, leases,** and which etcd version wrote the file.
- **Every revision of a key** the file keeps, each with its value and the lines that changed from the one before.

Kubernetes objects are stored as protobuf, which no person can read. The viewer decodes them with Kubernetes' own field names and prints them as kubectl prints them, so two revisions of an object differ by the lines that changed. Custom resources are stored as JSON and show the same way. Secrets encrypted at rest show only the provider and key name, since the key isn't in the file.

## Use it in the browser

1. **Open a file.** Drop a snapshot on the page or choose one. The file is read in your browser and never leaves it.
2. **Set the quota** if your cluster runs with a `--quota-backend-bytes` other than the 2 GiB default.
3. **Read what to look at**, then the space by resource, kind and prefix. Pick a resource or a prefix to list its keys.
4. **Pick a key** to see its revisions. Pick a revision to see its value, or the changes from the revision before it.

**Download every key as CSV** gives each key with its size, revisions, lease and kind. **Download the report as JSON** gives everything on the page.

## Use it from the command line

```sh
node revisions/cli.js backup.db
node revisions/cli.js backup.db --quota 8GiB --top 40
node revisions/cli.js backup.db --history /registry/leases/kube-node-lease/node-1
node revisions/cli.js backup.db --value /registry/pods/shop/web-0 --revision 2841
node revisions/cli.js backup.db --keys > keys.csv
```

| Option | Meaning |
|---|---|
| `--keys` | Every key as CSV: key, live, revisions, bytes, bytes in old revisions, create and mod revision, version, lease, kind |
| `--prefixes` | Space by key prefix as CSV; `--depth N` sets how many levels make a prefix, `--under PREFIX` looks inside one |
| `--history KEY` | Every revision of the key the file keeps, the first in full and each one after as the lines that changed |
| `--value KEY` | The key's value; with `--revision N`, the value it had at revision N |
| `--quota SIZE` | The cluster's `--quota-backend-bytes`, such as `8GiB` (default 2 GiB) |
| `--top N` | How many resources, prefixes and keys the summary lists (default 20) |
| `--json` | Print JSON |

Exit status: 0; 1 when an alarm is raised, the database is at 95% of its quota or more, the hash at the end doesn't match, or the key isn't there; 2 when the file can't be read. A backup job can check each snapshot it saves.

To get a file: `etcdctl snapshot save backup.db` on a machine that can reach etcd. On a kubeadm control plane node that is

```sh
ETCDCTL_API=3 etcdctl --endpoints https://127.0.0.1:2379 --cacert /etc/kubernetes/pki/etcd/ca.crt \
  --cert /etc/kubernetes/pki/etcd/server.crt --key /etc/kubernetes/pki/etcd/server.key snapshot save backup.db
```

A snapshot holds every Secret in the cluster that isn't encrypted at rest, so keep it as safe as the cluster's credentials.

## Use it in your own code

```js
const R = require('./revisions/revisions.js');
const snap = R.read(new Uint8Array(fs.readFileSync('backup.db')));
R.findings(snap, 8 * R.GiB); // [{ level, code, title, text }], worst first
R.report(snap);             // everything above, as plain data
R.history(snap, '/registry/pods/shop/web-0'); // [{ revision, version, deleted, value, ... }]
R.valueText(value);         // a value as text: a Kubernetes object as kubectl shows it
R.kubernetesObject(value);  // { apiVersion, kind, object }, the object as JSON data
```

In a page, load `kubernetes.js` and then `revisions.js` with script tags and use `window.KVRevisions`.

## How it was tested

The viewer was checked against real etcd servers, etcd's own tools and Kubernetes' own code. `test/generate/make-snapshots.py` runs etcd 3.6.15, 3.5.34 and 3.4.45 and fills each the way a Kubernetes cluster does: Pods, Nodes, Deployments, Services, leases renewed every ten seconds, events on an hour's lease, Secrets in the clear and encrypted at rest, custom resources. The objects are encoded by Kubernetes 1.37.1's own Go packages, exactly as kube-apiserver stores them. Then it compacts, writes more history, deletes some keys and saves snapshots.

- **etcd's figures.** For each snapshot, the viewer gives the same hash, size, revision and key count that `etcdutl snapshot status` prints (`etcdctl` for 3.4), and the same free pages and page counts as bbolt's own command line.
- **Keys and revisions.** Every live key matches what `etcdctl get` returns: value, create and mod revision, version and lease. Every older revision etcd could still serve for three busy keys is in the history with the same value.
- **Special cases.** A database that filled its 1 MiB quota and raised NOSPACE, a member's own database file with no hash at the end, authentication switched on, a changed byte and a cut file.
- **Kubernetes objects.** All 141 objects in the snapshot, 27 kinds, decode to the same JSON that Kubernetes' Go packages make of the same bytes. 139 print as YAML byte for byte as kubectl prints them. kubectl itself cannot print the other two.
- **YAML.** 240 more objects full of awkward strings, with quotes, line breaks, long lines, odd characters and keys that look like numbers, all print exactly as kubectl prints them.
- **Size.** A 198 MiB snapshot with 250,000 revisions opens in about two seconds on the command line and three in the browser.

The fixtures and recorded answers are in `test/fixtures/`, and the tests replay them, so they run without etcd or Kubernetes:

```sh
node --test revisions/test/revisions.test.js
```

`test/generate/k8scodec` is the small Go program that encodes and decodes Kubernetes objects with Kubernetes' own packages; it also lists the fields that `test/generate/make-schema.js` turns into `kubernetes.js`. `test/generate/measure.js` writes the counts to `test/results/etcd-and-kubernetes.json`.

## Limits

- **The whole file is read into memory.** A browser tab copes with a few hundred megabytes; for bigger files the command line is the safer choice, and it reads any file the machine has the memory for.
- **The stored object, not the served one.** kube-apiserver fills in defaults when it reads an object, so `kubectl get` can show fields that the stored object doesn't have. The viewer shows what is in the file.
- **Kinds outside Kubernetes 1.37.1.** Objects of a kind `kubernetes.js` doesn't list, such as protobuf types added by an aggregated API server, show their protobuf field numbers. Fields added in later Kubernetes versions are left out of objects of known kinds.
- **Where kubectl itself goes wrong.** kubectl refuses to print an object with certain control characters, or with a line break in a map key; the viewer prints them with escapes. kubectl's key order for some sets of keys that mix digits and letters, such as `1a`, `9a` and `10a`, goes round in a circle, so its order changes from run to run; the viewer picks one.
- **Only etcd 3.** etcd 2's data and its v2 store are a different format.

## License

Apache License 2.0. Copyright 2026 KeyValueStore.com. See `LICENSE` and `NOTICE` in the top folder. `kubernetes.js` is made from the Kubernetes project's API definitions, Apache License 2.0, Copyright The Kubernetes Authors.

etcd and Kubernetes are trademarks of The Linux Foundation. They're named only to say which systems the tool works with, and KeyValueStore.com isn't connected with or endorsed by The Linux Foundation or the Cloud Native Computing Foundation.
