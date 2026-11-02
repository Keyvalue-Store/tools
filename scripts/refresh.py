#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 KeyValueStore.com
#
# Checks whether the recorded server facts still hold for the newest patch
# releases. The Memory Calculator, Config Checker and ACL Builder were
# recorded from 15 pinned Redis and Valkey versions (scripts/build-servers.sh).
# This script:
#
#   1. lists the release tags of redis/redis and valkey-io/valkey and finds
#      the newest patch of each tracked line (8.10 for 8.10.2), and any newer
#      line that isn't tracked yet;
#   2. builds each newer patch the way build-servers.sh builds the tracked
#      ones, and records it with the three tools' recorders, under the id of
#      the tracked version it replaces, so the tools read it as that line;
#   3. replays the recordings through the tools as they are, and writes a
#      dated report to test/results/refresh/.
#
# It never changes the tools, their data or the version list. A clean
# report says the newest patches still match. A difference, a new line or a
# failed build exits with 1 and prints ::error lines for GitHub Actions, so
# a session can look into it.
#
# Usage: scripts/refresh.py [--dry-run]
#   --dry-run  only list the versions, build and record nothing
#   KV_WORK    working folder (default: a temporary one), KV_SCALE as for the
#              memory recorder (default 1), JOBS for the builds

import datetime, gzip, json, os, re, shutil, subprocess, sys, tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
REPOS = {'redis': 'https://github.com/redis/redis', 'valkey': 'https://github.com/valkey-io/valkey'}
TOOLS = [
    # name, recorder, replay command (gets the fixture through KV_FIXTURE or --file)
    ('memory', 'memory/test/generate/record.py', lambda f: ['node', 'memory/test/replay.js'], 'KV_FIXTURE'),
    ('config', 'config/test/generate/record.py', lambda f: ['node', 'config/test/replay.js'], 'KV_FIXTURE'),
    ('acl', 'acl/test/generate/record.py', lambda f: ['node', 'acl/test/replay.js', '--file', f], None),
]


def tracked():
    text = open(os.path.join(ROOT, 'scripts', 'build-servers.sh')).read()
    m = re.search(r'^ALL="([^"]*)"', text, re.M)
    return m.group(1).replace('\\', ' ').split()


def vkey(v):
    return tuple(int(x) for x in v.split('.'))


def releases(server):
    """Stable release versions from the tags: X.Y.Z only, no rc or m."""
    out = subprocess.run(['git', 'ls-remote', '--tags', '--refs', REPOS[server]], capture_output=True, text=True, check=True).stdout
    tags = set()
    for line in out.splitlines():
        tag = line.split('refs/tags/')[-1]
        if re.fullmatch(r'\d+\.\d+\.\d+', tag):
            tags.add(tag)
    return sorted(tags, key=vkey)


def plan():
    """For each tracked version, the newest patch of its line; and the
    lines newer than the newest tracked line of each server."""
    ids = tracked()
    rows, new_lines = [], []
    for server in REPOS:
        mine = [i.split('-', 1)[1] for i in ids if i.startswith(server + '-')]
        all_tags = releases(server)
        for v in mine:
            line = v.rsplit('.', 1)[0]
            newest = max((t for t in all_tags if t.rsplit('.', 1)[0] == line), key=vkey, default=v)
            rows.append({'id': server + '-' + v, 'server': server, 'line': line, 'tracked': v, 'newest': newest})
        top = max(vkey(v)[:2] for v in mine)
        lines = sorted({t.rsplit('.', 1)[0] for t in all_tags if vkey(t)[:2] > top}, key=lambda l: vkey(l + '.0'))
        for line in lines:
            newest = max((t for t in all_tags if t.rsplit('.', 1)[0] == line), key=vkey)
            new_lines.append({'server': server, 'line': line, 'newest': newest})
    return rows, new_lines


def run(cmd, log, env=None, cwd=ROOT):
    with open(log, 'a') as f:
        f.write('$ ' + ' '.join(cmd) + '\n')
        f.flush()
        return subprocess.run(cmd, cwd=cwd, env=env, stdout=f, stderr=subprocess.STDOUT).returncode


