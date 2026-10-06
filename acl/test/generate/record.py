# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 KeyValueStore.com
#
# Runs thousands of ACL cases against each built server and records what it
# does, for the tests to replay through acl.js:
#
#   setuser  ACL SETUSER calls, one to three on the same user: OK or the
#            error, then the user's line in ACL LIST (or the crash).
#   dryrun   ACL DRYRUN for users and commands (7.0 and later).
#   multi    the same commands queued inside MULTI by a client logged in as
#            the user: QUEUED or the NOPERM error (every version; 6.2 has
#            no DRYRUN).
#   getkeys  COMMAND GETKEYSANDFLAGS (GETKEYS in 6.2).
#   config   config files with user lines: the error the server stops with,
#            or the users ACL LIST shows once it runs.
#   aclfile  ACL LOAD with an ACL file: the error, or ACL LIST.
#
# Writes test/fixtures/runs.json.gz.
#
#   KV_BIN=/opt/kv python3 acl/test/generate/record.py [version ...]

import gzip, json, os, random, re, shutil, socket, subprocess, sys, tempfile, time, hashlib
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
BIN = os.environ.get('KV_BIN', '/opt/kv')
SERVERS = {v['version']: v for v in json.load(gzip.open(os.path.join(HERE, '..', 'fixtures', 'servers.json.gz'), 'rt'))}
OUT = os.path.join(HERE, '..', 'fixtures', 'runs.json.gz')
SCALE = float(os.environ.get('KV_SCALE', '1'))


def b(s):
    return s if isinstance(s, bytes) else str(s).encode('latin-1')


class Conn:
    """RESP over a Unix socket; strings travel as latin-1, byte for byte."""
    def __init__(self, path):
        self.s = socket.socket(socket.AF_UNIX)
        self.s.settimeout(10)
        self.s.connect(path)
        self.f = self.s.makefile('rb')

    def send(self, *args):
        args = [b(a) for a in args]
        self.s.sendall(b''.join([b'*%d\r\n' % len(args)] + [b'$%d\r\n%s\r\n' % (len(a), a) for a in args]))

    def call(self, *args):
        self.send(*args)
        return self.read()

    def read(self):
        line = self.f.readline()
        if not line:
            raise ConnectionError('closed')
        t, rest = line[:1], line[1:-2]
        if t == b'+':
            return rest.decode('latin-1')
        if t == b'-':
            raise RuntimeError(rest.decode('latin-1'))
        if t == b':':
            return int(rest)
        if t == b'$':
            n = int(rest)
            return None if n < 0 else self.f.read(n + 2)[:-2].decode('latin-1')
        if t in (b'*', b'%', b'>', b'~'):
            n = int(rest)
            return None if n < 0 else [self.read() for _ in range(n * (2 if t == b'%' else 1))]
        if t == b'_':
            return None
        raise ValueError(line)

    def close(self):
        try:
            self.s.close()
        except OSError:
            pass


def reply(c, *args):
    """('ok', value) or ('err', message without the leading ERR)."""
    try:
        return ('ok', c.call(*args))
    except RuntimeError as e:
        m = str(e)
        return ('err', m[4:] if m.startswith('ERR ') else m)


