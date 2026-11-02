# KeyValueStore Tools 0.2.0 release check, 2026-11-02

Release v0.2.0, titled "KeyValueStore Tools v0.2.0", published by the release workflow from commit dbb9544 (the tag points there). Not a draft.

Files at the tag, downloaded through the API, and at releases/latest/download, checked against SHA256SUMS; both SHA256SUMS files are identical:

```
de5cd0086250708d6e6eb3114e5054b01476cfbb37d1740760e6e1c5fb59a2e3  keyvaluestore-tools.tar.gz
6356299ff162a0f28f8b600e7a8c7ba886801c087a72df7d1198a76c5a254bfc  keyvaluestore-tools.zip
```

The downloaded keyvaluestore-tools.tar.gz unpacks to the 15 tool folders (rebalance included) with LICENSE, NOTICE and README.md; package.json says 0.2.0. `node scripts/smoke.js keyvaluestore-tools` on Node v22.23.4: all 15 tools passed (help, README and page for each; real work for slots, typed-json, keyspace, memory, config, acl, graph, pipe and rebalance). From the package, the Memory Calculator sized 10 streams of 1m entries with a group and 100k pending entries, and 100k hashes with 5 field TTLs on Valkey 9.1.
