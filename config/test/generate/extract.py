# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 KeyValueStore.com
#
# Reads each server version's config table out of its source code
# (src/config.c): every config's name, alias, type, flags, bounds and enum
# values, and the old names the server accepts and ignores; and, from the
# loader, parsers and checks, how the version behaves where versions differ.
# Then asks each built server for its defaults (CONFIG GET) and commands
# (COMMAND). Writes test/fixtures/servers.json.gz, which make-data.js turns
# into servers.js.
#
#   KV_SRC=/opt/kvsrc KV_BIN=/opt/kv python3 config/test/generate/extract.py
#
# KV_SRC holds the source trees (redis-7.2.16/, valkey-9.1.2/, ...) and
# KV_BIN the built servers (redis-7.2.16/redis-server, ...).

import glob, gzip, json, os, re, socket, subprocess, sys, tempfile, time

SRC = os.environ.get('KV_SRC', '/opt/kvsrc')
BIN = os.environ.get('KV_BIN', '/opt/kv')
HERE = os.path.dirname(os.path.abspath(__file__))

LIMITS = {
    'INT_MAX': 2**31 - 1, 'INT_MIN': -2**31, 'UINT_MAX': 2**32 - 1, 'LONG_MAX': 2**63 - 1, 'LONG_MIN': -2**63,
    'LLONG_MAX': 2**63 - 1, 'LLONG_MIN': -2**63, 'ULONG_MAX': 2**64 - 1, 'ULLONG_MAX': 2**64 - 1, 'SIZE_MAX': 2**64 - 1,
    'SSIZE_MAX': 2**63 - 1, 'LONG_LONG_MAX': 2**63 - 1, 'INT32_MAX': 2**31 - 1, 'UINT32_MAX': 2**32 - 1, 'INT64_MAX': 2**63 - 1,
    # <syslog.h> on Linux
    'LOG_USER': 1 << 3, **{'LOG_LOCAL%d' % i: (16 + i) << 3 for i in range(8)},
}


def version_key(v):
    name, num = v.split('-')
    return (name, [int(x) for x in num.split('.')])


def strip_comments(s):
    s = re.sub(r'/\*.*?\*/', ' ', s, flags=re.S)
    return re.sub(r'//[^\n]*', ' ', s)


def defines(srcdir):
    """Object-like #defines from the server's headers and C files."""
    out = {}
    for f in sorted(glob.glob(os.path.join(srcdir, '*.h')) + glob.glob(os.path.join(srcdir, '*.c'))):
        text = strip_comments(open(f, errors='replace').read())
        text = re.sub(r'\\\n', ' ', text)
        for m in re.finditer(r'^[ \t]*#[ \t]*define[ \t]+(\w+)[ \t]+([^\n]*)$', text, re.M):
            name, val = m.group(1), strip_comments(m.group(2)).strip()
            if val and name not in out:
                out[name] = val
        # C enum constants: NAME or NAME = value, counting up from the last value.
        for m in re.finditer(r'\benum\s*\w*\s*\{([^{}]*)\}', text):
            n = 0
            for item in m.group(1).split(','):
                item = item.strip()
                mm = re.match(r'^([A-Za-z_]\w*)\s*(?:=\s*(.+))?$', item, re.S)
                if not mm:
                    continue
                if mm.group(2):
                    try:
                        n = evaluate(mm.group(2), out)
                    except (ValueError, SyntaxError, NameError):
                        break
                if mm.group(1) not in out:
                    out[mm.group(1)] = str(n)
                n += 1
    return out


def evaluate(expr, defs, depth=0):
    """A C integer expression, macros and casts resolved."""
    if depth > 20:
        raise ValueError('too deep: ' + expr)
    e = expr.strip()
    def sub(m):
        w = m.group(0)
        if w in LIMITS:
            return '(' + str(LIMITS[w]) + ')'
        if w in defs:
            return '(' + str(evaluate(defs[w], defs, depth + 1)) + ')'
        return w
    e = re.sub(r'\((?:unsigned |signed )?(?:long long|long|int|size_t|ssize_t|time_t|off_t|mode_t|uint64_t|int64_t)\)', '', e)
    e = re.sub(r'(?<=\d)(?:ULL|LL|UL|LU|U|L)\b', '', e, flags=re.I)
    e = re.sub(r'\b[A-Za-z_]\w*\b', sub, e)
    if re.search(r'(?<![0-9])[A-Za-z_]', e.replace('0x', '').replace('0X', '')):
        raise ValueError('unresolved: ' + expr + ' -> ' + e)
    e = re.sub(r'\b0([0-7]+)\b', r'0o\1', e)  # C octal
    e = e.replace('/', '//')
    return int(eval(e))


