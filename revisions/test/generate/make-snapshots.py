# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 KeyValueStore.com
#
# Makes the etcd snapshots the Revision Viewer is tested on, and records what
# etcd's own tools and Kubernetes' own code say about them. It runs real etcd
# servers and fills them the way a small Kubernetes cluster does: objects
# encoded by Kubernetes' Go packages exactly as kube-apiserver stores them,
# leases renewed every few seconds, events with a TTL, Secrets in the clear
# or encrypted at rest. Then it compacts and saves snapshots.
#
# Needs: the etcd, etcdctl and etcdutl release binaries (ETCD_36, ETCD_35,
# ETCD_34: folders holding them), and k8scodec built from test/generate/k8scodec
# (KUBE_CODEC: its path):
#
#   ETCD_36=/opt/etcd/etcd-v3.6.15-linux-amd64 ETCD_35=/opt/etcd/etcd-v3.5.34-linux-amd64 ETCD_34=/opt/etcd/etcd-v3.4.45-linux-amd64 \
#     KUBE_CODEC=/path/to/k8scodec BBOLT=/path/to/bbolt python3 revisions/test/generate/make-snapshots.py
#
# BBOLT, optional, is bbolt's own command line (go.etcd.io/bbolt/cmd/bbolt);
# when given, its page counts go in the expected files too.
#
# Writes test/fixtures/*.db, *.expected.json, and kubernetes-objects.jsonl.gz:
# for every Kubernetes object in the cluster snapshot, the JSON Kubernetes'
# Go packages make of it and the YAML kubectl prints. Also writes
# app/example.js, the snapshot the page opens with "Try an example".

import base64, datetime, gzip, hashlib, json, os, random, shutil, subprocess, sys, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, '..', 'fixtures')
rnd = random.Random(20261006)
T0 = 1790000000  # 2026-09-21, the cluster's start


def b64(b):
    return base64.b64encode(b if isinstance(b, bytes) else b.encode()).decode()