class Server:
    """One running server, restarted when a case crashes it."""
    def __init__(self, version, config=None):
        self.version, self.config = version, config
        self.p = None
        self.start()

    def start(self):
        binary = [os.path.join(BIN, self.version, f) for f in os.listdir(os.path.join(BIN, self.version)) if f.endswith('-server')][0]
        self.d = tempfile.mkdtemp(prefix='kvacl-')
        self.sock = os.path.join(self.d, 's.sock')
        args = [binary]
        if self.config is not None:
            with open(os.path.join(self.d, 'test.conf'), 'wb') as f:
                f.write(b(self.config))
            args.append(os.path.join(self.d, 'test.conf'))
        args += ['--port', '0', '--unixsocket', self.sock, '--dir', self.d, '--save', '']
        self.log = open(os.path.join(self.d, 'out.log'), 'wb')
        self.p = subprocess.Popen(args, stdout=self.log, stderr=subprocess.STDOUT, cwd=self.d)
        for _ in range(1000):
            if os.path.exists(self.sock) or self.p.poll() is not None:
                break
            time.sleep(0.005)
        self.c = None
        for _ in range(500):
            if self.p.poll() is not None:
                break
            try:
                self.c = Conn(self.sock)
                reply(self.c, 'PING')
                break
            except (ConnectionError, OSError):
                self.c = None
                time.sleep(0.01)
        # The recorder works as a user of its own, whatever the cases do to the default user.
        if self.c is not None and self.config is None:
            reply(self.c, 'ACL', 'SETUSER', 'kvadmin', 'on', 'nopass', '~*', '&*', '+@all')
            reply(self.c, 'AUTH', 'kvadmin', 'x')

    def output(self):
        try:
            return open(os.path.join(self.d, 'out.log'), 'rb').read().decode('latin-1')
        except OSError:
            return ''

    def alive(self):
        return self.p.poll() is None

    def crashed(self):
        """After a dropped connection: did the server go down?"""
        for _ in range(100):
            if self.p.poll() is not None:
                return True
            time.sleep(0.01)
        return False

    def restart(self):
        self.stop()
        self.start()

    def stop(self):
        if self.c:
            self.c.close()
        if self.p and self.p.poll() is None:
            self.p.kill()
        if self.p:
            self.p.wait()
        self.log.close()
        shutil.rmtree(self.d, ignore_errors=True)


def crash_reason(out):
    """The assertion or panic a crashed server printed."""
    for pat in (r"Guru Meditation: (.*?) #", r"==> .*? '(.*?)' is not true", r"ASSERTION FAILED.*?\n.*?'(.*?)'"):
        m = re.search(pat, out)
        if m:
            return m.group(1)
    m = re.search(r'crashed by signal: (\d+)', out)
    return 'signal ' + m.group(1) if m else 'crashed'


# ---- what the cases are made of ----

KEYS = ['a', 'ab', 'abc', 'b', 'user:1', 'user:2', 'cache:x', 'x:y', '*', 'k', 'é', 'a*', '[a]', 'a\\*', '', 'A']
CHANNELS = ['news', 'news.1', 'chat', '*', 'a', 'n?ws', 'news.*', '']
KEY_PATTERNS = ['*', 'a*', 'user:*', 'a', 'ab', 'a?c', '[ab]*', '[^a]*', 'user:1', '', 'a\\*', '*:*', '*x', 'cache:*', '[a-c]*', '[c-a]', '[', 'a[', '\\', 'é*', 'A*', '?', '**', '*a*b*']
BAD_PATTERNS = ['a b', 'a\x00b', 'a\tb', 'x\n']
CHANNEL_PATTERNS = ['news', 'news.*', '*', 'n?ws', 'chat', '', '[nc]*', 'a']
PASSWORDS = ['secret', 'pw', '', 'p w', 'p\x00w', 'é']
WORDS = ['on', 'off', 'nopass', 'resetpass', 'reset', 'skip-sanitize-payload', 'sanitize-payload', 'clearselectors',
         'allkeys', 'resetkeys', 'allchannels', 'resetchannels', 'allcommands', 'nocommands', 'alldbs', 'resetdbs']
FIRSTARGS = [('select', '0'), ('select', '1'), ('debug', 'object'), ('debug', 'segfault'), ('get', 'x'), ('client', 'x'),
             ('config', 'nosuch'), ('select', 'A b'), ('select', 'a"b'), ('select', "a'b"), ('select', 'X')]
WEIRD = ['', ' ', '(', ')', '()', '( )', 'xyz', '\x00', 'on\x00x', '+', '-', '+@', '-@', '+|', '+get|', '+|get', '~', '%', '&',
         '%R', '%RW', '%~a', '%X~a', '%RR~a', '%R W~a', '%r~a', '%wR~a', '+get\x00x', 'ON', 'Off', '+GET', '-@ALL', '+@Read',
         'db=', 'db=0', 'db=1,2', 'DB=3', 'db=,1', 'db=1,', 'db=1,,2', 'db=-1', 'db=+2', 'db= 4', 'db=2147483647', 'db=2147483648',
         'db=99999999999999999999', 'db=0x1', 'db=a', 'db=3,1,3']


