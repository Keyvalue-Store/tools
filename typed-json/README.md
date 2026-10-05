# Typed JSON Converter

Turn DynamoDB's typed JSON into plain JSON, and plain JSON into typed JSON you can send to DynamoDB. It reads what the AWS tools print, such as Scan and Query output, exports to S3 and DynamoDB Streams records, and it keeps every digit of every number.

Try it in your browser at https://keyvaluestore.com/tools/typed-json/, or open `typed-json/app/index.html` from a copy of this repository.

Its logic is one JavaScript file, `typedjson.js`, with no dependencies. The web page, the command line and the tests all load it.

## What typed JSON is

DynamoDB stores each item as a set of named attributes, and every attribute has a type. When the API or the AWS command line shows you an item, it wraps every value in its type:

```json
{
  "pk":     {"S": "user#42"},
  "visits": {"N": "17"},
  "tags":   {"SS": ["beta", "mobile"]},
  "home":   {"M": {"city": {"S": "Lisbon"}}}
}
```

The same item as plain JSON:

```json
{"pk": "user#42", "visits": 17, "tags": ["beta", "mobile"], "home": {"city": "Lisbon"}}
```

The type codes are `S` for text, `N` for a number, `B` for binary data written as base64, `BOOL`, `NULL`, `M` for a map, `L` for a list, and `SS`, `NS` and `BS` for sets of text, numbers or binary.

Numbers are written as text, `"N": "17"`, for a reason. DynamoDB keeps up to 38 significant digits. A JavaScript number, and most JSON libraries, keep about 15 to 17, so a big ID or a precise money amount comes out changed. This converter reads JSON with its own parser and never turns numbers into floating point. `{"N": "12345678901234567890123456789012345678"}` comes out as the number `12345678901234567890123456789012345678`, and goes back the same way.

## Use it in the browser

Paste JSON into the left box, or load a file. The converted JSON appears on the right, ready to copy or download.

The page works out the direction for you. If every value is wrapped in a type, it converts to plain JSON. Otherwise it converts to typed JSON. You can set the direction yourself when a plain document happens to look typed.

When the result is typed JSON you can choose:

- **Sets.** Plain JSON has no sets, only lists. By default lists become lists (`L`). You can have lists of unique strings become string sets (`SS`) and lists of unique numbers become number sets (`NS`). A list with a repeated value, or with mixed types, stays a list, because DynamoDB refuses duplicates in a set.
- **batch-write-item requests.** Instead of items, write requests for `aws dynamodb batch-write-item`, 25 items each, the most one request may hold. Each request is one line. The page shows the shell loop that sends them.

Nothing you paste or load leaves the page. The tool doesn't send anything anywhere, and the page's security policy stops it from fetching or loading anything from another site.

## What it reads

| You paste | It gives back |
|---|---|
| One item, typed or plain | One item |
| A list of items | A list of items |
| One item per line (JSON Lines) | One item per line |
| `aws dynamodb scan` or `query` output (`{"Items": [...], "Count": ...}`) | The items, as a list |
| `aws dynamodb get-item` output (`{"Item": {...}}`) | The item |
| An export to S3 in DynamoDB JSON (one `{"Item": ...}` per line) | One item per line |
| `batch-get-item` output (`{"Responses": {...}}`) | The items, by table |
| DynamoDB Streams records, as a Lambda function receives them | Each record's event name, keys, new image and old image |

## Use it from the command line

You need Node.js 20 or newer. Nothing to install.

```sh
$ aws dynamodb scan --table-name users > scan.json
$ node typed-json/cli.js scan.json > users.json
Converted 1204 items, typed JSON to plain JSON, read as a Scan or Query result.

$ node typed-json/cli.js --batch users users.json > batches.jsonl
$ split -l 1 batches.jsonl batch- && for f in batch-*; do aws dynamodb batch-write-item --request-items file://$f; done
```

| Option | What it does |
|---|---|
| `--to-plain`, `--to-typed` | Set the direction instead of letting the tool pick |
| `--sets strings\|numbers\|both` | Lists of unique values become sets |
| `--batch TABLE` | Write batch-write-item requests for TABLE, 25 items per line |
| `--compact` | No indentation |

Reports, warnings and errors go to standard error, so standard output stays clean JSON.

## Use it in your own code

```js
const T = require('./typed-json/typedjson.js');
const r = T.convert(text, { direction: 'auto', sets: 'strings' });
r.text;          // the converted JSON
r.stats.items;   // how many items
```

In a page, load `typedjson.js` with a script tag and use `window.KVTypedJSON`. `T.parse()` and `T.stringify()` are the exact-number JSON reader and writer; numbers come back as `T.Num` objects holding their text.

## How it was tested

The converter was checked against the AWS SDK for JavaScript, `@aws-sdk/util-dynamodb` 3.996.9, the library AWS publishes for this job.

- **Both directions.** 3,000 random documents, with nested maps and lists, text in many scripts, and 10,963 numbers, went through the SDK's `marshall` and `unmarshall` and through the converter. The results were the same every time.
- **Big numbers.** Seven numbers at DynamoDB's limits, such as 38-digit integers, `1E-130` and `9.9999999999999999999999999999999999999E+125`, matched the SDK's exact mode digit for digit and came back unchanged.
- **Sets.** 500 documents with lists of unique strings and numbers became the same `SS` and `NS` sets the SDK makes from JavaScript `Set` objects.

`test/fixtures/sdk-roundtrip.jsonl` holds 150 of those documents with the SDK's output, and the tests replay them, so they run without the SDK:

```sh
node --test typed-json/test/typedjson.test.js
```

## Limits

- Binary values (`B`, `BS`) stay base64 text in plain JSON, since JSON has no raw bytes. Converting back makes them text (`S`), because nothing in plain JSON marks them as binary.
- Numbers are kept exactly, but DynamoDB accepts forms that JSON doesn't, such as `+5` or `.5`. Those come out as `5` and `0.5`, the same values, and exponents come out as `1e+3`.
- Numbers with more than 38 significant digits are flagged, since DynamoDB refuses them. The converter doesn't check DynamoDB's other limits, such as the 400 KB item size.
- The converter holds the whole document in memory. Very large exports are best split into files first.

## License

Apache License 2.0. Copyright 2026 KeyValueStore.com. See `LICENSE` and `NOTICE` in the top folder.
