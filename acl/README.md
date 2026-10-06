# ACL Builder

Paste a user's ACL rules and pick a server version. The builder applies the rules the way that version does. You get the error ACL SETUSER would reply with, word for word, or the line ACL LIST would print, and what the user can do in plain words. Type commands to see whether the user may run them, with the reply ACL DRYRUN gives and the error the command itself would get. Or paste what MONITOR printed while an app worked, and the builder drafts a user that may do what the app did and nothing more.

It knows 15 versions: Redis 6.2.24, 7.0.15, 7.2.16, 7.4.11, 8.0.6, 8.2.10, 8.4.7, 8.6.7, 8.8.3 and 8.10.2, and Valkey 7.2.14, 8.0.11, 8.1.10, 9.0.6 and 9.1.2.

Try it in your browser at https://keyvaluestore.com/tools/acl/, or open `acl/app/index.html` from a copy of this repository.

Its logic is one JavaScript file, `acl.js`, with no dependencies. The web page, the command line and the tests all load it, and so does the Config Checker, to check the `user` lines of a config file. `servers.js` holds what it knows about each version: every command and subcommand with its arity, flags, key positions and ACL categories, as the built servers report them, and the messages their ACL code prints.

## How ACL works

Since Redis 6 a server can have many users, each with its own passwords and rights. A client logs in with `AUTH name password`. One that doesn't is the user called `default`, which can do everything without a password until you change it. A user's rights are a list of rules. You give them to ACL SETUSER, write them in redis.conf as `user name rules...`, or keep them in an ACL file that ACL LOAD reads:

```
ACL SETUSER app on >s3cret ~app:* %R~config:* &events:* -@all +@read +set
```

`on` lets the user log in, and `>s3cret` adds a password; the server keeps only its SHA-256. Then the keys: `~app:*` lets the user read and write keys that match `app:*`, and `%R~config:*` lets it read `config:*` keys and nothing more. `&events:*` covers Pub/Sub channels. Last come the commands. `-@all` starts from none, `+@read` adds every command in the read category, and `+set` adds one more. Rules apply in order, so `+@all -flushall` and `-flushall +@all` don't mean the same thing.

A command runs only if the user may run it and may use every key and channel it names. The server finds the keys from the command's own description, so it knows that in `SORT list BY weight_* STORE out` the key `out` gets written and `list` gets read. A command it refuses gets an error that starts with NOPERM. ACL DRYRUN asks the same question without running anything.

Rules in parentheses make a selector, a second set of rights: `(~logs:* +xadd)`. A command may run if the rules outside the parentheses allow it or any one selector does. Valkey 9.1 adds databases: `db=0,2` keeps a user to those two.

The rules changed more between versions than they seem to. Redis 6.2 has no selectors and no `%R~` or `%W~`, and a new user there may use every channel; from 7.0 a new user starts with none. Redis 7.0 works out the rules ACL LIST prints from what the user can do, so they can come back in another form; 7.2 and later print them as written. Some first arguments, such as `+select|a b` with a space, make 7.2 and later crash when they print the user. From 7.0 the error for a bad `user` line in a config file names the wrong word. The builder does what each version does, these included.

## What the builder shows

- **Whether the server takes the rules.** If not, its error word for word: what ACL SETUSER replies, what ACL LOAD replies for an ACL file, or what the server prints when a `user` line in a config file stops it.
- **The line ACL LIST prints**, which is also what ACL SAVE writes to the ACL file.
- **What the user can do**: each rule in plain words, how many commands it may run and which, the keys it may read or write, the channels, and the databases on Valkey 9.1.
- **What to look at**: no password, every command, commands from @dangerous, the right to change users or settings, deprecated rules such as `+select|0`, and rules that crash the server when it lists the user.
- **The same rules with every version**, for upgrades.
- **Whether the user may run a command**: the reply ACL DRYRUN gives, the error the command gets, and the reason: the command itself, a key, a channel or a database.
- **A least-privilege user from MONITOR output**: the commands the app ran, a read pattern, a write pattern or both for each group of keys, the channels, and the databases on Valkey 9.1. Every line of the capture is checked against the result.