def rcase(s):
    if random.random() < 0.15:
        return ''.join(ch.upper() if random.random() < 0.5 else ch for ch in s)
    return s


def commands(vid):
    """[(fullname, arity, flags, categories, specs, is_container)] for a version, subcommands included."""
    out = []
    for cmd in SERVERS[vid]['commands']:
        out.append((cmd[0], cmd[1], cmd[2], cmd[6] or [], cmd[8] if len(cmd) > 8 else [], bool(len(cmd) > 9 and cmd[9])))
        for s in (cmd[9] if len(cmd) > 9 else []) or []:
            out.append((s[0], s[1], s[2], s[6] or [], s[8] if len(s) > 8 else [], False))
    return out


def sha(s):
    return hashlib.sha256(b(s)).hexdigest()


def one_op(vid, depth=0):
    cmds = commands(vid)
    cats = SERVERS[vid]['categories']
    r = random.random()
    if r < 0.12:
        return rcase(random.choice(WORDS))
    if r < 0.2:
        kind = random.choice('><#!')
        if kind in '><':
            return kind + random.choice(PASSWORDS)
        h = random.choice([sha(random.choice(PASSWORDS)), sha('x').upper(), 'abc', sha('y')[:63], sha('z') + '0'])
        return kind + h
    if r < 0.32:
        p = random.choice(KEY_PATTERNS + BAD_PATTERNS[:1]) if random.random() < 0.95 else random.choice(BAD_PATTERNS)
        perm = random.choice(['', '', '', 'R', 'W', 'RW', 'WR', 'r', 'w', 'Rw'])
        return ('%' + perm + '~' if perm else '~') + p
    if r < 0.38:
        return '&' + random.choice(CHANNEL_PATTERNS + BAD_PATTERNS[:1])
    if r < 0.62:
        name, arity, flags, ccats, specs, container = random.choice(cmds)
        sign = random.choice('++-')
        if random.random() < 0.05:
            name = 'nosuchcommand'
        return sign + rcase(name)
    if r < 0.7:
        base, arg = random.choice(FIRSTARGS)
        return '+' + rcase(base) + '|' + arg
    if r < 0.86:
        cat = random.choice(cats + ['all', 'all', 'nosuchcat'])
        return random.choice('+-') + '@' + rcase(cat)
    if r < 0.93 and depth == 0:
        inner = ' '.join(one_op(vid, 1) for _ in range(random.randint(0, 4)))
        return '(' + inner + ')'
    return random.choice(WEIRD)


def rule_args(vid, n=None):
    """Arguments for ACL SETUSER, selectors sometimes spread over several."""
    n = random.randint(0, 7) if n is None else n
    args = []
    for _ in range(n):
        op = one_op(vid)
        if op.startswith('(') and op.endswith(')') and ' ' in op and random.random() < 0.5:
            args.extend(op.split(' '))
        else:
            args.append(op)
    if random.random() < 0.05:
        args.insert(random.randint(0, len(args)), random.choice(['(+get', '(', '(~a', 'x)', ')']))
    return args


