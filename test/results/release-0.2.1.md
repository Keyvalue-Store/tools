# KeyValueStore Tools 0.2.1 release check, 2026-11-02

Release v0.2.1, titled "KeyValueStore Tools v0.2.1", published by the release workflow (run 41394732491, after test run 41394638290) from commit 8ea9cc4. Not a draft.

Files at the tag and at releases/latest, downloaded through the API and checked against SHA256SUMS; both SHA256SUMS files are identical:

```
de5baed576dd2fd2d8012807b26262cee967862ba44d6c52509e3e9ad422bd4e  keyvaluestore-tools.tar.gz
a7fd68e501180cb6948a473dbd7a2603313e03df58a0fa39bac6a72780a28a64  keyvaluestore-tools.zip
```

The downloaded keyvaluestore-tools.tar.gz unpacks to keyvaluestore-tools; package.json says 0.2.1. `node scripts/smoke.js` on the unpacked package with Node v22.23.4: all 15 tools passed. From the package, `acl/cli.js explain on +get "~*" --server "valkey 8.0.11"` printed "Checking as Valkey 8.0.12, the nearest version the builder knows."

Tracked versions: Redis 6.2.24, 7.0.15, 7.2.17, 7.4.12, 8.0.6, 8.2.11, 8.4.8, 8.6.8, 8.8.4, 8.10.3; Valkey 7.2.15, 8.0.12, 8.1.11, 9.0.7, 9.1.3. Replay on all 15: memory 97,211 cases, config 66,287 files, ACL 71,288 SETUSER calls among the rest, no differences. 437 tests pass.