def split_top(s, sep=','):
    """Splits on sep outside parentheses, braces and string literals."""
    out, depth, cur, i, q = [], 0, [], 0, None
    while i < len(s):
        c = s[i]
        if q:
            cur.append(c)
            if c == '\\':
                cur.append(s[i + 1]); i += 2; continue
            if c == q:
                q = None
        elif c in '"\'':
            q = c; cur.append(c)
        elif c in '({[':
            depth += 1; cur.append(c)
        elif c in ')}]':
            depth -= 1; cur.append(c)
        elif c == sep and depth == 0:
            out.append(''.join(cur).strip()); cur = []
        else:
            cur.append(c)
        i += 1
    if ''.join(cur).strip():
        out.append(''.join(cur).strip())
    return out


def c_string(tok):
    tok = tok.strip()
    if tok == 'NULL':
        return None
    parts = re.findall(r'"((?:[^"\\]|\\.)*)"', tok)
    if not parts:
        return None
    return ''.join(bytes(p, 'utf-8').decode('unicode_escape') for p in parts)


def table(text, start_pat):
    m = re.search(start_pat, text)
    i = text.index('{', m.end() - 1) + 1
    depth = 1
    j = i
    while depth:
        if text[j] == '{':
            depth += 1
        elif text[j] == '}':
            depth -= 1
        j += 1
    return text[i:j - 1]


NUMERIC = {'createIntConfig': 'int', 'createUIntConfig': 'uint', 'createLongConfig': 'long', 'createULongConfig': 'ulong',
           'createLongLongConfig': 'longlong', 'createULongLongConfig': 'ulonglong', 'createSizeTConfig': 'size_t',
           'createSSizeTConfig': 'ssize_t', 'createTimeTConfig': 'time_t', 'createOffTConfig': 'off_t'}


