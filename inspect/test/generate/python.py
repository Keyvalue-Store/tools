# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 KeyValueStore.com
#
# Writes test values with Python's own serializers and libraries: pickle in
# protocols 0 to 5, msgpack, cbor2, bson (from pymongo), protobuf, gzip,
# zlib, lz4, python-snappy, zstandard, bz2 and lzma. Each value goes to
# fixtures/NAME.bin, with fixtures/NAME.json saying what it should decode
# to, in the form test/inspect.test.js compares against.
#
#   pip install msgpack cbor2 pymongo protobuf lz4 python-snappy zstandard python-dateutil
#   python3 inspect/test/generate/python.py

import base64, bz2, collections, datetime, decimal, gzip, hashlib, hmac, io, json, lzma, math, os, pickle, re, sys, uuid, zlib, zoneinfo

# Sets of strings come out in an order that depends on the hash seed. Fix it,
# so the files come out the same on every run.
if os.environ.get('PYTHONHASHSEED') != '0':
    os.environ['PYTHONHASHSEED'] = '0'
    os.execv(sys.executable, [sys.executable] + sys.argv)
import bson, cbor2, dateutil.tz, lz4.block, lz4.frame, msgpack, snappy, zstandard
from google.protobuf import descriptor_pb2, descriptor_pool, message_factory
from google.protobuf import __version__ as protobuf_version

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'fixtures')
PY = 'Python %d.%d.%d' % sys.version_info[:3]