class Etcd:
    def __init__(self, bindir, name, extra=()):
        self.bindir, self.name = bindir, name
        self.dir = '/tmp/etcd-' + name
        shutil.rmtree(self.dir, ignore_errors=True)
        self.port = 23790 + rnd.randint(0, 99)
        self.url = 'http://127.0.0.1:%d' % self.port
        self.proc = subprocess.Popen([os.path.join(bindir, 'etcd'), '--name', name, '--data-dir', self.dir,
                                      '--listen-client-urls', self.url, '--advertise-client-urls', self.url,
                                      '--listen-peer-urls', 'http://127.0.0.1:%d' % (self.port + 1000),
                                      '--initial-advertise-peer-urls', 'http://127.0.0.1:%d' % (self.port + 1000),
                                      '--initial-cluster', '%s=http://127.0.0.1:%d' % (name, self.port + 1000)] + list(extra),
                                     stdout=subprocess.DEVNULL, stderr=open('/tmp/etcd-%s.log' % name, 'w'))
        for _ in range(100):
            try:
                self.post('/v3/maintenance/status', {})
                return
            except Exception:
                time.sleep(0.1)
        raise RuntimeError('etcd did not start')

    def post(self, path, body, token=None):
        req = urllib.request.Request(self.url + path, data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'})
        if token:
            req.add_header('Authorization', token)
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(req, timeout=10) as r:
            return json.loads(r.read() or b'{}')

    def put(self, key, value, lease=0):
        body = {'key': b64(key), 'value': b64(value)}
        if lease:
            body['lease'] = str(lease)
        return int(self.post('/v3/kv/put', body)['header']['revision'])

    def delete(self, key):
        return int(self.post('/v3/kv/deleterange', {'key': b64(key)})['header']['revision'])

    def lease(self, ttl):
        return int(self.post('/v3/lease/grant', {'TTL': str(ttl)})['ID'])

    def compact(self, rev):
        self.post('/v3/kv/compaction', {'revision': str(rev), 'physical': True})

    def ctl(self, *args):
        out = subprocess.run([os.path.join(self.bindir, 'etcdctl'), '--endpoints', self.url] + list(args),
                             capture_output=True, check=True, env=dict(os.environ, ETCDCTL_API='3'))
        return out.stdout

    def stop(self):
        self.proc.terminate()
        self.proc.wait(timeout=20)


# ---- Kubernetes objects, encoded by Kubernetes' own Go code ----

class Codec:
    """k8scodec, kept running: JSON in, the bytes kube-apiserver stores out."""
    def __init__(self, path):
        self.path = path
        self.p = subprocess.Popen([path, 'encode'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)

    def encode(self, obj):
        self.p.stdin.write(json.dumps(obj, separators=(',', ':')) + '\n')
        self.p.stdin.flush()
        line = self.p.stdout.readline()
        if not line:
            raise RuntimeError('k8scodec could not encode ' + json.dumps(obj)[:200])
        return base64.b64decode(line)

    def decode_all(self, values):
        p = subprocess.run([self.path, 'decode'], input=''.join(b64(v) + '\n' for v in values), capture_output=True, text=True, check=True)
        # Split on newlines only: values can hold other line breaks, such as U+0085.
        return [json.loads(l) for l in p.stdout.split('\n') if l]


CODEC = None
WRITTEN = {}  # sha256 of every value written, to the value


def k8s(obj):
    v = CODEC.encode(obj)
    WRITTEN[hashlib.sha256(v).hexdigest()] = v
    return v


def custom(obj):
    """A custom resource, which kube-apiserver stores as JSON."""
    v = (json.dumps(obj, separators=(',', ':'), ensure_ascii=False) + '\n').encode()
    WRITTEN[hashlib.sha256(v).hexdigest()] = v
    return v


def ts(sec):
    return datetime.datetime.fromtimestamp(sec, datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def micro(sec, us):
    return datetime.datetime.fromtimestamp(sec, datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S') + '.%06dZ' % us


def uid():
    return '%08x-%04x-4%03x-%04x-%012x' % (rnd.getrandbits(32), rnd.getrandbits(16), rnd.getrandbits(12), 0x8000 | rnd.getrandbits(14), rnd.getrandbits(48))


def managed(created, entries):
    """managedFields: which client set which field, as server-side apply records it."""
    out = []
    for i, (manager, op, fields, sub) in enumerate(entries):
        m = {'manager': manager, 'operation': op, 'apiVersion': 'v1', 'time': ts(created + i * 7), 'fieldsType': 'FieldsV1', 'fieldsV1': fields}
        if sub:
            m['subresource'] = sub
        out.append(m)
    return out


def meta(name, ns=None, created=None, labels=None, annotations=None, managers=None, **extra):
    created = created or T0 + rnd.randint(0, 86400)
    m = {'name': name, 'uid': uid(), 'creationTimestamp': ts(created)}
    if ns:
        m['namespace'] = ns
    if labels:
        m['labels'] = labels
    if annotations:
        m['annotations'] = annotations
    if managers:
        m['managedFields'] = managed(created, managers)
    m.update(extra)
    return m, created


def labels_fields(labels):
    return {'f:metadata': {'f:labels': {'.': {}, **{'f:' + k: {} for k in labels}}}}


def pod(name, ns, node, app, owner):
    labels = {'app': app, 'pod-template-hash': owner.rsplit('-', 1)[1], 'tier': 'web'}
    m, created = meta(name, ns, labels=labels, generateName=owner + '-', managers=[
        ('kube-controller-manager', 'Update', {**labels_fields(labels), 'f:metadata': {'f:generateName': {}, 'f:labels': {'.': {}, 'f:app': {}, 'f:pod-template-hash': {}, 'f:tier': {}}, 'f:ownerReferences': {'.': {}, 'k:{"uid":"%s"}' % uid(): {}}},
                                                     'f:spec': {'f:containers': {'k:{"name":"main"}': {'.': {}, 'f:image': {}, 'f:imagePullPolicy': {}, 'f:name': {}, 'f:ports': {'.': {}, 'k:{"containerPort":8080,"protocol":"TCP"}': {'.': {}, 'f:containerPort': {}, 'f:name': {}, 'f:protocol': {}}}, 'f:resources': {'.': {}, 'f:limits': {'.': {}, 'f:memory': {}}, 'f:requests': {'.': {}, 'f:cpu': {}, 'f:memory': {}}}}}}}, None),
        ('kubelet', 'Update', {'f:status': {'f:conditions': {'k:{"type":"Ready"}': {'.': {}, 'f:lastProbeTime': {}, 'f:lastTransitionTime': {}, 'f:status': {}, 'f:type': {}}}, 'f:containerStatuses': {}, 'f:hostIP': {}, 'f:phase': {}, 'f:podIP': {}, 'f:startTime': {}}}, 'status')])
    m['ownerReferences'] = [{'apiVersion': 'apps/v1', 'kind': 'ReplicaSet', 'name': owner, 'uid': uid(), 'controller': True, 'blockOwnerDeletion': True}]
    ip = '10.244.%d.%d' % (rnd.randint(0, 3), rnd.randint(2, 250))
    image = 'registry.example.com/%s:1.%d.%d' % (app, rnd.randint(0, 9), rnd.randint(0, 20))
    return {
        'apiVersion': 'v1', 'kind': 'Pod', 'metadata': m,
        'spec': {
            'containers': [{
                'name': 'main', 'image': image, 'imagePullPolicy': 'IfNotPresent',
                'ports': [{'name': 'http', 'containerPort': 8080, 'protocol': 'TCP'}],
                'env': [{'name': 'LOG_LEVEL', 'value': rnd.choice(['info', 'debug'])}, {'name': 'FEATURE_FLAGS', 'value': 'a,b,c'},
                        {'name': 'POD_IP', 'valueFrom': {'fieldRef': {'apiVersion': 'v1', 'fieldPath': 'status.podIP'}}}],
                'resources': {'requests': {'cpu': '250m', 'memory': '256Mi'}, 'limits': {'memory': '512Mi'}},
                'readinessProbe': {'httpGet': {'path': '/healthz', 'port': 'http', 'scheme': 'HTTP'}, 'periodSeconds': 10, 'timeoutSeconds': 1, 'successThreshold': 1, 'failureThreshold': 3},
                'livenessProbe': {'tcpSocket': {'port': 8080}, 'initialDelaySeconds': 15, 'periodSeconds': 20, 'timeoutSeconds': 1, 'successThreshold': 1, 'failureThreshold': 3},
                'volumeMounts': [{'name': 'config', 'mountPath': '/etc/' + app, 'readOnly': True},
                                 {'name': 'kube-api-access-%05x' % rnd.getrandbits(20), 'mountPath': '/var/run/secrets/kubernetes.io/serviceaccount', 'readOnly': True}],
                'terminationMessagePath': '/dev/termination-log', 'terminationMessagePolicy': 'File',
                'securityContext': {'runAsNonRoot': True, 'allowPrivilegeEscalation': False, 'capabilities': {'drop': ['ALL']}},
            }],
            'volumes': [{'name': 'config', 'configMap': {'name': app + '-config', 'defaultMode': 420}},
                        {'name': 'kube-api-access', 'projected': {'defaultMode': 420, 'sources': [
                            {'serviceAccountToken': {'expirationSeconds': 3607, 'path': 'token'}},
                            {'configMap': {'name': 'kube-root-ca.crt', 'items': [{'key': 'ca.crt', 'path': 'ca.crt'}]}},
                            {'downwardAPI': {'items': [{'path': 'namespace', 'fieldRef': {'apiVersion': 'v1', 'fieldPath': 'metadata.namespace'}}]}}]}}],
            'restartPolicy': 'Always', 'terminationGracePeriodSeconds': 30, 'dnsPolicy': 'ClusterFirst',
            'serviceAccountName': 'default', 'serviceAccount': 'default', 'nodeName': node, 'securityContext': {},
            'schedulerName': 'default-scheduler', 'priority': 0, 'enableServiceLinks': True, 'preemptionPolicy': 'PreemptLowerPriority',
            'tolerations': [{'key': 'node.kubernetes.io/not-ready', 'operator': 'Exists', 'effect': 'NoExecute', 'tolerationSeconds': 300},
                            {'key': 'node.kubernetes.io/unreachable', 'operator': 'Exists', 'effect': 'NoExecute', 'tolerationSeconds': 300}],
        },
        'status': {
            'phase': 'Running', 'hostIP': '10.0.0.%d' % (11 + int(node[-1])), 'hostIPs': [{'ip': '10.0.0.%d' % (11 + int(node[-1]))}],
            'podIP': ip, 'podIPs': [{'ip': ip}], 'startTime': ts(created + 2), 'qosClass': 'Burstable',
            'conditions': [{'type': t, 'status': 'True', 'lastProbeTime': None, 'lastTransitionTime': ts(created + 2 + i)} for i, t in enumerate(['PodReadyToStartContainers', 'Initialized', 'Ready', 'ContainersReady', 'PodScheduled'])],
            'containerStatuses': [{'name': 'main', 'ready': True, 'started': True, 'restartCount': 0, 'image': image,
                                   'imageID': image.split(':')[0] + '@sha256:' + '%064x' % rnd.getrandbits(256),
                                   'containerID': 'containerd://%064x' % rnd.getrandbits(256), 'state': {'running': {'startedAt': ts(created + 4)}}}],
        },
    }


def configmap(name, ns, data, binary=None):
    m, _ = meta(name, ns, labels={'app': name}, managers=[('kubectl-client-side-apply', 'Update', {'f:data': {'.': {}, **{'f:' + k: {} for k in data}}}, None)])
    o = {'apiVersion': 'v1', 'kind': 'ConfigMap', 'metadata': m, 'data': data}
    if binary:
        o['binaryData'] = {k: b64(v) for k, v in binary.items()}
    return o


def rules(size):
    groups = []
    while len(json.dumps(groups)) < size:
        groups.append({'alert': 'High%sLatency' % rnd.choice(['Api', 'Db', 'Cache', 'Queue']), 'expr': 'histogram_quantile(0.99, rate(http_request_duration_seconds_bucket[5m])) > %.1f' % rnd.uniform(0.2, 2),
                       'for': '%dm' % rnd.choice([5, 10, 15]), 'labels': {'severity': rnd.choice(['warning', 'critical'])}})
    return 'groups:\n- name: slo\n  rules:\n' + ''.join('  - alert: %s\n    expr: %s\n    for: %s\n    labels:\n      severity: %s\n' % (g['alert'], g['expr'], g['for'], g['labels']['severity']) for g in groups)


def secret(name, ns, encrypted):
    m, _ = meta(name, ns, managers=[('kubectl-create', 'Update', {'f:data': {'.': {}, 'f:api-key': {}, 'f:password': {}}, 'f:type': {}}, None)])
    plain = k8s({'apiVersion': 'v1', 'kind': 'Secret', 'metadata': m, 'type': 'Opaque',
                 'data': {'password': b64('pw-' + name), 'api-key': b64(os.urandom(24).hex())}})
    if not encrypted:
        return plain
    # kube-apiserver's aescbc provider: a prefix naming the provider and key,
    # then the IV and the ciphertext.
    return b'k8s:enc:aescbc:v1:key1:' + os.urandom(16) + os.urandom(len(plain) // 16 * 16 + 16)


def event(name, ns, pod_name, reason, n):
    m, created = meta(name, ns, created=T0 + 3600)
    return {'apiVersion': 'v1', 'kind': 'Event', 'metadata': m,
            'involvedObject': {'kind': 'Pod', 'namespace': ns, 'name': pod_name, 'uid': uid(), 'apiVersion': 'v1', 'resourceVersion': str(1000 + n), 'fieldPath': 'spec.containers{main}'},
            'reason': reason, 'type': 'Warning', 'count': n,
            'message': 'Back-off restarting failed container main in pod %s_%s(%s), the last %d attempts exited with code 137 after the memory limit was reached' % (pod_name, ns, uid(), n),
            'source': {'component': 'kubelet', 'host': 'node-%d' % rnd.randint(1, 3)},
            'firstTimestamp': ts(T0 + 3600), 'lastTimestamp': ts(T0 + 3600 + n * 30), 'eventTime': None,
            'reportingComponent': 'kubelet', 'reportingInstance': 'node-%d' % rnd.randint(1, 3)}


LEASE_META = {}


def lease_obj(name, ns, holder, renew, us):
    if (ns, name) not in LEASE_META:
        LEASE_META[(ns, name)] = meta(name, ns, created=T0, managers=[('kubelet' if ns == 'kube-node-lease' else 'kube-controller-manager', 'Update', {'f:spec': {'f:holderIdentity': {}, 'f:leaseDurationSeconds': {}, 'f:renewTime': {}}}, None)])[0]
    return {'apiVersion': 'coordination.k8s.io/v1', 'kind': 'Lease', 'metadata': LEASE_META[(ns, name)],
            'spec': {'holderIdentity': holder, 'leaseDurationSeconds': 40, 'acquireTime': micro(T0, 125000), 'renewTime': micro(renew, us), 'leaseTransitions': 0}}


def namespace(name):
    m, _ = meta(name, labels={'kubernetes.io/metadata.name': name})
    return {'apiVersion': 'v1', 'kind': 'Namespace', 'metadata': m, 'spec': {'finalizers': ['kubernetes']}, 'status': {'phase': 'Active'}}


def node(name, i):
    m, created = meta(name, labels={'kubernetes.io/hostname': name, 'kubernetes.io/os': 'linux', 'kubernetes.io/arch': 'amd64', 'node.kubernetes.io/instance-type': 'm6i.xlarge', 'topology.kubernetes.io/zone': 'eu-west-1' + 'abc'[i]},
                      annotations={'node.alpha.kubernetes.io/ttl': '0', 'volumes.kubernetes.io/controller-managed-attach-detach': 'true'},
                      managers=[('kubelet', 'Update', {'f:metadata': {'f:annotations': {'.': {}, 'f:volumes.kubernetes.io/controller-managed-attach-detach': {}}}}, None),
                                ('kubelet', 'Update', {'f:status': {'f:conditions': {}, 'f:images': {}, 'f:nodeInfo': {}}}, 'status')])
    cap = {'cpu': '4', 'memory': '16073356Ki', 'pods': '110', 'ephemeral-storage': '81106868Ki', 'hugepages-1Gi': '0', 'hugepages-2Mi': '0'}
    alloc = dict(cap, cpu='3920m', memory='15356556Ki', **{'ephemeral-storage': '74747526063'})
    return {'apiVersion': 'v1', 'kind': 'Node', 'metadata': m,
            'spec': {'podCIDR': '10.244.%d.0/24' % i, 'podCIDRs': ['10.244.%d.0/24' % i], 'providerID': 'aws:///eu-west-1%s/i-%017x' % ('abc'[i], rnd.getrandbits(68))},
            'status': {'capacity': cap, 'allocatable': alloc,
                       'conditions': [{'type': t, 'status': s, 'lastHeartbeatTime': ts(T0 + 7200), 'lastTransitionTime': ts(created + 30), 'reason': r, 'message': msg}
                                      for t, s, r, msg in [('MemoryPressure', 'False', 'KubeletHasSufficientMemory', 'kubelet has sufficient memory available'),
                                                           ('DiskPressure', 'False', 'KubeletHasNoDiskPressure', 'kubelet has no disk pressure'),
                                                           ('PIDPressure', 'False', 'KubeletHasSufficientPID', 'kubelet has sufficient PID available'),
                                                           ('Ready', 'True', 'KubeletReady', 'kubelet is posting ready status')]],
                       'addresses': [{'type': 'InternalIP', 'address': '10.0.0.%d' % (11 + i)}, {'type': 'Hostname', 'address': name}],
                       'daemonEndpoints': {'kubeletEndpoint': {'Port': 10250}},
                       'nodeInfo': {'machineID': '%032x' % rnd.getrandbits(128), 'systemUUID': uid(), 'bootID': uid(), 'kernelVersion': '6.8.0-1021-aws',
                                    'osImage': 'Ubuntu 24.04.3 LTS', 'containerRuntimeVersion': 'containerd://2.1.4', 'kubeletVersion': 'v1.37.1',
                                    'kubeProxyVersion': '', 'operatingSystem': 'linux', 'architecture': 'amd64'},
                       'images': [{'names': ['registry.example.com/%s@sha256:%064x' % (a, rnd.getrandbits(256)), 'registry.example.com/%s:1.4.2' % a], 'sizeBytes': rnd.randint(20, 400) * 1000000}
                                  for a in ['web', 'cart', 'checkout', 'prometheus', 'echo', 'coredns', 'kube-proxy']]}}


def deployment(name, ns, replicas):
    applied = {'apiVersion': 'apps/v1', 'kind': 'Deployment', 'metadata': {'annotations': {}, 'name': name, 'namespace': ns},
               'spec': {'replicas': replicas, 'selector': {'matchLabels': {'app': name}}, 'template': {'metadata': {'labels': {'app': name}},
                        'spec': {'containers': [{'image': 'registry.example.com/%s:1.4.2' % name, 'name': 'main'}]}}}}
    m, created = meta(name, ns, labels={'app': name}, generation=3,
                      annotations={'deployment.kubernetes.io/revision': '3', 'kubectl.kubernetes.io/last-applied-configuration': json.dumps(applied, separators=(',', ':')) + '\n'},
                      managers=[('kubectl-client-side-apply', 'Update', {'f:metadata': {'f:annotations': {'.': {}, 'f:kubectl.kubernetes.io/last-applied-configuration': {}}}, 'f:spec': {'f:replicas': {}}}, None),
                                ('kube-controller-manager', 'Update', {'f:status': {'f:availableReplicas': {}, 'f:conditions': {}, 'f:readyReplicas': {}}}, 'status')])
    return {'apiVersion': 'apps/v1', 'kind': 'Deployment', 'metadata': m,
            'spec': {'replicas': replicas, 'selector': {'matchLabels': {'app': name}}, 'revisionHistoryLimit': 10, 'progressDeadlineSeconds': 600,
                     'strategy': {'type': 'RollingUpdate', 'rollingUpdate': {'maxUnavailable': '25%', 'maxSurge': '25%'}},
                     'template': {'metadata': {'labels': {'app': name}, 'annotations': {'kubectl.kubernetes.io/restartedAt': '2026-09-30T14:02:11Z'}},
                                  'spec': {'containers': [{'name': 'main', 'image': 'registry.example.com/%s:1.4.2' % name, 'imagePullPolicy': 'IfNotPresent',
                                                           'terminationMessagePath': '/dev/termination-log', 'terminationMessagePolicy': 'File', 'resources': {}}],
                                           'restartPolicy': 'Always', 'terminationGracePeriodSeconds': 30, 'dnsPolicy': 'ClusterFirst', 'securityContext': {}, 'schedulerName': 'default-scheduler'}}},
            'status': {'observedGeneration': 3, 'replicas': replicas, 'updatedReplicas': replicas, 'readyReplicas': replicas, 'availableReplicas': replicas,
                       'conditions': [{'type': 'Available', 'status': 'True', 'lastUpdateTime': ts(created + 60), 'lastTransitionTime': ts(created + 60), 'reason': 'MinimumReplicasAvailable', 'message': 'Deployment has minimum availability.'},
                                      {'type': 'Progressing', 'status': 'True', 'lastUpdateTime': ts(created + 90), 'lastTransitionTime': ts(created + 10), 'reason': 'NewReplicaSetAvailable', 'message': 'ReplicaSet "%s-7d4b9c8f6d" has successfully progressed.' % name}]}}


def service(name, ns, port):
    m, _ = meta(name, ns, labels={'app': name})
    ip = '10.96.%d.%d' % (rnd.randint(0, 255), rnd.randint(1, 254))
    return {'apiVersion': 'v1', 'kind': 'Service', 'metadata': m,
            'spec': {'ports': [{'name': 'http', 'protocol': 'TCP', 'port': 80, 'targetPort': 'http' if port == 'http' else port}], 'selector': {'app': name},
                     'clusterIP': ip, 'clusterIPs': [ip], 'type': 'ClusterIP', 'sessionAffinity': 'None', 'ipFamilies': ['IPv4'], 'ipFamilyPolicy': 'SingleStack', 'internalTrafficPolicy': 'Cluster'},
            'status': {'loadBalancer': {}}}


def endpointslice(name, ns, n):
    m, _ = meta(name + '-abc12', ns, labels={'kubernetes.io/service-name': name, 'endpointslice.kubernetes.io/managed-by': 'endpointslice-controller.k8s.io'}, generateName=name + '-')
    return {'apiVersion': 'discovery.k8s.io/v1', 'kind': 'EndpointSlice', 'metadata': m, 'addressType': 'IPv4',
            'endpoints': [{'addresses': ['10.244.%d.%d' % (i % 3, 10 + i)], 'conditions': {'ready': True, 'serving': True, 'terminating': False}, 'nodeName': 'node-%d' % (i % 3 + 1),
                           'targetRef': {'kind': 'Pod', 'namespace': ns, 'name': '%s-%d' % (name, i), 'uid': uid()}} for i in range(n)],
            'ports': [{'name': 'http', 'port': 8080, 'protocol': 'TCP'}]}


def extras(edge_cases=True):
    """One of each of the other kinds a cluster keeps, with Kubernetes' special types in them."""
    out = []
    m, created = meta('fluent-bit', 'monitoring', labels={'app': 'fluent-bit'})
    out.append(('/registry/daemonsets/monitoring/fluent-bit', {
        'apiVersion': 'apps/v1', 'kind': 'DaemonSet', 'metadata': m,
        'spec': {'selector': {'matchLabels': {'app': 'fluent-bit'}}, 'updateStrategy': {'type': 'RollingUpdate', 'rollingUpdate': {'maxUnavailable': 1, 'maxSurge': 0}},
                 'template': {'metadata': {'labels': {'app': 'fluent-bit'}}, 'spec': {'containers': [{'name': 'fluent-bit', 'image': 'fluent/fluent-bit:4.0.3', 'args': ['--config', '/etc/fluent-bit/fluent-bit.yaml'], 'command': ['/fluent-bit/bin/fluent-bit']}],
                              'tolerations': [{'operator': 'Exists'}], 'hostNetwork': True}}},
        'status': {'currentNumberScheduled': 3, 'numberMisscheduled': 0, 'desiredNumberScheduled': 3, 'numberReady': 3, 'observedGeneration': 1, 'updatedNumberScheduled': 3, 'numberAvailable': 3}}))
    m, _ = meta('fluent-bit-5d8f7c9b4', 'monitoring', labels={'app': 'fluent-bit', 'controller-revision-hash': '5d8f7c9b4'})
    out.append(('/registry/controllerrevisions/monitoring/fluent-bit-5d8f7c9b4', {
        'apiVersion': 'apps/v1', 'kind': 'ControllerRevision', 'metadata': m, 'revision': 1,
        'data': {'spec': {'template': {'$patch': 'replace', 'metadata': {'labels': {'app': 'fluent-bit'}}, 'spec': {'containers': [{'name': 'fluent-bit', 'image': 'fluent/fluent-bit:4.0.3'}]}}},
                 'weights': [0.5, 1.25, 2e-7, 1500000.0, 3, 10000000000], 'enabled': True, 'nothing': None}}))
    m, _ = meta('web', 'shop')
    out.append(('/registry/horizontalpodautoscalers/shop/web', {
        'apiVersion': 'autoscaling/v2', 'kind': 'HorizontalPodAutoscaler', 'metadata': m,
        'spec': {'scaleTargetRef': {'apiVersion': 'apps/v1', 'kind': 'Deployment', 'name': 'web'}, 'minReplicas': 3, 'maxReplicas': 20,
                 'metrics': [{'type': 'Resource', 'resource': {'name': 'cpu', 'target': {'type': 'Utilization', 'averageUtilization': 70}}},
                             {'type': 'Pods', 'pods': {'metric': {'name': 'http_requests_per_second'}, 'target': {'type': 'AverageValue', 'averageValue': '1500m'}}}],
                 'behavior': {'scaleDown': {'stabilizationWindowSeconds': 300, 'selectPolicy': 'Max', 'policies': [{'type': 'Percent', 'value': 50, 'periodSeconds': 60}]}}},
        'status': {'currentReplicas': 6, 'desiredReplicas': 6, 'lastScaleTime': ts(T0 + 5000),
                   'currentMetrics': [{'type': 'Resource', 'resource': {'name': 'cpu', 'current': {'averageUtilization': 41, 'averageValue': '102m'}}}],
                   'conditions': [{'type': 'AbleToScale', 'status': 'True', 'lastTransitionTime': ts(T0 + 100), 'reason': 'ReadyForNewScale', 'message': 'recommended size matches current size'}]}}))
    m, _ = meta('web', 'shop')
    out.append(('/registry/poddisruptionbudgets/shop/web', {'apiVersion': 'policy/v1', 'kind': 'PodDisruptionBudget', 'metadata': m,
                'spec': {'minAvailable': '50%', 'selector': {'matchLabels': {'app': 'web'}}},
                'status': {'observedGeneration': 1, 'disruptionsAllowed': 3, 'currentHealthy': 6, 'desiredHealthy': 3, 'expectedPods': 6}}))
    m, _ = meta('report', 'shop')
    out.append(('/registry/cronjobs/shop/report', {'apiVersion': 'batch/v1', 'kind': 'CronJob', 'metadata': m,
                'spec': {'schedule': '*/15 * * * *', 'timeZone': 'Europe/Amsterdam', 'concurrencyPolicy': 'Forbid', 'suspend': False, 'successfulJobsHistoryLimit': 3, 'failedJobsHistoryLimit': 1,
                         'jobTemplate': {'spec': {'backoffLimit': 2, 'template': {'spec': {'restartPolicy': 'OnFailure', 'containers': [{'name': 'report', 'image': 'registry.example.com/report:2.0.0', 'args': ['--since', '15m', '--format=csv']}]}}}}},
                'status': {'lastScheduleTime': ts(T0 + 6300), 'lastSuccessfulTime': ts(T0 + 6342)}}))
    m, _ = meta('system:controller:report-reader')
    out.append(('/registry/clusterroles/system:controller:report-reader', {'apiVersion': 'rbac.authorization.k8s.io/v1', 'kind': 'ClusterRole', 'metadata': m,
                'rules': [{'apiGroups': [''], 'resources': ['pods', 'pods/log'], 'verbs': ['get', 'list', 'watch']}, {'apiGroups': ['batch'], 'resources': ['jobs'], 'verbs': ['*']},
                          {'nonResourceURLs': ['/healthz', '/metrics'], 'verbs': ['get']}]}))
    m, _ = meta('report-reader')
    out.append(('/registry/clusterrolebindings/report-reader', {'apiVersion': 'rbac.authorization.k8s.io/v1', 'kind': 'ClusterRoleBinding', 'metadata': m,
                'roleRef': {'apiGroup': 'rbac.authorization.k8s.io', 'kind': 'ClusterRole', 'name': 'system:controller:report-reader'},
                'subjects': [{'kind': 'ServiceAccount', 'name': 'report', 'namespace': 'shop'}]}))
    m, _ = meta('csr-8kq2v')
    out.append(('/registry/certificatesigningrequests/csr-8kq2v', {'apiVersion': 'certificates.k8s.io/v1', 'kind': 'CertificateSigningRequest', 'metadata': m,
                'spec': {'request': b64('-----BEGIN CERTIFICATE REQUEST-----\nMIIBfake\n-----END CERTIFICATE REQUEST-----\n'), 'signerName': 'kubernetes.io/kube-apiserver-client-kubelet',
                         'usages': ['digital signature', 'client auth'], 'username': 'system:node:node-2', 'groups': ['system:nodes', 'system:authenticated'],
                         'extra': {'authentication.kubernetes.io/credential-id': ['X509SHA256=%064x' % rnd.getrandbits(256)], 'scopes': ['a', 'b']}, 'uid': uid()},
                'status': {'conditions': [{'type': 'Approved', 'status': 'True', 'reason': 'AutoApproved', 'message': 'Auto approving kubelet client certificate after SubjectAccessReview.', 'lastUpdateTime': ts(T0 + 40), 'lastTransitionTime': ts(T0 + 40)}],
                           'certificate': b64('-----BEGIN CERTIFICATE-----\nMIIBfakecert\n-----END CERTIFICATE-----\n')}}))
    m, _ = meta('system-cluster-critical')
    out.append(('/registry/priorityclasses/system-cluster-critical', {'apiVersion': 'scheduling.k8s.io/v1', 'kind': 'PriorityClass', 'metadata': m, 'value': 2000000000,
                'description': 'Used for system critical pods that must run in the cluster, but can be moved to another node if necessary.', 'preemptionPolicy': 'PreemptLowerPriority'}))
    m, _ = meta('data-postgres-0', 'shop', finalizers=['kubernetes.io/pvc-protection'])
    out.append(('/registry/persistentvolumeclaims/shop/data-postgres-0', {'apiVersion': 'v1', 'kind': 'PersistentVolumeClaim', 'metadata': m,
                'spec': {'accessModes': ['ReadWriteOnce'], 'resources': {'requests': {'storage': '20Gi'}}, 'storageClassName': 'gp3', 'volumeMode': 'Filesystem', 'volumeName': 'pvc-' + uid()},
                'status': {'phase': 'Bound', 'accessModes': ['ReadWriteOnce'], 'capacity': {'storage': '20Gi'}}}))
    m, _ = meta('pvc-0b6c', finalizers=['kubernetes.io/pv-protection', 'external-attacher/ebs-csi-aws-com'])
    out.append(('/registry/persistentvolumes/pvc-0b6c', {'apiVersion': 'v1', 'kind': 'PersistentVolume', 'metadata': m,
                'spec': {'capacity': {'storage': '20Gi'}, 'csi': {'driver': 'ebs.csi.aws.com', 'volumeHandle': 'vol-%017x' % rnd.getrandbits(68), 'fsType': 'ext4', 'volumeAttributes': {'storage.kubernetes.io/csiProvisionerIdentity': '1790000000000-1234-ebs.csi.aws.com'}},
                         'accessModes': ['ReadWriteOnce'], 'persistentVolumeReclaimPolicy': 'Delete', 'storageClassName': 'gp3', 'volumeMode': 'Filesystem',
                         'claimRef': {'kind': 'PersistentVolumeClaim', 'namespace': 'shop', 'name': 'data-postgres-0', 'uid': uid(), 'apiVersion': 'v1', 'resourceVersion': '4242'},
                         'nodeAffinity': {'required': {'nodeSelectorTerms': [{'matchExpressions': [{'key': 'topology.kubernetes.io/zone', 'operator': 'In', 'values': ['eu-west-1a']}]}]}}},
                'status': {'phase': 'Bound', 'lastPhaseTransitionTime': ts(T0 + 900)}}))
    m, _ = meta('web', 'shop', annotations={'nginx.ingress.kubernetes.io/rewrite-target': '/$1', 'nginx.ingress.kubernetes.io/configuration-snippet': 'more_set_headers "X-Frame-Options: DENY";\nmore_set_headers "X-Content-Type-Options: nosniff";\n'})
    out.append(('/registry/ingress/shop/web', {'apiVersion': 'networking.k8s.io/v1', 'kind': 'Ingress', 'metadata': m,
                'spec': {'ingressClassName': 'nginx', 'tls': [{'hosts': ['shop.example.com'], 'secretName': 'web-tls'}],
                         'rules': [{'host': 'shop.example.com', 'http': {'paths': [{'path': '/(.*)', 'pathType': 'ImplementationSpecific', 'backend': {'service': {'name': 'web', 'port': {'number': 80}}}}]}}]},
                'status': {'loadBalancer': {'ingress': [{'hostname': 'a1b2c3.elb.eu-west-1.amazonaws.com'}]}}}))
    m, _ = meta('web.example.com', annotations={'cert-manager.io/inject-ca-from': 'cert-manager/webhook-ca'})
    out.append(('/registry/mutatingwebhookconfigurations/web.example.com', {'apiVersion': 'admissionregistration.k8s.io/v1', 'kind': 'MutatingWebhookConfiguration', 'metadata': m,
                'webhooks': [{'name': 'inject.web.example.com', 'admissionReviewVersions': ['v1'], 'sideEffects': 'None', 'failurePolicy': 'Ignore', 'timeoutSeconds': 5, 'matchPolicy': 'Equivalent', 'reinvocationPolicy': 'Never',
                              'clientConfig': {'service': {'namespace': 'shop', 'name': 'injector', 'path': '/mutate', 'port': 443}, 'caBundle': b64(b'-----BEGIN CERTIFICATE-----\nMIIBca\n-----END CERTIFICATE-----\n')},
                              'rules': [{'operations': ['CREATE', 'UPDATE'], 'apiGroups': [''], 'apiVersions': ['v1'], 'resources': ['pods'], 'scope': '*'}],
                              'namespaceSelector': {'matchExpressions': [{'key': 'inject', 'operator': 'NotIn', 'values': ['off', 'no']}]}}]}))
    m, _ = meta('certificates.cert-manager.io', labels={'app.kubernetes.io/name': 'cert-manager'})
    out.append(('/registry/apiextensions.k8s.io/customresourcedefinitions/certificates.cert-manager.io', {
        'apiVersion': 'apiextensions.k8s.io/v1', 'kind': 'CustomResourceDefinition', 'metadata': m,
        'spec': {'group': 'cert-manager.io', 'scope': 'Namespaced', 'names': {'plural': 'certificates', 'singular': 'certificate', 'kind': 'Certificate', 'listKind': 'CertificateList', 'shortNames': ['cert', 'certs'], 'categories': ['cert-manager']},
                 'versions': [{'name': 'v1', 'served': True, 'storage': True, 'subresources': {'status': {}},
                               'additionalPrinterColumns': [{'name': 'Ready', 'type': 'string', 'jsonPath': '.status.conditions[?(@.type == "Ready")].status'}, {'name': 'Age', 'type': 'date', 'jsonPath': '.metadata.creationTimestamp'}],
                               'schema': {'openAPIV3Schema': {'type': 'object', 'description': 'A Certificate resource should be created to ensure an up to date and signed X.509 certificate is stored in the Kubernetes Secret resource named in `spec.secretName`.',
                                   'required': ['spec'], 'properties': {
                                       'apiVersion': {'type': 'string'}, 'kind': {'type': 'string'}, 'metadata': {'type': 'object'},
                                       'spec': {'type': 'object', 'required': ['issuerRef', 'secretName'], 'properties': {
                                           'dnsNames': {'type': 'array', 'items': {'type': 'string'}, 'x-kubernetes-list-type': 'atomic'},
                                           'duration': {'type': 'string', 'default': '2160h', 'pattern': '^[0-9]+(h|m|s)$'},
                                           'secretName': {'type': 'string', 'minLength': 1, 'maxLength': 253},
                                           'privateKey': {'type': 'object', 'properties': {'algorithm': {'type': 'string', 'enum': ['RSA', 'ECDSA', 'Ed25519']}, 'size': {'type': 'integer', 'minimum': 256, 'maximum': 8192, 'format': 'int32'}}},
                                           'secretTemplate': {'type': 'object', 'properties': {'labels': {'type': 'object', 'additionalProperties': {'type': 'string'}}}},
                                           'issuerRef': {'type': 'object', 'required': ['name'], 'properties': {'name': {'type': 'string'}, 'kind': {'type': 'string'}, 'group': {'type': 'string'}}},
                                           'additionalOutputFormats': {'type': 'array', 'items': {'type': 'object', 'additionalProperties': False, 'properties': {'type': {'type': 'string'}}}},
                                           'keystores': {'type': 'object', 'x-kubernetes-preserve-unknown-fields': True}}},
                                       'status': {'type': 'object', 'properties': {'conditions': {'type': 'array', 'x-kubernetes-list-map-keys': ['type'], 'x-kubernetes-list-type': 'map',
                                           'items': {'type': 'object', 'required': ['status', 'type'], 'properties': {'status': {'type': 'string', 'enum': ['True', 'False', 'Unknown']}, 'type': {'type': 'string'}}}}}}}}}}]},
        'status': {'storedVersions': ['v1'], 'acceptedNames': {'plural': 'certificates', 'singular': 'certificate', 'kind': 'Certificate', 'listKind': 'CertificateList', 'shortNames': ['cert', 'certs'], 'categories': ['cert-manager']},
                   'conditions': [{'type': 'Established', 'status': 'True', 'lastTransitionTime': ts(T0 + 20), 'reason': 'InitialNamesAccepted', 'message': 'the initial names have been accepted'}]}}))
    m, _ = meta('v1beta1.metrics.k8s.io', labels={'k8s-app': 'metrics-server'})
    out.append(('/registry/apiregistration.k8s.io/apiservices/v1beta1.metrics.k8s.io', {'apiVersion': 'apiregistration.k8s.io/v1', 'kind': 'APIService', 'metadata': m,
                'spec': {'service': {'name': 'metrics-server', 'namespace': 'kube-system', 'port': 443}, 'group': 'metrics.k8s.io', 'version': 'v1beta1', 'insecureSkipTLSVerify': True, 'groupPriorityMinimum': 100, 'versionPriority': 100},
                'status': {'conditions': [{'type': 'Available', 'status': 'True', 'lastTransitionTime': ts(T0 + 300), 'reason': 'Passed', 'message': 'all checks passed'}]}}))
    # A pod being deleted: deletionTimestamp is set and a grace period counts down.
    p = pod('echo-9', 'default', 'node-2', 'echo', 'echo-6f9d8b7c5')
    p['metadata']['deletionTimestamp'] = ts(T0 + 7000)
    p['metadata']['deletionGracePeriodSeconds'] = 30
    out.append(('/registry/pods/default/echo-9', p))
    if not edge_cases:
        return out
    # Values that YAML has to quote or write in a special way.
    tricky = {'yes': 'yes', 'no': 'No', 'on': 'ON', 'y': 'y', 'tilde': '~', 'null': 'null', 'empty': '', 'number': '8080', 'octal': '0755', 'hex': '0x1F', 'float': '1e3',
              'underscore': '1_000', 'ports': '8080:80', 'sexagesimal': '1:20:30', 'date': '2026-10-06', 'datetime': '2026-10-06 08:11:03', 'version': '1.2.3', 'infinity': '.inf',
              'binary': '0b101', 'plus': '+1', 'dot': '.5', 'dash': '- item', 'question': '? what', 'colon': 'key: value', 'hash': 'a #b', 'hash2': '#comment', 'brace': '{json}',
              'bracket': '[list]', 'star': '*alias', 'amp': '&anchor', 'bang': '!tag', 'pipe': '|pipe', 'gt': '>folded', 'percent': '%TAG', 'at': '@at', 'tick': '`tick',
              'quote': "it's", 'dquote': 'say "hi"', 'backslash': 'C:\\Users', 'leading': ' leading', 'trailing': 'trailing ', 'tab': 'a\tb', 'emoji': 'ship it 🚀', 'accent': 'café',
              'multi': 'line one\nline two\n', 'multi-no-end': 'line one\nline two', 'multi-two-ends': 'line one\n\n', 'multi-lead': '  indented\nnext\n', 'multi-trailing-space': 'a \nb\n',
              'control': 'bell\u0007', 'nel': 'a\u0085b', 'nbsp': 'a\u00a0b', 'dots': '...', 'dashes': '---', 'lone-dash': '-', 'colon-end': 'trailing:', 'url': 'http://example.com/a?b=c#d',
              'long': 'This sentence is long enough that the YAML writer has to fold it across more than one line when kubectl prints it, at the first space after column eighty.',
              'long-quoted': 'key: this one also has a colon and a space early on, so it goes in single quotes, and it is long enough to be folded too.',
              'long-nospace': 'x' * 120, 'merge': '<<', 'True': 'True', 'Off': 'off', '012': 'leading zero key'}
    long_key = 'example.com/' + 'k' * 130
    m, _ = meta('yaml-edge-cases', 'default', annotations={long_key: 'a key over 128 bytes', 'true': 'a key YAML reads as a bool', '8080': 'a key YAML reads as a number', 'multi\nline-key': 'a key with a line break'})
    out.append(('/registry/configmaps/default/yaml-edge-cases', {'apiVersion': 'v1', 'kind': 'ConfigMap', 'metadata': m, 'data': tricky, 'binaryData': {'blob': b64(bytes(range(0, 256, 7)))}}))
    # Key order, line breaks YAML reads differently, and long quoted text. (Not keys like
    # 1a, 9a and 10a together: go-yaml's order for those goes round in a circle, so
    # kubectl itself prints them in a different order from one run to the next.)
    more = {'a10': 'natural order', 'a2': 'natural order', 'a01': 'leading zero', 'a1': 'one', 'a': 'letter', 'A': 'capital', 'Z': 'capital',
            '_under': 'punctuation', '-dash': 'punctuation', '1a': 'digit', '9a': 'digit', '0': 'zero', '00': 'zeros', 'ä': 'non-ASCII letter',
            'nel-run': 'a\u0085\u0085b', 'nel-spaces': 'a \u0085  b', 'nel-edges': '\u0085a\u0085', 'line-sep': 'a\u2028b',
            'para-sep-multi': 'a\u2029b\nc\n', 'tab-long': '\t' + ' '.join(['word'] * 30), 'quote-long': "'" + ' '.join(['word'] * 30), 'spaces-long': 'x ' + '  '.join(['word'] * 30),
            'emoji-long': ' '.join(['🚀'] * 50), 'literal-long': '\n'.join(['a long line ' * 12] * 2) + '\n', 'colon-space-end': 'ends with colon: ', 'hash-start-long': '#' + ' word' * 30,
            'bom': '\ufeffbom', 'private': '\ue000', 'cr': 'a\rb', 'crlf': 'a\r\nb\r\n', 'only-newline': '\n', 'two-newlines': '\n\n',
            'space-newline': ' \n', 'newline-space': '\n ', 'trail-newline-space': 'a\n ', 'yes-multi': 'yes\nno\n', 'number-multi': '1\n2', 'date-like': '2026-02-30', 'datetime-z': '2026-10-06T08:11:03Z',
            'datetime-t-nozone': '2026-10-06T08:11:03', 'datetime-frac': '2026-10-06 08:11:03.5', 'datetime-bad-hour': '2026-10-06 25:00:00', 'time-short': '2026-1-2t3:4:5+01:00',
            'hex-upper': '0X1F', 'octal-o': '0o17', 'bad-octal': '09', 'big-int': '99999999999999999999', 'neg-zero': '-0', 'exp': '1E+5', 'dot-exp': '.5e3', 'inf-word': 'inf', 'sign-only': '+',
            'base60-float': '1:20.5', 'not-base60': '1:60', 'underscore-float': '1_0.5', 'leading-plus-float': '+.5', 'tilde-word': '~x', 'question-end': 'what?', 'colon-mid': 'a:b'}
    m, _ = meta('yaml-edge-cases-2', 'default')
    out.append(('/registry/configmaps/default/yaml-edge-cases-2', {'apiVersion': 'v1', 'kind': 'ConfigMap', 'metadata': m, 'data': more}))
    # What go-yaml refuses to read back, so kubectl cannot print these as YAML at all:
    # control characters, and a line break in a key.
    m, _ = meta('yaml-unprintable', 'default')
    out.append(('/registry/configmaps/default/yaml-unprintable', {'apiVersion': 'v1', 'kind': 'ConfigMap', 'metadata': m, 'data': {'del': 'a\x7fb', 'c1': 'a\x9fb', 'nonchar': '\uffff'}}))
    m, _ = meta('yaml-break-in-key', 'default')
    out.append(('/registry/configmaps/default/yaml-break-in-key', {'apiVersion': 'v1', 'kind': 'ConfigMap', 'metadata': m, 'data': {'z\u0085key': 'a key with U+0085'}}))
    return out


# ---- filling a cluster ----

def fill(e, encrypted, small=False, example=False):
    """Writes a small cluster's worth of keys with history, and returns notes."""
    notes = {}
    nodes = ['node-1', 'node-2', 'node-3']
    for ns in ['default', 'kube-system', 'kube-node-lease', 'shop', 'monitoring']:
        e.put('/registry/namespaces/' + ns, k8s(namespace(ns)))
    for i, n in enumerate(nodes):
        e.put('/registry/minions/' + n, k8s(node(n, i)))
    apps_ = [('shop', 'web', 6), ('shop', 'cart', 3), ('shop', 'checkout', 2), ('monitoring', 'prometheus', 1), ('default', 'echo', 2)]
    if small:
        apps_ = apps_[:2]
    for ns, app, replicas in apps_:
        e.put('/registry/deployments/%s/%s' % (ns, app), k8s(deployment(app, ns, replicas)))
        e.put('/registry/services/specs/%s/%s' % (ns, app), k8s(service(app, ns, 'http' if app != 'echo' else 8080)))
        e.put('/registry/endpointslices/%s/%s-abc12' % (ns, app), k8s(endpointslice(app, ns, replicas)))
        for i in range(replicas):
            e.put('/registry/pods/%s/%s-%d' % (ns, app, i), k8s(pod('%s-%d' % (app, i), ns, nodes[i % 3], app, app + '-7d4b9c8f6d')))
    e.put('/registry/configmaps/monitoring/prometheus-rules', k8s(configmap('prometheus-rules', 'monitoring', {'rules.yaml': rules(20000 if small else 60000)})))
    e.put('/registry/configmaps/kube-system/coredns', k8s(configmap('coredns', 'kube-system', {'Corefile': '.:53 {\n    errors\n    health {\n       lameduck 5s\n    }\n    ready\n    kubernetes cluster.local in-addr.arpa ip6.arpa {\n       pods insecure\n       fallthrough in-addr.arpa ip6.arpa\n       ttl 30\n    }\n    forward . /etc/resolv.conf\n    cache 30\n    loop\n    reload\n}\n'})))
    for ns, name in [('shop', 'db-credentials'), ('shop', 'stripe-api'), ('monitoring', 'grafana-admin'), ('kube-system', 'bootstrap-token-x7k2p')]:
        e.put('/registry/secrets/%s/%s' % (ns, name), secret(name, ns, encrypted))
    if not small:
        for key, obj in extras(edge_cases=not example):
            e.put(key, k8s(obj))
    # A custom resource: kube-apiserver stores those as JSON.
    cert = {'apiVersion': 'cert-manager.io/v1', 'kind': 'Certificate',
            'metadata': {'creationTimestamp': ts(T0 + 400), 'generation': 1, 'name': 'web-tls', 'namespace': 'shop', 'uid': uid()},
            'spec': {'dnsNames': ['shop.example.com'], 'duration': '2160h', 'issuerRef': {'kind': 'ClusterIssuer', 'name': 'letsencrypt'}, 'privateKey': {'algorithm': 'ECDSA', 'size': 256}, 'secretName': 'web-tls'},
            'status': {'conditions': [{'lastTransitionTime': ts(T0 + 460), 'message': 'Certificate is up to date and has not expired', 'observedGeneration': 1, 'reason': 'Ready', 'status': 'True', 'type': 'Ready'}],
                       'notAfter': ts(T0 + 400 + 90 * 86400), 'renewalTime': ts(T0 + 400 + 60 * 86400), 'revision': 1}}
    e.put('/registry/cert-manager.io/certificates/shop/web-tls', custom(cert))
    if not small:
        rollout = {'apiVersion': 'argoproj.io/v1alpha1', 'kind': 'Rollout',
                   'metadata': {'creationTimestamp': ts(T0 + 800), 'generation': 4, 'name': 'checkout', 'namespace': 'shop', 'uid': uid(), 'labels': {'app': 'checkout'}},
                   'spec': {'replicas': 2, 'revisionHistoryLimit': 3, 'selector': {'matchLabels': {'app': 'checkout'}},
                            'strategy': {'canary': {'steps': [{'setWeight': 20}, {'pause': {'duration': '10m'}}, {'setWeight': 50.0}, {'pause': {}}],
                                                    'analysis': {'successRate': 0.995, 'maxLatencySeconds': 1.5e6, 'tiny': 2e-7, 'huge': 1e22, 'exact': 12345678901234567890, 'negative': -0.25, 'whole': 3.0}}},
                            'template': {'metadata': {'labels': {'app': 'checkout'}}, 'spec': {'containers': [{'name': 'main', 'image': 'registry.example.com/checkout:3.1.0'}]}}},
                   'status': {'currentStepIndex': 1, 'phase': 'Paused', 'message': 'CanaryPauseStep', 'pauseConditions': [{'reason': 'CanaryPauseStep', 'startTime': ts(T0 + 900)}], 'readyReplicas': 2}}
        e.put('/registry/argoproj.io/rollouts/shop/checkout', custom(rollout))

    # Events live an hour, through a lease, as kube-apiserver writes them.
    ev_lease = e.lease(3600)
    notes['eventLease'] = '%x' % ev_lease
    events = []
    for i in range(12 if small else 40):
        ns, app = rnd.choice([('shop', 'web'), ('shop', 'cart'), ('default', 'echo')])
        pod_name = '%s-%d' % (app, rnd.randint(0, 2))
        name = '%s.%x' % (pod_name, rnd.getrandbits(48))
        key = '/registry/events/%s/%s' % (ns, name)
        for n in range(1, rnd.randint(2, 4)):
            e.put(key, k8s(event(name, ns, pod_name, 'BackOff', n)), ev_lease)
        events.append(key)

    # Node heartbeats: each node renews its lease every 10 seconds.
    renew = T0 + 600
    for step in range(15 if small else 40):
        for n in nodes:
            e.put('/registry/leases/kube-node-lease/' + n, k8s(lease_obj(n, 'kube-node-lease', n, renew + step * 10, rnd.randint(0, 999999))))
        if step % 2 == 0:
            e.put('/registry/leases/kube-system/kube-controller-manager', k8s(lease_obj('kube-controller-manager', 'kube-system', 'cp-1_7f3', renew + step * 10, rnd.randint(0, 999999))))
    mid = int(e.post('/v3/maintenance/status', {})['header']['revision'])
    # Compact what came before, as kube-apiserver does every five minutes.
    e.compact(mid)
    notes['compactedAt'] = mid

    # More history after the compaction.
    for step in range(10):
        for n in nodes:
            e.put('/registry/leases/kube-node-lease/' + n, k8s(lease_obj(n, 'kube-node-lease', n, renew + 1000 + step * 10, rnd.randint(0, 999999))))
    e.put('/registry/configmaps/monitoring/prometheus-rules', k8s(configmap('prometheus-rules', 'monitoring', {'rules.yaml': rules(20000 if small else 61000)})))
    for key in events[:5]:
        e.delete(key)
    e.delete('/registry/pods/shop/web-5' if not small else '/registry/pods/shop/web-1')
    e.put('/registry/pods/shop/web-6' if not small else '/registry/pods/shop/web-2', k8s(pod('web-6', 'shop', 'node-1', 'web', 'web-7d4b9c8f6d')))
    return notes


def expected(e, snapshot, notes, etcdutl):
    """What etcd itself says about the data and the snapshot."""
    out = {'notes': notes}
    # etcd 3.4 has no etcdutl; its etcdctl checks snapshots itself.
    if os.path.exists(etcdutl):
        st = json.loads(subprocess.run([etcdutl, 'snapshot', 'status', snapshot, '-w', 'json'], capture_output=True, check=True).stdout)
    else:
        st = json.loads(e.ctl('snapshot', 'status', snapshot, '-w', 'json'))
    out['snapshotStatus'] = st
    status = json.loads(e.ctl('endpoint', 'status', '-w', 'json'))[0]['Status']
    out['endpointStatus'] = {'dbSize': status.get('dbSize'), 'dbSizeInUse': status.get('dbSizeInUse'), 'revision': status['header']['revision']}
    live = json.loads(e.ctl('get', '', '--prefix', '-w', 'json'))
    out['live'] = [{'key': base64.b64decode(kv['key']).decode('utf-8', 'replace'), 'createRevision': kv['create_revision'], 'modRevision': kv['mod_revision'],
                    'version': kv['version'], 'lease': '%x' % kv['lease'] if kv.get('lease') else '', 'valueSha256': hashlib.sha256(base64.b64decode(kv.get('value', ''))).hexdigest(),
                    'valueBytes': len(base64.b64decode(kv.get('value', '')))} for kv in live.get('kvs', [])]
    # Every revision etcd can still serve, for keys with history.
    hist = {}
    revision = out['endpointStatus']['revision']
    for key in ['/registry/leases/kube-node-lease/node-1', '/registry/configmaps/monitoring/prometheus-rules', '/registry/leases/kube-system/kube-controller-manager']:
        seen = {}
        for rev in range(notes['compactedAt'], revision + 1):
            r = json.loads(e.ctl('get', key, '--rev', str(rev), '-w', 'json'))
            for kv in r.get('kvs', []):
                seen[kv['mod_revision']] = {'version': kv['version'], 'valueSha256': hashlib.sha256(base64.b64decode(kv['value'])).hexdigest()}
        hist[key] = seen
    out['history'] = hist
    members = json.loads(e.ctl('member', 'list', '-w', 'json'))
    out['members'] = [{'name': m.get('name'), 'peerURLs': m.get('peerURLs'), 'clientURLs': m.get('clientURLs')} for m in members['members']]
    alarms = e.ctl('alarm', 'list').decode().strip()
    out['alarms'] = [a for a in alarms.split('\n') if a]
    # bbolt's own tool on the same file, without the hash etcdctl appends.
    bbolt = os.environ.get('BBOLT')
    if bbolt:
        with open(snapshot, 'rb') as f:
            data = f.read()
        if len(data) % 4096 == 32:
            data = data[:-32]
        with open('/tmp/bbolt-plain.db', 'wb') as f:
            f.write(data)
        pages = subprocess.run([bbolt, 'pages', '/tmp/bbolt-plain.db'], capture_output=True, check=True, text=True).stdout.split('\n')[2:]
        kinds = {}
        for line in pages:
            parts = line.split()
            if len(parts) >= 2:
                kinds[parts[1]] = kinds.get(parts[1], 0) + 1 + (int(parts[3]) if len(parts) > 3 and parts[3].isdigit() else 0)
        stats = subprocess.run([bbolt, 'stats', '/tmp/bbolt-plain.db'], capture_output=True, check=True, text=True).stdout
        pairs = int([l for l in stats.split('\n') if 'Number of keys/value pairs' in l][0].split(':')[1])
        out['bbolt'] = {'pages': kinds, 'keyValuePairs': pairs}
    return out


def run(bindir, version, label, encrypted, small=False, extra=(), auth=False, fillup=False):
    e = Etcd(bindir, label, extra)
    notes = fill(e, encrypted, small)
    if fillup:
        # Write until the space quota runs out and etcd raises its NOSPACE alarm.
        try:
            for i in range(10000):
                e.put('/registry/configmaps/default/bulk-%d' % i, k8s(configmap('bulk-%d' % i, 'default', {'data': ''.join(rnd.choice('abcdefghij: \n') for _ in range(3000))})))
        except Exception:
            notes['filledUpAfter'] = i
    if auth:
        e.ctl('user', 'add', 'root', '--new-user-password', 'example-root-password')
        e.ctl('user', 'grant-role', 'root', 'root')
        e.ctl('role', 'add', 'kube-apiserver')
        e.ctl('role', 'grant-permission', 'kube-apiserver', 'readwrite', '/registry/', '--prefix=true')
        e.ctl('user', 'add', 'kube-apiserver', '--new-user-password', 'example-apiserver-password')
        e.ctl('user', 'grant-role', 'kube-apiserver', 'kube-apiserver')
        e.ctl('auth', 'enable')
        notes['authEnabled'] = True
    snap = os.path.join(FIX, 'etcd-%s-%s.db' % (version, label))
    if auth:
        e.ctl('--user', 'root:example-root-password', 'snapshot', 'save', snap)
        e.ctl('--user', 'root:example-root-password', 'auth', 'disable')
    else:
        e.ctl('snapshot', 'save', snap)
    exp = expected(e, snap, notes, os.path.join(bindir, 'etcdutl'))
    e.stop()
    # The member's own database file, as it is on disk: no hash at the end.
    if label == 'cluster':
        shutil.copy(os.path.join(e.dir, 'member', 'snap', 'db'), os.path.join(FIX, 'etcd-%s-%s-member.db' % (version, label)))
    with open(os.path.join(FIX, 'etcd-%s-%s.expected.json' % (version, label)), 'w') as f:
        json.dump(exp, f, indent=1, sort_keys=True)
        f.write('\n')
    print(label, version, os.path.getsize(snap), 'bytes', exp['snapshotStatus'])
    return snap


def make_example(bindir):
    """The snapshot behind "Try an example" in the page: the cluster without the test oddities."""
    e = Etcd(bindir, 'example')
    fill(e, encrypted=False, example=True)
    path = '/tmp/etcd-example-snapshot.db'
    e.ctl('snapshot', 'save', path)
    e.stop()
    with open(path, 'rb') as f:
        data = base64.b64encode(gzip.compress(f.read(), 9)).decode()
    lines = ['// SPDX-License-Identifier: Apache-2.0', '// Copyright 2026 KeyValueStore.com', '//',
             '// The example behind "Try an example": a snapshot saved by etcd 3.6.15 from a small',
             '// Kubernetes cluster\'s data, gzipped and base64-encoded so the page can open it',
             '// without fetching anything. Made by test/generate/make-snapshots.py.', '',
             'window.KV_EXAMPLE_ETCD = [']
    chunks = [data[i:i + 100] for i in range(0, len(data), 100)]
    lines += ["  '%s'%s" % (c, ',' if i < len(chunks) - 1 else '') for i, c in enumerate(chunks)]
    lines.append('].join(\'\');')
    out = os.path.join(HERE, '..', '..', 'app', 'example.js')
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, 'w') as f:
        f.write('\n'.join(lines) + '\n')
    print('example', os.path.getsize(path), 'bytes,', os.path.getsize(out), 'in example.js')


def record_objects(snap):
    """Kubernetes' own reading of every Kubernetes object in the snapshot."""
    # The values in the file, found with the Revision Viewer's reader (tested on its own against etcd's tools).
    script = ("const R=require(%s);const fs=require('fs');const s=R.read(new Uint8Array(fs.readFileSync(%s)));"
              "const out=new Set();for(const e of s.keys.values())for(const h of e.history)if(!h.deleted)out.add(require('crypto').createHash('sha256').update(h.value).digest('hex'));"
              "console.log(JSON.stringify([...out]))") % (json.dumps(os.path.join(HERE, '..', '..', 'revisions.js')), json.dumps(snap))
    shas = json.loads(subprocess.run(['node', '-e', script], capture_output=True, check=True, text=True).stdout)
    values = [WRITTEN[s] for s in sorted(shas) if s in WRITTEN]
    decoded = CODEC.decode_all(values)
    with gzip.open(os.path.join(FIX, 'kubernetes-objects.jsonl.gz'), 'wt', 9) as f:
        for v, d in zip(values, decoded):
            d['sha256'] = hashlib.sha256(v).hexdigest()
            f.write(json.dumps(d, sort_keys=True, ensure_ascii=False) + '\n')
    print(len(values), 'Kubernetes objects recorded')


if __name__ == '__main__':
    CODEC = Codec(os.environ.get('KUBE_CODEC', '/opt/k8scodec-build/k8scodec'))
    e36 = os.environ.get('ETCD_36', '/opt/etcd/etcd-v3.6.15-linux-amd64')
    e35 = os.environ.get('ETCD_35', '/opt/etcd/etcd-v3.5.34-linux-amd64')
    e34 = os.environ.get('ETCD_34', '/opt/etcd/etcd-v3.4.45-linux-amd64')
    snap = run(e36, '3.6.15', 'cluster', encrypted=False)
    record_objects(snap)
    run(e35, '3.5.34', 'encrypted', encrypted=True, small=True, auth=True)
    run(e36, '3.6.15', 'nospace', encrypted=False, small=True, extra=['--quota-backend-bytes', str(1024 * 1024)], fillup=True)
    run(e34, '3.4.45', 'small', encrypted=False, small=True)
    make_example(e36)
    # Big files go in gzipped; the tests unzip them.
    for name in ['etcd-3.6.15-nospace.db', 'etcd-3.6.15-cluster-member.db']:
        path = os.path.join(FIX, name)
        with open(path, 'rb') as f, gzip.open(path + '.gz', 'wb', 9) as g:
            g.write(f.read())
        os.remove(path)
