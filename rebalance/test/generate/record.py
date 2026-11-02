# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 KeyValueStore.com
#
# Checks the Cluster Rebalancing Planner against real clusters. For each
# server version it starts seven nodes with cluster mode on: three primaries
# with the slots split the way --cluster create splits them, a replica for
# each, and one primary with no slots. It writes keys of mixed sizes, some
# grouped under hash tags, then runs three steps one after another on the
# same cluster:
#
#   add-empty  balance slot counts, which moves slots onto the empty primary
#   by-bytes   balance by MEMORY USAGE of every key, from --key-sizes
#   drain      drain one primary and give another weight 2
#
# Each step records CLUSTER NODES, runs rebalance/cli.js, runs the script it
# wrote with that version's own redis-cli or valkey-cli, waits until every
# node agrees on who owns each slot, records CLUSTER NODES again, and reads
# back every key from the primary that now owns its slot.
#
# Writes rebalance/test/fixtures/clusters.json.gz.
#
#   KV_BIN=/opt/kv python3 rebalance/test/generate/record.py [version ...]
#
# Temporary folders go under TMPDIR.

import gzip, hashlib, json, os, random, shutil, socket, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
BIN = os.environ.get('KV_BIN', '/opt/kv')
OUT = os.path.join(HERE, '..', 'fixtures', 'clusters.json.gz')
VERSIONS = ['redis-6.2.24', 'redis-7.4.11', 'redis-8.10.2', 'valkey-8.0.11', 'valkey-9.1.2']
SLOTS = 16384


class Conn:
    """RESP over TCP."""
    def __init__(self, port):
        self.s = socket.create_connection(('127.0.0.1', port), timeout=60)
        self.f = self.s.makefile('rb')

    def call(self, *args):
        args = [a if isinstance(a, bytes) else str(a).encode() for a in args]
        self.s.sendall(b''.join([b'*%d\r\n' % len(args)] + [b'$%d\r\n%s\r\n' % (len(a), a) for a in args]))
        r = self.read()
        if isinstance(r, Exception):
            raise r
        return r

    def read(self):
        line = self.f.readline()
        if not line:
            raise ConnectionError('closed')
        t, rest = line[:1], line[1:-2]
        if t == b'+':
            return rest.decode()
        if t == b'-':
            return RuntimeError(rest.decode())
        if t == b':':
            return int(rest)
        if t in (b'$', b'='):
            n = int(rest)
            return None if n < 0 else self.f.read(n + 2)[:-2]
        if t in (b'*', b'%', b'~'):
            n = int(rest)
            return None if n < 0 else [self.read() for _ in range(n * (2 if t == b'%' else 1))]
        if t == b'_':
            return None
        raise ValueError(line)

    def close(self):
        self.s.close()


def text(v):
    return v.decode() if isinstance(v, bytes) else v


def owners(nodes_text):
    """Slot owner ids from CLUSTER NODES, ignoring migrating markers."""
    own = [None] * SLOTS
    for line in nodes_text.strip().splitlines():
        f = line.split()
        if 'master' not in f[2].split(','):
            continue
        for s in f[8:]:
            if s.startswith('['):
                continue
            a, _, b = s.partition('-')
            for x in range(int(a), int(b or a) + 1):
                own[x] = f[0]
    return own