def main():
    dry = '--dry-run' in sys.argv[1:]
    today = datetime.date.today().isoformat()
    rows, new_lines = plan()
    changed = [r for r in rows if r['newest'] != r['tracked']]
    problems = []
    work = os.environ.get('KV_WORK') or tempfile.mkdtemp(prefix='kv-refresh-')
    log = os.path.join(work, 'refresh.log')
    os.makedirs(work, exist_ok=True)

    if changed and not dry:
        newer = [r['server'] + '-' + r['newest'] for r in changed]
        env = dict(os.environ, KV_SRC=os.path.join(work, 'src'), KV_BIN=os.path.join(work, 'bin'), KV_ALLOW_ANY='1')
        built_ok = run(['sh', 'scripts/build-servers.sh'] + newer, log, env) == 0
        # Each new build stands in for the tracked version of its line.
        mapped = os.path.join(work, 'mapped')
        os.makedirs(mapped, exist_ok=True)
        ready = []
        for r in changed:
            src = os.path.join(work, 'bin', r['server'] + '-' + r['newest'])
            if not os.path.isdir(src) or not os.listdir(src):
                r['status'] = 'build failed'
                problems.append('%s %s did not build; see the log' % (r['server'], r['newest']))
                continue
            dst = os.path.join(mapped, r['id'])
            if not os.path.exists(dst):
                os.symlink(src, dst)
            ready.append(r)
        if not built_ok and not problems:
            problems.append('the build script failed; see the log')
        for name, recorder, replay, envname in TOOLS:
            if not ready:
                break
            fixture = os.path.join(work, name + '.json.gz')
            env = dict(os.environ, KV_BIN=mapped, KV_OUT=fixture)
            code = run(['python3', recorder] + [r['id'] for r in ready], log, env)
            if code != 0 or not os.path.exists(fixture):
                problems.append('the %s recorder failed; see the log' % name)
                for r in ready:
                    r.setdefault('tools', {})[name] = 'recording failed'
                continue
            renv = dict(os.environ)
            if envname:
                renv[envname] = fixture
            out = subprocess.run(replay(fixture), cwd=ROOT, env=renv, capture_output=True, text=True)
            with open(log, 'a') as f:
                f.write(out.stdout + out.stderr)
            # A replay exits with 1 when it finds differences; any other
            # failure, or a crash after some output, counts as one too.
            crashed = out.returncode not in (0, 1) or (out.returncode == 1 and 'differences' not in out.stdout)
            if crashed:
                problems.append('the %s replay failed (exit %d); see the log' % (name, out.returncode))
            for r in ready:
                lines = [l for l in out.stdout.splitlines() if r['id'] in l]
                diffs = 0
                for l in lines:
                    for m in re.finditer(r'(\d+) differences', l):
                        diffs += int(m.group(1))
                r.setdefault('tools', {})[name] = 'same' if diffs == 0 and lines else ('%d differences' % diffs if lines else 'no result')
                if crashed:
                    r['tools'][name] = 'replay failed'
                elif diffs or not lines:
                    problems.append('%s %s: %s %s' % (r['server'], r['newest'], name, r['tools'][name]))
        for r in ready:
            if 'status' not in r:
                r['status'] = 'same' if all(v == 'same' for v in r.get('tools', {}).values()) else 'differs'
    for l in new_lines:
        problems.append('new line %s %s (newest %s) is not tracked' % (l['server'], l['line'], l['newest']))

    # The report.
    md = ['# Refresh check, ' + today, '']
    md.append('Newest patch release of every tracked Redis and Valkey line, recorded with the Memory Calculator, Config Checker and ACL Builder recorders and replayed through the tools as they are.')
    md.append('')
    md.append('| Line | Tracked | Newest | Result |')
    md.append('|---|---|---|---|')
    for r in rows:
        if r['newest'] == r['tracked']:
            result = 'newest is tracked'
        elif dry:
            result = 'newer patch, not checked (dry run)'
        else:
            t = r.get('tools', {})
            result = r.get('status', '') + (': ' + ', '.join('%s %s' % kv for kv in t.items()) if t else '')
        md.append('| %s %s | %s | %s | %s |' % (r['server'].capitalize(), r['line'], r['tracked'], r['newest'], result))
    md.append('')
    if new_lines:
        md.append('New lines not tracked yet: ' + ', '.join('%s %s (%s)' % (l['server'].capitalize(), l['line'], l['newest']) for l in new_lines) + '.')
    else:
        md.append('No new lines.')
    md.append('')
    md.append('Problems: ' + ('none.' if not problems else ''))
    for p in problems:
        md.append('- ' + p)
    md.append('')
    text = '\n'.join(md)
    print(text)
    if not dry:
        outdir = os.path.join(ROOT, 'test', 'results', 'refresh')
        os.makedirs(outdir, exist_ok=True)
        with open(os.path.join(outdir, today + '.md'), 'w') as f:
            f.write(text)
        with open(os.path.join(outdir, today + '.json'), 'w') as f:
            json.dump({'date': today, 'lines': rows, 'newLines': new_lines, 'problems': problems}, f, indent=1)
            f.write('\n')
        print('log:', log, file=sys.stderr)
    for p in problems:
        print('::error::' + p)
    sys.exit(1 if problems else 0)


if __name__ == '__main__':
    main()
