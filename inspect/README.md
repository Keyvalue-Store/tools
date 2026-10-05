# Value Inspector

Paste a value from Redis, Valkey, Memcached or any key-value store and see what format it's in and what it says. It reads JSON, JWT, MessagePack, CBOR, BSON, Protocol Buffers, PHP `serialize()` and sessions, igbinary, Java serialization, Python pickle and Ruby Marshal, and it peels off base64, hex, gzip, zlib, LZ4 and Snappy on the way in.

Try it in your browser at https://keyvaluestore.com/tools/inspect/, or open `inspect/app/index.html` from a copy of this repository.

Its logic is one JavaScript file, `inspect.js`, with no dependencies. The web page, the command line and the tests all load it.

## Why stored values are hard to read

A key-value store keeps bytes. It doesn't know or care what they mean, so applications turn their objects into bytes before they store them, each in its own way:

- **Java and Spring.** Spring Data Redis and Spring Session store objects with Java's built-in serialization by default. Those values start with `\xac\xed\x00\x05`, followed by class names and fields.
- **Python and Django.** Django's Redis cache pickles every value except plain integers. A pickle starts with `\x80` and a protocol number.
- **PHP.** PHP sessions kept in Redis use the session format, `name|value`, with the values in `serialize()` format, like `a:2:{s:4:"user";...}`. The phpredis and Memcached extensions can use igbinary instead, which starts with `\x00\x00\x00\x02`.
- **Ruby.** `Marshal.dump` output starts with `\x04\x08`.
- **Everyone else.** JSON, often gzipped or base64-encoded, or a compact binary format such as MessagePack, CBOR or Protocol Buffers.

On top of that, `redis-cli` prints binary values with `\x` escapes, so what you see in the terminal is one more layer away from the data. Reading a value by hand means recognizing the format from a few bytes, undoing the escapes and any compression, and knowing the format's layout.

## How it works it out

The inspector looks at the value the way a person would, from the outside in:

1. **What was pasted.** Text in double quotes is read as `redis-cli`'s quoted form, with its `\xHH`, `\n`, `\r`, `\t`, `\a`, `\b`, `\"` and `\\` escapes. Hex with spaces or colons between the bytes, or `0x` in front, is read as hex. Anything else is the text itself, in UTF-8. A loaded file is read as raw bytes.
2. **Wrappers.** gzip, zlib, LZ4 frames and framed Snappy announce themselves in their first bytes, and their checksums confirm it. A value that's all base64 or all hex digits is decoded when what comes out makes sense. LZ4 blocks and raw Snappy, which have no header, are tried last. Each wrapper found is one layer, and the inspector starts again on what's inside, up to 8 layers deep.
3. **The format.** Java serialization, pickle, Marshal, igbinary, BSON and Redis `DUMP` payloads have signatures. Text is tried as JSON, a JWT, PHP `serialize()` and sessions, and pickle's older text protocols. Binary with no signature is tried as MessagePack, CBOR and Protocol Buffers, and a reading wins only when it holds real text, floats, booleans or nulls, since random bytes often happen to parse as one of these. Weaker readings are shown as possibilities. Images and a few file types are recognized too.

## What it reads

| Format | Spotted by | What you see |
|---|---|---|
| JSON | Text starting with `{`, `[` or `"` | Every number exactly as written, including ones past what a double can hold |
| JWT | Three base64url parts | Header and claims, with `exp`, `iat` and `nbf` as dates. The signature isn't checked |
| PHP `serialize()` | `a:`, `O:`, `s:`, `i:` and the rest | Arrays as lists or maps, objects with private and protected properties marked, enums, references resolved, and what classes with their own `serialize()` wrote |
| PHP sessions | `name\|value` | Each session variable |
| igbinary | `\x00\x00\x00\x02` | The same as `serialize()`, with its string and object back-references resolved |
| Java serialization | `\xac\xed\x00\x05` | Objects with their class names and fields, superclasses included. `HashMap`, `ArrayList`, `Vector`, `HashSet`, `TreeMap`, `Date`, `UUID`, `BigInteger`, `BigDecimal`, enums, boxed numbers and `java.time` values shown as plain values |
| Python pickle | `\x80` and a protocol number, or a text pickle ending in `.` | Protocols 0 to 5: dicts, lists, tuples, sets, bytes, objects with their state, named tuples, `datetime` with time zones from `datetime`, `zoneinfo`, dateutil and pytz, `Decimal`, `UUID`, `OrderedDict`, Django models |
| Ruby Marshal | `\x04\x08` | Hashes, symbols, strings and their encodings, objects, structs, `Time` |
| MessagePack | Tried on binary without a signature | Every type, with timestamps as dates |
| CBOR | Tried on binary without a signature | Every type, with dates, big numbers, decimals and sets |
| BSON | Its length in the first 4 bytes | `ObjectId` with its creation time, dates, `Decimal128`, UUIDs, regular expressions |
| Protocol Buffers | Tried on binary without a signature | Field numbers and values. Without the `.proto` schema the names and exact types are unknown |
| Redis `DUMP` | The CRC64 at its end | Named, with a pointer to the [Snapshot Viewer](../snapshot/), which decodes them |
| gzip, zlib, LZ4, Snappy | Headers and checksums | Decompressed, with the checksum checked |
| base64, hex | The whole value in that alphabet | Decoded when what's inside makes sense |
| Images | PNG, JPEG, GIF, WebP, BMP, SVG signatures | The size in pixels, and a preview on the page |
| Zstandard, bzip2, xz, ZIP, PDF, .NET BinaryFormatter, Avro, Parquet | Their signatures | Named only |

