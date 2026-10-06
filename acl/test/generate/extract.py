# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 KeyValueStore.com
#
# Collects what the ACL Builder knows about each server version. From the
# built server: every command and subcommand as COMMAND reports it (arity,
# flags, key positions and key specs, ACL categories), the categories in
# ACL CAT order, and the defaults of a new user. From the source code: which
# commands find their keys with a function of their own, which commands
# take Pub/Sub channels, and the messages the ACL code prints. Writes
# test/fixtures/servers.json.gz, which make-data.js turns into servers.js.
#
#   KV_SRC=/opt/kvsrc KV_BIN=/opt/kv python3 acl/test/generate/extract.py

import glob, gzip, json, os, re, shutil, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.environ.get('KV_SRC', '/opt/kvsrc')
BIN = os.environ.get('KV_BIN', '/opt/kv')
sys.path.insert(0, os.path.join(HERE, '..', '..', '..', 'config', 'test', 'generate'))
from record import Conn  # noqa: E402  (the Config Checker's small RESP client)


def version_key(v):
    name, num = v.split('-')
    return (name, [int(x) for x in num.split('.')])


def start(version):
    binary = glob.glob(os.path.join(BIN, version, '*-server'))[0]
    d = tempfile.mkdtemp(prefix='kvacl-')
    sock = os.path.join(d, 's.sock')
    p = subprocess.Popen([binary, '--port', '0', '--unixsocket', sock, '--dir', d, '--save', ''],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, cwd=d)
    for _ in range(500):
        if os.path.exists(sock):
            break
        time.sleep(0.01)
    for _ in range(100):
        try:
            c = Conn(sock)
            c.call('PING')
            return p, d, c
        except (ConnectionError, OSError):
            time.sleep(0.02)
    raise RuntimeError('server did not start: ' + version)


def entries(source):
    """Command table entries in the source: (name, text of the entry, table it is in)."""
    out = []
    # 7.2 and later: commands.def with MAKE_CMD(...); 7.0: commands.c; 6.2: server.c.
    for table in re.finditer(r'struct (?:COMMAND_STRUCT|redisCommand|serverCommand) (\w+)\[\]\s*=\s*\{(.*?)\n\};', source, re.S):
        name, body = table.group(1), table.group(2)
        for m in re.finditer(r'(?:MAKE_CMD\(|\{)"([a-z0-9_|-]+)",', body):
            end = body.find('\n', m.end())
            nxt = re.search(r'(?:MAKE_CMD\(|\n\s*\{)"[a-z0-9_|-]+",', body[m.end():])
            stop = m.end() + nxt.start() if nxt else len(body)
            out.append((m.group(1), body[m.start():stop], name))
    return out


def command_table(srcdir):
    files = [f for f in ('commands.def', 'commands.c', 'server.c') if os.path.exists(os.path.join(srcdir, f))]
    text = open(os.path.join(srcdir, files[0]), errors='replace').read()
    for name, entry, table in entries(text):
        parent = None
        tm = re.match(r'(\w+?)_Subcommands$', table)
        if tm:
            parent = tm.group(1).lower().replace('_', '-')
        yield ((parent + '|' + name) if parent else name), entry


def getkeys_procs(srcdir):
    """Commands (full names) that have a key-finding function of their own."""
    out = {}
    for full, entry in command_table(srcdir):
        m = re.search(r'\b(\w+GetKeys)\b', entry)
        if m:
            out[full] = m.group(1)
    return out


def protected(srcdir):
    """Commands the server refuses unless enable-debug-command or
    enable-module-command allows them (7.0 and later)."""
    return sorted(full for full, entry in command_table(srcdir) if re.search(r'\bCMD_PROTECTED\b', entry))


def database_args(srcdir):
    """Valkey 9.1 and later: commands that name databases in their arguments
    (a function finds them), and commands that touch every database."""
    dbid, alldbs = {}, []
    for full, entry in command_table(srcdir):
        m = re.search(r'\b(\w+DbIdArgs)\b', entry)
        if m:
            dbid[full] = m.group(1)
        if re.search(r'\bCMD_ALL_DBS\b', entry):
            alldbs.append(full)
    return dbid, sorted(alldbs)