def good_rules(vid):
    """Rules a person would write, for checking commands."""
    cmds = commands(vid)
    cats = SERVERS[vid]['categories']
    rules = []
    if random.random() < 0.3:
        rules.append(random.choice(['allkeys', '~*']))
    else:
        for _ in range(random.randint(0, 3)):
            perm = random.choice(['', '', '%R', '%W', '%RW'])
            rules.append((perm + '~' if perm else '~') + random.choice(KEY_PATTERNS))
    if random.random() < 0.3:
        rules.append('allchannels')
    else:
        # Redis 6.2 starts new users with every channel.
        rules.append('resetchannels')
        for _ in range(random.randint(0, 2)):
            rules.append('&' + random.choice(CHANNEL_PATTERNS))
    start = random.choice(['+@all', '-@all', '-@all', ''])
    if start:
        rules.append(start)
    for _ in range(random.randint(0, 5)):
        t = random.random()
        if t < 0.4:
            rules.append(random.choice('+-') + '@' + random.choice(cats))
        elif t < 0.85:
            rules.append(random.choice('+-') + random.choice(cmds)[0])
        else:
            base, arg = random.choice(FIRSTARGS[:6])
            rules.append('+' + base + '|' + arg)
    if vid == 'valkey-9.1.2' and random.random() < 0.5:
        rules.append(random.choice(['db=0', 'db=1', 'db=0,2', 'resetdbs', 'alldbs', 'db=5']))
    if random.random() < 0.25 and not vid.startswith('redis-6.'):
        sel = good_rules(vid) if random.random() < 0.1 else ['~' + random.choice(KEY_PATTERNS), random.choice(['+@read', '+get', '+@write', '+set', '+@all', '+@string'])]
        rules.append('(' + ' '.join(sel) + ')')
    return rules


ARGS = ['STORE', 'BY', 'GET', 'LIMIT', 'KEYS', 'STREAMS', 'GROUP', 'BLOCK', 'COUNT', 'NOACK', 'STOREDIST', 'WITHSCORES', 'AUTH',
        'AUTH2', 'COPY', 'REPLACE', 'DB', 'IFEQ', 'IFNE', 'CLAIM', 'MAXCOUNT', 'MAXSIZE', 'SET', 'INCRBY', 'OVERFLOW', 'u8',
        'STRINGS', 'USAGE', 'get', 'store', 'streams', 'keys', 'db']
NUMS = ['0', '1', '2', '3', '-1', '10', '4294967297', '18446744073709551617', '01', ' 1', '1 ', '+1']


# Commands that find their keys, channels or databases in a way of their own.
FOCUS = ['sort', 'sort_ro', 'migrate', 'georadius', 'georadiusbymember', 'xread', 'xreadgroup', 'set', 'bitfield', 'eval',
         'evalsha_ro', 'fcall', 'lmpop', 'blmpop', 'zunionstore', 'zinter', 'sintercard', 'publish', 'subscribe', 'psubscribe',
         'ssubscribe', 'spublish', 'unsubscribe', 'copy', 'move', 'select', 'swapdb', 'flushall', 'delex', 'pfmerge', 'msetex',
         'memory|usage', 'stralgo', 'lcs', 'getex', 'object|encoding', 'cluster|flushslot', 'auth', 'hello']


def argv_for(vid, cmd=None):
    """A command line to check: right arity most of the time, arguments that
    find keys and channels in different ways."""
    cmds = commands(vid)
    if cmd is None:
        focus = [c for c in cmds if c[0] in FOCUS]
        cmd = random.choice(focus if focus and random.random() < 0.3 else cmds)
    name, arity, flags, ccats, specs, container = cmd
    if random.random() < 0.02:
        return [rcase(random.choice(['nosuch', 'config', 'client', 'object'])), 'nosuchsub']
    parts = name.split('|')
    argv = [rcase(p) for p in parts]
    n = arity if arity > 0 else -arity + random.choice([0, 0, 1, 1, 2, 3, 5])
    if random.random() < 0.03:
        n += random.choice([-1, 1])
    while len(argv) < n:
        t = random.random()
        if t < 0.45:
            argv.append(random.choice(KEYS))
        elif t < 0.6:
            argv.append(random.choice(NUMS[:4]) if random.random() < 0.8 else random.choice(NUMS))
        elif t < 0.75:
            argv.append(random.choice(ARGS))
        else:
            argv.append(random.choice(CHANNELS))
    # numkeys in its place, so key specs find keys
    lname = name.lower()
    # Database numbers where commands take them.
    if lname in ('select', 'move', 'swapdb') and len(argv) > 1 and random.random() < 0.8:
        for i in range(1 if lname != 'move' else 2, len(argv)):
            argv[i] = random.choice(['0', '1', '2', '5', '15', '16', '-1', '01', 'x'])
    if lname == 'copy' and random.random() < 0.7:
        argv = argv[:3] + random.choice([['DB', '1'], ['DB', '2', 'REPLACE'], ['REPLACE', 'DB', '0'], ['DB', '1', 'DB', '5'], ['DB', 'x'], ['DB', '16']])
    if lname in ('eval', 'evalsha', 'eval_ro', 'evalsha_ro', 'fcall', 'fcall_ro', 'blmpop', 'bzmpop', 'zunionstore', 'zinterstore', 'zdiffstore') and len(argv) > 2 and random.random() < 0.8:
        argv[2] = str(random.randint(0, max(0, len(argv) - 3)))
    if lname in ('zunion', 'zinter', 'zdiff', 'zintercard', 'sintercard', 'lmpop', 'zmpop', 'sdiffcard', 'sunioncard', 'msetex') and len(argv) > 1 and random.random() < 0.8:
        argv[1] = str(random.randint(0, max(0, len(argv) - 2)))
    return argv


