# Expression Tester

Check the expressions a DynamoDB request carries the way DynamoDB checks them: key conditions, filters, conditions, updates and projections. The tester answers with the same error message DynamoDB gives, word for word, and finds the same problem first when there are several. When the request is fine, it runs it on items you give it and shows what comes back, or what an update leaves behind.

Try it in your browser at https://keyvaluestore.com/tools/expressions/, or open `expressions/app/index.html` from a copy of this repository.

Its logic is one JavaScript file, `expressions.js`, with no dependencies. The web page, the command line and the tests all load it.

## What DynamoDB expressions are

DynamoDB has no query language like SQL. A request names an item by its key, or a range of items by their partition key, and then carries small expressions that say what to do:

- A **key condition** picks the items a Query reads: `pk = :customer AND begins_with(sk, :year)`.
- A **filter** drops some of the items a Query or Scan read before they come back: `amount >= :min`. The items still count as read.
- A **condition** makes a write happen only if the item is in a given state: `attribute_not_exists(pk)` to create without overwriting, `version = :expected` for optimistic locking.
- An **update** says how to change an item: `SET visits = visits + :one REMOVE draft`.
- A **projection** picks the attributes that come back: `title, price, reviews[0]`.

The values never go in the expression itself. Each is a placeholder, such as `:one`, defined in `ExpressionAttributeValues`. Names can be placeholders too, such as `#st`, defined in `ExpressionAttributeNames`, and they have to be when a name is one of DynamoDB's 563 reserved words, which include everyday names like `status`, `name`, `data`, `count`, `total`, `items`, `value` and `ttl`.

DynamoDB is strict about all of it. A request with a reserved word, a placeholder that isn't defined, a placeholder that is defined but not used, two paths in one update that overlap, or a key condition with `OR` is refused with a `ValidationException`, and the message names one problem at a time. Code usually finds out in production. The tester lets you find out first.

Expressions also hold some surprises the tester makes visible:

- `AND` binds tighter than `OR`, so `a OR b AND c` means `a OR (b AND c)`. The tester draws the condition as DynamoDB groups it.
- `<>` is true when the attribute is missing, and `=` is false.
- Strings compare by their UTF-8 bytes, so `"¿"` sorts after `"z"` and an emoji sorts after `"｡"`.
- `size()` of a string counts UTF-16 code units in DynamoDB Local, so an emoji counts as 2.
- In an update, every value is worked out from the item as it was, so `SET a = b, b = a` swaps two attributes.
- `SET list[10] = :v` on a list of three adds the value at the end, and `REMOVE list[0], list[2]` uses the positions from before the update.

## Use it in the browser

1. **Pick the operation**, then write the expressions and the two maps, or open **Paste a whole request instead** and paste the parameters your code sends. Values can be typed (`{":one": {"N": "1"}}`), as the API and the AWS command line write them, or plain (`{":one": 1}`), as the document clients take them.
2. **Give the key schema**, the table's or index's partition key and sort key, so the tester can apply the rules DynamoDB has for keys.
3. **Add items**: for a Query or Scan, the items in the table, one per line or as a list; for the other operations, the item as it is now, or nothing for an item that doesn't exist yet.
4. **Read the answer.** A refused request shows DynamoDB's message, what it means and the spot in the expression. An accepted one shows how DynamoDB groups the conditions, what each placeholder stands for, and the result: the items returned, each with the parts of the filter that held or didn't, or the item before and after an update.

**Put #placeholders on reserved words** rewrites every reserved word in the expressions as a placeholder and adds it to `ExpressionAttributeNames`.

## Use it from the command line

```sh
node expressions/cli.js --request request.json --items items.json --key pk:S,sk:N
node expressions/cli.js --update 'SET visits = visits + :one' --values '{":one": {"N": "1"}}' --item item.json --key pk:S
node expressions/cli.js --filter 'status = :s' --values '{":s": "new"}' --items scan-output.json
node expressions/cli.js --escape 'status = :s AND size(data) > :n'
```