## Use it in the browser

1. **Paste the rules** into the first box: ACL SETUSER with its arguments, a line from ACL LIST, the `user` lines of redis.conf, or a whole ACL file. You can also open or drop a file. It's read in your browser and never leaves it.
2. **Pick the server** you run. The verdict, the ACL LIST line and the explanation change as you type. The table at the end shows what each version does with the same rules.
3. **Check commands** in the second box, one per line, the way you'd type them in redis-cli. For an ACL file with several users, pick the user.
4. **Draft a user** in the third box: run `redis-cli MONITOR > monitor.txt` while the app works, stop it after a while, and paste or open the file. If several clients show up, pick the one you want. **Explain this user above** copies the draft into the first box.

MONITOR shows every command the server runs, so it slows a busy server down. Keep the capture short, and run it where the traffic is like the real thing, such as a staging server.

## Use it from the command line

```sh
node acl/cli.js explain on ">pass word" "~app:*" +@read --server valkey-9.1   # what the user can do
node acl/cli.js explain --file users.acl                                      # each user of an ACL file
node acl/cli.js explain --config /etc/redis/redis.conf                        # the user lines of a config file
node acl/cli.js check "on nopass ~app:* +@read" -- GET app:1                  # may it run this?
node acl/cli.js check "on nopass ~app:* +@read" --commands commands.txt       # each line of a file
node acl/cli.js build monitor.txt --name web                                  # draft a user from MONITOR output
node acl/cli.js keys SORT list BY weight_* STORE out                          # the keys a command names
```

| Option | Meaning |
|---|---|
| `--server VERSION` | `redis-7.2`, `"valkey 9.1"`, `8` (the newest 8.x of either), or a full version such as `8.4.7`. The default is the newest Redis |
| `--db N` | The client's database, for Valkey 9.1's `db=` rules (default 0) |
| `--pubsub-default allchannels\|resetchannels` | The server's `acl-pubsub-default`, when it isn't the version's default |
| `--name NAME` | The user's name |
| `--exact` | For `build`: one key pattern per key, not one per prefix |
| `--client ADDR` | For `build`: only the lines of this client, as MONITOR names it (`10.0.0.7:52310`) |
| `--password PASS` | For `build`: the password to put in the rules. Without it the rules say `>CHANGE-ME` |
| `--versions` | List the versions |
| `--json` | Print JSON |

Rules can be separate arguments or one quoted argument, and may start with `ACL SETUSER name` or `user name`. Exit status: 0 when the rules are valid and every command is allowed; 1 when the server would refuse the rules or a command; 2 for a problem with the input.

## Use it in your own code

```js
const A = require('./acl/acl.js');
const id = 'redis-8.10.2';
const r = A.setUser(null, 'app', ['on', '>s3cret', '~app:*', '-@all', '+@read'], id);
r.ok;                                   // false with r.error, the text after "ERR"
A.listLine(r.user, id);                 // { line: 'user app on ...' }, or { crash } when listing it crashes the server
A.check(r.user, ['GET', 'app:1'], id);  // { allowed, reason, index, dryrun, reply, keys, channels, selector }
A.explain(r.user, id);                  // { login, selectors: [{ rules, commands, keys, channels, databases }], warnings }
A.loadFile(text, id, { filename: 'users.acl' });  // ACL LOAD: { ok, users } or { ok: false, error }
A.checkUserLine(argv, id);              // a redis.conf user line: null, or the error the server stops with
A.startupUsers(lines, id);              // those lines when the server starts: { users } or { log }
A.getKeys(['SET', 'k', 'v'], id);       // COMMAND GETKEYSANDFLAGS: { keys: [['k', ['OW', 'update']]] }
A.build(A.parseMonitor(text), id, { name: 'web' });  // { args, setuser, aclfile, commands, keys, channels, check }
```

