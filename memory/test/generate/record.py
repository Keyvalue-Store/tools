# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 KeyValueStore.com
#
# Writes keys of many shapes to each built server and records how much
# used_memory grew, for the tests to replay through memory.js. Each case
# starts from an empty database, writes its keys from a connection of its
# own, closes it, waits until the server has settled (no rehashing left),
# and reads INFO memory again. It also records what chance decided: how
# many keys shared a bucket in Redis's tables, how many child buckets
# Valkey's tables needed.
#
# Writes test/fixtures/runs.json.gz.
#
#   KV_BIN=/opt/kv python3 memory/test/generate/record.py [version ...]
#
# KV_SCALE scales the number of random cases, KV_KINDS picks the kinds
# (strings,keys,hashes,sets,zsets,lists,mixed,settings) and KV_JOBS the
# number of servers run at once.

import gzip, json, os, random, re, shutil, socket, subprocess, sys, tempfile, time
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
BIN = os.environ.get('KV_BIN', '/opt/kv')
OUT = os.path.join(HERE, '..', 'fixtures', 'runs.json.gz')
SCALE = float(os.environ.get('KV_SCALE', '1'))
KINDS = os.environ.get('KV_KINDS', 'strings,keys,hashes,sets,zsets,lists,mixed,settings').split(',')
VERSIONS = ['redis-6.2.24', 'redis-7.0.15', 'redis-7.2.16', 'redis-7.4.11', 'redis-8.0.6', 'redis-8.2.10',
            'redis-8.4.7', 'redis-8.6.7', 'redis-8.8.3', 'redis-8.10.2', 'valkey-7.2.14', 'valkey-8.0.11',
            'valkey-8.1.10', 'valkey-9.0.6', 'valkey-9.1.2']
TTL = '1000000'


def b(s):
    return s if isinstance(s, bytes) else str(s).encode('latin-1')


class Conn:
    """RESP over a Unix socket."""
    def __init__(self, path):
        self.s = socket.socket(socket.AF_UNIX)
        self.s.settimeout(120)
        self.s.connect(path)
        self.f = self.s.makefile('rb')

    @staticmethod
    def pack(args):
        args = [b(a) for a in args]
        return b''.join([b'*%d\r\n' % len(args)] + [b'$%d\r\n%s\r\n' % (len(a), a) for a in args])

    def call(self, *args):
        self.s.sendall(self.pack(args))
        r = self.read()
        if isinstance(r, Exception):
            raise r
        return r

    def pipeline(self, cmds):
        out = []
        batch, size = [], 0
        for c in cmds:
            data = self.pack(c)
            batch.append(data)
            size += len(data)
            if len(batch) >= 1000 or size >= 1 << 20:
                self.s.sendall(b''.join(batch))
                out += [self.read() for _ in batch]
                batch, size = [], 0
        if batch:
            self.s.sendall(b''.join(batch))
            out += [self.read() for _ in batch]
        for r in out:
            if isinstance(r, Exception):
                raise r
        return out

    def read(self):
        line = self.f.readline()
        if not line:
            raise ConnectionError('closed')
        t, rest = line[:1], line[1:-2]
        if t == b'+':
            return rest.decode('latin-1')
        if t == b'-':
            return RuntimeError(rest.decode('latin-1'))
        if t == b':':
            return int(rest)
        if t in (b'$', b'='):
            n = int(rest)
            return None if n < 0 else self.f.read(n + 2)[:-2].decode('latin-1')
        if t in (b'*', b'%', b'>', b'~'):
            n = int(rest)
            return None if n < 0 else [self.read() for _ in range(n * (2 if t == b'%' else 1))]
        if t == b'_':
            return None
        raise ValueError(line)

    def quit(self):
        """QUIT, then wait until the server has closed the connection, which
        it does after freeing the client."""
        self.s.sendall(self.pack(['QUIT']))
        try:
            while self.s.recv(65536):
                pass
        except OSError:
            pass
        self.s.close()