| Option | Meaning |
|---|---|
| `--request FILE` | The parameters of a Query, Scan, GetItem, PutItem, UpdateItem or DeleteItem call, typed or plain |
| `--key-condition`, `--filter`, `--condition`, `--update`, `--projection` | The expressions, one by one |
| `--names JSON\|@FILE`, `--values JSON\|@FILE` | `ExpressionAttributeNames` and `ExpressionAttributeValues` |
| `--operation NAME` | The operation, when the expressions don't make it clear |
| `--items FILE` | Items to query or scan: a JSON list, JSON Lines, the output of `aws dynamodb scan`, or an export to S3 (`-` reads stdin) |
| `--item FILE` | The item an update, condition or projection works on |
| `--key NAME:TYPE[,NAME:TYPE]` | The partition key and sort key, such as `pk:S,sk:N` |
| `--typed`, `--plain` | Read values and items as typed or plain JSON instead of deciding by looking |
| `--reverse` | Query results in descending order, as `ScanIndexForward: false` |
| `--escape EXPR` | Rewrite reserved words as placeholders and print the names to add |
| `--json` | Print JSON |

Exit status: 0 when DynamoDB would accept the request, 1 when it would refuse it or the condition fails, 2 for a problem with the input. A CI job can check every expression a codebase sends before it ships.

## Use it in your own code

```js
const X = require('./expressions/expressions.js');
const req = X.readRequest(fs.readFileSync('request.json', 'utf8'));
req.item = X.readItem(X.parseJson('{"pk": {"S": "o#1"}, "qty": {"N": "1"}}'));
req.keySchema = { partition: { name: 'pk', type: 'S' } };
const r = X.run(req);
r.error;            // null, or { type, message, code, expression, start, end }
X.explain(r.error); // what the error means, in plain words
r.after;            // the item after an update, as a Map of attribute to value
```

`X.check(req)` only checks the request, without running it. `X.escapeNames(expression)` adds placeholders for reserved words. In a page, load `expressions.js` with a script tag and use `window.KVExpressions`.

## How it was tested

The tester was checked against DynamoDB Local 3.3.1 (May 2026), the version of DynamoDB that AWS publishes for development and testing.

- **Random requests.** A seeded generator wrote 4,800 requests, more than half of them broken on purpose: 1,500 scans with filters and projections over 25 varied items, 600 projections, 1,200 queries and 1,500 updates. DynamoDB Local answered each, and the tester gave the same answer to every scan, projection and query: the same error message word for word, or the same items in the same order. It gave the same answer to 1,472 of the 1,500 updates.
- **Written by hand.** 214 requests each pin down one rule: how names and placeholders are read, which error comes first, number precision and limits, list and set updates, key conditions, projections. The tester matched all 214.
- **Reserved words.** All 573 words on AWS's published list were sent as attribute names. DynamoDB Local refused 563 of them as reserved. `CONVERT` and `SIZE` are on the list but accepted, and `AND`, `OR`, `NOT`, `BETWEEN`, `IN`, `SET`, `ADD` and `DELETE` are keywords that give a syntax error instead. The tester follows DynamoDB, not the list.

The requests and the answers are in `test/fixtures/`, and the tests replay them, so they run without DynamoDB:

```sh
node --test expressions/test/expressions.test.js
```

`test/generate/record.js` records the answers again from a running DynamoDB Local, and `test/generate/measure.js` writes the counts to `test/results/dynamodb-local-3.3.1.json`.

## Limits

- **Updates with several problems that show only while they run.** The 28 updates out of 1,500 where the tester differs each had two or more problems found only as the update runs, such as an attribute that isn't there and a path that can't be written, and DynamoDB Local reported a different one of them first. Both always named a real problem. Updates with one such problem matched.
- **Which second path an overlap message names.** When two paths in an update or projection overlap, DynamoDB Local's message doesn't always name the second path of the pair. The tester names the two that overlap.
- **DynamoDB Local is the reference, not the service.** AWS documents some differences between the two. One the tests show: DynamoDB Local keeps numbers inside lists and maps as they were written, while the tester trims every number's leading and trailing zeros, as AWS documents for the service.
- **What the tester doesn't check.** Item size (400 KB), throughput, indexes beyond the key schema you give, `Limit`, pagination, PartiQL and transactions are outside it. A Query runs on the items you give, so it shows which items match, not which ones a real table holds.
- **Placeholders after a dot.** DynamoDB's grammar accepts a `:value` after a dot in a path, such as `m.:v`, and DynamoDB Local then fails with an internal error. The tester reports that error.

## License

Apache License 2.0. Copyright 2026 KeyValueStore.com. See `LICENSE` and `NOTICE` in the top folder.

DynamoDB is a trademark of Amazon.com, Inc. or its affiliates. It's named only to say which system the tool works with, and KeyValueStore.com isn't connected with or endorsed by Amazon.