Short binary values that aren't anything else also show what they'd be as 16-, 32- and 64-bit numbers, floats or a UUID, and text that looks like a Unix time or a hash says so.

## Nothing in a value runs

Some of these formats can carry instructions as well as data. A pickle can tell Python to call any function while it's loading, which is how a crafted pickle runs commands on a server. Java deserialization runs the `readObject` methods of whatever classes the stream names, and Marshal calls `_load` and `marshal_load`.

The inspector never calls anything. It reads pickle's opcodes, Java's stream records and Marshal's type bytes and builds a description of what they would make. A pickle that would run `os.system('echo hi')` shows up as a call to `posix.system` with the argument `"echo hi"`, and nothing more happens. Decompression stops at 64 MB, so a small value built to expand without end can't take over the page, and an object that a value points to from many places is printed in full once.

## Use it in the browser

Paste a value, load a file, or pick one of the examples, each written by the real library. The page shows:

- **The layers**, outside in, such as base64, then gzip with its checksum, then JSON.
- **The value**, indented, with notes such as the Java class of a boxed number or the time zone of a date.
- **Show as JSON** turns the value into plain JSON: maps with text keys become objects, bytes become `{"$bytes": "base64..."}`, and objects keep their class in `"$class"`. A big object that the value points to from more than one place appears in full the first time and as `{"$same": "where it was"}` after that.
- **Download the decoded bytes** saves what was inside the last layer, after decompression.
- **Other readings**, when a value without a signature also parses as another format.
- **The bytes**, as a hex dump.

To get a value out of Redis or Valkey with its bytes intact, ask for the quoted form:

```sh
redis-cli --no-raw GET session:42
valkey-cli --no-raw HGET user:42 profile
```

Nothing you paste leaves the page. The tool doesn't send anything anywhere, and the page's security policy stops it from fetching or loading anything from another site.

## Use it from the command line

You need Node.js 20 or newer. Nothing to install.

```sh
$ node inspect/cli.js cart.bin
gzip (checksum ok) > JSON, 119 bytes
  gzip: file name cart.json
  gzip: dated 2026-10-05T16:42:30Z

{
  "user": "alice"
  "items": [{"sku": "A-100", "qty": 2}, {"sku": "B-220", "qty": 1}]
  "total": 31.5
  "updated": 1791218550
}

$ redis-cli --no-raw GET session:42 | node inspect/cli.js -
$ node inspect/cli.js --text '"\x80\x04\x95\x0b\x00\x00\x00\x00\x00\x00\x00}\x94\x8c\x01a\x94K\x01s."'
$ node inspect/cli.js value.bin --json > value.json
```

| Option | What it does |
|---|---|
| `-` | Read the value from standard input. `redis-cli --no-raw` output is recognized, and the newline `redis-cli` adds is left out when the value makes sense without it |
| `--text VALUE` | Read the value the way it would be pasted: quoted, hex or plain text |
| `--json` | Print the layers, the format and the value as JSON |
| `--hex` | Also print a hex dump of the innermost bytes |
| `--out FILE` | Save the innermost bytes, after every layer is undone, to FILE |

## Use it in your own code

```js
const I = require('./inspect/inspect.js');
const a = I.analyze(bytes);            // a Uint8Array
a.layers;                              // [{ id: 'gzip', name: 'gzip', size: 119, out: 108, check: 'ok', facts: [...] }]
a.result.id;                           // 'json'
I.show(a.result.value);                // the indented text form
I.plain(a.result.value);               // plain JSON-ready data
I.fromInput('"\\xac\\xed\\x00\\x05..."'); // { bytes, form: 'quoted' }
I.parsePickle(bytes);                  // or any single decoder: parseJava, parsePHP, parseMsgpack...
```