class Server:
    def __init__(self, vid):
        self.vid = vid
        self.server, rest = vid.split('-')
        self.num = tuple(int(x) for x in rest.split('.')[:2])
        binary = [os.path.join(BIN, vid, f) for f in os.listdir(os.path.join(BIN, vid)) if f.endswith('-server')][0]
        self.d = tempfile.mkdtemp(prefix='kvmem-')
        self.sock = os.path.join(self.d, 's.sock')
        args = [binary, '--port', '0', '--unixsocket', self.sock, '--dir', self.d, '--save', '', '--appendonly', 'no',
                '--slowlog-log-slower-than', '-1', '--hz', '100']
        if self.num >= (7, 0) or self.server == 'valkey':
            args += ['--enable-debug-command', 'yes']
        if self.server == 'redis' and self.num >= (8, 4) and os.environ.get('KV_IOTHREADS', '1') == '1':
            # Redis 8.4 keeps parsed commands in a shared pool for reuse when
            # it has no I/O threads, which holds more or less memory depending
            # on the commands that went before. With I/O threads it frees them.
            args += ['--io-threads', '2']
        if self.server == 'valkey' and self.num >= (8, 1):
            # Valkey 8.1 also logs commands with requests or replies over 1 MB.
            args += ['--commandlog-request-larger-than', '-1', '--commandlog-reply-larger-than', '-1']
        self.log = open(os.path.join(self.d, 'out.log'), 'wb')
        self.p = subprocess.Popen(args, stdout=self.log, stderr=subprocess.STDOUT, cwd=self.d)
        self.m = None
        try:
            for _ in range(2000):
                if os.path.exists(self.sock) or self.p.poll() is not None:
                    break
                time.sleep(0.005)
            for _ in range(500):
                try:
                    c = Conn(self.sock)
                    c.call('PING')
                    c.s.close()
                    break
                except (ConnectionError, OSError):
                    time.sleep(0.01)
            self.m = Conn(self.sock)
            self.startup = self.used()
        except BaseException:
            self.stop()
            raise

    def is_redis(self, at_least=None):
        return self.server == 'redis' and (at_least is None or self.num >= at_least)

    def conn(self):
        return Conn(self.sock)

    def used(self):
        info = self.m.call('INFO', 'memory')
        return int(re.search(r'used_memory:(\d+)', info).group(1))

    def full(self):
        """DEBUG HTSTATS and HTSTATS-KEY take 'full' from 7.2."""
        return [] if self.server == 'redis' and self.num < (7, 2) else ['full']

    def stop(self):
        try:
            if self.m:
                self.m.s.close()
        except OSError:
            pass
        if self.p.poll() is None:
            self.p.kill()
        self.p.wait()
        self.log.close()
        shutil.rmtree(self.d, ignore_errors=True)


# ---- hash table statistics ----

def parse_table(text):
    """The main table of a DEBUG HTSTATS section, and whether it's rehashing."""
    out = {'rehashing': 'Hash table 1 stats' in text}
    m = re.search(r'rehashing index: (-?\d+)', text)
    if m and int(m.group(1)) >= 0:
        out['rehashing'] = True
    main = text.split('Hash table 1 stats')[0]
    for name, pat in (('size', r'table size: (\d+)'), ('n', r'number of (?:elements|entries): (\d+)'),
                      ('nonEmpty', r'different slots: (\d+)'), ('buckets', r'top-level buckets: (\d+)'),
                      ('children', r'child buckets: (\d+)')):
        m = re.search(pat, main)
        if m:
            out[name] = int(m.group(1))
    if 'No stats available' in main:
        out['n'] = 0
    return out


def keyspace(srv):
    text = srv.m.call('DEBUG', 'HTSTATS', '0', *srv.full())
    parts = text.split('[Expires HT]')
    return parse_table(parts[0]), parse_table(parts[1] if len(parts) > 1 else '')


def full_table(t):
    """A table serverCron may still double: a full Redis dict (7.4+, Valkey
    8.0) or a Valkey hashtable with 7 keys in each bucket."""
    if not t.get('n'):
        return False
    if 'buckets' in t:
        return t['n'] >= 7 * t['buckets']
    return t['n'] >= t.get('size', 0)


def settle_keyspace(srv):
    """Wait until both tables of db 0 are rehashed and serverCron has
    nothing more to do to them. serverCron runs every 10 ms (hz 100)."""
    time.sleep(0.025)
    last, same = None, 0
    for _ in range(3000):
        k, e = keyspace(srv)
        busy = k['rehashing'] or e['rehashing']
        if not busy and not full_table(k) and not full_table(e):
            return k, e
        state = (k.get('size'), k.get('buckets'), e.get('size'), e.get('buckets'), busy)
        if not busy and state == last:
            same += 1
            if same >= 4:
                return k, e
        else:
            same = 0
        last = state
        time.sleep(0.012)
    raise RuntimeError('keyspace never settled')


def flushall(srv):
    """FLUSHALL SYNC, run inside MULTI: from Redis 7.4 a FLUSHALL SYNC on
    its own swaps in new tables and frees the old ones in a background
    thread, and the client is told OK when that's done. Inside MULTI the
    client can't wait, so the server empties the tables there and then."""
    srv.m.call('MULTI')
    srv.m.call('FLUSHALL', 'SYNC')
    r = srv.m.call('EXEC')
    if r != ['OK']:
        raise RuntimeError('FLUSHALL in MULTI: %r' % (r,))


def settle_empty(srv):
    """After FLUSHALL, Valkey 8.1+ frees the keyspace tables and serverCron
    gives each an empty bucket again within a few runs. Wait for that, so
    every case starts with one bucket in each table. Redis 8.2 keeps 16
    bytes the first time DEBUG HTSTATS looks at an emptied database, so
    look once now."""
    keyspace(srv)
    if srv.server != 'valkey' or srv.num < (8, 1):
        return
    time.sleep(0.04)
    last = srv.used()
    for _ in range(100):
        time.sleep(0.012)
        now = srv.used()
        if now == last:
            return
        last = now
    raise RuntimeError('empty database never settled')


LOOKUP = {'hash': 'HEXISTS', 'set': 'SISMEMBER', 'zset': 'ZSCORE'}