def extract(version):
    srcdir = os.path.join(SRC, version, 'src')
    raw = open(os.path.join(srcdir, 'config.c'), errors='replace').read()
    defs = defines(srcdir)
    text = strip_comments(raw)
    body = table(text, r'standardConfig (?:static_)?configs\[\]\s*=\s*\{')
    # Conditional parts: debug builds only (dropped), TLS and compression builds (kept, marked).
    lines, cond = [], []
    for line in body.split('\n'):
        s = line.strip()
        m = re.match(r'#\s*(ifdef|ifndef|if|else|endif)\s*(\w*)', s)
        if m:
            if m.group(1) in ('ifdef', 'if', 'ifndef'):
                cond.append(m.group(2))
            elif m.group(1) == 'endif':
                cond.pop()
            continue
        if 'LOG_REQ_RES' in cond:
            continue
        tag = [c for c in cond if c in ('USE_OPENSSL', 'USE_COMPRESSION')]
        lines.append((line, tag[0] if tag else None))
    entries = []
    joined = ''
    tags = []
    for line, tag in lines:
        joined += line + '\n'
        tags.append((len(joined), tag))
    pos = 0
    for part in split_top(joined):
        if not part.startswith('create'):
            continue
        at = joined.index(part, pos)
        pos = at + len(part)
        tag = None
        for end, t in tags:
            if end >= at:
                tag = t
                break
        m = re.match(r'(create\w+Config)\s*\((.*)\)\s*$', part, re.S)
        if not m:
            raise ValueError('cannot read ' + part[:80])
        kind, args = m.group(1), split_top(m.group(2))
        e = {'name': c_string(args[0]), 'alias': c_string(args[1]), 'flags': sorted(re.findall(r'[A-Z_]+', args[2]))}
        if tag:
            e['build'] = {'USE_OPENSSL': 'tls', 'USE_COMPRESSION': 'compression'}[tag]
        # The default as written in the source, for configs the built servers don't have.
        if kind == 'createBoolConfig':
            e.update(type='bool', valid=args[5], apply=args[6], sourceDefault='yes' if evaluate(args[4], defs) else 'no')
        elif kind in ('createStringConfig', 'createSDSConfig'):
            e.update(type='string' if kind == 'createStringConfig' else 'sds', emptyToNull=args[3].strip() == 'EMPTY_STRING_IS_NULL', valid=args[6], apply=args[7],
                     sourceDefault=c_string(args[5]) or '')
        elif kind == 'createEnumConfig':
            e.update(type='enum', enum=args[3].strip(), valid=args[6], apply=args[7], sourceDefault=args[5].strip())
        elif kind in NUMERIC:
            # Bounds as strings: JSON numbers lose the low digits of 64-bit values.
            e.update(type='numeric', numeric=NUMERIC[kind], lower=str(evaluate(args[3], defs)), upper=str(evaluate(args[4], defs)),
                     numflags=sorted(f for f in re.findall(r'[A-Z_]+', args[7]) if f != 'INTEGER_CONFIG'), valid=args[8], apply=args[9])
            d = evaluate(args[6], defs)
            if 'OCTAL_CONFIG' in e['numflags']:
                e['sourceDefault'] = format(d, 'o')
            elif 'PERCENT_CONFIG' in e['numflags'] and d < 0:
                e['sourceDefault'] = str(-d) + '%'
            else:
                e['sourceDefault'] = str(d)
        elif kind == 'createSpecialConfig':
            e.update(type='special', set=args[3].strip())
        else:
            raise ValueError(kind)
        for k in ('valid', 'apply'):
            if k in e:
                e[k] = None if e[k].strip() == 'NULL' else e[k].strip()
        entries.append(e)
    # Enums: names, and values for the ones that combine as flags.
    enums = {}
    for m in re.finditer(r'configEnum (\w+)\[\]\s*=\s*\{(.*?)\};', text, re.S):
        vals = []
        for pair in re.findall(r'\{\s*("(?:[^"\\]|\\.)*"|NULL)\s*,\s*([^}]*)\}', m.group(2)):
            name = c_string(pair[0])
            if name is None:
                break
            try:
                v = evaluate(pair[1], defs)
            except ValueError:
                v = None
            vals.append([name, v])
        enums[m.group(1)] = vals
    for e in entries:
        if e['type'] == 'enum':
            value = evaluate(e['sourceDefault'], defs)
            names = [n for n, v in enums.get(e['enum'], []) if v == value]
            e['sourceDefault'] = names[0] if names else None
    # Old names the loader accepts and ignores.
    deprecated = []
    dm = re.search(r'deprecatedConfig deprecated_configs\[\]\s*=\s*\{(.*?)\};', text, re.S)
    if dm:
        for name, lo, hi in re.findall(r'\{\s*"([^"]+)"\s*,\s*(\d+)\s*,\s*(\d+)\s*\}', dm.group(1)):
            deprecated.append([name, int(lo), int(hi)])
    return {'version': version, 'configs': entries, 'enums': enums, 'deprecated': deprecated, 'notify': notify(version, defs), 'features': features(version),
            'consts': {k: evaluate(defs[k], defs) for k in ['CONFIG_BINDADDR_MAX', 'CONFIG_MIN_HZ', 'CONFIG_MAX_HZ', 'CONFIG_OOM_COUNT', 'LOADBUF_SIZE',
                                                            'NET_HOST_STR_LEN', 'NET_IP_STR_LEN', 'HASH_SEED_MAX_LEN', 'CONFIG_FDSET_INCR',
                                                            'IO_THREADS_MAX_NUM'] if k in defs}}


def without_gcra(text):
    """Drops #ifdef ENABLE_GCRA parts, keeping their #else: release builds don't define it."""
    out, stack = [], []
    for line in text.split('\n'):
        m = re.match(r'\s*#\s*(ifdef|ifndef|if|else|endif)\b\s*(\w*)', line)
        if m and (m.group(1) in ('ifdef', 'ifndef', 'if')):
            stack.append([m.group(2) == 'ENABLE_GCRA' and m.group(1) == 'ifdef', m.group(2) == 'ENABLE_GCRA'])
            continue
        if m and m.group(1) == 'else' and stack:
            if stack[-1][1]:
                stack[-1][0] = not stack[-1][0]
            continue
        if m and m.group(1) == 'endif' and stack:
            stack.pop()
            continue
        if any(skip for skip, _ in stack):
            continue
        out.append(line)
    return '\n'.join(out)


