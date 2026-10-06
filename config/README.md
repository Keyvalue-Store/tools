# Config Checker

Paste a redis.conf or valkey.conf and pick a server version. The checker reads the file the way that version reads it at startup and tells you whether the server would start. If it wouldn't, you get the error the server prints, word for word, with the line it stops at, and then every other line it would stop at once that one is fixed. If it would, you see each setting the file changes as CONFIG GET would report it, and the settings that deserve a second look. It also reads the output of `CONFIG GET *` from a running server and shows what differs from the defaults.

It knows 15 versions: Redis 6.2.24, 7.0.15, 7.2.16, 7.4.11, 8.0.6, 8.2.10, 8.4.7, 8.6.7, 8.8.3 and 8.10.2, and Valkey 7.2.14, 8.0.11, 8.1.10, 9.0.6 and 9.1.2.

Try it in your browser at https://keyvaluestore.com/tools/config/, or open `config/app/index.html` from a copy of this repository.

Its logic is one JavaScript file, `config.js`, with no dependencies. The web page, the command line and the tests all load it. `servers.js` holds what it knows about each version: every setting's name, type, limits and default, and where that version's code behaves differently from the others. Both were made from the servers' own source code and checked against the built servers.

## How a server reads its config file

Redis and Valkey read their config file once, at startup, before they open a port. Each line is a setting and its value, such as `maxmemory 2gb`. A line that starts with `#` is a comment. Quotes keep spaces inside a value: `requirepass "a long pass phrase"`.

The server stops at the first line it can't use. It prints the line and the reason, then exits, so a misspelled name, a value out of range or a quote left open keeps the whole server down. The fix is usually small. Finding it can take a while when each attempt means a restart, and a busy machine may restart the server over and over while you look.

A file that works with one version can stop another. Settings come and go, and the rules for values change. Redis 7.0 stopped accepting `gopher-enabled`. Redis 8.0 no longer stops at an unknown name: it treats the name as a module's setting and stops later, while starting, when no module claims it. Valkey 9.0 reads `"abc"def` as one value where every other version refuses the line. Checking a file against each version you might run finds these before an upgrade does.

Some lines don't stop the server and still don't do what they seem to. A setting given twice keeps the last value. Old names such as `slave-read-only` still work for `replica-read-only`, and a few old settings are read and ignored. Some values change as the server starts: `hz` is held between 1 and 500, a cluster has one database, a watchdog period too short for `hz` is raised. The checker shows each of these.

## What the checker shows

- **Whether the server starts.** If not, what it prints, word for word, and the line. Then the other lines it would stop at, each as if the ones before it were fixed, so one pass finds them all.
- **The same file with every version**, for upgrades and for knowing which servers a shared file works with.
- **Every setting the file changes**, with the value CONFIG GET would report, the default, and the lines that set it. Sizes come out in bytes, old names under their new ones.
- **What to look at**: no password with protected mode off, nothing saved to disk, no memory limit, an eviction policy that makes writes fail at the limit, commands renamed away, DEBUG or MODULE switched on, a short password, and others.
- **Notes**: what the server logs or adjusts while starting, and the lines it can't judge from the file alone, such as a folder that must exist.
- **A short file** with only the lines that change something, under current names.
- **A running server's settings**, from the output of `CONFIG GET *`, against the defaults of its version. It works out the version from the names when you don't know it.

## Use it in the browser

1. **Paste the file** into the box, or open it or drop it there. It's read in your browser and never leaves it.
2. **Pick the server** you run. For Redis 6.2 and 7.0, say whether it was built with TLS; for Redis 8.10, whether it was built with BUILD_COMPRESSION=yes. Those settings exist only in such builds.
3. **Read the verdict.** If the server stops, fix the lines in the list and watch the verdict change as you type.
4. **Look at the rest**: what to look at, the settings the file sets, the file line by line, and the table of versions. Pick a version in the table to see its details.

**Download the short file** gives the settings that differ from the defaults. **Download the report as JSON** gives everything on the page.

## Use it from the command line

```sh
node config/cli.js redis.conf                        # which of the 15 versions start with it
node config/cli.js redis.conf --server valkey-9.1    # one version in detail
node config/cli.js redis.conf --server 8 --minimal   # the lines that change something
node config/cli.js --get config.txt                  # CONFIG GET * output against the defaults
```

| Option | Meaning |
|---|---|
| `--server VERSION` | `redis-7.2`, `"valkey 9.1"`, `8` (the newest 8.x), a full version such as `8.4.7`, or `all` (the default) |
| `--no-tls` | Redis 6.2 or 7.0 built without TLS, where the TLS settings don't exist |
| `--compression` | Redis 8.10 built with BUILD_COMPRESSION=yes |
| `--minimal` | Print the lines that change something, with current names |
| `--get FILE` | Read the output of `CONFIG GET *` from FILE; with `--server`, against that version |
| `--versions` | List the versions |
| `--json` | Print JSON |