def settle_value(srv, c, key, typ):
    """Finish a value's own rehashing with lookups (nothing else moves it on)
    and return its table's statistics."""
    for _ in range(100000):
        st = parse_table(c.call('DEBUG', 'HTSTATS-KEY', key, *srv.full()))
        if not st['rehashing']:
            return st
        c.pipeline([[LOOKUP[typ], key, '\x01absent']] * 64)
    raise RuntimeError('value never settled')


# ---- names and values ----

ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'


def b62(i):
    s = ''
    while True:
        s = ALNUM[i % 62] + s
        i //= 62
        if i == 0:
            return s


def key_name(g, i, K):
    """Key i of group g, K bytes long, distinct from every other."""
    if K == 1 and i == 0:
        return LETTERS[g]
    s = LETTERS[g] + b62(i)
    if len(s) > K:
        raise ValueError('key too short')
    return s[0] + ':' * (K - len(s)) + s[1:]


def key_capacity(K):
    return 0 if K < 1 else 62 ** (K - 1)


def text(i, L):
    """Distinct text i of L bytes; never a number."""
    if L == 0:
        if i:
            raise ValueError('only one empty string')
        return ''
    rest = b62(i // 52)
    if len(rest) > L - 1:
        if L == 1 and i < 52:
            return LETTERS[i]
        raise ValueError('text too short')
    return LETTERS[i % 52] + ':' * (L - 1 - len(rest)) + rest if L > 1 else LETTERS[i]


def text_capacity(L):
    return 1 if L == 0 else 52 if L == 1 else 52 * 62 ** (L - 1)


def same_value(e):
    return e['int'] if 'int' in e else 'v' * e['len']


def distinct(e, n):
    if 'int' in e:
        a = int(e['int'])
        return [str(a + i) for i in range(n)]
    return [text(i, e['len']) for i in range(n)]


def fits(g):
    """Can the group be written with distinct names?"""
    if g['count'] > key_capacity(g['key']) or g['count'] > 1 and g['key'] < 2:
        return False
    for name, count in (('field', 'fields'), ('member', 'members')):
        e = g.get(name)
        if e is None:
            continue
        if 'int' in e:
            if int(e['int']) + g[count] - 1 > 2 ** 63 - 1:
                return False
        elif g[count] > text_capacity(e['len']):
            return False
    return True


# ---- writing a case ----

def group_commands(gi, g):
    """The commands that write group gi, key by key."""
    for i in range(g['count']):
        k = key_name(gi, i, g['key'])
        ttl = i < g.get('ttlCount', 0)
        t, once = g['type'], g.get('writes', 'once') != 'each'
        cmds = []
        if t == 'string':
            v = same_value(g['value'])
            if ttl and g.get('ttlMode', 'ex') == 'ex':
                cmds.append(['SET', k, v, 'EX', TTL])
            else:
                cmds.append(['SET', k, v])
        elif t == 'hash':
            v = same_value(g['value'])
            fs = distinct(g['field'], g['fields'])
            if once:
                cmds.append(['HSET', k] + [x for f in fs for x in (f, v)])
            else:
                cmds += [['HSET', k, f, v] for f in fs]
        elif t == 'set':
            ms = distinct(g['member'], g['members'])
            cmds += [['SADD', k] + ms] if once else [['SADD', k, m] for m in ms]
        elif t == 'zset':
            ms = distinct(g['member'], g['members'])
            s = g.get('score', '0')
            cmds += [['ZADD', k] + [x for m in ms for x in (s, m)]] if once else [['ZADD', k, s, m] for m in ms]
        elif t == 'list':
            v = same_value(g['item'])
            n = g['items']
            cmds += [['RPUSH', k] + [v] * n] if once else [['RPUSH', k, v] for _ in range(n)]
        if ttl and (t != 'string' or g.get('ttlMode', 'ex') == 'expire'):
            cmds.append(['EXPIRE', k, TTL])
        yield k, cmds


def big(cmd):
    return any(len(b(a)) >= 32768 for a in cmd)


CONFIG_62 = {'hashMaxListpackEntries': 'hash-max-ziplist-entries', 'hashMaxListpackValue': 'hash-max-ziplist-value',
             'zsetMaxListpackEntries': 'zset-max-ziplist-entries', 'zsetMaxListpackValue': 'zset-max-ziplist-value',
             'listMaxListpackSize': 'list-max-ziplist-size'}
CONFIG = {'hashMaxListpackEntries': 'hash-max-listpack-entries', 'hashMaxListpackValue': 'hash-max-listpack-value',
          'setMaxIntsetEntries': 'set-max-intset-entries', 'setMaxListpackEntries': 'set-max-listpack-entries',
          'setMaxListpackValue': 'set-max-listpack-value', 'zsetMaxListpackEntries': 'zset-max-listpack-entries',
          'zsetMaxListpackValue': 'zset-max-listpack-value', 'listMaxListpackSize': 'list-max-listpack-size',
          'maxmemoryPolicy': 'maxmemory-policy'}
DEFAULTS = {'hashMaxListpackEntries': '512', 'hashMaxListpackValue': '64', 'setMaxIntsetEntries': '512',
            'setMaxListpackEntries': '128', 'setMaxListpackValue': '64', 'zsetMaxListpackEntries': '128',
            'zsetMaxListpackValue': '64', 'listMaxListpackSize': '-2', 'maxmemoryPolicy': 'noeviction'}


def config_name(srv, name):
    if srv.is_redis() and srv.num == (6, 2):
        return CONFIG_62.get(name) or ('set-max-intset-entries' if name == 'setMaxIntsetEntries' else
                                      'maxmemory-policy' if name == 'maxmemoryPolicy' else None)
    if name.startswith('setMaxListpack') and srv.is_redis() and srv.num < (7, 2):
        return None
    return CONFIG[name]


def apply_settings(srv, settings, restore=False):
    for name, value in (settings or {}).items():
        cn = config_name(srv, name)
        if cn is None:
            continue
        v = DEFAULTS[name] if restore else str(value)
        if name == 'maxmemoryPolicy':
            # A policy only counts with a limit.
            srv.m.call('CONFIG', 'SET', 'maxmemory', '0' if restore or v == 'noeviction' else '4gb')
        srv.m.call('CONFIG', 'SET', cn, v)


def run_case(srv, case):
    """Run a case until used_memory goes back to where it started after
    FLUSHALL: now and then the server frees or allocates a few bytes of its
    own in the middle of a case, and that case is run again."""
    for attempt in range(5):
        out = run_once(srv, case)
        if out.pop('back') == 0:
            if attempt:
                out['tries'] = attempt + 1
            return out
    raise RuntimeError('used_memory keeps moving around this case')


def run_once(srv, case):
    apply_settings(srv, case.get('settings'))
    before = srv.used()
    c = srv.conn()
    encodings, observed = [], []
    for gi, g in enumerate(case['groups']):
        keys, pending = [], []
        for k, cmds in group_commands(gi, g):
            keys.append(k)
            for cmd in cmds:
                if big(cmd):
                    if pending:
                        c.pipeline(pending)
                        pending = []
                    c.call(*cmd)
                else:
                    pending.append(cmd)
            if len(pending) >= 2000:
                c.pipeline(pending)
                pending = []
        if pending:
            c.pipeline(pending)
        enc = c.call('OBJECT', 'ENCODING', keys[0]) if keys else None
        encodings.append(enc)
        obs = {}
        if enc in ('hashtable', 'skiplist') and g['type'] != 'string':
            coll = children = 0
            for k in keys:
                st = settle_value(srv, c, k, g['type'])
                coll += st['n'] - st.get('nonEmpty', st['n'])
                children += st.get('children', 0)
            obs = {'collisions': coll, 'children': children}
        observed.append(obs)
    c.quit()
    k, e = settle_keyspace(srv)
    after = srv.used()
    flushall(srv)
    settle_empty(srv)
    back = srv.used() - before
    apply_settings(srv, case.get('settings'), restore=True)
    out = dict(case)
    out['back'] = back
    out['delta'] = after - before
    out['enc'] = encodings
    out['obs'] = observed
    out['keys'] = {x: k[x] for x in ('size', 'n', 'nonEmpty', 'buckets', 'children') if x in k}
    out['expires'] = {x: e[x] for x in ('size', 'n', 'nonEmpty', 'buckets', 'children') if x in e}
    return out


def warm_up(srv):
    """Run every command the cases use once: the first call of a command
    allocates its latency histogram, which must not count."""
    if srv.server == 'valkey' or srv.num >= (7, 0):
        srv.m.call('DEBUG', 'REPLYBUFFER', 'RESIZING', '0')
    srv.m.call('DEBUG', 'HTSTATS', '0', *srv.full())
    srv.m.call('CONFIG', 'SET', 'maxmemory', '0')
    srv.m.call('CONFIG', 'SET', 'maxmemory-policy', 'noeviction')
    case = {'groups': [
        {'type': 'string', 'count': 2, 'key': 4, 'value': {'len': 3}, 'ttlCount': 2, 'ttlMode': 'expire'},
        {'type': 'string', 'count': 1, 'key': 4, 'value': {'len': 40000}, 'ttlCount': 1, 'ttlMode': 'ex'},
        {'type': 'hash', 'count': 1, 'key': 4, 'fields': 600, 'field': {'len': 4}, 'value': {'len': 80}, 'ttlCount': 1},
        {'type': 'set', 'count': 1, 'key': 4, 'members': 300, 'member': {'len': 4}},
        {'type': 'zset', 'count': 1, 'key': 4, 'members': 300, 'member': {'len': 4}, 'score': '1'},
        {'type': 'list', 'count': 1, 'key': 4, 'items': 3, 'item': {'len': 2}}]}
    # Commands a case may need only now and then.
    c = srv.conn()
    for cmd in (['HEXISTS', 'x', 'y'], ['SISMEMBER', 'x', 'y'], ['ZSCORE', 'x', 'y'], ['OBJECT', 'ENCODING', 'x'],
                ['DEBUG', 'HTSTATS-KEY', 'x'], ['SET', 'x', 'y', 'EX', '100'], ['EXPIRE', 'x', '100'], ['RPUSH', 'l', 'a'],
                ['HSET', 'h', 'a', 'b'], ['SADD', 's', 'a'], ['ZADD', 'z', '1', 'a'], ['CONFIG', 'SET', 'maxmemory', '0']):
        # Errors are fine here (DEBUG HTSTATS-KEY on a missing key): the first
        # error of a kind allocates its counter, and the cases make none.
        c.s.sendall(Conn.pack(cmd))
        c.read()
    c.quit()
    flushall(srv)
    settle_empty(srv)
    for _ in range(2):
        run_once(srv, case)
    # Some versions allocate a little once more after the first cases; then
    # an empty case must leave used_memory as it was.
    zero = 0
    for _ in range(12):
        zero = zero + 1 if run_case(srv, {'groups': []})['delta'] == 0 else 0
        if zero == 3:
            return
    raise RuntimeError(srv.vid + ': empty cases keep changing used_memory')


# ---- the cases ----

K_LIST = [1, 2, 5, 8, 13, 16, 20, 23, 24, 25, 28, 31, 32, 33, 36, 39, 40, 41, 44, 45, 50, 64, 100, 116, 127, 128, 129, 200, 252, 253, 300]
V_LIST = [0, 1, 2, 3, 4, 5, 8, 9, 10, 12, 15, 16, 17, 20, 21, 24, 25, 28, 30, 31, 32, 33, 34, 36, 40, 41, 42, 43, 44, 45, 46, 48,
          50, 56, 60, 63, 64, 65, 80, 90, 100, 104, 106, 108, 110, 112, 114, 116, 117, 118, 120, 128, 200, 252, 253, 255, 256, 300,
          1000, 4000, 16000]
INTS = ['0', '1', '9999', '10000', '-1', '12345678', '4294967296', '-9223372036854775808', '9223372036854775807']


def string_cases(rnd):
    out = []
    for K in K_LIST:
        for V in V_LIST:
            if rnd.random() >= SCALE:
                continue
            out.append({'groups': [{'type': 'string', 'count': 1, 'key': K, 'value': {'len': V}}]})
            if rnd.random() < 0.5:
                out.append({'groups': [{'type': 'string', 'count': 1, 'key': K, 'value': {'len': V}, 'ttlCount': 1, 'ttlMode': 'expire'}]})
            if rnd.random() < 0.25:
                out.append({'groups': [{'type': 'string', 'count': 1, 'key': K, 'value': {'len': V}, 'ttlCount': 1, 'ttlMode': 'ex'}]})
        for v in INTS:
            val = {'int': v}
            out.append({'groups': [{'type': 'string', 'count': 1, 'key': K, 'value': val}]})
            out.append({'groups': [{'type': 'string', 'count': 1, 'key': K, 'value': val, 'ttlCount': 1,
                                    'ttlMode': rnd.choice(['ex', 'expire'])}]})
    # Big values: the query buffer becomes the value.
    for V in [32767, 32768, 40000, 65520, 65531, 70000, 100000, 1000000]:
        for K in [10, 200]:
            out.append({'groups': [{'type': 'string', 'count': 1, 'key': K, 'value': {'len': V}}]})
            out.append({'groups': [{'type': 'string', 'count': 1, 'key': K, 'value': {'len': V}, 'ttlCount': 1, 'ttlMode': 'expire'}]})
    return out


def key_cases(rnd):
    """Many keys: the keyspace and expires tables, and their collisions."""
    out = []
    counts = [2, 3, 4, 5, 6, 7, 8, 9, 13, 14, 15, 16, 17, 27, 28, 29, 31, 32, 33, 55, 56, 57, 63, 64, 65, 100, 111, 112, 113,
              127, 128, 129, 223, 224, 225, 255, 256, 257, 447, 448, 449, 1000, 1023, 1024, 1025, 1791, 1792, 1793, 4096, 10000, 30000]
    for n in counts:
        for ttl in (0, n, n // 2):
            out.append({'groups': [{'type': 'string', 'count': n, 'key': 12, 'value': {'len': 10}, 'ttlCount': ttl, 'ttlMode': 'ex'}]})
    for _ in range(int(60 * SCALE)):
        n = rnd.choice([rnd.randint(2, 300), rnd.randint(300, 5000)])
        out.append({'groups': [{'type': 'string', 'count': n, 'key': rnd.choice([6, 12, 20, 40, 100, 140]),
                                'value': rnd.choice([{'len': rnd.randint(0, 120)}, {'int': str(rnd.randint(-5, 20000))}]),
                                'ttlCount': rnd.randint(0, n), 'ttlMode': rnd.choice(['ex', 'expire'])}]})
    return out


FIELD_SPECS = [{'len': 1}, {'len': 3}, {'len': 5}, {'len': 8}, {'len': 10}, {'len': 16}, {'len': 31}, {'len': 32}, {'len': 50},
               {'len': 64}, {'len': 65}, {'len': 100}, {'len': 200}, {'len': 253}, {'int': '0'}, {'int': '100'}, {'int': '1000'},
               {'int': '100000'}, {'int': '4294967296'}, {'int': '-50'}]
VALUE_SPECS = [{'len': 0}, {'len': 1}, {'len': 5}, {'len': 10}, {'len': 20}, {'len': 32}, {'len': 50}, {'len': 64}, {'len': 65},
               {'len': 80}, {'len': 100}, {'len': 116}, {'len': 120}, {'len': 121}, {'len': 200}, {'len': 1000}, {'int': '0'},
               {'int': '13'}, {'int': '500'}, {'int': '5000'}, {'int': '70000'}, {'int': '4294967296'}, {'int': '-5'}]
HASH_N = [1, 2, 5, 10, 64, 100, 127, 128, 129, 255, 256, 257, 300, 448, 449, 511, 512, 513, 600, 896, 897, 1000, 1024, 1025, 2000, 4096]


def collection_group(rnd, typ, n, elem, extra):
    g = {'type': typ, 'count': extra.get('count', 1), 'key': extra.get('key', 8)}
    if typ == 'hash':
        g.update({'fields': n, 'field': elem, 'value': extra['value']})
    elif typ in ('set', 'zset'):
        g.update({'members': n, 'member': elem})
        if typ == 'zset':
            g['score'] = extra.get('score', '1')
    else:
        g.update({'items': n, 'item': elem})
    g['writes'] = extra.get('writes', 'once')
    if extra.get('ttl'):
        g['ttlCount'] = g['count'] if extra['ttl'] == 'all' else 1
    return g


def hash_cases(rnd):
    out = []
    # Around the limits, with short values.
    for n in HASH_N:
        for writes in ('once', 'each'):
            for f in ({'len': 6}, {'int': '1000'}):
                out.append({'groups': [collection_group(rnd, 'hash', n, f, {'value': {'len': 10}, 'writes': writes})]})
    # Field and value lengths around the value limit and the 128-byte entry.
    for f in FIELD_SPECS:
        for v in VALUE_SPECS:
            n = rnd.choice([1, 3, 20, 100])
            out.append({'groups': [collection_group(rnd, 'hash', n, f, {'value': v, 'writes': rnd.choice(['once', 'each']),
                                                                         'ttl': rnd.random() < 0.2})]})
    for _ in range(int(300 * SCALE)):
        n = rnd.choice(HASH_N + [rnd.randint(1, 3000)])
        out.append({'groups': [collection_group(rnd, 'hash', n, rnd.choice(FIELD_SPECS), {
            'value': rnd.choice(VALUE_SPECS), 'writes': rnd.choice(['once', 'each']), 'ttl': rnd.random() < 0.2,
            'count': rnd.choice([1, 1, 1, 2, 5]), 'key': rnd.choice([3, 8, 20, 40, 130])})]})
    return out


MEMBER_SPECS = [{'int': '0'}, {'int': '-5'}, {'int': '1000'}, {'int': '40000'}, {'int': '-40000'}, {'int': '3000000000'},
                {'int': '-3000000000'}, {'int': '9000000000000000000'}, {'len': 1}, {'len': 3}, {'len': 8}, {'len': 16},
                {'len': 31}, {'len': 32}, {'len': 64}, {'len': 65}, {'len': 100}, {'len': 253}]
SET_N = [1, 2, 10, 100, 127, 128, 129, 200, 223, 224, 225, 256, 448, 449, 511, 512, 513, 600, 896, 897, 1000, 3000]


def set_cases(rnd):
    out = []
    for n in SET_N:
        for writes in ('once', 'each'):
            for m in ({'len': 6}, {'int': '1000'}, {'int': '3000000000'}):
                out.append({'groups': [collection_group(rnd, 'set', n, m, {'writes': writes})]})
    for _ in range(int(300 * SCALE)):
        n = rnd.choice(SET_N + [rnd.randint(1, 3000)])
        out.append({'groups': [collection_group(rnd, 'set', n, rnd.choice(MEMBER_SPECS), {
            'writes': rnd.choice(['once', 'each']), 'ttl': rnd.random() < 0.2, 'count': rnd.choice([1, 1, 1, 3]),
            'key': rnd.choice([3, 8, 20, 130])})]})
    return out


SCORES = ['0', '1', '-1', '13', '127', '128', '4095', '4096', '-4097', '100000', '1759734012', '1759734012345',
          '4503599627370495', '4503599627370496', '9007199254740993', '100000000000000000', '1e18', '4611686018427387904',
          '4611686018427387905', '5764607523034235000', '1e19', '0.1', '0.5', '-2.5', '3.14159', '1e-7', '1.5e-5', '0.000123',
          '123456.789', '1.5e300', '-1.5e-300', 'inf', '-inf', '-0', '1.7976931348623157e308', '2.2250738585072014e-308',
          '5e-324', '1234567890.123456789', '0.30000000000000004', '100.5', '1e21', '1e22', '123e20', '9.5e-5']
ZSET_N = [1, 2, 10, 100, 127, 128, 129, 200, 256, 500, 1000, 3000]
ZMEMBER_SPECS = [{'int': '0'}, {'int': '1000'}, {'int': '1000000'}, {'len': 1}, {'len': 5}, {'len': 10}, {'len': 31},
                 {'len': 32}, {'len': 64}, {'len': 65}, {'len': 100}]


def zset_cases(rnd):
    out = []
    # Scores in a listpack: exact.
    for s in SCORES:
        for m in ({'len': 5}, {'int': '1000'}):
            out.append({'groups': [collection_group(rnd, 'zset', rnd.choice([1, 7, 50]), m, {'score': s})]})
    for n in ZSET_N:
        for writes in ('once', 'each'):
            out.append({'groups': [collection_group(rnd, 'zset', n, {'len': 8}, {'writes': writes, 'score': '1'})]})
    # One member in a skiplist: one node, whose size shows its level.
    for m in ZMEMBER_SPECS:
        out.append({'groups': [collection_group(rnd, 'zset', 1, m, {'score': '2.5'})], 'settings': {'zsetMaxListpackEntries': 0}})
    for _ in range(int(200 * SCALE)):
        n = rnd.choice(ZSET_N + [rnd.randint(1, 2000)])
        out.append({'groups': [collection_group(rnd, 'zset', n, rnd.choice(ZMEMBER_SPECS), {
            'writes': rnd.choice(['once', 'each']), 'ttl': rnd.random() < 0.2, 'score': rnd.choice(SCORES),
            'count': rnd.choice([1, 1, 2]), 'key': rnd.choice([3, 8, 130])})]})
    return out


ITEM_SPECS = [{'int': '5'}, {'int': '100'}, {'int': '1000'}, {'int': '100000'}, {'int': '4294967296'}, {'int': '-1'},
              {'len': 0}, {'len': 1}, {'len': 5}, {'len': 10}, {'len': 11}, {'len': 12}, {'len': 20}, {'len': 63}, {'len': 64},
              {'len': 100}, {'len': 127}, {'len': 128}, {'len': 500}, {'len': 1000}, {'len': 4000}, {'len': 4090}, {'len': 8000},
              {'len': 8170}, {'len': 8175}, {'len': 8180}, {'len': 8185}, {'len': 8192}, {'len': 8193}, {'len': 10000},
              {'len': 20000}]
LIST_N = [1, 2, 10, 100, 500, 600, 681, 682, 683, 700, 744, 745, 1000, 2000, 5000, 20000]


def list_cases(rnd):
    out = []
    for n in LIST_N:
        for writes in ('once', 'each'):
            for e in ({'len': 10}, {'int': '100'}, {'len': 60}):
                out.append({'groups': [collection_group(rnd, 'list', n, e, {'writes': writes})]})
    for e in ITEM_SPECS:
        for n in (1, 3, 40):
            out.append({'groups': [collection_group(rnd, 'list', n, e, {'writes': rnd.choice(['once', 'each'])})]})
    for _ in range(int(200 * SCALE)):
        e = rnd.choice(ITEM_SPECS)
        n = rnd.choice(LIST_N + [rnd.randint(1, 3000)])
        if 'len' in e and e['len'] * n > 20000000:
            n = max(1, 20000000 // max(1, e['len']))
        out.append({'groups': [collection_group(rnd, 'list', n, e, {'writes': rnd.choice(['once', 'each']),
                                                                    'ttl': rnd.random() < 0.2, 'count': rnd.choice([1, 1, 2])})]})
    for fill in (-1, -3, -5, 5, 128):
        for _ in range(int(12 * SCALE)):
            e = rnd.choice(ITEM_SPECS)
            n = rnd.choice([1, 50, 300, 2000])
            if 'len' in e and e['len'] * n > 20000000:
                n = max(1, 20000000 // max(1, e['len']))
            out.append({'groups': [collection_group(rnd, 'list', n, e, {'writes': rnd.choice(['once', 'each'])})],
                        'settings': {'listMaxListpackSize': fill}})
    return out


def random_group(rnd, gi):
    t = rnd.choice(['string', 'string', 'hash', 'set', 'zset', 'list'])
    count = rnd.choice([1, 5, 30, 200])
    key = rnd.choice([6, 12, 24, 50])
    if t == 'string':
        g = {'type': t, 'count': count, 'key': key, 'value': rnd.choice([{'len': rnd.randint(0, 300)}, {'int': str(rnd.randint(-100, 100000))}]),
             'ttlMode': rnd.choice(['ex', 'expire'])}
    elif t == 'hash':
        g = collection_group(rnd, t, rnd.randint(1, 40), rnd.choice(FIELD_SPECS[:10]), {'value': rnd.choice(VALUE_SPECS[:9]), 'count': count, 'key': key})
    elif t == 'set':
        g = collection_group(rnd, t, rnd.randint(1, 60), rnd.choice(MEMBER_SPECS[:12]), {'count': count, 'key': key})
    elif t == 'zset':
        g = collection_group(rnd, t, rnd.randint(1, 60), rnd.choice(ZMEMBER_SPECS[:8]), {'count': count, 'key': key, 'score': rnd.choice(SCORES[:12])})
    else:
        g = collection_group(rnd, t, rnd.randint(1, 60), rnd.choice(ITEM_SPECS[:12]), {'count': count, 'key': key})
    g['ttlCount'] = rnd.randint(0, count)
    return g


def mixed_cases(rnd):
    out = []
    for _ in range(int(60 * SCALE)):
        out.append({'groups': [random_group(rnd, i) for i in range(rnd.randint(2, 5))]})
    return out


def settings_cases(rnd):
    out = []
    for policy in ('allkeys-lru', 'volatile-lfu', 'allkeys-random'):
        for v in ('0', '42', '9999', '10000', '-7'):
            out.append({'groups': [{'type': 'string', 'count': 3, 'key': 10, 'value': {'int': v}}], 'settings': {'maxmemoryPolicy': policy}})
    for _ in range(int(80 * SCALE)):
        s = {}
        typ = rnd.choice(['hash', 'set', 'zset'])
        if typ == 'hash':
            s = {'hashMaxListpackEntries': rnd.choice([0, 1, 16, 1000, 2000]), 'hashMaxListpackValue': rnd.choice([0, 10, 64, 128, 300])}
            g = collection_group(rnd, 'hash', rnd.choice([1, 10, 100, 900]), rnd.choice(FIELD_SPECS), {'value': rnd.choice(VALUE_SPECS), 'writes': rnd.choice(['once', 'each'])})
        elif typ == 'set':
            s = {'setMaxIntsetEntries': rnd.choice([0, 1, 100, 1000]), 'setMaxListpackEntries': rnd.choice([0, 1, 50, 300]),
                 'setMaxListpackValue': rnd.choice([0, 10, 64, 200])}
            g = collection_group(rnd, 'set', rnd.choice([1, 10, 100, 400]), rnd.choice(MEMBER_SPECS), {'writes': rnd.choice(['once', 'each'])})
        else:
            s = {'zsetMaxListpackEntries': rnd.choice([0, 1, 16, 300]), 'zsetMaxListpackValue': rnd.choice([0, 10, 64, 200])}
            g = collection_group(rnd, 'zset', rnd.choice([1, 10, 100, 250]), rnd.choice(ZMEMBER_SPECS), {'writes': rnd.choice(['once', 'each']), 'score': rnd.choice(SCORES)})
        out.append({'groups': [g], 'settings': s})
    return out


def all_cases(vid):
    rnd = random.Random('memory-cases')
    makers = {'strings': string_cases, 'keys': key_cases, 'hashes': hash_cases, 'sets': set_cases, 'zsets': zset_cases,
              'lists': list_cases, 'mixed': mixed_cases, 'settings': settings_cases}
    cases = []
    for kind in ['strings', 'keys', 'hashes', 'sets', 'zsets', 'lists', 'mixed', 'settings']:
        made = makers[kind](rnd)
        if kind in KINDS:
            for c in made:
                c['kind'] = kind
                cases.append(c)
    out = []
    for c in cases:
        if not all(fits(g) for g in c['groups']):
            continue
        # Redis 6.2 reads a big argument into a buffer that doubles: the first
        # one on a connection lands a size class higher in a few ranges.
        if vid == 'redis-6.2.24' and any(g['type'] == 'string' and 40953 <= g['value'].get('len', 0) <= 65528 for g in c['groups']):
            continue
        out.append(c)
    return out


def record_version(vid):
    t0 = time.time()
    srv = Server(vid)
    rec = {'startup': srv.startup, 'cases': []}
    try:
        warm_up(srv)
        rec['warm'] = srv.used()
        cases = all_cases(vid)
        for i, case in enumerate(cases):
            try:
                rec['cases'].append(run_case(srv, case))
            except Exception as e:
                print(vid, 'case', i, json.dumps(case)[:300], repr(e), file=sys.stderr)
                raise
            if i % 500 == 0:
                print(vid, i, '/', len(cases), round(time.time() - t0), 's', file=sys.stderr, flush=True)
    finally:
        srv.stop()
    print(vid, len(rec['cases']), 'cases', round(time.time() - t0), 's', file=sys.stderr, flush=True)
    return vid, rec


def main():
    wanted = sys.argv[1:] or VERSIONS
    old = {}
    if os.path.exists(OUT):
        old = json.load(gzip.open(OUT, 'rt'))
        if not sys.argv[1:]:
            # A full recording keeps only the versions it records.
            old = {v: r for v, r in old.items() if v in wanted}
    def safe(vid):
        try:
            return record_version(vid)
        except Exception as e:
            print(vid, 'failed:', repr(e), file=sys.stderr, flush=True)
            return vid, None
    failed = []
    with ThreadPoolExecutor(max_workers=int(os.environ.get('KV_JOBS', '3'))) as ex:
        for vid, rec in ex.map(safe, wanted):
            if rec is None:
                failed.append(vid)
                continue
            if os.environ.get('KV_KINDS') and vid in old:
                kept = [c for c in old[vid]['cases'] if c.get('kind') not in KINDS]
                rec['cases'] = kept + rec['cases']
            old[vid] = rec
    # Write to a temporary file first, so a run that stops halfway leaves
    # the fixture as it was.
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    tmp = OUT + '.tmp'
    with gzip.open(tmp, 'wt', compresslevel=9) as f:
        json.dump(old, f, sort_keys=True, separators=(',', ':'))
    os.replace(tmp, OUT)
    print(OUT, os.path.getsize(OUT), 'bytes', file=sys.stderr)
    if failed:
        print('failed:', ' '.join(failed), '(the fixture keeps their earlier recording, if it had one)', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