# ---- the probes ----

def acl_list_line(c, name):
    for line in c.call('ACL', 'LIST'):
        if line.startswith('user ' + name + ' '):
            return line
    return None


def record_setuser(srv, vid, n):
    out = []
    for i in range(n):
        name = 'fz%d' % i
        if random.random() < 0.03:
            name = random.choice(['a b', 'a\x00b', 'tab\tx', '', 'default'])
        steps = [rule_args(vid) for _ in range(random.choice([1, 1, 1, 2, 3]))]
        res = []
        for args in steps:
            r = reply(srv.c, 'ACL', 'SETUSER', name, *args) if srv.alive() else None
            entry = {'args': args}
            try:
                if r[0] == 'err':
                    entry['error'] = r[1]
                else:
                    entry['list'] = acl_list_line(srv.c, name)
            except (ConnectionError, OSError):
                if srv.crashed():
                    entry['crash'] = crash_reason(srv.output())
                    res.append(entry)
                    srv.restart()
                    break
                raise
            res.append(entry)
        out.append({'name': name, 'steps': res})
        if srv.alive() and name != 'default':
            try:
                srv.c.call('ACL', 'DELUSER', name)
            except (RuntimeError, ConnectionError):
                pass
        if name == 'default' and srv.alive():
            srv.c.call('ACL', 'SETUSER', 'default', 'reset', 'on', 'nopass', '~*', '&*', '+@all')
    return out


def make_user(srv, rules, name='fzu'):
    """Creates the user; the rules as ACL SETUSER takes them, or None if it doesn't."""
    srv.c.call('ACL', 'DELUSER', name)
    r = reply(srv.c, 'ACL', 'SETUSER', name, 'reset', *rules)
    return r[0] == 'ok'


def record_dryrun(srv, vid, users, per):
    out = []
    for _ in range(users):
        rules = good_rules(vid)
        if not make_user(srv, rules):
            continue
        db = random.choice([0, 0, 0, 1, 2, 5]) if vid == 'valkey-9.1.2' else 0
        if db:
            srv.c.call('SELECT', db)
        checks = []
        for _ in range(per):
            argv = argv_for(vid)
            r = reply(srv.c, 'ACL', 'DRYRUN', 'fzu', *argv)
            checks.append([argv, r[1] if r[0] == 'ok' else {'error': r[1]}])
        if db:
            srv.c.call('SELECT', 0)
        out.append({'rules': rules, 'db': db, 'checks': checks})
    return out


def record_multi(srv, vid, users, per):
    out = []
    skip = {'exec', 'discard', 'reset', 'quit', 'multi', 'watch', 'unwatch', 'shutdown', 'monitor', 'sync', 'psync', 'hello', 'auth'}
    cmds = [c for c in commands(vid) if c[0].split('|')[0] not in skip and 'no_multi' not in c[2]]
    for _ in range(users):
        rules = good_rules(vid)
        if not make_user(srv, rules + ['on', 'nopass', '+multi']):
            continue
        c = Conn(srv.sock)
        try:
            c.call('AUTH', 'fzu', 'x')
            c.call('MULTI')
            checks = []
            for _ in range(per):
                argv = argv_for(vid, random.choice(cmds))
                if argv[0].lower() in skip:
                    continue
                r = reply(c, *argv)
                checks.append([argv, r[1] if r[0] == 'ok' else {'error': r[1]}])
        finally:
            c.close()
        out.append({'rules': rules + ['on', 'nopass', '+multi'], 'checks': checks})
    return out