def value(i):
    rnd = random.Random(i)
    if i < 300:
        size = 6000 + rnd.randrange(4000)
    else:
        size = 20 + rnd.randrange(1500)
    return hashlib.sha256(str(i).encode()).hexdigest().encode() * (size // 64 + 1)


def keyname(i):
    # The first 300 keys share five hash tags, so a few slots carry much more
    # than their share and balancing by bytes differs from balancing by count.
    return ('{hot%d}:%d' % (i % 5, i) if i < 300 else 'item:%d' % i).encode()


class Cluster:
    def __init__(self, vid, base):
        self.vid = vid
        d = os.path.join(BIN, vid)
        self.server = [os.path.join(d, f) for f in os.listdir(d) if f.endswith('-server')][0]
        self.cli = [os.path.join(d, f) for f in os.listdir(d) if f.endswith('-cli')][0]
        self.dir = tempfile.mkdtemp(prefix='kvrebal-')
        self.ports = [base + i for i in range(7)]
        self.procs = []
        for p in self.ports:
            nd = os.path.join(self.dir, str(p))
            os.mkdir(nd)
            log = open(os.path.join(nd, 'out.log'), 'wb')
            self.procs.append(subprocess.Popen([self.server, '--port', str(p), '--bind', '127.0.0.1', '--dir', nd,
                                                '--cluster-enabled', 'yes', '--cluster-config-file', 'nodes.conf',
                                                '--cluster-node-timeout', '5000', '--save', '', '--appendonly', 'no'],
                                               stdout=log, stderr=subprocess.STDOUT, cwd=nd))
        self.c = {}
        for p in self.ports:
            for _ in range(500):
                try:
                    self.c[p] = Conn(p)
                    self.c[p].call('PING')
                    break
                except (OSError, RuntimeError):
                    time.sleep(0.02)
            else:
                raise RuntimeError(vid + ': node %d did not start' % p)

    def stop(self):
        for c in self.c.values():
            c.close()
        for p in self.procs:
            p.terminate()
        for p in self.procs:
            try:
                p.wait(10)
            except subprocess.TimeoutExpired:
                p.kill()
        shutil.rmtree(self.dir, ignore_errors=True)

    def myid(self, p):
        return text(self.c[p].call('CLUSTER', 'MYID'))

    def nodes(self, p=None):
        return text(self.c[p or self.ports[0]].call('CLUSTER', 'NODES'))

    def form(self):
        primaries, replicas, empty = self.ports[:3], self.ports[3:6], self.ports[6]
        ranges = [(0, 5460), (5461, 10922), (10923, 16383)]
        for p, (a, b) in zip(primaries, ranges):
            self.c[p].call('CLUSTER', 'ADDSLOTS', *range(a, b + 1))
        for p in self.ports[1:]:
            self.c[p].call('CLUSTER', 'MEET', '127.0.0.1', self.ports[0])
        self.wait(lambda: all(len(self.nodes(p).strip().splitlines()) == 7 for p in self.ports), 'meet')
        for r, p in zip(replicas, primaries):
            self.c[r].call('CLUSTER', 'REPLICATE', self.myid(p))
        self.wait(lambda: self.settled() and all(sum(1 for l in self.nodes(p).strip().splitlines() if 'slave' in l.split()[2]) == 3
                                                 for p in self.ports), 'form')
        self.empty = empty
        self.primaries = primaries

    def wait(self, ok, what, limit=120):
        end = time.time() + limit
        while time.time() < end:
            try:
                if ok():
                    return
            except (OSError, RuntimeError):
                pass
            time.sleep(0.2)
        for p in self.ports:
            try:
                sys.stderr.write('--- %d\n%s\n' % (p, self.nodes(p)))
            except (OSError, RuntimeError) as e:
                sys.stderr.write('--- %d: %s\n' % (p, e))
        raise RuntimeError(self.vid + ': timed out waiting for ' + what)

    def settled(self):
        """Every node reports cluster_state:ok, the same owner for every slot,
        no open slots and no node marked failing. A primary drained of every
        slot may turn into a replica (Redis 7.0 and later move it under the
        node that took its last slot), so replicas are not counted."""
        views = []
        for p in self.ports:
            info = text(self.c[p].call('CLUSTER', 'INFO'))
            if 'cluster_state:ok' not in info:
                return False
            t = self.nodes(p)
            if '->-' in t or '-<-' in t:
                return False
            views.append(owners(t))
            if any('fail' in l.split()[2] or 'handshake' in l.split()[2] for l in t.strip().splitlines()):
                return False
        return all(v == views[0] for v in views) and None not in views[0]

    def write(self, n):
        # Each key goes straight to the primary that owns its slot.
        own = owners(self.nodes())
        port_of = self.port_map()
        for i in range(n):
            k = keyname(i)
            self.c[port_of[own[self.slot(k)]]].call('SET', k, value(i))

    def port_map(self):
        m = {}
        for line in self.nodes().strip().splitlines():
            f = line.split()
            m[f[0]] = int(f[1].split('@')[0].rsplit(':', 1)[1])
        return m

    def slot(self, k):
        return self.c[self.ports[0]].call('CLUSTER', 'KEYSLOT', k)

    def key_sizes(self, n):
        own = owners(self.nodes())
        port_of = self.port_map()
        lines = []
        for i in range(n):
            k = keyname(i)
            size = self.c[port_of[own[self.slot(k)]]].call('MEMORY', 'USAGE', k)
            lines.append('%s %d' % (k.decode(), size))
        return '\n'.join(lines) + '\n'

    def read_back(self, n):
        own = owners(self.nodes())
        port_of = self.port_map()
        ok, bad = 0, []
        for i in range(n):
            k = keyname(i)
            got = self.c[port_of[own[self.slot(k)]]].call('GET', k)
            if got == value(i):
                ok += 1
            else:
                bad.append(k.decode())
        total = sum(self.c[p].call('DBSIZE') for p in self.ports if p in self.primary_ports())
        return ok, bad[:20], total

    def primary_ports(self):
        out = []
        port_of = self.port_map()
        for line in self.nodes().strip().splitlines():
            f = line.split()
            if 'master' in f[2].split(','):
                out.append(port_of[f[0]])
        return out


def ref(cluster, port):
    return '127.0.0.1:%d' % port


def run_step(cl, name, args, n, scratch, sizes=None):
    before = cl.nodes()
    nodes_file = os.path.join(scratch, name + '.nodes')
    open(nodes_file, 'w').write(before)
    argv = ['node', os.path.join(ROOT, 'rebalance', 'cli.js'), nodes_file, '--json', '--script', os.path.join(scratch, name + '.sh')] + args
    if sizes is not None:
        sf = os.path.join(scratch, name + '.sizes')
        open(sf, 'w').write(sizes)
        argv += ['--key-sizes', sf]
    planned = subprocess.run(argv, capture_output=True, text=True)
    if planned.returncode != 0:
        raise RuntimeError(cl.vid + ' ' + name + ': planner exit %d: %s' % (planned.returncode, planned.stderr + planned.stdout))
    plan = json.loads(planned.stdout)
    t0 = time.time()
    env = dict(os.environ, CLI=cl.cli)
    ran = subprocess.run(['sh', os.path.join(scratch, name + '.sh')], capture_output=True, text=True, env=env)
    if ran.returncode != 0:
        raise RuntimeError(cl.vid + ' ' + name + ': script exit %d: %s' % (ran.returncode, ran.stderr[-2000:]))
    seconds = time.time() - t0
    cl.wait(cl.settled, name)
    after = cl.nodes()
    ok, bad, total = cl.read_back(n)
    return {
        'name': name, 'args': args, 'nodesBefore': before, 'keySizes': sizes, 'nodesAfter': after,
        'planned': {'movedSlots': plan.get('movedSlots', 0), 'moves': [{'from': m['fromNode'], 'to': m['toNode'], 'slots': m['slots']} for m in plan['moves']]},
        'scriptSeconds': round(seconds, 1), 'keys': n, 'readBack': ok, 'wrong': bad, 'keysOnPrimaries': total,
    }


def record(vid, base):
    n = 4000
    cl = Cluster(vid, base)
    scratch = tempfile.mkdtemp(prefix='kvrebal-plan-')
    try:
        cl.form()
        cl.write(n)
        steps = []
        steps.append(run_step(cl, 'add-empty', [], n, scratch))
        steps.append(run_step(cl, 'by-bytes', [], n, scratch, sizes=cl.key_sizes(n)))
        steps.append(run_step(cl, 'drain', ['--drain', ref(cl, cl.primaries[1]), '--weight', ref(cl, cl.empty) + '=2'], n, scratch))
        version = text(cl.c[cl.ports[0]].call('INFO', 'server'))
        ver = [l.split(':', 1)[1].strip() for l in version.splitlines() if l.startswith(('redis_version:', 'valkey_version:'))]
        return {'version': vid, 'serverVersion': ver[-1] if ver else '', 'steps': steps}
    finally:
        cl.stop()
        shutil.rmtree(scratch, ignore_errors=True)


def save(old):
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    rows = [old[v] for v in VERSIONS if v in old] + [old[v] for v in sorted(old) if v not in VERSIONS]
    with gzip.open(OUT, 'wt') as f:
        json.dump(rows, f, indent=1)


def main():
    versions = sys.argv[1:] or VERSIONS
    old = {}
    if os.path.exists(OUT):
        for r in json.load(gzip.open(OUT, 'rt')):
            old[r['version']] = r
    for i, v in enumerate(versions):
        t = time.time()
        r = record(v, 21000 + 20 * VERSIONS.index(v) if v in VERSIONS else 21000 + 20 * i)
        old[v] = r
        save(old)
        print('%s: %s' % (v, ', '.join('%s %d slots, %d/%d keys read back' % (s['name'], s['planned']['movedSlots'], s['readBack'], s['keys']) for s in r['steps'])),
              '(%.0f s)' % (time.time() - t), flush=True)


if __name__ == '__main__':
    main()