def notify(version, defs):
    srcdir = os.path.join(SRC, version, 'src')
    text = without_gcra(strip_comments(open(os.path.join(srcdir, 'notify.c'), errors='replace').read()))
    f2s = re.search(r'keyspaceEventsStringToFlags\([^)]*\)\s*\{(.*?)\n\}', text, re.S).group(1)
    chars = [[c, evaluate(n, defs)] for c, n in re.findall(r"case '(.)':\s*flags \|= (NOTIFY_\w+)", f2s)]
    s2f = re.search(r'keyspaceEventsFlagsToString\([^)]*\)\s*\{(.*?)\n\}', text, re.S).group(1)
    head, _, tail = s2f.partition('} else {')
    inner, _, after = tail.partition('}')
    order = lambda part: [[evaluate(n, defs), c] for n, c in re.findall(r'flags & (NOTIFY_\w+)\)\s*res = sdscatlen\(res,\s*"(.)"', part)]
    config = without_gcra(strip_comments(open(os.path.join(srcdir, 'config.c'), errors='replace').read()))
    message = re.search(r'"(Invalid event class character\.[^"]*)"', config).group(1)
    return {'chars': chars, 'all': evaluate('NOTIFY_ALL', defs), 'inner': order(inner), 'after': order(after), 'message': message}


def commands(client):
    """Command names, and subcommands as 'config|get' (7.0 and later)."""
    out, subs = [], []
    for info in client.call('COMMAND'):
        out.append(info[0])
        if len(info) > 9 and info[9]:
            subs.extend(sub[0] for sub in info[9])
    return sorted(out), sorted(subs)


