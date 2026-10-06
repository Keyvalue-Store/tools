# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 KeyValueStore.com
#
# Random Kubernetes objects full of awkward strings, encoded and printed by
# Kubernetes' own Go code, to test the Revision Viewer's YAML against
# kubectl's at every depth: long lines folded after 80 columns, quoting,
# line breaks, key order. Needs k8scodec (KUBE_CODEC: its path):
#
#   KUBE_CODEC=/path/to/k8scodec python3 revisions/test/generate/make-yaml-cases.py
#
# Writes test/fixtures/yaml-cases.jsonl.gz: each line the stored bytes
# (base64) and the YAML Kubernetes made of them.

import base64, gzip, json, os, random, subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
rnd = random.Random(1006)

# Characters go-yaml can read back: no C1 controls, no U+FFFE or U+FFFF.
POOL = ([chr(c) for c in range(0x20, 0x7f)] * 6 + [' '] * 60 + list('éüß中文日本ж') + ['🚀', '😀'] +
        ['\n'] * 6 + ['\t', '\r', '\u0085', '\u2028', '\u2029', '\u00a0', '\ufeff', '\x01', '\x1b'])
WORDS = ['yes', 'no', 'on', 'off', 'true', 'null', '~', '-', '- ', ': ', ' #', '#', '---', '...', '0', '012', '0x1F', '1e3', '1.5', '1:20',
         '2026-10-06', '2026-10-06T08:00:00Z', '"', "'", '\\', '|', '>', '*', '&', '!', '%', '@', '`', '{', '}', '[', ']', ',', '?', ':']


def text():
    kind = rnd.random()
    if kind < 0.15:
        return rnd.choice(WORDS)
    if kind < 0.45:
        # Prose of random words: long enough to fold, sometimes with a trap at the start.
        words = [''.join(rnd.choice('abcdefghij') for _ in range(rnd.randint(1, 12))) for _ in range(rnd.randint(1, 40))]
        s = ' '.join(words)
        if rnd.random() < 0.4:
            s = rnd.choice(WORDS) + s
        if rnd.random() < 0.3:
            s = s.replace(' ', '  ', rnd.randint(0, 3))
        return s
    return ''.join(rnd.choice(POOL) for _ in range(rnd.randint(0, 160)))


def key():
    if rnd.random() < 0.7:
        return ''.join(rnd.choice('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._') for _ in range(rnd.randint(1, 20)))
    # Keys can't hold line breaks or tabs and still be read back as YAML.
    return ''.join(c for c in text() if c not in '\n\r\u0085\u2028\u2029\t\x01\x1b')[:150] or 'k'


def objects():
    for i in range(160):
        yield {'apiVersion': 'v1', 'kind': 'ConfigMap',
               'metadata': {'name': 'cm-%d' % i, 'namespace': 'default', 'annotations': {key(): text() for _ in range(rnd.randint(0, 4))},
                            'finalizers': [text() for _ in range(rnd.randint(0, 3))]},
               'data': {key(): text() for _ in range(rnd.randint(1, 8))}}
    for i in range(80):
        yield {'apiVersion': 'v1', 'kind': 'Pod', 'metadata': {'name': 'pod-%d' % i, 'labels': {key(): text()}},
               'spec': {'containers': [{'name': 'main', 'image': 'x', 'args': [text() for _ in range(rnd.randint(1, 5))],
                                        'env': [{'name': key(), 'value': text()} for _ in range(rnd.randint(0, 3))]}]},
               'status': {'message': text(), 'conditions': [{'type': 'Ready', 'status': 'True', 'message': text()}]}}


def main():
    codec = os.environ.get('KUBE_CODEC', '/opt/k8scodec-build/k8scodec')
    objs = list(objects())
    enc = subprocess.run([codec, 'encode'], input=''.join(json.dumps(o, separators=(',', ':')) + '\n' for o in objs),
                         capture_output=True, text=True, check=True).stdout.split('\n')
    enc = [e for e in enc if e]
    dec = subprocess.run([codec, 'decode'], input=''.join(e + '\n' for e in enc), capture_output=True, text=True, check=True).stdout.split('\n')
    dec = [json.loads(d) for d in dec if d]
    out = os.path.join(HERE, '..', 'fixtures', 'yaml-cases.jsonl.gz')
    with gzip.open(out, 'wt', 9) as f:
        for e, d in zip(enc, dec):
            row = {'value': e, 'yaml': d.get('yaml'), 'error': d.get('error')}
            f.write(json.dumps({k: v for k, v in row.items() if v is not None}, sort_keys=True, ensure_ascii=False) + '\n')
    print(len(enc), 'objects,', sum(1 for d in dec if 'error' in d), 'that kubectl cannot print as YAML')


if __name__ == '__main__':
    main()
