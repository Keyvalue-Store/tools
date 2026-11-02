# KeyValueStore.com tools

## Where the next session starts

KeyValueStore Tools 0.2 (softdev-plan item 33 in photozeitgeist/jollyroger.biz, approved by YK 2026-11-02: Phases 0, A, B and upkeep) is in progress; see the next section.

## In progress: KeyValueStore Tools 0.2

What and why: this file was a six-line release stub, so no session could see the project's rules or history; moving slots between cluster primaries is planned by hand today; the Memory Calculator has no streams or per-field hash TTLs, which modern Redis and Valkey use; the recorded server facts are pinned to point releases with no way to notice drift; and Node.js 20 reached end of life in April 2026.

Design decisions:
- Phase 0: this file becomes the project's plan and handoff. RELEASING.md stays the release reference.
- Upkeep: Node.js 22 or newer (package.json engines, every README), CI on 22 and 24, the release check's oldest Node 22.
- Phase A, Cluster Rebalancing Planner, a 15th tool in `rebalance/` (library `rebalance.js`, `cli.js`, `app/`, README, tests), same shape as the others: one dependency-free file loaded by page, CLI and tests.
  - Input: `CLUSTER NODES` output. Parses node id, address (with cluster bus port and optional hostname), flags, primary id, epochs, link state and slots, including `[slot->-id]` migrating and `[slot-<-id]` importing markers. Primaries with no slots (new empty nodes) take part.
  - Optional load: a per-slot weight file (`slot,bytes` or `slot bytes`) or a key list with sizes (each line a key and a byte count, hashed to slots with the Hash Slot Calculator's code). Without load, it balances slot counts.
  - Options: per-node weight (`--weight ID=2`), drain a node (`--drain ID`), threshold below which a node is left alone (default 2 percent, as `redis-cli --cluster rebalance`), a cap on slots moved.
  - Plan: targets in proportion to weight (largest remainder for slot counts); donors give slots from the ends of their ranges so ranges stay contiguous; receivers take contiguous runs; for byte balance a donor stops before a slot would push it below target by more than half that slot. Output: per-node before and after (slots, bytes, share), the moves (from, to, slot ranges, slots, bytes), and a shell script of the standard manual procedure (SETSLOT IMPORTING and MIGRATING, GETKEYSINSLOT plus MIGRATE in batches, SETSLOT NODE on both ends and the other primaries) using redis-cli or valkey-cli. Nothing is run by the tool.
  - Refusals: slots not covered, open migrating or importing slots, failed or address-less primaries, unknown node ids in options. Each with the reason and what to run (`--cluster fix`, `CLUSTER SETSLOT ... STABLE`).
  - Checked against the real thing: a recorder starts real clusters on several of the built versions (3 primaries with replicas plus one empty primary), writes keys, records `CLUSTER NODES` and per-slot key counts and sizes, runs the planner, executes its script against the cluster, and records the final `CLUSTER NODES`, key counts and a read-back of every key. Tests replay: every recorded `CLUSTER NODES` parses, and the plan's target ownership equals what the real cluster ended with.
- Phase B1, Memory Calculator: streams (entries, fields per entry, field and value sizes, optional consumer groups, consumers and pending entries) and hash fields with their own TTLs (HEXPIRE, Redis 7.4 and later, Valkey 9.0 and later; earlier versions say they have no such command). Recorded from the 15 built servers like every other kind; the target is the existing bar, no differences in replay, with anything left to chance stated and measured the way the existing chance figures are.
- Phase B2, fixture refresh: `scripts/refresh.sh` and a monthly `refresh` workflow in this public repository (Actions minutes on public repositories don't count against YK's private allowance). It finds the newest patch release of every tracked Redis and Valkey line and any new line, builds the newest patches, records them with the existing recorders, replays them through the current tools mapped to their line, and commits a dated report to `test/results/refresh/`. It never changes the tools or the version list on its own: a clean report says the newest patches still match, a difference or a new line fails the run with annotations so a session can act.
- Version 0.2.0.

Steps (done / remaining):
1. [x] Phase 0 and upkeep (this file, Node 22, CI matrix).
2. [x] Rebalancing planner library, CLI and page, with tests (parser on every flag and slot form, coverage and open-slot refusals, slot-count and byte balance, weights, drain, threshold, cap, contiguous ranges, script text). The script moves a whole range per step (one redis-cli process per node per step, stdin commands, every reply OK) after a slot-by-slot first version took over 15 minutes for 4096 slots.
3. [x] Planner recorder against real clusters, fixtures and replay tests: Redis 6.2.24, 7.4.11, 8.10.2, Valkey 8.0.11, 9.1.2; add-empty, by-bytes and drain steps all ended with the planned owners and all 4000 keys read back. A drained donor turns replica and may refuse its last SETSLOT NODE (Redis: only with masters; Valkey 8: connection closed; Valkey 9: NOREPLICAS); the script accepts those from the donor only.
4. [x] Streams and hash-field TTLs in memory.js, recorder cases, replay with no differences: 2205 stream cases (15 versions) and 945 field-TTL cases (Redis 7.4+, Valkey 9.0+) recorded, 0 differences. Struct sizes come from compiling sizeof() against each version's headers. The rax is modelled as its canonical shape (Redis 8.10 inlines 16-byte leaves). Recorder: explicit stream IDs (perMs), each group's XREADGROUPs in MULTI (Redis 8.4 indexes pending by delivery time), field TTLs by one HPEXPIREAT at a fixed time. Valkey 9's volatile set past 127 fields and its table of keys with volatile fields hash pointers, so those cases get the skiplist tolerance (6 sd).
5. [ ] Refresh script and workflow, first run. scripts/refresh.py and .github/workflows/refresh.yml done (dry run: 12 of 15 lines have a newer patch, no new lines); first run 41382437732 in progress.
6. [x] READMEs, RELEASING.md, smoke checks for the new tool (rebalance README, root README table and refresh section, memory README streams and field TTLs, RELEASING.md refresh section, scripts/smoke.js rebalance case, copy-to-site list).
7. [x] Independent review, two rounds. Round 1 blocker: move_keys took empty GETKEYSINSLOT output as an empty slot, so a key with an empty name stayed on the donor and Redis dropped it when the slot changed owner (script exited 0). Fixed: migrate until COUNTKEYSINSLOT is 0, stop when a round makes no progress, check every slot of a range is empty before SETSLOT NODE; reproduced on real clusters (empty name, newline key): now exit 1 with the key intact. Should-fix, all fixed: a newline key could loop forever (same fix); NOREPLICAS was accepted from a donor that still held slots (now only once donor_done: replica, or no slots and nothing half moved, within 30 s); on_node now counts OK replies; huge streams exhausted memory (caps: 10m entries, 1000 groups, 1m pending a group); refresh.py ignored replay crashes. Nits fixed: set -f, no GNU grep alternation, "Cannot plan" for option errors, text form refuses consumers/pending without groups. Round 2: nothing to fix (real Valkey 9.1.2 drain checked by the reviewer). Five-version cluster recordings redone with the final script.
8. [x] 0.2.0 released by the workflow from dbb9544; tar.gz and zip match SHA256SUMS at the tag and at latest; the downloaded package passed scripts/smoke.js (all 15 tools). Evidence in test/results/release-0.2.0.md.
9. [ ] keyvaluestore.com page for the new tool, Memory Calculator page update, release post; softdevstudio.com note; softdev-plan.md item 33 marked done.

## Project facts

Fourteen (with 0.2, fifteen) free tools for key-value stores, each one dependency-free JavaScript file used by a web page, a command line and tests. Code: github.com/Keyvalue-Store/tools (public, Apache 2.0). Site: keyvaluestore.com, repository photozeitgeist/keyvaluestore.com, built on the AltSql project template, content only. Tools run in the browser at https://keyvaluestore.com/tools/<tool>/; `scripts/copy-to-site.sh` copies the pages into the site.

## Low maintenance workflow

YK approves scope; the agent does code, tests, docs, CI, releases, site and upkeep. Answer questions without acting on them. Work on main. This file is the plan and handoff; README.md and each tool's README are the manuals. No ROADMAP, STATUS or session files, no Word or PDF documents. Releases are automated: raise `version` in package.json and push to main; never ask YK to publish one. RELEASING.md has the procedure and the checks to run afterwards. An independent review runs before a release. Website work comes after a verified release. Don't discuss domain sale or value in project materials.

## Code standard

Each tool's logic stays one dependency-free JavaScript file. Every tool is checked against the real thing (built servers, reference code or official packages); recorded answers live in `test/fixtures/` and full measurements in `test/results/`, and the tests replay them. `scripts/build-servers.sh` builds the 15 tracked Redis and Valkey versions from source (about half an hour on 2 CPUs, 4.5 GB). `node --test` runs everything. Write in plain words, varied sentence length, no em dashes.

## History

2026-10-08: KeyValueStore Tools 0.1.0 released with fourteen tools: Hash Slot Calculator, Typed JSON Converter, Mass Insert Builder, Keyspace Map, Consistent Hashing Playground, Snapshot Viewer, Traffic Analyzer, Value Inspector, Memory Calculator, Config Checker, ACL Builder, Expression Tester, Revision Viewer and Graph Key Builder.