def channel_commands(srcdir):
    """Commands whose arguments are Pub/Sub channels, with which arguments and how."""
    db = open(os.path.join(srcdir, 'db.c'), errors='replace').read()
    m = re.search(r'commands_with_channels\[\]\s*=\s*\{(.*?)\};', db, re.S)
    if not m:
        return None
    out = []
    for proc, flags, start, count in re.findall(r'\{(\w+)Command,\s*([A-Z_| ]+),\s*(-?\d+),\s*(-?\d+)\}', m.group(1)):
        out.append([proc.lower(), sorted(f.strip().replace('CMD_CHANNEL_', '').lower() for f in flags.split('|')), int(start), int(count)])
    return out


def acl_messages(srcdir):
    """ACLSetUserStringError: errno name -> message."""
    acl = open(os.path.join(srcdir, 'acl.c'), errors='replace').read()
    m = re.search(r'const char \*ACLSetUserStringError\(void\)\s*\{(.*?)\n\}', acl, re.S)
    body = m.group(1)
    out = {}
    default = re.search(r'errmsg\s*=\s*((?:"[^"]*"\s*)+);', body)
    out['default'] = ''.join(re.findall(r'"([^"]*)"', default.group(1)))
    for errno, msg in re.findall(r'errno\s*==\s*(\w+)\)?\s*\n?\s*errmsg\s*=\s*((?:"(?:[^"\\]|\\.)*"\s*)+);', body):
        out[errno] = ''.join(re.findall(r'"((?:[^"\\]|\\.)*)"', msg))
    return out


def user_flags(srcdir):
    acl = open(os.path.join(srcdir, 'acl.c'), errors='replace').read()
    m = re.search(r'ACLUserFlags\[\]\s*=\s*\{(.*?)\};', acl, re.S)
    return [name for name, _ in re.findall(r'\{"([a-z-]+)",\s*(\w+)\}', m.group(1))]


def main():
    versions = sorted((os.path.basename(p) for p in glob.glob(os.path.join(SRC, '*-*')) if os.path.isdir(os.path.join(p, 'src'))), key=version_key)
    out = []
    for v in versions:
        srcdir = os.path.join(SRC, v, 'src')
        p, d, c = start(v)
        try:
            commands = c.call('COMMAND')
            categories = c.call('ACL', 'CAT')
            members = {cat: sorted(c.call('ACL', 'CAT', cat)) for cat in categories}
            pubsub_default = c.call('CONFIG', 'GET', 'acl-pubsub-default')
            c.call('ACL', 'SETUSER', 'kvnew')
            new_user = [l for l in c.call('ACL', 'LIST') if l.startswith('user kvnew ')][0]
            default_user = [l for l in c.call('ACL', 'LIST') if l.startswith('user default ')][0]
        finally:
            p.kill()
            p.wait()
            shutil.rmtree(d, ignore_errors=True)
        commands.sort(key=lambda x: x[0])
        for cmd in commands:
            if len(cmd) > 9 and cmd[9]:
                cmd[9].sort(key=lambda x: x[0])
        dbid, alldbs = database_args(srcdir)
        x = {
            'version': v, 'commands': commands, 'categories': categories, 'categoryMembers': members,
            'pubsubDefault': pubsub_default[1] if pubsub_default else None, 'newUser': new_user, 'defaultUser': default_user,
            'getkeys': getkeys_procs(srcdir), 'channels': channel_commands(srcdir), 'messages': acl_messages(srcdir), 'userFlags': user_flags(srcdir),
            'dbidArgs': dbid, 'allDbs': alldbs, 'protected': protected(srcdir),
        }
        print(v, len(commands), 'commands,', sum(len(cmd[9]) if len(cmd) > 9 else 0 for cmd in commands), 'subcommands,',
              len(x['getkeys']), 'with key functions:', ' '.join(sorted(x['getkeys'])), file=sys.stderr)
        out.append(x)
    dest = os.path.join(HERE, '..', 'fixtures', 'servers.json.gz')
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with gzip.open(dest, 'wt', compresslevel=9) as f:
        json.dump(out, f, sort_keys=True, separators=(',', ':'))
        f.write('\n')


if __name__ == '__main__':
    main()