def record_getkeys(srv, vid, n):
    out = []
    sub = 'GETKEYS' if vid.startswith('redis-6.') else 'GETKEYSANDFLAGS'
    for _ in range(n):
        argv = argv_for(vid)
        r = reply(srv.c, 'COMMAND', sub, *argv)
        out.append([argv, r[1] if r[0] == 'ok' else {'error': r[1]}])
    return out


ADMIN = 'user kvadmin on nopass ~* &* +@all'
RESTORE = b'user default on nopass ~* &* +@all\nuser kvadmin on nopass ~* &* +@all\n'


def admin(srv):
    """A new connection logged in as kvadmin, which every loaded file keeps."""
    c = Conn(srv.sock)
    reply(c, 'AUTH', 'kvadmin', 'x')
    return c


def record_aclfile(srv, vid, n):
    out = []
    for i in range(n):
        path = os.path.join(srv.d, 'users.acl')
        lines = []
        if random.random() < 0.85:
            lines.append('user default on nopass ~* &* +@all')
        for j in range(random.randint(0, 3)):
            t = random.random()
            if t < 0.75:
                name = random.choice(['u%d' % j, 'u%d' % j, 'default', 'u0', 'a\tb', ''])
                lines.append('user ' + name + ' ' + ' '.join(rule_args(vid, random.randint(0, 6))))
            else:
                lines.append(random.choice(['', '   ', '# a comment', 'User x on', 'user', 'users x', '\tuser x on', 'user x on  ~a', 'user x  on', 'user x on\t~a',
                                            'user x on (+get', 'user x (+get', 'user x on (+get ~a', 'user x ( +get )', 'user x "on"', 'user x on\r']))
        lines.insert(random.randint(0, len(lines)), ADMIN)
        text = '\n'.join(lines) + random.choice(['\n', '', '\n\n'])
        with open(path, 'wb') as f:
            f.write(b(text))
        entry = {'file': text}
        c = None
        try:
            c = admin(srv)
            r = reply(c, 'ACL', 'LOAD')
            if r[0] == 'err':
                entry['error'] = r[1]
            else:
                c.close()
                c = admin(srv)
                lst = reply(c, 'ACL', 'LIST')
                entry['list'] = lst[1] if lst[0] == 'ok' else {'error': lst[1]}
        except (ConnectionError, OSError):
            if srv.crashed():
                entry['crash'] = crash_reason(srv.output())
            else:
                entry['dropped'] = True
            out.append(entry)
            if c:
                c.close()
            srv.restart()
            continue
        out.append(entry)
        # Back to the two users that can do everything.
        with open(os.path.join(srv.d, 'users.acl'), 'wb') as f:
            f.write(RESTORE)
        try:
            ok = reply(c, 'ACL', 'LOAD')[0] == 'ok'
        except (ConnectionError, OSError):
            ok = False
        c.close()
        if not ok:
            srv.restart()
    return out


def record_config(vid, n):
    """Config files with user lines; each starts a server of its own."""
    out = []
    for i in range(n):
        lines = []
        for j in range(random.choice([1, 1, 1, 2, 3])):
            name = random.choice(['u%d' % j, 'u%d' % j, 'u%d' % j, 'default', 'u0', '"a b"', '"a\\x00b"', 'U0'])
            args = rule_args(vid, random.randint(0, 6))
            text = ' '.join(quote_conf(a) for a in args)
            lines.append('user ' + name + (' ' + text if text else ''))
        if random.random() < 0.05:
            lines.insert(0, random.choice(['aclfile users.acl', 'acl-pubsub-default allchannels']))
        # A user for the recorder, whatever the file does to the default user.
        lines.insert(0, 'user kvadmin on nopass ~* &* +@all')
        conf = '\n'.join(lines) + '\n'
        srv = Server(vid, conf)
        entry = {'config': conf}
        try:
            if srv.c is None:
                srv.p.wait(timeout=10)
                entry['exit'] = srv.output()
            else:
                reply(srv.c, 'AUTH', 'kvadmin', 'x')
                lst = reply(srv.c, 'ACL', 'LIST')
                entry['list'] = lst[1] if lst[0] == 'ok' else {'error': lst[1]}
        except (ConnectionError, OSError):
            entry['crash'] = crash_reason(srv.output()) if srv.crashed() else 'dropped'
        finally:
            srv.stop()
        out.append(entry)
    return out