def cj(x):
    """The canonical form the tests compare: what the inspector should find."""
    if x is None: return None
    if isinstance(x, bool): return x
    if isinstance(x, int): return {'i': str(x)}
    if isinstance(x, float):
        if math.isnan(x): return {'n': 'NaN'}
        if math.isinf(x): return {'n': 'Infinity' if x > 0 else '-Infinity'}
        return {'n': x}
    if isinstance(x, str): return x
    if isinstance(x, bytes): return {'b': x.hex()}
    if isinstance(x, bytearray): return {'tag': 'bytearray', 'v': {'b': bytes(x).hex()}}
    if isinstance(x, (list, tuple, set, frozenset, collections.deque)): return [cj(i) for i in x]
    if isinstance(x, dict): return {'map': [[cj(k), cj(v)] for k, v in x.items()]}
    if isinstance(x, decimal.Decimal): return {'dec': str(x)}
    if isinstance(x, datetime.datetime):
        if x.tzinfo is None: return {'date': x.isoformat()}
        return {'ms': (x - datetime.datetime(1970, 1, 1, tzinfo=datetime.timezone.utc)) // datetime.timedelta(milliseconds=1)}
    if isinstance(x, datetime.date): return {'tag': 'datetime.date', 'v': x.isoformat()}
    if isinstance(x, datetime.time): return {'tag': 'datetime.time', 'v': x.isoformat()}
    if isinstance(x, datetime.timedelta): return {'tag': 'timedelta', 'v': str(x)}
    if isinstance(x, uuid.UUID): return {'tag': 'UUID', 'v': str(x)}
    if isinstance(x, complex): return {'tag': 'complex', 'v': [cj(x.real), cj(x.imag)]}
    if hasattr(x, '__dict__'):
        return {'obj': type(x).__module__ + '.' + type(x).__qualname__, 'fields': [[k, cj(v)] for k, v in x.__dict__.items()]}
    raise TypeError(type(x))

def write(name, data, expected, fmt, source, layers=(), exact=False):
    with open(os.path.join(OUT, name + '.bin'), 'wb') as f: f.write(data)
    out = {'source': source, 'layers': list(layers), 'format': fmt, 'value': expected}
    if exact: out['exact'] = True
    with open(os.path.join(OUT, name + '.json'), 'w') as f:
        json.dump(out, f, ensure_ascii=False, indent=1, allow_nan=False)
    print(name, len(data))

class User:
    def __init__(self, name, roles, last_seen):
        self.name = name
        self.roles = roles
        self.last_seen = last_seen
        self.active = True

# One value with most of what pickle can hold.
CET = datetime.timezone(datetime.timedelta(hours=2))
cart = {
    'user': User('alice', ['admin', 'editor'], datetime.datetime(2026, 10, 5, 9, 30, 15, 250000)),
    'items': [('sku-1', 2, decimal.Decimal('19.99')), ('sku-2', 1, decimal.Decimal('5.00'))],
    'tags': {'new', 'sale'},
    'frozen': frozenset([3]),
    'big': 2 ** 70, 'negative': -(2 ** 40), 'small': -7, 'zero': 0, 'byte': 255, 'short': 65535, 'int32': -2147483648,
    'pi': 3.141592653589793, 'nan': float('nan'), 'inf': float('-inf'),
    'raw': b'\x00\x01\xff', 'buffer': bytearray(b'abc'), 'text': 'café \U0001f525\nline two "quoted" \\ back',
    'none': None, 'yes': True, 'no': False,
    'ordered': collections.OrderedDict([('b', 1), ('a', 2)]),
    'counts': collections.defaultdict(int, {'x': 1}),
    'id': uuid.UUID('12345678-1234-5678-1234-567812345678'),
    'day': datetime.date(2026, 10, 5), 'time': datetime.time(13, 45, 0, 5),
    'utc': datetime.datetime(2026, 10, 5, 12, 0, 0, tzinfo=datetime.timezone.utc),
    'cet': datetime.datetime(2026, 10, 5, 14, 0, 0, tzinfo=CET),
    'wait': datetime.timedelta(days=1, seconds=3723, microseconds=5),
    'complex': complex(1.5, -2),
    'empty': [(), [], {}, '', b''],
}
for p in range(0, 6):
    data = pickle.dumps(cart, protocol=p)
    write('pickle-protocol-%d' % p, data, cj(pickle.loads(data)), 'pickle', PY + ', pickle protocol %d' % p)

# A pickle that refers back to the same list twice, from memo.
shared = ['once']
write('pickle-memo', pickle.dumps({'a': shared, 'b': shared}, protocol=2), cj({'a': shared, 'b': shared}), 'pickle', PY + ', pickle protocol 2')

# Time zones from zoneinfo and dateutil, a namedtuple, a dict subclass, an
# object whose state is a tuple, and a long string, in protocols 5 and 0.
# Protocols 0 and 1 rebuild objects through copyreg._reconstructor.
Point = collections.namedtuple('Point', 'x y')
class Bag(dict):
    pass
class Pair:
    def __init__(self, a, b): self.a, self.b = a, b
    def __getstate__(self): return (self.a, self.b)
    def __setstate__(self, state): self.state = state
bag = Bag({'a': 1})
bag.color = 'red'
edge = {
    'zoneinfo': datetime.datetime(2026, 10, 5, 9, 0, tzinfo=zoneinfo.ZoneInfo('Europe/Lisbon')),
    'tzoffset': datetime.datetime(2026, 10, 5, 9, 0, tzinfo=dateutil.tz.tzoffset('X', 3600)),
    'tzutc': datetime.datetime(2026, 10, 5, 9, 0, tzinfo=dateutil.tz.tzutc()),
    'tzfile': datetime.datetime(2026, 10, 5, 9, 0, tzinfo=dateutil.tz.gettz('Europe/Berlin')),
    'point': Point(1, 2), 'bag': bag, 'pair': Pair('v', 42), 'long': 'x' * 200000,
}
def cj_edge(x):
    # A datetime in a named zone shows its wall-clock time and the zone's name.
    if isinstance(x, datetime.datetime) and isinstance(x.tzinfo, zoneinfo.ZoneInfo):
        return {'date': x.replace(tzinfo=None).isoformat() + '[' + x.tzinfo.key + ']'}
    if isinstance(x, datetime.datetime) and isinstance(x.tzinfo, dateutil.tz.tzfile):
        return {'date': x.replace(tzinfo=None).isoformat() + '[' + re.sub('.*zoneinfo/', '', x.tzinfo._filename) + ']'}
    if isinstance(x, tuple) and hasattr(x, '_fields'):
        return {'obj': type(x).__module__ + '.' + type(x).__qualname__, 'fields': [], 'items': [cj_edge(i) for i in x]}
    if isinstance(x, Bag):
        return {'obj': '__main__.Bag', 'fields': [[k, cj_edge(v)] for k, v in x.items()] + [[k, cj_edge(v)] for k, v in x.__dict__.items()]}
    if isinstance(x, dict): return {'map': [[cj_edge(k), cj_edge(v)] for k, v in x.items()]}
    return cj(x)
for p in (5, 0):
    data = pickle.dumps(edge, protocol=p)
    write('pickle-edge' + ('-protocol-0' if p == 0 else ''), data, cj_edge(pickle.loads(data)), 'pickle', PY + ', pickle protocol %d with time zones and rebuilt objects' % p)

# MessagePack, with every width of integer, bin, str, floats and timestamps.
mp = {
    'ints': [0, 127, 128, 255, 256, 65535, 65536, 2 ** 32 - 1, 2 ** 32, 2 ** 64 - 1, -1, -32, -33, -128, -129, -32768, -32769, -2 ** 31, -2 ** 31 - 1, -2 ** 63],
    'floats': [1.5, -0.25, 1e300],
    'strings': ['', 'a' * 31, 'b' * 32, 'c' * 300, 'd' * 65536],
    'bin': b'\x00\xff' * 3,
    'nested': {'list': [None, True, False], 'map': {1: 'one', 2: 'two'}},
    'when': msgpack.Timestamp(1791218550, 123000000),
    'when64': msgpack.Timestamp(1791218550, 0),
    'when96': msgpack.Timestamp(2 ** 34 + 5, 7000000),
    'big_array': list(range(20)),
    'big_map': {('k%02d' % i): i for i in range(20)},
}
data = msgpack.packb(mp, use_bin_type=True)
def cj_mp(x):
    if isinstance(x, msgpack.Timestamp): return {'ms': x.seconds * 1000 + x.nanoseconds // 1000000}
    if isinstance(x, dict): return {'map': [[cj_mp(k), cj_mp(v)] for k, v in x.items()]}
    if isinstance(x, list): return [cj_mp(i) for i in x]
    return cj(x)
write('msgpack', data, cj_mp(msgpack.unpackb(data, raw=False, strict_map_key=False, timestamp=0)), 'msgpack', PY + ', msgpack ' + '.'.join(map(str, msgpack.version)))
write('msgpack-float32', msgpack.packb([1.5, 2.25], use_single_float=True), cj([1.5, 2.25]), 'msgpack', PY + ', msgpack with single floats')
session = {'user_id': 42, 'name': 'Alice', 'roles': ['admin', 'editor'], 'cart': {'sku-1': 2, 'sku-7': 1}, 'dark_mode': True,
           'last_login': msgpack.Timestamp(1791218550, 0), 'avatar': b'\x89PNG...'}
data = msgpack.packb(session, use_bin_type=True)
write('msgpack-session', data, cj_mp(msgpack.unpackb(data, raw=False, timestamp=0)), 'msgpack', PY + ', msgpack ' + '.'.join(map(str, msgpack.version)))

# CBOR, with tags for dates, decimals, big numbers and sets.
cb = {
    'text': 'héllo', 'bytes': b'\x01\x02', 'ints': [0, 23, 24, 255, 256, 65536, 2 ** 32, -1, -24, -25, -2 ** 63],
    'big': 2 ** 80, 'negbig': -(2 ** 80), 'float': 1.1, 'half': 0.5, 'none': None, 'yes': True,
    'when': datetime.datetime(2026, 10, 5, 12, 30, 0, 123000, tzinfo=datetime.timezone.utc),
    'decimal': decimal.Decimal('123.45'), 'set': {1, 2}, 'nested': [[1, [2, [3]]], {'a': {'b': {}}}],
}
data = cbor2.dumps(cb)
def cj_cbor(x):
    if isinstance(x, decimal.Decimal):
        t = x.as_tuple()
        m = int(''.join(map(str, t.digits))) * (-1 if t.sign else 1)
        return {'tag': 'decimal fraction', 'v': [{'i': str(t.exponent)}, {'i': str(m)}]}
    if isinstance(x, dict): return {'map': [[cj_cbor(k), cj_cbor(v)] for k, v in x.items()]}
    if isinstance(x, (list, set, frozenset)): return [cj_cbor(i) for i in x]
    return cj(x)
write('cbor', data, cj_cbor(cbor2.loads(data)), 'cbor', PY + ', cbor2')

# BSON, with the types MongoDB adds.
oid = bson.ObjectId('65f0a1b2c3d4e5f601234567')
doc = {
    '_id': oid, 'name': 'alice', 'age': 30, 'balance': bson.Int64(2 ** 40), 'ratio': 0.75,
    'joined': datetime.datetime(2026, 10, 5, 8, 0, 0, 123000, tzinfo=datetime.timezone.utc),
    'price': bson.Decimal128('1234.5678'), 'tiny': bson.Decimal128('1E-10'), 'huge': bson.Decimal128('-9.99E+100'),
    'tags': ['a', 'b'], 'address': {'city': 'Lisbon', 'zip': '1100'},
    'blob': bson.Binary(b'\x00\x01\x02', 0), 'uid': bson.Binary(uuid.UUID('12345678-1234-5678-1234-567812345678').bytes, 4),
    'pattern': bson.Regex('^a.*z$', 'i'), 'none': None, 'yes': True, 'min': bson.MinKey(), 'max': bson.MaxKey(),
    'ts': bson.Timestamp(1791218550, 7), 'code': bson.Code('function () { return 1; }'),
}
data = bson.encode(doc)
def cj_bson(x):
    if isinstance(x, bson.ObjectId): return {'tag': 'ObjectId', 'v': str(x)}
    if isinstance(x, bson.Int64): return {'i': str(int(x))}
    if isinstance(x, bson.Decimal128): return {'tag': 'Decimal128', 'v': {'dec': str(x)}}
    if isinstance(x, bson.Binary):
        if x.subtype == 4: return {'tag': 'UUID', 'v': str(uuid.UUID(bytes=bytes(x)))}
        return {'b': bytes(x).hex()}
    if isinstance(x, bson.Regex): return {'tag': 'regex', 'v': '/' + x.pattern + '/' + ''.join(c for c, bit in (('i', 2), ('l', 4), ('m', 8), ('s', 16), ('u', 32), ('x', 64)) if x.flags & bit)}
    if isinstance(x, bson.MinKey): return {'tag': 'MinKey', 'v': None}
    if isinstance(x, bson.MaxKey): return {'tag': 'MaxKey', 'v': None}
    if isinstance(x, bson.Timestamp): return {'tag': 'Timestamp', 'v': '%d, %d' % (x.time, x.inc)}
    if isinstance(x, bson.Code): return {'tag': 'JavaScript', 'v': str(x)}
    if isinstance(x, dict): return {'map': [[cj_bson(k), cj_bson(v)] for k, v in x.items()]}
    if isinstance(x, list): return [cj_bson(i) for i in x]
    return cj(x)
decoded = bson.decode(data, codec_options=bson.CodecOptions(tz_aware=True, uuid_representation=4))
write('bson', data, cj_bson(decoded), 'bson', PY + ', bson from pymongo ' + bson.__name__)

# Protocol Buffers: a message type made at run time, with every wire type.
fd = descriptor_pb2.FileDescriptorProto(name='t.proto', package='t', syntax='proto3')
inner = fd.message_type.add(name='Inner')
inner.field.add(name='label', number=1, type=9, label=1)
inner.field.add(name='weight', number=2, type=5, label=1)
m = fd.message_type.add(name='Order')
F = descriptor_pb2.FieldDescriptorProto
for name, num, typ, lab in [('id', 1, F.TYPE_INT64, 1), ('negative', 2, F.TYPE_INT32, 1), ('sint', 3, F.TYPE_SINT32, 1), ('flag', 4, F.TYPE_BOOL, 1),
                            ('f32', 5, F.TYPE_FIXED32, 1), ('f64', 6, F.TYPE_FIXED64, 1), ('dbl', 7, F.TYPE_DOUBLE, 1), ('flt', 8, F.TYPE_FLOAT, 1),
                            ('name', 9, F.TYPE_STRING, 1), ('raw', 10, F.TYPE_BYTES, 1), ('item', 11, F.TYPE_MESSAGE, 3), ('packed', 12, F.TYPE_INT32, 3),
                            ('notes', 13, F.TYPE_STRING, 3), ('big_field', 1000, F.TYPE_UINT64, 1)]:
    f = m.field.add(name=name, number=num, type=typ, label=lab)
    if typ == F.TYPE_MESSAGE: f.type_name = '.t.Inner'
pool = descriptor_pool.DescriptorPool()
pool.Add(fd)
Order = message_factory.GetMessageClass(pool.FindMessageTypeByName('t.Order'))
o = Order(id=1791218550123, negative=-5, sint=-3, flag=True, f32=4000000000, f64=2 ** 60, dbl=2.5, flt=0.5, name='café',
          raw=b'\x00\x9f\xff', packed=[3, 270, 86942], notes=['first', 'second'], big_field=2 ** 63 + 1)
o.item.add(label='a', weight=1)
o.item.add(label='b', weight=2)
data = o.SerializeToString()
expected = {'schema': {'1': 'int64', '2': 'int32', '3': 'sint32', '4': 'bool', '5': 'fixed32', '6': 'fixed64', '7': 'double', '8': 'float', '9': 'string', '10': 'bytes', '11': 'Inner', '12': 'packed int32', '13': 'string', '1000': 'uint64'},
            'fields': [['1', {'i': '1791218550123'}], ['2', {'i': '-5'}], ['3', {'i': '-3'}], ['4', True], ['5', {'i': '4000000000'}], ['6', {'i': str(2 ** 60)}],
                       ['7', {'n': 2.5}], ['8', {'n': 0.5}], ['9', 'café'], ['10', {'b': '009fff'}],
                       ['11', [['1', 'a'], ['2', {'i': '1'}]]], ['11', [['1', 'b'], ['2', {'i': '2'}]]], ['12', [{'i': '3'}, {'i': '270'}, {'i': '86942'}]],
                       ['13', 'first'], ['13', 'second'], ['1000', {'i': str(2 ** 63 + 1)}]]}
write('protobuf', data, expected, 'protobuf', PY + ', protobuf ' + protobuf_version)

# The same JSON in every compression format, and in base64 and hex.
payload = json.dumps({'user': 'alice', 'items': [1, 2, 3], 'note': 'x' * 200}).encode()
pj = cj(json.loads(payload))
gz = io.BytesIO()
with gzip.GzipFile(filename='cart.json', mode='wb', fileobj=gz, mtime=1791218550) as g: g.write(payload)
write('gzip-json', gz.getvalue(), pj, 'json', PY + ', gzip', ['gzip'])
write('zlib-json', zlib.compress(payload, 9), pj, 'json', PY + ', zlib level 9', ['zlib'])
write('zlib-fast-json', zlib.compress(payload, 1), pj, 'json', PY + ', zlib level 1', ['zlib'])
write('lz4-frame-json', lz4.frame.compress(payload, content_checksum=True, block_checksum=True, store_size=True), pj, 'json', PY + ', lz4.frame ' + lz4.__version__, ['lz4'])
write('lz4-block-json', lz4.block.compress(payload, store_size=True), pj, 'json', PY + ', lz4.block with the size stored', ['lz4-block'])
write('snappy-raw-json', snappy.compress(payload), pj, 'json', PY + ', python-snappy', ['snappy-raw'])
sc = snappy.StreamCompressor()
write('snappy-framed-json', sc.add_chunk(payload), pj, 'json', PY + ', python-snappy framing format', ['snappy'])
write('base64-gzip-json', base64.b64encode(gz.getvalue()), pj, 'json', PY + ', gzip then base64', ['base64', 'gzip'])
write('hex-zlib-json', zlib.compress(payload).hex().encode(), pj, 'json', PY + ', zlib then hex', ['hex', 'zlib'])
write('gzip-pickle', gzip.compress(pickle.dumps({'k': [1, 2]}, protocol=5), mtime=0), cj({'k': [1, 2]}), 'pickle', PY + ', pickle protocol 5 then gzip', ['gzip'])
write('zstd-json', zstandard.ZstdCompressor().compress(payload), None, 'zstd', PY + ', zstandard ' + zstandard.__version__)
write('bzip2-json', bz2.compress(payload), None, 'bzip2', PY + ', bz2')
write('xz-json', lzma.compress(payload), None, 'xz', PY + ', lzma')

# A JWT signed with HMAC-SHA256.
def b64u(b): return base64.urlsafe_b64encode(b).rstrip(b'=').decode()
header = {'alg': 'HS256', 'typ': 'JWT'}
claims = {'sub': 'user-42', 'name': 'Alice', 'iat': 1791218550, 'exp': 1791222150, 'roles': ['admin']}
signing = b64u(json.dumps(header, separators=(',', ':')).encode()) + '.' + b64u(json.dumps(claims, separators=(',', ':')).encode())
sig = hmac.new(b'secret', signing.encode(), hashlib.sha256).digest()
write('jwt', (signing + '.' + b64u(sig)).encode(), {'obj': 'JSON Web Token', 'fields': [['header', cj(header)], ['payload', cj(claims)], ['signature', {'b': sig.hex()}]]}, 'jwt', PY + ', hmac and base64')

# JSON with numbers a double can't hold.
big = '{"id": 12345678901234567890123, "price": 0.1000000000000000055511151231257827, "list": [1e400, -0, 2.50]}'
write('json-exact', big.encode(), {'map': [['id', {'i': '12345678901234567890123'}], ['price', {'num': '0.1000000000000000055511151231257827'}], ['list', [{'num': '1e400'}, {'i': '-0'}, {'num': '2.50'}]]]}, 'json', 'Written by hand', exact=True)