def features(version):
    """How this version's config code behaves where versions differ, read off its source."""
    srcdir = os.path.join(SRC, version, 'src')
    config = open(os.path.join(srcdir, 'config.c'), errors='replace').read()
    util = open(os.path.join(srcdir, 'util.c'), errors='replace').read()
    def body(text, fn):
        m = re.search(r'\n(?:static )?[\w ]*\b' + fn + r'\([^)]*\)\s*\{', text)
        if not m:
            return ''
        i, depth = m.end(), 1
        while depth:
            depth += {'{': 1, '}': -1}.get(text[i], 0)
            i += 1
        return text[m.start():i]
    memtoull = body(util, 'memtoull')
    string2ll = body(util, 'string2llScalar') or body(util, 'string2ll')
    string2d = body(util, 'string2d')
    bound = body(config, 'numericBoundaryCheck')
    loader = body(config, 'loadServerConfigFromString')
    aux = body(open(os.path.join(srcdir, 'cluster.c'), errors='replace').read() + open(os.path.join(srcdir, 'cluster_legacy.c'), errors='replace').read() if os.path.exists(os.path.join(srcdir, 'cluster_legacy.c')) else open(os.path.join(srcdir, 'cluster.c'), errors='replace').read(), 'isValidAuxChar')
    return {
        'legacy': 'createSpecialConfig(' not in config,
        'server': 'Valkey' if version.startswith('valkey') else 'Redis',
        'fatalLabel': 'Version' if 'FATAL CONFIG FILE ERROR (Version' in config else 'Redis',
        'enumPrefix': 'argument(s) must be one of the following: ' if 'argument(s) must be one of the following' in config else 'argument must be one of the following: ',
        'unknownAsModuleConfig': 'Collect all unknown configurations into' in loader,
        'moduleDotConfig': 'Module config specified without value' in loader,
        'unsignedNegCheck': 'argument must be greater or equal to 0' in bound,
        'ulongUnsigned': 'NUMERIC_TYPE_ULONG ||' in bound,
        'memtoull': 'clamp' if 'Clamp to ULLONG_MAX' in memtoull else 'erange' if 'errno == ERANGE' in memtoull else 'wrap',
        'string2llMaxLen': 'LONG_STR_SIZE' in string2ll,
        # Valkey 8.1 and 9.0 call valkey_strtod, which is strtod unless built
        # with USE_FAST_FLOAT=yes; 9.1's is the ffc parser, without hexadecimal.
        'string2d': 'fast' if 'fast_float_strtod(s, slen' in string2d else 'fastfallback' if 'fast_float_strtod' in string2d else
                    'ffc' if 'valkey_strtod' in string2d and 'ffc_from_chars' in read_if(os.path.join(srcdir, 'valkey_strtod.c')) else 'strtod',
        'dbnumClusterFix': 'Changing databases number from' in loader,
        'ioThreadsClamp': 'IO_THREADS_MAX_NUM' in loader,
        'dirEmptyCheck': "dir can't be empty" in config,
        'primaryWords': 'Invalid primary port' in config,
        'auxChar': 'valkey' if "c <= ','" in aux else 'cntrl' if 'iscntrl' in aux else 'basic' if aux else None,
        'saveStaticReset': 'static int save_loaded' in config,
        # At startup the watchdog period is raised to twice the timer period.
        'watchdogClamp': 'applyWatchdogPeriod();' in open(os.path.join(srcdir, 'server.c'), errors='replace').read(),
        # What the server logs when module settings are left over.
        'moduleLog': 'unresolved' if 'Unresolved Configuration(s) Detected' in module_c(srcdir) else
                     'unused' if 'Unused Module Configuration' in module_c(srcdir) else 'plain',
        'renameAssert': rename_assert(config),
        'aclConflict': acl_conflict(srcdir, version),
        # How a line splits into arguments: the old sdssplitargs, or Valkey's
        # sdsparsearg, which drops 0xff bytes and, from 9.0, lets a closing
        # quote run into more text.
        'splitArgs': split_args_kind(srcdir),
        # Validators that changed between versions.
        'dbfilenameEmpty': "dbfilename can't be empty" in config,
        'aofFilenameEmpty': "appendfilename can't be empty" in config,
        'announceIpHostnames': 'Hostnames for cluster-announce-ip' in config,
        # Redis 8's I/O threads each take file descriptors from the pool maxclients sizes.
        'ioThreadFds': os.path.exists(os.path.join(srcdir, 'iothread.c')) and 'main thread notifications' in open(os.path.join(srcdir, 'iothread.c'), errors='replace').read(),
        # Modules built into the server, and the settings they add.
        'internalModules': internal_modules(srcdir),
    }


def internal_modules(srcdir):
    """Settings that modules built into the server register, such as Redis 8's vector sets."""
    module = module_c(srcdir)
    m = re.search(r'void moduleLoadInternalModules\(void\) \{(.*?)\n\}', module, re.S)
    if not m or 'OnLoad' not in m.group(1):
        return None
    start = module[:m.start()].count('\n') + 1
    line = None
    for i, l in enumerate(m.group(0).split('\n')):
        if 'serverAssert(retval == C_OK)' in l:
            line = 'module.c:%d' % (start + i)
    configs, names, log = [], [], []
    for f in sorted(glob.glob(os.path.join(srcdir, '..', 'modules', 'vector-sets', '*.c'))):
        text = open(f, errors='replace').read()
        for kind, name in re.findall(r'RedisModule_Register(Bool|String|Enum|Numeric)Config\(\s*ctx,\s*"([^"]+)"', text):
            configs.append([name, kind.lower()])
        names += re.findall(r'RedisModule_Init\(\s*ctx,\s*"([^"]+)"', text)
        log += re.findall(r'RedisModule_Log\(\s*ctx,\s*"warning",\s*"(Error loading user module configuration)"', text)
    return {'assert': line, 'configs': configs, 'module': names[0] if names else None, 'configError': log[0] if log else None}


def read_if(path):
    return open(path, errors='replace').read() if os.path.exists(path) else ''


def split_args_kind(srcdir):
    sds = open(os.path.join(srcdir, 'sds.c'), errors='replace').read()
    m = re.search(r'static int sdsparsearg\(.*?\n\}', sds, re.S)
    if not m:
        return 'classic'
    return 'parsearg-strict' if 'closing quote must be followed by a space' in m.group(0) else 'parsearg-loose'


def module_c(srcdir):
    return open(os.path.join(srcdir, 'module.c'), errors='replace').read()


