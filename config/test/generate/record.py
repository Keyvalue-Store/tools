# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 KeyValueStore.com
#
# Starts each built server with thousands of config files and records what
# it does with each one: the error it stops with, or the value of every
# setting as CONFIG GET * reports it. The tests feed the same files to
# config.js and compare. Writes test/fixtures/runs.json.gz.
#
#   KV_BIN=/opt/kv python3 config/test/generate/record.py [version ...]
#
# KV_BIN holds the built servers (redis-7.2.16/redis-server, ...).
# servers.json.gz, from extract.py, says which configs each version has.
#
# Most probes go in batches: a file with one line for each of many configs.
# When the server stops at a line, that line comes out and the rest runs
# again, until the server starts; then CONFIG GET * shows what every valid
# line did. Lines that only make sense alone, or that touch each other,
# run as separate cases.

import gzip, json, os, re, resource, shutil, socket, subprocess, sys, tempfile, time
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
BIN = os.environ.get('KV_BIN', '/opt/kv')
SERVERS = json.load(gzip.open(os.path.join(HERE, '..', 'fixtures', 'servers.json.gz'), 'rt'))
OUT = os.path.join(HERE, '..', 'fixtures', 'runs.json.gz')

# Builds without TLS: Redis 6.2 and 7.0 compile the TLS settings in only
# when built with TLS, and these weren't.
NO_TLS = ('redis-6.2.24', 'redis-7.0.15')


# ---- running a server ----

class Conn:
    """RESP over a Unix socket; bulk strings come back as latin-1 text, byte for byte."""
    def __init__(self, path):
        self.s = socket.socket(socket.AF_UNIX)
        self.s.settimeout(5)
        self.s.connect(path)
        self.f = self.s.makefile('rb')

    def call(self, *args):
        args = [a if isinstance(a, bytes) else str(a).encode() for a in args]
        self.s.sendall(b''.join([b'*%d\r\n' % len(args)] + [b'$%d\r\n%s\r\n' % (len(a), a) for a in args]))
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
        self.s.close()


def split_args(line):
    """sdssplitargs, for finding the password a file sets."""
    out, p, n = [], 0, len(line)
    while True:
        while p < n and line[p] in ' \t\n\v\f\r':
            p += 1
        if p >= n:
            return out
        cur, inq, insq = '', False, False
        while True:
            c = line[p] if p < n else ''
            if inq:
                if c == '\\' and line[p + 1:p + 2] == 'x' and re.match(r'[0-9a-fA-F]{2}', line[p + 2:p + 4]):
                    cur += chr(int(line[p + 2:p + 4], 16)); p += 3
                elif c == '\\' and p + 1 < n:
                    p += 1
                    cur += {'n': '\n', 'r': '\r', 't': '\t', 'b': '\b', 'a': '\a'}.get(line[p], line[p])
                elif c == '"':
                    if p + 1 < n and line[p + 1] not in ' \t\n\v\f\r':
                        return None
                    p += 1
                    break
                elif not c:
                    return None
                else:
                    cur += c
            elif insq:
                if c == '\\' and line[p + 1:p + 2] == "'":
                    p += 1; cur += "'"
                elif c == "'":
                    if p + 1 < n and line[p + 1] not in ' \t\n\v\f\r':
                        return None
                    p += 1
                    break
                elif not c:
                    return None
                else:
                    cur += c
            elif c in ('', ' ', '\n', '\r', '\t'):
                break
            elif c == '"':
                inq = True
            elif c == "'":
                insq = True
            else:
                cur += c
            p += 1
        out.append(cur)


def password(lines):
    """The last password the file gives the default user, if any."""
    pw = None
    for line in lines if isinstance(lines, list) else lines.split('\n'):
        a = split_args(line.strip(' \t\r\n'))
        if a and a[0].lower() == 'requirepass' and len(a) == 2:
            pw = a[1]
    return pw


def limits():
    # A setting that makes the server allocate too much fails fast instead of swapping.
    resource.setrlimit(resource.RLIMIT_AS, (16 << 30, 16 << 30))


LOG = re.compile(r'^\d+:[A-Z] \d+ \w+ \d+ [\d:.]+ (.) (.*)$')
# Log lines every start has, or that depend on the machine rather than the file.
NOISE = re.compile(r'WARNING Memory overcommit|WARNING: The TCP backlog|no config file specified|Ready to accept|'
                   r'oO0OoO0OoO0Oo|Configuration loaded|monotonic clock|Server initialized|Running mode=|'
                   r'WARNING supervised by|systemd supervision|upstart supervision|Increased maximum number|'
                   r'You requested maxclients|Your current .ulimit|Server can.t set maximum open files|'
                   r'Failed to write PID file|Error condition on socket for SYNC|Unable to connect to (MASTER|PRIMARY)|'
                   r'Could not create server TCP listening socket', re.I)


def hidden_names(vid):
    """Settings CONFIG GET * leaves out; CONFIG GET with the exact name shows them."""
    version = next(v for v in SERVERS if v['version'] == vid)
    return [c['name'] for c in version['configs'] if c['present'] and 'HIDDEN_CONFIG' in c['flags']]


def all_names(vid):
    version = next(v for v in SERVERS if v['version'] == vid)
    return sorted(set(version['listed']) | set(hidden_names(vid)))


def config_get(sock, version, lines, as_pubsub):
    """CONFIG GET * and the hidden settings. When a tiny client-output-buffer-limit
    for normal clients cuts the reply off, ask again as a pub/sub client (RESP3
    lets a subscribed client run any command), whose limits are separate."""
    c = Conn(sock)
    try:
        try:
            c.call('PING')
        except RuntimeError as e:
            if not str(e).startswith('NOAUTH'):
                raise
            c.call('AUTH', (password(lines) or '').encode('latin-1'))
        if as_pubsub:
            c.call('HELLO', '3')
            c.call('SUBSCRIBE', 'kvrec')
        values = {}
        r = c.call('CONFIG', 'GET', '*')
        values = dict(zip(r[0::2], r[1::2]))
        for name in hidden_names(version):
            h = c.call('CONFIG', 'GET', name)
            values.update(dict(zip(h[0::2], h[1::2])))
        return values
    finally:
        c.close()