Exit status: 0 when the server starts with the file, with every version you asked about; 1 when it stops; 2 when the file can't be read or no version matches. A version the checker doesn't know exactly, such as 7.2.4, is checked as the newest release of the same minor version it knows. A deploy script can run the check before it restarts the server:

```sh
version=$(redis-server --version | grep -o 'v=[0-9.]*' | cut -c3-)
node config/cli.js /etc/redis/redis.conf --server "redis $version" || exit 1
```

To get `CONFIG GET *` output: `redis-cli --raw CONFIG GET '*' > config.txt` (or `valkey-cli`). The numbered output without `--raw` works too.

## Use it in your own code

```js
const C = require('./config/config.js');
const r = C.check(fs.readFileSync('redis.conf'), 'valkey-9.1.2');
r.ok;                       // whether the server starts
r.error;                    // { line, text, message, output }: where it stops and what it prints
r.problems;                 // every line it would stop at, in order
r.values.get('maxmemory');  // '2147483648', as CONFIG GET reports it (bytes, one character per byte)
C.advise(r);                // [{ level, code, title, text }], worst first
C.minimal(r);               // the lines that change something
C.findVersion('redis 8');   // 'redis-8.10.2'
C.compareConfigGet(C.parseConfigGet(text), 'redis-7.2.16');
```

A file's bytes (a Buffer or Uint8Array) are read as they are; a string is read as UTF-8. Values come back as strings with one character per byte, the way the server stores them; `C.fromBinary(value)` turns one into text. In a page, load `servers.js` and then `config.js` with script tags and use `window.KVConfig`.

## How it was tested

The checker's answers come from the servers. `test/generate/extract.py` reads each version's table of settings from its source code (`src/config.c`): every name, old name, type, bound, flag and allowed value, and the code that splits lines, reads numbers and checks values where versions differ. Then it asks each built server for its defaults.

`test/generate/record.py` started each of the 15 servers with 66,000 config files in all, 3,500 to 5,000 per version, and recorded what it did with each one: the exact text it printed when it stopped, what it logged when it stopped while starting, or the value of every setting, from `CONFIG GET`, when it started. The files try every setting of every version with values chosen to find the edges: the limits and one past them, numbers that overflow 32 and 64 bits, memory units, percentages, octal, signs, spaces and leading zeros, every allowed word in every case, quotes and escapes, bytes such as NUL and 0xff, comments, line endings, old names, and settings that act on each other.

- **Every file reads the same.** For each one, the checker gives the server's answer: the same text, byte for byte, at the same line, or the same value for every setting. Over the 66,000 files that is about 2,500,000 values.
- **Every problem in a file.** Most files hold one line for each of many settings. When the server stopped at a line, that line came out and the file ran again, until the server started. Reading the whole file at once, the checker lists the same lines in the same order, and ends with the same values.
- **Stopping while starting.** Settings left for modules, users in the file together with an ACL file, a subcommand given to rename-command, and a bad value for Redis 8's built-in vector sets all stop the server after it has read the file. The checker gives the same log lines.

The recorded files and answers are in `test/fixtures/`, and the tests replay them, so they run without any server:

```sh
node --test config/test/config.test.js
```

`node config/test/replay.js` lists any differences, and `test/generate/measure.js` writes the counts to `test/results/servers.json`.

## Limits

- **What isn't in the file.** An `include` line reads another file, which the checker doesn't see. A `loadmodule` line loads a module that may accept settings of its own, so with a module loaded the checker leaves those lines to it.
- **The machine.** Some lines are checked against the machine as the server starts: `dir` must exist, `logfile` must open, the locale in `locale-collate` and the group in `unixsocketgroup` must exist, and TLS needs certificate files and a build with TLS. The checker lists these as not checked.
- **ACL rules.** A `user` line stops the server if its rules are wrong. The checker catches a user declared twice; it checks the rules themselves when the ACL Builder's `acl.js` is loaded beside it, as it is on the web page.
- **Startup failures that depend on more than the file**, such as a data file that can't be read or a port in use, are outside what a config check can know.
- **Sentinel.** The checker reads server config files, not sentinel.conf.

## License

Apache License 2.0. Copyright 2026 KeyValueStore.com. See `LICENSE` and `NOTICE` in the top folder.

Redis is a registered trademark of Redis Ltd. Valkey is a trademark of the Linux Foundation. They're named only to say which servers the tool works with, and KeyValueStore.com isn't connected with or endorsed by either.