Names, rules and arguments are bytes. Pass them as strings with one character per byte, the way the server sees them, or turn text into such a string with `A.toBinary(text)`. `A.fromBinary(s)` turns one back into text. In a page, load `servers.js` and then `acl.js` with script tags and use `window.KVAcl`.

## How it was tested

`test/generate/extract.py` asks each built server for its commands (COMMAND), its categories (ACL CAT) and the users it starts with, and reads from its source code which commands find their keys with a function of their own, which take channels, and the ACL error messages. `make-data.js` checks that every category's commands, as ACL CAT lists them, match what COMMAND says, and writes `servers.js`.

`test/generate/record.py` ran the same kinds of cases on each of the 15 servers and recorded the answers:

- **ACL SETUSER**: 71,000 calls with rules of every kind, valid and not, often two or three on the same user, and the line ACL LIST printed after each one that worked. About half were refused, and 1,700 made the server crash while it printed the user.
- **ACL DRYRUN**: 150,000 checks of users against commands, on the 14 versions that have it, with keys and channels picked to match some patterns and miss others, selectors, first arguments and, on Valkey 9.1, databases.
- **Commands inside MULTI**: 60,000 commands sent by a client logged in as the user, which the server checks and queues without running. Redis 6.2 has no ACL DRYRUN, so this is how it was checked; on the others it checks the NOPERM errors.
- **COMMAND GETKEYSANDFLAGS** (GETKEYS on 6.2): 90,000 commands, with the options that move keys around, such as STORE, KEYS, STREAMS and a count of keys.
- **ACL LOAD**: 12,000 ACL files.
- **Config files**: 7,500, each a server start, with `user` lines.

For every case, `acl.js` gives the server's answer: the same error text, byte for byte, the same ACL LIST line, the same DRYRUN reply, the same keys with the same flags. Redis 6.2 and 7.0 print some rules in an order that changes each time the server starts; those are compared as a set. The recorded cases are in `test/fixtures/`, and the tests replay them, so they run without any server:

```sh
node --test acl/test/acl.test.js
```

`node acl/test/replay.js` lists any differences, and `test/generate/measure.js` writes the counts to `test/results/servers.json`.

## Limits

- **Modules.** The builder knows the commands of each server as built, Redis 8's vector sets included. Commands that other modules add, such as the JSON and search commands of Redis Stack, are unknown to it, and so are their categories. A rule for one of them gets the error the server gives for an unknown command.
- **Server settings.** `acl-pubsub-default` decides whether a new user may use every channel; the builder takes the version's default unless you say otherwise. Valkey 9.1 counts databases up to `databases` (16 unless you say otherwise).
- **Order.** Redis 6.2 and 7.0 list single commands in ACL LIST in an order that changes from one start of the server to the next. The builder lists them alphabetically.
- **Other errors.** The check covers ACL and the errors that come before it: an unknown command, the wrong number of arguments, DEBUG and MODULE switched off, a command not allowed in MULTI. A command can still fail later for other reasons, such as wrong arguments, a full memory, a cluster redirect or a read-only replica.
- **MONITOR.** It shows commands as the server runs them: commands inside MULTI show up when EXEC runs, and commands a Lua script runs show up as `lua`. They run with the rights of the user who called the script, so the draft includes them. MONITOR hides the arguments of AUTH and HELLO. A draft only covers what the capture shows. Key patterns made from prefixes are a guess at how the app names its keys, so read them before you use them.

## License

Apache License 2.0. Copyright 2026 KeyValueStore.com. See `LICENSE` and `NOTICE` in the top folder.

Redis is a registered trademark of Redis Ltd. Valkey is a trademark of the Linux Foundation. They're named only to say which servers the tool works with, and KeyValueStore.com isn't connected with or endorsed by either.