def rename_assert(config):
    """Where renaming a subcommand trips an assertion: 'config.c:552' and the expression."""
    lines = config.split('\n')
    for i, line in enumerate(lines):
        if '"rename-command"' in line:
            for j in range(i, i + 20):
                m = re.search(r'serverAssert\((.*)\);', lines[j])
                if m:
                    return ['config.c:%d' % (j + 1), m.group(1)]
    return None


def acl_conflict(srcdir, version):
    """The message a server stops with when the file has both aclfile and user lines."""
    acl = open(os.path.join(srcdir, 'acl.c'), errors='replace').read()
    m = re.search(r'void ACLLoadUsersAtStartup\(void\) \{.*?serverLog\(LL_WARNING,\s*((?:"(?:[^"\\]|\\.)*"\s*)+)(,\s*SERVER_TITLE)?\);', acl, re.S)
    text = ''.join(re.findall(r'"((?:[^"\\]|\\.)*)"', m.group(1)))
    if m.group(2):
        text = text.replace('%s', 'Valkey' if version.startswith('valkey') else 'Redis')
    return text


# ---- defaults from the running servers ----

class Client:
    """A small RESP client over a Unix socket."""
    def __init__(self, path):
        self.s = socket.socket(socket.AF_UNIX)
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
            return rest.decode()
        if t == b'-':
            return Exception(rest.decode())
        if t == b':':
            return int(rest)
        if t == b'$':
            n = int(rest)
            return None if n < 0 else self.f.read(n + 2)[:-2].decode('utf-8', 'replace')
        if t in (b'*', b'%'):
            n = int(rest)
            return None if n < 0 else [self.read() for _ in range(n * (2 if t == b'%' else 1))]
        raise ValueError(line)


def server_defaults(version, names):
    binary = glob.glob(os.path.join(BIN, version, '*-server'))[0]
    d = tempfile.mkdtemp(prefix='kvcfg-')
    sockpath = os.path.join(d, 's.sock')
    p = subprocess.Popen([binary, '--port', '0', '--unixsocket', sockpath, '--dir', d, '--save', ''], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, cwd=d)
    for _ in range(200):
        if os.path.exists(sockpath):
            break
        time.sleep(0.02)
    c = Client(sockpath)
    allv = c.call('CONFIG', 'GET', '*')
    listed = dict(zip(allv[0::2], allv[1::2]))
    exact = {}
    for n in names:
        r = c.call('CONFIG', 'GET', n)
        if isinstance(r, list) and r:
            exact[r[0]] = r[1]
    info = c.call('INFO', 'server')
    cmds = commands(c)
    try:
        c.call('SHUTDOWN', 'NOSAVE')
    except ConnectionError:
        pass
    p.wait(timeout=10)
    return listed, exact, d, info, cmds


def main():
    versions = sorted((os.path.basename(p) for p in glob.glob(os.path.join(SRC, '*-*')) if os.path.isdir(os.path.join(p, 'src'))), key=version_key)
    out = []
    for v in versions:
        x = extract(v)
        names = [c['name'] for c in x['configs']]
        listed, exact, tmp, info, cmds = server_defaults(v, names)
        x['commands'], x['subcommands'] = cmds
        # The server was started with --port 0, --unixsocket, --dir and --save ""; put back what those replaced.
        x['listed'] = {k: listed[k] for k in sorted(listed)}
        for c in x['configs']:
            c['default'] = exact.get(c['name'])
            c['present'] = c['name'] in exact
        x['startedWith'] = {'port': '0', 'unixsocket': tmp + '/s.sock', 'dir': tmp, 'save': ''}
        x['serverVersion'] = re.search(r'(?:redis|valkey)_version:(\S+)', info).group(1)
        missing = [c['name'] for c in x['configs'] if not c['present']]
        print(v, len(x['configs']), 'configs,', len(x['enums']), 'enums,', len(x['deprecated']), 'deprecated; not in this build:', missing, file=sys.stderr)
        out.append(x)
    dest = os.path.join(HERE, '..', 'fixtures', 'servers.json.gz')
    with gzip.open(dest, 'wt', compresslevel=9) as f:
        json.dump(out, f, indent=1, sort_keys=True)
        f.write('\n')


if __name__ == '__main__':
    main()