def quote_conf(a):
    """A rule as a config file line writes it: quoted when it has to be."""
    if a and not re.search(r'[\x00-\x20"\'\\\x7f-\xff]', a):
        return a
    out = '"'
    for ch in a:
        o = ord(ch)
        if ch in '"\\':
            out += '\\' + ch
        elif o < 0x20 or o >= 0x7f:
            out += '\\x%02x' % o
        else:
            out += ch
    return out + '"'


def record_version(vid):
    random.seed('acl-' + vid)
    t0 = time.time()
    rec = {}
    srv = Server(vid)
    try:
        rec['setuser'] = record_setuser(srv, vid, int(3000 * SCALE))
        if not vid.startswith('redis-6.'):
            rec['dryrun'] = record_dryrun(srv, vid, int(300 * SCALE), 40)
        rec['multi'] = record_multi(srv, vid, int((400 if vid.startswith('redis-6.') else 100) * SCALE), 40)
        rec['getkeys'] = record_getkeys(srv, vid, int(6000 * SCALE))
    finally:
        srv.stop()
    srv = AclFileServer(vid)
    try:
        rec['aclfile'] = record_aclfile(srv, vid, int(800 * SCALE))
    finally:
        srv.stop()
    rec['config'] = record_config(vid, int(500 * SCALE))
    print(vid, {k: len(x) for k, x in rec.items()}, round(time.time() - t0), 's', file=sys.stderr)
    return vid, rec


class AclFileServer(Server):
    """A server with an ACL file, which it reads at startup."""
    def __init__(self, version):
        self.version, self.config = version, None
        self.start()

    def start(self):
        self.d = tempfile.mkdtemp(prefix='kvacl-')
        with open(os.path.join(self.d, 'users.acl'), 'wb') as f:
            f.write(RESTORE)
        binary = [os.path.join(BIN, self.version, f) for f in os.listdir(os.path.join(BIN, self.version)) if f.endswith('-server')][0]
        self.sock = os.path.join(self.d, 's.sock')
        self.log = open(os.path.join(self.d, 'out.log'), 'wb')
        self.p = subprocess.Popen([binary, '--port', '0', '--unixsocket', self.sock, '--dir', self.d, '--save', '', '--aclfile', 'users.acl'],
                                  stdout=self.log, stderr=subprocess.STDOUT, cwd=self.d)
        for _ in range(1000):
            if os.path.exists(self.sock) or self.p.poll() is not None:
                break
            time.sleep(0.005)
        self.c = None
        for _ in range(200):
            try:
                self.c = Conn(self.sock)
                self.c.call('PING')
                break
            except (ConnectionError, OSError, RuntimeError):
                self.c = None
                time.sleep(0.01)


def main():
    wanted = sys.argv[1:] or sorted(SERVERS)
    old = {}
    if os.path.exists(OUT) and sys.argv[1:]:
        old = json.load(gzip.open(OUT, 'rt'))
    with ThreadPoolExecutor(max_workers=int(os.environ.get('KV_JOBS', '8'))) as ex:
        for vid, rec in ex.map(record_version, wanted):
            old[vid] = rec
    with gzip.open(OUT, 'wt', compresslevel=9) as f:
        json.dump(old, f, sort_keys=True, separators=(',', ':'))
    print(OUT, os.path.getsize(OUT), 'bytes', file=sys.stderr)


if __name__ == '__main__':
    main()