def run(version, lines, args=()):
    """Starts the server with a config file of these lines; returns what happened."""
    binary = [os.path.join(BIN, version, f) for f in os.listdir(os.path.join(BIN, version)) if f.endswith('-server')][0]
    d = tempfile.mkdtemp(prefix='kvrec-')
    p = None
    try:
        conf = os.path.join(d, 'test.conf')
        with open(conf, 'wb') as f:
            f.write(''.join(l + '\n' for l in lines).encode('latin-1') if isinstance(lines, list) else lines.encode('latin-1'))
        sock = os.path.join(d, 's.sock')
        cmd = [binary, conf, '--port', '0', '--unixsocket', sock, '--dir', d] + list(args)
        p = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=d, preexec_fn=limits)
        values, deadline, cut = None, time.time() + 20, 0
        while time.time() < deadline and p.poll() is None:
            if os.path.exists(sock):
                try:
                    values = config_get(sock, version, lines, cut >= 2)
                    break
                except RuntimeError as e:
                    values = {'__error': str(e)}
                    break
                except (ConnectionError, OSError):
                    # Connected and then cut off: the reply was too big for the
                    # file's output buffer limit. Twice, and we ask as pub/sub;
                    # twice more, and we give up on reading the values.
                    cut += 1
                    if cut >= 4:
                        values = {'__error': 'the output buffer limits cut off CONFIG GET'}
                        break
            time.sleep(0.001)
        timed_out = values is None and p.poll() is None
        p.kill()
        out, err = p.communicate(timeout=20)
        out, err = out.decode('latin-1'), err.decode('latin-1')
        log = []
        for line in out.split('\n'):
            m = LOG.match(line)
            if m and m.group(1) == '#' and not NOISE.search(m.group(2)):
                log.append(m.group(2))
        if values is not None:
            # Where it runs, not what the file says.
            for name in ('dir', 'unixsocket'):
                values.pop(name, None)
            if '--port' in args:
                values.pop('port', None)
            return {'kind': 'started', 'values': values, 'log': log}
        if timed_out:
            return {'kind': 'timeout', 'stderr': err, 'log': log}
        if 'FATAL CONFIG FILE ERROR' in err:
            return {'kind': 'config-error', 'stderr': err, 'log': log}
        return {'kind': 'failed', 'stderr': err, 'log': log, 'stdout': out[-4000:]}
    finally:
        # A server that went into the background (daemonize) names its socket, under d, in its title.
        if p is not None and p.returncode == 0:
            subprocess.run(['pkill', '-9', '-f', d], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        shutil.rmtree(d, ignore_errors=True)


def free_port():
    """A port with port + 10000 also free, for cluster mode's bus."""
    while True:
        s = socket.socket()
        s.bind(('127.0.0.1', 0))
        port = s.getsockname()[1]
        s.close()
        if port > 55535:
            continue
        t = socket.socket()
        try:
            t.bind(('127.0.0.1', port + 10000))
            return port
        except OSError:
            continue
        finally:
            t.close()


# ---- what to try ----

INTS = ['0', '1', '-1', '2', '7', '10', '100', '128', '1000', '65535', '65536', '2147483647', '2147483648', '-2147483648',
        '-2147483649', '4294967295', '4294967296', '9223372036854775807', '9223372036854775808', '-9223372036854775808',
        '-9223372036854775809', '18446744073709551615', '18446744073709551616', '99999999999999999999', '+1', '01', '00',
        '-0', '1.5', '1e3', '0x10', 'abc', '""', '" 1"', '"1 "', '1k', '1 2', '012345678901234567890']
MEMORY = ['1b', '1B', '1k', '1K', '1kb', '1KB', '1kB', '1m', '1mb', '1MB', '1g', '1gb', '1GB', '1t', '1tb', '1.5mb', '-1mb',
          'kb', 'b', 'mb', '0gb', '+1mb', '01mb', '"1 mb"', '1mbb', '17179869183gb', '17179869184gb', '17179869185gb',
          '18446744073709551615b', '18446744073709551616b', '18446744073709551615k', '9223372036854775808',
          '99999999999999999999999999gb', '1' * 127, '1' * 128 + 'mb', '"\\xff"']
PERCENT = ['0%', '1%', '10%', '100%', '101%', '200%', '1000%', '2147483647%', '9223372036854775807%', '9223372036854775808%',
           '-1%', '%', '%%', '1%%', '01%', '+1%', '1.5%', '1mb%', '" 1%"', '-0%']
OCTAL = ['0', '7', '8', '9', '10', '77', '777', '0777', '0o777', '0x1ff', '1000', '7777', '-1', '-0', '+7', ' 7', '"7 "', '""',
         '" "', '+', '-', '778', '77777777777777777777777', '1777777777777777777777', '2000000000000000000000', '700', '600', '660', '0000777']
UNSIGNED = ['" -1"', '+1', '01', '"+18446744073709551615"', '18446744073709551615', '18446744073709551616', '9223372036854775808',
            '" 5"', '"5 "', '-18446744073709551615']
BOOL = ['yes', 'no', 'YES', 'No', 'nO', 'y', 'n', '1', '0', 'true', 'on', '""', '"yes "', 'yes yes', "'yes'"]
STRING = ['abc', '""', '"a b"', 'a b', "'x y'", '"\\x41\\x00b"', '"\\xff"', '\xc3\xbc', '"a\\nb"', 'a/b', 'a\\b', '.', '..',
          'x' * 300, '"#"', '#']

# Valid values that would make the server allocate a lot or take long to start.
SAFE_MAX = {'databases': 100000, 'maxclients': 10000}
# Never in a batch: they change how or whether the server runs.
SKIP = {
    'daemonize': ['yes'], 'logfile': None, 'aclfile': None, 'cluster-enabled': ['yes', 'YES'], 'tls-port': 'nonzero',
    'tls-replication': ['yes', 'YES'], 'tls-cluster': ['yes', 'YES'], 'locale-collate': None, 'unixsocketgroup': None,
    'server-cpulist': None, 'bio-cpulist': None, 'aof-rewrite-cpulist': None, 'bgsave-cpulist': None, 'rdma-bind': None,
    'rdma-port': None, 'rdma-rx-size': None, 'syslog-enabled': ['yes', 'YES'], 'loglevel': None, 'log-format': None,
    'log-timestamp-format': None, 'oom-score-adj': None, 'preload-file': None,
}

PROC_TITLE = ['{title}', '"{title} {listen-addr} {server-mode}"', '{bogus}', '{title', 'x}', '""', '" "', '"{title} {port} {tls-port} {unixsocket} {config-file}"',
              '{server-mode}', '{}', 'plain', '"{title}{title}"', '"{TITLE}"', '"a {title} b"', '{listen-addr}', '"  {title}  "', '"{title} {"', '"}{title}"']
HOSTNAMES = ['a.b-c', 'a_b', '""', 'x' * 255, 'x' * 256, '"a b"', 'A1.b2', '-a', '1.2.3.4', '\xc3\xbc']
NODENAMES = ['node-1', '"a b"', 'a,b', 'a=b', '\'a"b\'', '"a\'b"', '"a\\\\b"', '"a\\x7fb"', '"a\\x1fb"', 'a@b', 'a!b', 'a:b', 'a.b',
             '\xc3\xbc', '""', 'x' * 300, 'a/b', 'a-b_c', 'a#b', 'a$b']
IPS = ['1.2.3.4', '::1', '2001:db8::1', 'abc', '1.2.3', '1.2.3.4.5', '256.1.1.1', '01.2.3.4', 'x' * 45, 'x' * 46, 'host.name', 'host-1',
       '""', '1.2.3.4:5', '::ffff:1.2.3.4', 'fe80::1%eth0', 'a_b', '"1.2.3.4 "', '::', ':::', '1::2::3', '1:2:3:4:5:6:7:8', '1:2:3:4:5:6:7:8:9',
       '\xc3\xbc', 'a,b', 'a b']
FILENAMES = ['dump.rdb', '""', 'a/b', '"a\\\\b"', 'a\\b', '.', '..', 'x/', '/x', 'a b', '"a b"', 'x' * 300]
SEEDS = ['abc', '""', 'x' * 64, 'x' * 65, '"a b"']
PEERNAMES = ['host', '""', '"a b"', '"a\\tb"', '" "', '"a\\nb"', 'a,b', '"  "']
PRELOAD = ['""', 'aof:/a/b.aof', 'rdb:/x.rdb', 'x', 'aof:/a//b.aof', 'aof:/a/../b.aof', 'aof:/a/./b.aof', 'rdb:/x', 'rdb:/x.', 'aof:x.aof',
           'rdb:/', 'AOF:/a.aof', 'rdb:/.x', 'rdb://x.rdb']
POWERS = ['1', '2', '3', '4', '6', '8', '1024', '1023', '0', '-1', '4294967296', '2147483648', '65536']

SPECIAL = {
    'setConfigSaveOption': ['900 1', '"900 1"', '"900 1 300 10"', '900 1 300 10', '""', '900', '900 1 300', '0 1', '1 0', '1 -1', '-1 1',
                            '900 ""', '"" 1', '900 " 1"', '900 "1 "', '900 +1', '+900 1', '900 abc', '900 1.5', '9223372036854775807 1',
                            '9223372036854775808 1', '900 2147483648', '900 4294967297', '"900 \'"', '0x10 1', '900 1x', '" 900" 1',
                            '1 9223372036854775807', '3600 1 300 100 60 10000'],
    'setConfigClientOutputBufferLimitOption': ['normal 0 0 0', 'replica 1mb 1mb 1', 'slave 256mb 64mb 60', 'pubsub 32mb 8mb 60',
                            'master 1 1 1', 'primary 1 1 1', 'NORMAL 1 1 1', 'bogus 1 1 1', 'normal 1 1', 'normal 1 1 1 pubsub 2 2 2',
                            '"normal 1 1 1"', 'normal -1 1 1', 'normal 1 -1 1', 'normal 1 1 -1', 'normal 1 1 abc', 'normal 1 1 ""',
                            'normal abc 1 1', 'normal 1.5mb 1 1', 'normal 1 1 2147483648', 'normal 1 1 4294967297', 'normal 1 1 " 5"',
                            'normal 1 1 "5 "', 'normal 1 1 +5', 'normal 1 1 1.5', 'normal 18446744073709551615 1 1',
                            'normal 18446744073709551616 1 1', 'normal "" "" ""', 'normal 1 1 1 replica 2 2 2 pubsub 3 3 3',
                            'pubsub 1 1 1 pubsub 2 2 2', 'normal 1 1 1 bogus 2 2 2', 'normal kb mb 0', 'normal 1 1 9223372036854775808'],
    'setConfigOOMScoreAdjValuesOption': ['0 200 800', '0 0 0', '-2000 0 2000', '2001 0 0', '0 0 -2001', '0 1', '0 1 2 3', '"0 200 800"',
                            '800 200 0', 'a b c', '1.5 0 0', '"" 0 0', '+1 0 0', '" 1" 0 0', '"1 " 0 0', '-1000 1000 1000', '0 4294967297 0'],
    'setConfigNotifyKeyspaceEventsOption': ['""', 'KEA', 'A', 'Kx', 'g$lshzxet', 'KEm', 'z', 'Q', 'KEAn', 'AKE', 'AA', 'KK', 'Kn', 'Km',
                            'Kd', 'Kt', 'KO', 'Ko', 'KS', 'KN', 'Kv', 'KV', 'KEA ', '"K E"', 'K E', 'k', 'e', 'KEgmn', 'Ehx',
                            'KEA$lshzxetdmno', 'KEAmnd'],
    'setConfigBindOption': ['127.0.0.1', '127.0.0.1 ::1', '"* -::*"', '""', ' '.join('127.0.0.%d' % i for i in range(1, 17)),
                            ' '.join('127.0.0.%d' % i for i in range(1, 18)), '"127.0.0.1 ::1"', 'bogus', '"" ""', '-127.0.0.1'],
    'setConfigLatencyTrackingInfoPercentilesOutputOption': ['50 99 99.9', '""', '0 100', '100.1', '-1', 'abc', '1e2', '0x10', 'inf',
                            'nan', '-inf', '50 99 99.9 99.99 99.999', '99.9999999', '+50', '"50 99"', '1e-400', '1e400', '.5', '5.',
                            '0x1p3', '1_0', '50 abc', '50 101', '-0', '100', '0', '99.123456789', '1e-7', '0.0000001', '"" 50',
                            '50.0000004', '50.0000005', '33.3333335', '1E2', '0X10', ' 50', '0x', '1e', '1e+', 'infinity', 'NaN', '00050'],
}
SPECIAL['setConfigSocketBindOption'] = SPECIAL['setConfigBindOption']


def numeric_probes(c):
    lo, hi = int(c['lower']), int(c['upper'])
    vals = list(INTS)
    for x in (lo, hi, lo - 1, hi + 1, lo + 1, hi - 1):
        vals.append(str(x))
    flags = c['numflags']
    if 'MEMORY_CONFIG' in flags:
        vals += MEMORY
    if 'PERCENT_CONFIG' in flags:
        vals += PERCENT
    if 'OCTAL_CONFIG' in flags:
        vals += OCTAL
    if 'UNSIGNED_CONFIG' in flags:
        vals += UNSIGNED
    if c.get('valid') in ('isValidArraySliceSize', 'isValidArraySparseKmax', 'isValidArraySparseKmin'):
        vals += POWERS
    out = []
    for x in vals:
        if c['name'] in SAFE_MAX and re.fullmatch(r'-?\d+', x) and lo <= int(x) <= hi and int(x) > SAFE_MAX[c['name']]:
            continue
        if x not in out:
            out.append(x)
    return out


def string_probes(c):
    v = c.get('valid')
    if v == 'isValidProcTitleTemplate':
        return PROC_TITLE + ['"' + 'x' * 300 + '"']
    if v == 'isValidAnnouncedHostname':
        return HOSTNAMES
    if v == 'isValidAnnouncedNodename':
        return NODENAMES
    if v in ('isValidAnnouncedIp', 'isValidClusterAnnounceIp', 'isValidIpV4', 'isValidIpV6'):
        return IPS
    if v in ('isValidDBfilename', 'isValidAOFfilename', 'isValidAOFdirname', 'isValidBackupdirname', 'isValidClusterConfigFile'):
        return FILENAMES
    if v == 'isValidDbHashSeed':
        return SEEDS
    if v == 'isValidTlsExpectedPeerName':
        return PEERNAMES
    if v == 'isValidPreloadFile':
        return PRELOAD
    return STRING


def enum_probes(c, version):
    names = [n for n, _ in version['enums'][c['enum']]]
    vals = list(names) + ['bogus', '""', names[0].upper(), names[0] + ' ' + names[-1], '"' + names[0] + ' ' + names[-1] + '"',
                          names[0] + ' ' + names[0], '"' + names[0] + '"', names[0][:-1] if len(names[0]) > 1 else 'x']
    if 'MULTI_ARG_CONFIG' in c['flags']:
        for a in names:
            for b in names:
                if a < b:
                    vals.append(a + ' ' + b)
    out = []
    for x in vals:
        if x not in out:
            out.append(x)
    return out


def probes(c, version):
    """The values to try for one config, as the text after its name."""
    t = c['type']
    if t == 'bool':
        return BOOL
    if t == 'numeric':
        return numeric_probes(c)
    if t in ('string', 'sds'):
        return string_probes(c)
    if t == 'enum':
        return enum_probes(c, version)
    if t == 'special':
        return SPECIAL.get(c['set'], [])
    return []


def skipped(name, value):
    rule = SKIP.get(name, False)
    if rule is False:
        return False
    if rule is None:
        return True
    a = split_args(value) or ['']
    word = a[0].lower() if a else ''
    if rule == 'nonzero':
        return re.fullmatch(r'0*[1-9][0-9]*', word) is not None
    return word in rule


def batches(version):
    """Lines for batches: per config, its probes; then round robin, so each batch has each config once."""
    per = []
    for c in version['configs']:
        if not c['present'] and not (c.get('build') == 'tls' and version['version'] in NO_TLS):
            continue
        if c['type'] == 'special' and c['set'] in ('setConfigDirOption', 'setConfigReplicaOfOption'):
            continue
        lines = []
        for value in probes(c, version):
            if skipped(c['name'], value):
                continue
            lines.append(c['name'] + ' ' + value)
        # The same config by its other names and cases, and with no value or two.
        lines.append(c['name'].upper() + ' ' + first_valid(c, version))
        if c.get('alias') and not skipped(c['alias'], first_valid(c, version)):
            lines.append(c['alias'] + ' ' + first_valid(c, version))
        lines.append(c['name'])
        if 'MULTI_ARG_CONFIG' not in c['flags']:
            lines.append(c['name'] + ' ' + first_valid(c, version) + ' ' + first_valid(c, version))
        per.append([l for l in lines if not skipped(c['name'], l.split(' ', 1)[1] if ' ' in l else '')])
    out = []
    depth = max(len(x) for x in per)
    for i in range(depth):
        out.append([x[i] for x in per if i < len(x)])
    return out


def first_valid(c, version):
    t = c['type']
    if t == 'bool':
        return 'no'
    if t == 'numeric':
        lo, hi = int(c['lower']), int(c['upper'])
        if 'OCTAL_CONFIG' in c['numflags']:
            return '700'
        return str(max(lo, min(hi, 1)))
    if t == 'enum':
        return version['enums'][c['enum']][0][0]
    if t == 'special':
        return {'setConfigSaveOption': '900 1', 'setConfigClientOutputBufferLimitOption': 'normal 0 0 0', 'setConfigOOMScoreAdjValuesOption': '0 200 800',
                'setConfigNotifyKeyspaceEventsOption': 'KEA', 'setConfigBindOption': '127.0.0.1', 'setConfigSocketBindOption': '127.0.0.1',
                'setConfigRdmaBindOption': '127.0.0.1', 'setConfigLatencyTrackingInfoPercentilesOutputOption': '50',
                'setConfigDirOption': '.', 'setConfigReplicaOfOption': 'no one'}[c['set']]
    v = c.get('valid')
    if v in ('isValidAnnouncedIp', 'isValidClusterAnnounceIp', 'isValidIpV4'):
        return '1.2.3.4'
    if v == 'isValidIpV6':
        return '::1'
    if v == 'isValidProcTitleTemplate':
        return '{title}'
    if v == 'isValidPreloadFile':
        return 'rdb:/x.rdb'
    return 'abc'


# Hand-written files: things that touch each other, directives, and how lines are read.
def cases(version):
    vid = version['version']
    names = {c['name'] for c in version['configs'] if c['present']}
    out = []
    def case(name, lines, args=(), when=True):
        if when:
            out.append({'name': name, 'lines': lines, 'args': list(args)})
    # How a line is read: quotes, escapes, spaces, comments. syslog-ident takes any string and CONFIG GET shows it.
    for i, t in enumerate(['"a b"', "'a b'", '"a\\"b"', "'a\\'b'", '"a\\nb"', '"a\\tb"', '"a\\rb"', '"a\\bb"', '"a\\ab"', '"a\\x41b"',
                           '"a\\x4gb"', '"a\\xb"', '"a\\\\b"', '"a\\qb"', '"abc', "'abc", '"abc"def', "'abc'def", 'abc"def"', "abc'def'",
                           '""', "''", '"" x', '"a"b', '"a" b', 'a\\b', '"\\x00"', '"a\\x00b"', '\xc3\xa9', '\xff', 'a\x0bb', '\x0ba',
                           'a\x0c', '"a"\x0b', '"a"\x0c', "'a'\x0b", '"a\\', "'a\\", '"a\\\'b"', "'a\\\"b'", 'a"b c"d', '"\\x41"', '"\\X41"',
                           '"\\x"', '"\\x4"', '"\\xff\\xfe"', "''x", '"a\\x20b"', 'a\rb', 'a\r', '\ra', '"a\rb"', "'a\rb'", 'a#b', '#a',
                           '"#a"', '"a b" "c d"', '"\\\\"', "'\\\\'", "'\\'", '"\\"', '"\\x41\\x42"', '"a""b"', "'a''b'"]):
        case('read %d' % i, ['syslog-ident ' + t])
    for i, lines in enumerate([
            [''], [], ['# just a comment'], ['   # indented comment'], ['#maxmemory 1mb'], ['maxmemory 1mb # comment'],
            ['\t\tmaxmemory 1mb'], ['maxmemory\t1mb'], ['maxmemory 1mb\r'], [' \r'], ['\x0b'], ['\x0c'], ['\x0cmaxmemory 1mb'],
            ['\x0c# comment'], ['\xef\xbb\xbfmaxmemory 1mb'], ['MaxMemory 1mb'], ['maxmemory\x0b 1mb'], ['maxmemory 1mb\x0b'],
            ['maxmemory \x0c1mb'], ['  maxmemory   1mb  '], ['maxmemory 1mb', '', '', 'maxmemory 2mb'], ['"maxmemory" 1mb'],
            ["'maxmemory' 1mb"], ['"max"memory 1mb'], ['\\maxmemory 1mb'], ['maxmemory 1mb\x00junk', 'maxmemory 3mb'],
            ['maxmemory 1mb\x00', 'maxmemory 3mb'], ['\x00maxmemory 1mb', 'maxmemory 3mb'], ['syslog-ident ' + 'a' * 2000],
            ['syslog-ident ' + 'a' * 1020 + '\x00bc', 'maxmemory 3mb'], ['syslog-ident ' + 'a' * 1010 + '\x00' + 'b' * 20, 'maxmemory 3mb'],
            ['maxmemory 1mb\r\nmaxmemory-policy allkeys-lru\r'], ['# \xff\xfe comment'], ['"unbalanced'], ['maxmemory "1mb'],
            ['maxmemory 1mb', '"unbalanced', 'maxmemory 2mb'], ['maxmemory 1mb # "unbalanced'], ['maxmemory\r1mb'], ['maxmemory\n1mb'],
            ['maxmemory 1mb \\'], ['maxmemory "1m"b'], ['maxmemory 1"m"b'], ['maxmemory "" '], ['maxmemory'], ['maxmemory 1mb 2mb'],
            ['MAXMEMORY-POLICY ALLKEYS-LRU'], ['maxmemory-policy "allkeys-lru"'], ['maxmemory-policy allkeys-lru', 'maxmemory-policy noeviction']]):
        case('lines %d' % i, lines)
    # File endings and line breaks.
    out.append({'name': 'no final newline', 'raw': 'maxmemory 1mb\nmaxmemory-policy allkeys-lru', 'args': []})
    out.append({'name': 'crlf', 'raw': 'maxmemory 1mb\r\nmaxmemory-policy allkeys-lru\r\n', 'args': []})
    out.append({'name': 'cr only', 'raw': 'maxmemory 1mb\rmaxmemory-policy allkeys-lru\r', 'args': []})
    out.append({'name': 'empty file', 'raw': '', 'args': []})
    out.append({'name': 'nul then newline', 'raw': 'maxmemory 1mb\x00\nmaxmemory 2mb\n', 'args': []})
    out.append({'name': 'nul at end', 'raw': 'maxmemory 2mb\nhz 20\x00', 'args': []})
    out.append({'name': 'long line nul', 'raw': 'syslog-ident ' + 'a' * 1011 + '\x00xyz\nhz 20\n', 'args': []})
    out.append({'name': 'long line nul 2', 'raw': 'syslog-ident ' + 'a' * 1011 + 'b\x00xyz\nhz 20\n', 'args': []})
    out.append({'name': 'long line nul 3', 'raw': 'hz 20\nsyslog-ident ' + 'a' * 1500 + '\x00xyz\nhz 30\n', 'args': []})
    # Old names this version ignores, with the right and wrong number of arguments.
    for name, lo, hi in version['deprecated']:
        for n in sorted({lo - 1, lo, hi, hi + 1}):
            if n >= 1:
                case('deprecated %s %d' % (name, n), [' '.join([name] + ['1'] * (n - 1))])
        case('deprecated upper ' + name, [name.upper() + ' 1'])
    for name in ['list-max-ziplist-entries', 'list-max-ziplist-value', 'lua-replicate-commands', 'io-threads-do-reads', 'dynamic-hz',
                 'events-per-io-thread', 'sanitize-dump-payload', 'hash-max-ziplist-entries', 'slave-read-only', 'lua-time-limit']:
        case('old name ' + name, [name + ' 1'])
        case('old name yes ' + name, [name + ' yes'])
    # Directives.
    for i, lines in enumerate([
            ['rename-command get foo'], ['rename-command get ""'], ['rename-command nosuch foo'], ['rename-command get set'],
            ['rename-command GET Foo', 'rename-command FOO bar'], ['rename-command get foo', 'rename-command foo bar'],
            ['rename-command get foo', 'rename-command set foo'], ['rename-command get ""', 'rename-command get x'], ['rename-command get'],
            ['rename-command get foo bar'], ['rename-command'], ['rename-command get GET'], ['rename-command get Set'],
            ['rename-command get foo', 'rename-command set get'], ['rename-command config|get foo'], ['rename-command config| foo'],
            ['rename-command |get foo'], ['rename-command config|nosuch foo'], ['rename-command get x|y'], ['rename-command get "a b"'],
            ['rename-command get \xc3\xa9'], ['rename-command flushall ""', 'rename-command flushdb ""', 'rename-command keys ""'],
            ['rename-command get foo', 'rename-command get bar'],
            ['include'], ['include a b'], ['loadmodule'], ['user'], ['user default on nopass ~* &* +@all'], ['user alice on >secret ~* +@all'],
            ['user alice', 'user bob on'], ['user alice on nopass ~* +@all', 'user alice off'], ['sentinel'], ['sentinel monitor m 127.0.0.1 6379 2'],
            ['sentinel foo'], ['SENTINEL'], ['bogus'], ['bogus 1'], ['bogus 1 2'], ['bogus.thing'], ['bogus.thing 1'], ['bogus.thing 1 2'],
            ['bogus.thing 1', 'bogus.thing 2'], ['bogus.thing 1', 'other.thing 2'], ['bogus 1', 'bogus.x 2'], ['.x 1'], ['x. 1'], ['a.b.c 1'],
            ['bogus.thing ""'], ['BOGUS.THING 1'], ['save', 'bogus.x 1'], ['bogus 1', 'maxmemory-policy bogus'], ['maxmemory-policy bogus', 'bogus 1'],
            ['aclfile users.acl', 'user alice on nopass ~* +@all'], ['aclfile ""', 'user alice on nopass ~* +@all'],
            ['aclfile users.acl', 'bogus.x 1', 'user alice on nopass ~* +@all'],
            ['watchdog-period 10'], ['slaveof no one'], ['replicaof no one'], ['replicaof NO ONE'], ['replicaof no'], ['replicaof a b c'],
            ['replicaof 127.0.0.1 1'], ['replicaof 127.0.0.1 0'], ['replicaof 127.0.0.1 65535'], ['replicaof 127.0.0.1 65536'],
            ['replicaof 127.0.0.1 -1'], ['replicaof 127.0.0.1 abc'], ['replicaof 127.0.0.1 ""'], ['replicaof 127.0.0.1 4294967297'],
            ['replicaof 127.0.0.1 " 1"'], ['replicaof 127.0.0.1 "1 "'], ['replicaof 127.0.0.1 +1'], ['replicaof 127.0.0.1 1.5'],
            ['replicaof "127.0.0.1 1"'], ['replicaof "127.0.0.1"'], ['replicaof "" 1'], ['slaveof 127.0.0.1 1'], ['replicaof 127.0.0.1 1', 'replicaof no one'],
            ['replicaof 127.0.0.1 9223372036854775808'], ['replicaof 127.0.0.1 -4294967295'], ['replicaof 127.0.0.1 1', 'slaveof 127.0.0.2 2'],
            ['replicaof no one', 'replicaof 127.0.0.1 1'], ['replicaof "no one"'], ['replicaof 127.0.0.1 01'], ['replicaof ::1 1'],
            ['dir ""'], ['dir .'], ['dir "."'], ['dir ./'], ['dir . .'], ['dir'], ['logfile ""'], ['pidfile ""'], ['unixsocket ""'],
            ['port 0'], ['port 6380'], ['port -1'], ['port 65536'], ['port abc'], ['port 4294967296'],
            ['cluster-enabled yes', 'replicaof 127.0.0.1 1'], ['replicaof 127.0.0.1 1', 'cluster-enabled yes'],
            ['cluster-enabled yes', 'replicaof 127.0.0.1 1', 'replicaof no one'], ['cluster-enabled yes', 'slaveof 127.0.0.1 1', 'hz 0'],
            ['cluster-enabled yes', 'replicaof 127.0.0.1 1', 'maxmemory-policy bogus'], ['hz 0'], ['hz 1000'], ['hz 500'], ['hz 501'], ['hz -1'],
            ['hz 2147483647'], ['hz 0', 'hz 20'], ['io-threads 0'], ['io-threads 1'], ['io-threads 128'], ['io-threads 129'], ['io-threads 200'],
            ['io-threads 256'], ['io-threads 2147483647'], ['save 900 1', 'save 300 10'], ['save ""', 'save 900 1'], ['save 900 1', 'save ""'],
            ['save 900 1', 'save'], ['save 900'], ['save 900 1 300'], ['save 900 1', 'save 900'], ['save', 'save 900 1'], ['save "900 \'"'],
            ['save 900 1', 'save "900 \'"'], ['save 900 1', 'save "" ""'], ['save "" ""'], ['save 900 1 300 10', 'save 60 10000'],
            ['save 900 ""'], ['save "" 1'], ['save 900 1 ""'], ['save 0 0'], ['save 1 0'], ['save abc def'], ['save " 900" 1'],
            ['client-output-buffer-limit normal 1 1 1', 'client-output-buffer-limit pubsub 2 2 2'],
            ['client-output-buffer-limit normal 1 1 1', 'client-output-buffer-limit normal 2 2 2'],
            ['client-output-buffer-limit normal 1mb 1mb 1 extra'], ['client-output-buffer-limit normal 1 1 1 pubsub 2 2'],
            ['client-output-buffer-limit "normal 1 1 1 pubsub 2 2 2"'], ['client-output-buffer-limit ""'], ['client-output-buffer-limit'],
            ['client-output-buffer-limit normal 1 1 1 normal 2 2 2'], ['client-output-buffer-limit normal -1 -1 1'],
            ['oom-score-adj-values 800 200 0'], ['oom-score-adj-values 0 200 800', 'oom-score-adj-values 1 2 3'], ['oom-score-adj-values ""'],
            ['oom-score-adj-values "0 200"'], ['oom-score-adj-values 0 0 -1'],
            ['notify-keyspace-events KEA', 'notify-keyspace-events ""'], ['notify-keyspace-events'], ['notify-keyspace-events K E'],
            ['bind 127.0.0.1', 'bind ""'], ['bind'], ['bind ""', 'bind 127.0.0.1 ::1'],
            ['latency-tracking-info-percentiles 50 abc'], ['latency-tracking-info-percentiles 50 101', 'latency-tracking-info-percentiles 1'],
            ['latency-tracking-info-percentiles "50 99"', 'latency-tracking-info-percentiles ""'], ['latency-tracking-info-percentiles'],
            ['shutdown-on-sigint save nosave'], ['shutdown-on-sigint "save nosave"'], ['shutdown-on-sigint default save'],
            ['shutdown-on-sigint now force'], ['shutdown-on-sigint ""'], ['shutdown-on-sigint'], ['shutdown-on-sigterm "now  force"'],
            ['maxmemory-clients 10%', 'maxmemory-clients 1mb'], ['appendonly yes', 'appenddirname ""'], ['appendonly yes', 'appendfilename ""'],
            ['dbfilename ""'], ['appendfilename ""'], ['appenddirname ""'], ['cluster-config-file ""'],
            ['array-sparse-kmax 10', 'array-sparse-kmin 20'], ['array-sparse-kmin 20', 'array-sparse-kmax 10'], ['array-sparse-kmin 5', 'array-sparse-kmax 5'],
            ['array-sparse-kmax 0', 'array-sparse-kmin 100'], ['array-sparse-kmax 100', 'array-sparse-kmin 99'],
            ['tls-port 0'], ['tls-port 1'], ['tls-replication no'], ['tls-cluster no'], ['repl-compression 1'], ['repl-compression-max-latency 5'],
            ['enable-debug-command yes', 'enable-module-command local', 'enable-protected-configs yes'],
            ['protected-mode no'], ['requirepass abc'], ['requirepass ""'], ['masterauth abc'], ['primaryauth abc'], ['masteruser u'],
            ['databases 0'], ['databases 1'], ['databases 16'], ['databases 100000'], ['databases -1'], ['databases 2147483648'],
            ['maxclients 1'], ['maxclients 0'], ['maxclients 10000'], ['maxclients 4294967296'],
            ['locale-collate ""'], ['locale-collate C'], ['locale-collate POSIX'], ['locale-collate bogus'],
            ['supervised no'], ['supervised bogus'], ['supervised NO'], ['oom-score-adj no'], ['oom-score-adj bogus'], ['oom-score-adj yes'],
            ['oom-score-adj relative'], ['oom-score-adj absolute', 'oom-score-adj-values 0 100 200'], ['loglevel bogus'], ['loglevel debug'],
            ['loglevel nothing'], ['syslog-enabled no'], ['syslog-enabled bogus'], ['daemonize no'], ['daemonize bogus'], ['daemonize'],
            ['logfile'], ['logfile a b'], ['aclfile'], ['unixsocketperm 700'], ['unixsocketperm -1'], ['unixsocketperm 777abc'],
            ['unixsocketperm ""'], ['unixsocketperm 1000'], ['unixsocketperm 0777'], ['unixsocketperm 8'], ['unixsocketperm abc'],
            ['unixsocketperm 77777777777777777777777'], ['unixsocketperm " 7"'], ['unixsocketperm 4294967296'], ['unixsocketperm -4294966785'],
            ['cluster-config-file nodes.conf'], ['cluster-config-file a b'], ['cluster-announce-ip 1.2.3.4'],
            ['proc-title-template "{title}"', 'set-proc-title no'], ['hash-seed abc'], ['hash-seed ' + 'x' * 65],
            ['repl-backlog-size 1mb', 'repl-backlog-size 2mb'], ['maxmemory 1mb', 'MAXMEMORY 2mb', 'maxmemory 3mb'],
            ['slave-read-only no', 'replica-read-only yes'], ['replica-read-only no', 'slave-read-only yes']]):
        case('directive %d' % i, lines)
    # Settings whose values do something at startup: one file each.
    for c in version['configs']:
        if not c['present']:
            continue
        if c['name'] in ('locale-collate', 'preload-file', 'unixsocketgroup', 'server-cpulist', 'bio-cpulist', 'aof-rewrite-cpulist',
                         'bgsave-cpulist', 'loglevel', 'log-format', 'log-timestamp-format', 'syslog-facility', 'oom-score-adj'):
            vals = probes(c, version) if c['type'] != 'string' else ['""', 'abc', '0', '0-1', '0,1', '1-0', 'C', 'POSIX', 'en_US.UTF-8', 'a b', '"a b"']
            if c['name'] == 'preload-file':
                vals = PRELOAD
            for value in vals:
                case('startup %s %s' % (c['name'], value), [c['name'] + ' ' + value])
    # Settings of modules built into the server (Redis 8.2's vector sets).
    internal = (version['features'].get('internalModules') or {}).get('configs') or []
    for name, kind in internal:
        for value in ['yes', 'no', 'YES', 'bogus', '""', '"yes no"', 'yes no', '1']:
            case('internal %s %s' % (name, value), [name + ' ' + value])
        case('internal %s twice' % name, [name + ' yes', name + ' no'])
        case('internal %s with other' % name, [name + ' yes', 'bogus.thing 1'])
        case('internal %s upper' % name, [name.upper() + ' yes'])
        case('internal %s alone' % name, [name])
    # Bytes 0xff, which Valkey 8.1 and later drop.
    for i, t in enumerate(['"\xff"', '"a\xffb"', "'\xff'", '"\\\xff"', 'a\xffb', '"\\xff"', '"\\xFF"', '\xff\xff', '"\xfe"']):
        case('byte ff %d' % i, ['syslog-ident ' + t])
    case('byte ff name', ['maxmemory\xff 1mb'])
    # Redis 8's I/O threads and the file descriptors maxclients leaves them.
    for threads, clients in [(8, 1), (16, 1), (32, 1), (40, 1), (43, 1), (44, 1), (48, 1), (64, 64), (80, 1), (128, 128), (128, 10000), (4, 1)]:
        case('io threads %d %d' % (threads, clients), ['io-threads %d' % threads, 'maxclients %d' % clients])
    case('unixsocketgroup empty', ['unixsocketgroup ""'])
    # Cluster mode, which needs a port with a free bus port.
    case('cluster databases', ['cluster-enabled yes', 'databases 16'], ['cluster'])
    case('cluster databases 1', ['cluster-enabled yes', 'databases 1'], ['cluster'])
    case('cluster databases 0', ['cluster-enabled yes', 'databases 0'], ['cluster'])
    case('cluster default', ['cluster-enabled yes'], ['cluster'])
    case('cluster replicaof no one', ['cluster-enabled yes', 'replicaof no one'], ['cluster'])
    return out


# ---- recording ----

def baseline_diff(values, baseline):
    """CONFIG GET values that differ from the version's defaults, and names that come or go."""
    diff = {k: v for k, v in values.items() if baseline.get(k) != v}
    gone = [k for k in baseline if k not in values]
    if gone:
        diff['__gone'] = gone
    return diff


def fatal(version, stderr):
    """Splits the server's fatal message into line, text and message when it has the usual shape."""
    label = ('Version ' if version.startswith('valkey') else 'Redis ') + version.split('-')[1]
    head = '\n*** FATAL CONFIG FILE ERROR (' + label + ') ***\n'
    if not stderr.startswith(head):
        return {'stderr': stderr}
    rest = stderr[len(head):]
    m = re.match(r"Reading the configuration file, at line (\d+)\n>>> '(.*)'\n(.*)\n\Z", rest, re.S)
    if m:
        text, message = m.group(2), m.group(3)
        if head + "Reading the configuration file, at line %s\n>>> '%s'\n%s\n" % (m.group(1), text, message) == stderr and '\n' not in message:
            return {'line': int(m.group(1)), 'text': text, 'message': message}
    if rest.endswith('\n') and '\n' not in rest[:-1]:
        return {'line': None, 'message': rest[:-1]}
    return {'stderr': stderr}


def outcome(version, r, baseline):
    """A run's result, small: the error, or the values that differ from the defaults."""
    o = {}
    if r['kind'] == 'started':
        o['values'] = baseline_diff(r['values'], baseline['values'])
    elif r['kind'] == 'config-error':
        o['error'] = fatal(version, r['stderr'])
    else:
        o['failed'] = r['stderr'] if r['stderr'] else None
    log = [l for l in r['log'] if l not in baseline['log']]
    if log:
        o['log'] = log
    return o


def record_version(vid):
    version = next(v for v in SERVERS if v['version'] == vid)
    t0 = time.time()
    base = run(vid, [])
    assert base['kind'] == 'started', (vid, base)
    baseline = {'values': base['values'], 'log': base['log']}
    result = {'tls': vid not in NO_TLS, 'baseline': base['values'], 'baselineLog': base['log'], 'batches': [], 'cases': []}
    runs = 1
    for lines in batches(version):
        removed = []
        outcomes = []
        while True:
            keep = [l for i, l in enumerate(lines) if i not in removed]
            r = run(vid, keep)
            runs += 1
            o = outcome(vid, r, baseline)
            outcomes.append(o)
            if r['kind'] == 'config-error' and o['error'].get('line'):
                # The line that stopped it, as an index into the batch.
                idx = [i for i in range(len(lines)) if i not in removed][o['error']['line'] - 1]
                removed.append(idx)
                continue
            break
        result['batches'].append({'lines': lines, 'removed': removed, 'runs': outcomes})
        if 'values' not in outcomes[-1]:
            # It didn't start: try what's left one line at a time.
            for i, l in enumerate(lines):
                if i in removed:
                    continue
                r = run(vid, [l])
                runs += 1
                result['cases'].append({'name': 'batch line', 'lines': [l], 'args': [], 'result': outcome(vid, r, baseline)})
    for c in cases(version):
        args = []
        if 'cluster' in c['args']:
            port = free_port()
            args = ['--port', str(port)]
        raw = c.get('raw')
        r = run(vid, raw if raw is not None else c['lines'], args)
        runs += 1
        entry = {'name': c['name'], 'args': c['args'], 'result': outcome(vid, r, baseline)}
        if raw is not None:
            entry['raw'] = raw
        else:
            entry['lines'] = c['lines']
        result['cases'].append(entry)
    print(vid, runs, 'runs in', round(time.time() - t0), 's', file=sys.stderr)
    return vid, result


def main():
    wanted = sys.argv[1:] or [v['version'] for v in SERVERS]
    out = {}
    if os.path.exists(OUT) and sys.argv[1:]:
        out = json.load(gzip.open(OUT, 'rt'))['versions']
    with ThreadPoolExecutor(max_workers=os.cpu_count() or 2) as pool:
        for vid, result in pool.map(record_version, wanted):
            out[vid] = result
    with gzip.open(OUT, 'wt', compresslevel=9) as f:
        json.dump({'versions': {k: out[k] for k in sorted(out)}}, f, sort_keys=True, separators=(',', ':'))
    print(OUT, os.path.getsize(OUT), 'bytes', file=sys.stderr)


if __name__ == '__main__':
    main()