In a page, load `inspect.js` with a script tag and use `window.KVInspect`.

## How it was tested

Every test value but one was written by the real thing, and checked against what the same language reads back from it. The one exception is a JSON document written by hand, with numbers past what a double can hold.

- **Python 3.13** wrote pickles in all six protocols, holding objects, dates with and without time zones (fixed offsets, `zoneinfo` and dateutil), named tuples, a `dict` subclass, an object whose state is a tuple, `Decimal`, `UUID`, sets, `OrderedDict`, `defaultdict`, bytes, big integers, NaN and infinity. It also wrote MessagePack with every integer width, timestamps and binary data (msgpack 1.2), CBOR with tags for dates, decimals, big numbers and sets (cbor2), a BSON document with `ObjectId`, `Decimal128`, UUIDs, regular expressions and timestamps (pymongo), a Protocol Buffers message with every wire type (protobuf 7.36), the same JSON in gzip, zlib, LZ4 frames and blocks, raw and framed Snappy, base64 and hex, and a signed JWT.
- **Django 6.1**'s Redis cache serializer pickled a `User` model.
- **PHP 8.3** wrote `serialize()` output with private and protected properties, enums, references, every kind of number and a class with its own `serialize()`, a session through `session_encode()`, and the same values through igbinary 3.2.
- **Ruby 3.3** wrote `Marshal.dump` output with symbols, strings in UTF-8, ASCII, binary and Shift_JIS, big integers, `Time` in UTC and with an offset, structs, ranges, regular expressions, and classes with `marshal_dump` and `_dump`.
- **Java 21** wrote objects through `ObjectOutputStream`: a session map holding custom classes with inheritance and back-references, every primitive type, boxed numbers, collections including `Vector` and `Stack`, arrays, `Date`, a `Timestamp` with nanoseconds, `UUID`, `BigInteger`, `BigDecimal`, enums, `java.time` values including a year before 1, a class with its own `writeObject`, an `Externalizable` class and a stream of several objects.
- **Valkey 9.1.2 and Redis 8.10.2** supplied `DUMP` payloads, and `valkey-cli` and `redis-cli` printed stored values with `--no-raw`.

The results:

- **All 47 values with something to decode** came out exactly as their own language reads them back, compared value by value. The 5 images came out with the right type and size, and the bzip2, xz, Zstandard and `DUMP` values were named.
- **All 10 quoted values** that `redis-cli` and `valkey-cli` printed read back to the exact bytes stored.
- **DEFLATE.** The decoder matched Node's zlib on 7 inputs at 4 compression levels and 5 strategies, including fixed and dynamic Huffman codes and stored blocks.
- **No false alarms.** Of 50,000 random base64 tokens and 20,000 random hex strings, from 4 to 48 bytes long, none was taken for anything but text. Of 20,000 random binary values, all but 232 stayed binary data, and those 232 were 10 bytes or shorter and happened to be valid text.
- **No crashes.** Thousands of random values, and every test value cut short and with a flipped bit, decoded or failed cleanly. So did values built to make a decoder hang or print forever, such as a Java class that is its own superclass and a pickled list holding itself twice, thirty levels deep.
- **Speed.** A 5 MB JSON document inside gzip decodes in about 0.4 seconds.

The scripts that wrote the values are in `test/generate/`, the values and what they should decode to in `test/fixtures/`, and the measurements in `test/results/`, made by `test/generate/measure.js`. The tests replay them, so they run with nothing but Node.js:

```sh
node --test inspect/test/inspect.test.js
```

## Limits

- **Protocol Buffers without the schema.** Field numbers and wire values only. A varint could be signed, unsigned or zigzag-encoded, and a length-delimited field could be text, bytes, a nested message or packed numbers, so the inspector shows its best reading with notes.
- **Formats it doesn't decode.** Zstandard, bzip2, xz, ZIP and .NET BinaryFormatter are named but not opened. Brotli has no signature at all, so a Brotli value shows as binary data.
- **Custom serialization.** Java classes with their own `writeObject` show the extra data as raw bytes after their fields, Python classes built by their own `__reduce__` show the call that would build them, and Ruby `_dump` data shows as the string it wrote.
- **Big values.** The page shows up to 2,000 items in each collection, 4,000 characters of each string and 500 levels of nesting. The JSON view has every item and every character, and the download has every byte.
- **Guesses.** Binary with no signature can parse as more than one format. The inspector picks the reading with the most text in it and lists the others.

## License

Apache License 2.0. Copyright 2026 KeyValueStore.com. See `LICENSE` and `NOTICE` in the top folder.
