// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Cluster Rebalancing Planner. Reads the output of CLUSTER NODES from a Redis
// or Valkey cluster, optionally a load per slot (bytes or keys), and works out
// which slots to move between primaries so each holds its share, keeping
// ranges contiguous. It writes the moves as a shell script of the standard
// manual procedure; it never connects to anything. One file, no
// dependencies. In a browser it defines KVRebalance; in Node, require()
// returns the same functions.

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KVRebalance = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SLOTS = 16384;

  // CRC16-CCITT (XMODEM) and the hash-tag rule, the same as the Hash Slot
  // Calculator's, so a key list with sizes can be turned into a load per slot.
  const TABLE = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 8;
    for (let k = 0; k < 8; k++) c = (c & 0x8000) ? ((c << 1) ^ 0x1021) : (c << 1);
    TABLE[i] = c & 0xffff;
  }
  const encoder = new TextEncoder();
  function keySlot(key) {
    const b = key instanceof Uint8Array ? key : encoder.encode(String(key));
    let s = b.indexOf(0x7b), start = 0, end = b.length;
    if (s !== -1) {
      const e = b.indexOf(0x7d, s + 1);
      if (e !== -1 && e > s + 1) { start = s + 1; end = e; }
    }
    let crc = 0;
    for (let i = start; i < end; i++) crc = ((crc << 8) ^ TABLE[((crc >> 8) ^ b[i]) & 0xff]) & 0xffff;
    return crc & (SLOTS - 1);
  }

  // ---------------------------------------------------------------- parsing

  const ID = /^[0-9a-f]{40}$/;
  const FLAGS = new Set(['myself', 'master', 'slave', 'replica', 'fail?', 'fail', 'handshake', 'noaddr', 'nofailover', 'noflags']);

  // Parses CLUSTER NODES. Each line: id, ip:port@cport[,hostname], flags,
  // primary id or "-", ping-sent, pong-recv, config-epoch, link-state, then
  // slots: "N", "N-M", "[N->-id]" (migrating to id) or "[N-<-id]" (importing
  // from id). Returns the nodes and one error per line it could not read.
  function parseClusterNodes(text) {
    const nodes = [], errors = [];
    const lines = String(text).split(/\r?\n/);
    lines.forEach((raw, n) => {
      const line = raw.trim();
      if (!line || line.startsWith('#')) return;
      const f = line.split(/\s+/);
      const bad = (message) => errors.push({ line: n + 1, text: line.slice(0, 120), message });
      if (f.length < 8) return bad('a CLUSTER NODES line has at least 8 fields');
      if (!ID.test(f[0])) return bad('the first field should be a 40-character node id');
      const addr = /^(.*):(\d+)@(\d+)(?:,(.*))?$/.exec(f[1]);
      if (!addr) return bad('the address should look like ip:port@cport');
      const flags = f[2].split(',');
      for (const flag of flags) if (!FLAGS.has(flag)) return bad('unknown flag ' + flag);
      if (f[3] !== '-' && !ID.test(f[3])) return bad('the fourth field should be a primary id or -');
      if (f[7] !== 'connected' && f[7] !== 'disconnected') return bad('the link state should be connected or disconnected');
      const node = {
        id: f[0], host: addr[1], port: Number(addr[2]), cport: Number(addr[3]), hostname: addr[4] || '',
        flags, myself: flags.includes('myself'),
        primary: flags.includes('master'),
        replica: flags.includes('slave') || flags.includes('replica'),
        failed: flags.includes('fail'), suspect: flags.includes('fail?'),
        noaddr: flags.includes('noaddr') || flags.includes('handshake') || addr[1] === '' || Number(addr[2]) === 0,
        primaryId: f[3] === '-' ? null : f[3], configEpoch: Number(f[6]), connected: f[7] === 'connected',
        ranges: [], migrating: [], importing: []
      };
      for (let i = 8; i < f.length; i++) {
        const s = f[i];
        let m;
        if ((m = /^\[(\d+)->-([0-9a-f]{40})\]$/.exec(s))) node.migrating.push({ slot: Number(m[1]), to: m[2] });
        else if ((m = /^\[(\d+)-<-([0-9a-f]{40})\]$/.exec(s))) node.importing.push({ slot: Number(m[1]), from: m[2] });
        else if ((m = /^(\d+)(?:-(\d+))?$/.exec(s))) {
          const a = Number(m[1]), b = m[2] === undefined ? a : Number(m[2]);
          if (a > b || b >= SLOTS) return bad('slot range ' + s + ' is outside 0 to 16383');
          node.ranges.push([a, b]);
        } else return bad('cannot read slot entry ' + s);
      }
      nodes.push(node);
    });
    const seen = new Set();
    for (const node of nodes) {
      if (seen.has(node.id)) errors.push({ line: 0, text: node.id, message: 'node ' + node.id + ' appears twice' });
      seen.add(node.id);
    }
    return { nodes, errors };
  }

  // A load per slot from lines of "slot,value", "slot value" or a range
  // "N-M value" spread evenly. "#" starts a comment.
  function parseSlotLoad(text) {
    const load = new Float64Array(SLOTS), errors = [];
    String(text).split(/\r?\n/).forEach((raw, n) => {
      const line = raw.replace(/#.*/, '').trim();
      if (!line) return;
      const m = /^(\d+)(?:-(\d+))?[\s,;]+([0-9]+(?:\.[0-9]+)?)$/.exec(line);
      if (!m) { errors.push({ line: n + 1, text: line.slice(0, 120), message: 'expected a slot and a number, such as 1234,52000' }); return; }
      const a = Number(m[1]), b = m[2] === undefined ? a : Number(m[2]), v = Number(m[3]);
      if (a > b || b >= SLOTS) { errors.push({ line: n + 1, text: line, message: 'slot outside 0 to 16383' }); return; }
      for (let s = a; s <= b; s++) load[s] += v / (b - a + 1);
    });
    return { load, errors };
  }

  // Decodes a key written the way redis-cli quotes it: "..." with \" \\ \n
  // \r \t \xHH. A bare key is taken as it is.
  function unquote(s) {
    if (s.length < 2 || s[0] !== '"' || s[s.length - 1] !== '"') return encoder.encode(s);
    const out = [];
    for (let i = 1; i < s.length - 1; i++) {
      const c = s[i];
      if (c !== '\\') { for (const b of encoder.encode(c)) out.push(b); continue; }
      const d = s[++i];
      if (d === 'x' && /^[0-9a-fA-F]{2}$/.test(s.slice(i + 1, i + 3))) { out.push(parseInt(s.slice(i + 1, i + 3), 16)); i += 2; }
      else out.push({ n: 10, r: 13, t: 9, a: 7, b: 8 }[d] !== undefined ? { n: 10, r: 13, t: 9, a: 7, b: 8 }[d] : d.charCodeAt(0));
    }
    return new Uint8Array(out);
  }

  // A load per slot from lines of a key and a number: "user:1 4096",
  // "user:1,4096" or "4096 user:1" (the number may come first or last).
  // Keys may be quoted the way redis-cli prints them.
  function parseKeySizes(text) {
    const load = new Float64Array(SLOTS), errors = [];
    let keys = 0;
    String(text).split(/\r?\n/).forEach((raw, n) => {
      const line = raw.trim();
      if (!line || line.startsWith('#')) return;
      let m = /^(.+?)[\s,;]+([0-9]+(?:\.[0-9]+)?)$/.exec(line), key, v;
      if (m) { key = m[1]; v = Number(m[2]); }
      else if ((m = /^([0-9]+(?:\.[0-9]+)?)[\s,;]+(.+)$/.exec(line))) { key = m[2]; v = Number(m[1]); }
      else { errors.push({ line: n + 1, text: line.slice(0, 120), message: 'expected a key and a number of bytes' }); return; }
      load[keySlot(unquote(key.trim()))] += v;
      keys++;
    });
    return { load, keys, errors };
  }

  // ---------------------------------------------------------------- helpers

  function rangesOf(slots) {
    const sorted = Array.from(slots).sort((a, b) => a - b), out = [];
    for (const s of sorted) {
      const last = out[out.length - 1];
      if (last && last[1] === s - 1) last[1] = s; else out.push([s, s]);
    }
    return out;
  }
  function formatRanges(ranges) { return ranges.map(([a, b]) => a === b ? String(a) : a + '-' + b).join(' '); }
  function label(node) { return node.host + ':' + node.port; }

  // Finds a node by full id, a unique id prefix of at least 6 characters,
  // or host:port.
  function findNode(nodes, ref) {
    const r = String(ref).trim().toLowerCase();
    const exact = nodes.filter((n) => n.id === r || (n.host + ':' + n.port).toLowerCase() === r);
    if (exact.length === 1) return exact[0];
    if (r.length >= 6 && /^[0-9a-f]+$/.test(r)) {
      const prefix = nodes.filter((n) => n.id.startsWith(r));
      if (prefix.length === 1) return prefix[0];
      if (prefix.length > 1) throw new Error(ref + ' matches more than one node id; give more of it');
    }
    throw new Error('no node ' + ref + ' in the CLUSTER NODES output');
  }

  // Problems that make moving slots unsafe, each with what to do about it.
  function check(cluster) {
    const problems = [], notes = [];
    const nodes = cluster.nodes;
    const owner = new Int32Array(SLOTS).fill(-1);
    const primaries = nodes.filter((n) => n.primary);
    if (!primaries.length) problems.push({ code: 'no-primaries', message: 'there are no primaries in this output', fix: 'paste the output of CLUSTER NODES from any node of the cluster' });
    nodes.forEach((n, i) => {
      for (const [a, b] of n.ranges) for (let s = a; s <= b; s++) {
        if (owner[s] !== -1 && owner[s] !== i) problems.push({ code: 'double-owner', message: 'slot ' + s + ' is claimed by ' + label(nodes[owner[s]]) + ' and ' + label(n), fix: 'run redis-cli --cluster check, then --cluster fix' });
        owner[s] = i;
      }
      if (n.ranges.length && !n.primary) problems.push({ code: 'replica-slots', message: label(n) + ' is not a primary but lists slots', fix: 'take CLUSTER NODES again; the output looks damaged' });
    });
    let missing = 0, first = -1;
    for (let s = 0; s < SLOTS; s++) if (owner[s] === -1) { missing++; if (first < 0) first = s; }
    if (missing) problems.push({ code: 'uncovered', message: missing + ' slots have no owner (the first is ' + first + ')', fix: 'run redis-cli --cluster fix HOST:PORT, or CLUSTER ADDSLOTS on a primary, before rebalancing' });
    for (const n of nodes) {
      for (const m of n.migrating) problems.push({ code: 'open-slot', message: 'slot ' + m.slot + ' is migrating from ' + label(n) + ' to ' + m.to.slice(0, 8), fix: 'finish or undo that move: redis-cli --cluster fix, or CLUSTER SETSLOT ' + m.slot + ' STABLE on both nodes' });
      for (const m of n.importing) problems.push({ code: 'open-slot', message: 'slot ' + m.slot + ' is importing into ' + label(n) + ' from ' + m.from.slice(0, 8), fix: 'finish or undo that move: redis-cli --cluster fix, or CLUSTER SETSLOT ' + m.slot + ' STABLE on both nodes' });
      if (n.primary && (n.failed || n.suspect)) problems.push({ code: 'failed', message: 'primary ' + label(n) + ' is marked ' + (n.failed ? 'fail' : 'fail?'), fix: 'wait for failover or bring the node back first' });
      if (n.primary && n.noaddr) problems.push({ code: 'noaddr', message: 'primary ' + n.id.slice(0, 8) + ' has no usable address', fix: 'wait until the node has joined, then take CLUSTER NODES again' });
      if (n.primary && !n.connected && !n.myself) notes.push(label(n) + ' shows a disconnected link from the node this output came from');
    }
    for (const p of primaries) {
      if (p.ranges.length && !nodes.some((r) => r.replica && r.primaryId === p.id)) notes.push('primary ' + label(p) + ' has no replica');
    }
    return { problems, notes, owner, primaries };
  }

  // ---------------------------------------------------------------- planning

  // opts: weights {ref: number}, drain [ref], threshold (percent, default 2),
  // maxSlots (default all), load (Float64Array of 16384, or null for slot
  // counts). Returns the plan, or the problems that stop one.
  function plan(cluster, opts) {
    opts = opts || {};
    const c = check(cluster);
    const result = { problems: c.problems.slice(), notes: c.notes.slice(), moves: [], before: [], after: [], by: opts.load ? 'load' : 'slots', balanced: false };
    if (c.problems.length) return result;
    const primaries = c.primaries;
    const weight = new Map(primaries.map((p) => [p.id, 1]));
    try {
      for (const [ref, w] of Object.entries(opts.weights || {})) {
        const n = findNode(cluster.nodes, ref);
        if (!n.primary) throw new Error(label(n) + ' is a replica; weights are for primaries');
        if (!(w >= 0) || !isFinite(w)) throw new Error('the weight for ' + ref + ' should be 0 or more');
        weight.set(n.id, Number(w));
      }
      for (const ref of opts.drain || []) {
        const n = findNode(cluster.nodes, ref);
        if (!n.primary) throw new Error(label(n) + ' is a replica; only primaries hold slots');
        weight.set(n.id, 0);
      }
    } catch (e) { result.problems.push({ code: 'option', message: e.message, fix: 'check the node ids in your options' }); return result; }
    const W = primaries.reduce((a, p) => a + weight.get(p.id), 0);
    if (!(W > 0)) { result.problems.push({ code: 'option', message: 'every primary has weight 0', fix: 'leave at least one primary to hold the slots' }); return result; }
    const threshold = opts.threshold === undefined ? 2 : Number(opts.threshold);
    const maxSlots = opts.maxSlots === undefined ? SLOTS : Number(opts.maxSlots);
    const load = opts.load || null;
    const m = (s) => load ? load[s] : 1;

    const owned = new Map(primaries.map((p) => [p.id, []]));
    for (let s = 0; s < SLOTS; s++) owned.get(primaries.find((p) => p === cluster.nodes[c.owner[s]]).id).push(s);
    const amount = (id) => owned.get(id).reduce((a, s) => a + m(s), 0);
    const total = primaries.reduce((a, p) => a + amount(p.id), 0);
    if (load && !(total > 0)) { result.problems.push({ code: 'option', message: 'the load adds up to 0', fix: 'give sizes for keys or slots that exist, or balance by slot count' }); return result; }

    // Targets in proportion to weight; for slot counts, whole slots by largest remainder.
    const target = new Map();
    if (!load) {
      const exact = primaries.map((p) => SLOTS * weight.get(p.id) / W);
      const base = exact.map(Math.floor);
      let left = SLOTS - base.reduce((a, b) => a + b, 0);
      const order = exact.map((x, i) => [x - base[i], i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
      for (const [, i] of order) { if (!left) break; base[i]++; left--; }
      primaries.forEach((p, i) => target.set(p.id, base[i]));
    } else primaries.forEach((p) => target.set(p.id, total * weight.get(p.id) / W));

    const snapshot = () => primaries.map((p) => ({ id: p.id, node: label(p), slots: owned.get(p.id).length, load: load ? amount(p.id) : undefined, target: target.get(p.id), weight: weight.get(p.id) }));
    result.before = snapshot();
    result.total = total;

    // Already balanced? Every primary within the threshold of its target, and
    // nothing to drain.
    const deviation = (id) => {
      const t = target.get(id), a = amount(id);
      return t === 0 ? (a > 0 ? Infinity : 0) : Math.abs(a - t) / t * 100;
    };
    if (primaries.every((p) => deviation(p.id) <= threshold)) {
      result.balanced = true;
      result.after = snapshot();
      return result;
    }

    // Move slots from primaries above target to those below. Donors give from
    // the top of their highest range; receivers take what the largest deficit
    // asks for. With a load, a donor keeps a slot when giving it would leave
    // the donor further below target than it is above it now, and a receiver
    // takes only while it is short by at least half the slot.
    const surplus = (id) => amount(id) - target.get(id);
    const flows = new Map();
    let moved = 0;
    const donors = primaries.filter((p) => surplus(p.id) > 0).sort((a, b) => surplus(b.id) - surplus(a.id) || (a.id < b.id ? -1 : 1));
    for (const d of donors) {
      const slots = owned.get(d.id);
      let i = slots.length - 1;
      while (i >= 0 && moved < maxSlots) {
        const s = slots[i];
        const w = m(s);
        const extra = surplus(d.id);
        if (!load ? extra < 1 : extra < w / 2) {
          if (!load) break;
          i--;
          if (extra <= 0) break;
          continue;
        }
        if (load && w === 0) { i--; continue; }
        const receivers = primaries.filter((p) => p !== d && -surplus(p.id) > (load ? w / 2 : 0.5));
        if (!receivers.length) { if (!load) break; i--; continue; }
        receivers.sort((a, b) => surplus(a.id) - surplus(b.id) || (a.id < b.id ? -1 : 1));
        const r = receivers[0];
        slots.splice(i, 1);
        owned.get(r.id).push(s);
        const key = d.id + '>' + r.id;
        if (!flows.has(key)) flows.set(key, { from: d, to: r, slots: [], load: 0 });
        const flow = flows.get(key);
        flow.slots.push(s);
        flow.load += w;
        moved++;
        i = Math.min(i, slots.length) - 1;
      }
    }
    for (const list of owned.values()) list.sort((a, b) => a - b);
    for (const f of flows.values()) {
      result.moves.push({ from: f.from.id, fromNode: label(f.from), to: f.to.id, toNode: label(f.to), ranges: rangesOf(f.slots), slots: f.slots.length, load: load ? f.load : undefined });
    }
    result.movedSlots = moved;
    result.movedLoad = load ? result.moves.reduce((a, mv) => a + mv.load, 0) : undefined;
    result.capped = moved >= maxSlots && maxSlots < SLOTS && primaries.some((p) => deviation(p.id) > threshold);
    result.after = snapshot();
    const owner = new Array(SLOTS);
    for (const [id, list] of owned) for (const s of list) owner[s] = id;
    result.owner = owner;
    return result;
  }

  // ---------------------------------------------------------------- script

  function quote(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

  // A POSIX shell script that carries out the plan with redis-cli or
  // valkey-cli, one range at a time: IMPORTING on the receiver and
  // MIGRATING on the donor for every slot of the range, keys moved with
  // MIGRATE in batches from the slots that hold any, then SETSLOT NODE on
  // the receiver, the donor and every other primary. Each of those steps is
  // one redis-cli process reading its commands from standard input, and any
  // reply other than OK stops the script. REDISCLI_AUTH (and MIGRATE_AUTH
  // for MIGRATE, which defaults to it) supply a password.
  function script(cluster, p, opts) {
    opts = opts || {};
    const cli = opts.cli || 'redis-cli';
    const batch = opts.batch || 100;
    const timeout = opts.timeout || 60000;
    const byId = new Map(cluster.nodes.map((n) => [n.id, n]));
    const primaries = cluster.nodes.filter((n) => n.primary);
    const lines = [
      '#!/bin/sh',
      '# Written by the KeyValueStore.com Cluster Rebalancing Planner.',
      '# Moves ' + (p.movedSlots || 0) + ' slots in ' + p.moves.length + ' moves. Read it before you run it.',
      '# Set REDISCLI_AUTH for a password; MIGRATE uses MIGRATE_AUTH, or REDISCLI_AUTH.',
      '# Keys go from CLUSTER GETKEYSINSLOT to MIGRATE one per line, so a key with',
      '# a newline in its name stops the script. If it stops part way, run',
      '# redis-cli --cluster fix HOST:PORT to close the slots it left open.',
      'set -eu',
      'CLI=${CLI:-' + cli + '}',
      'BATCH=${BATCH:-' + batch + '}',
      'TIMEOUT=${TIMEOUT:-' + timeout + '}',
      'MIGRATE_AUTH=${MIGRATE_AUTH:-${REDISCLI_AUTH:-}}',
      'PRIMARIES=' + quote(primaries.map((n) => n.host + ' ' + n.port).join(' ')),
      '',
      '# setslots FIRST LAST STATE NODE_ID: CLUSTER SETSLOT for every slot of a range',
      'setslots() {',
      '  s=$1',
      '  while [ "$s" -le "$2" ]; do echo "CLUSTER SETSLOT $s $3 $4"; s=$((s + 1)); done',
      '}',
      '',
      '# on_node HOST PORT [ALSO]: run the commands on standard input; all must',
      '# answer OK, or match the pattern ALSO',
      'on_node() {',
      '  out=$("$CLI" -h "$1" -p "$2" 2>&1) || true',
      '  bad=$(printf \'%s\\n\' "$out" | grep -v \'^OK$\' | grep -v "${3:-^OK$}" || true)',
      '  if [ -n "$bad" ]; then echo "$1:$2: $bad" >&2; return 1; fi',
      '}',
      '',
      '# move_keys SLOT FROM_HOST FROM_PORT TO_HOST TO_PORT',
      'move_keys() {',
      '  while :; do',
      '    keys=$("$CLI" -h "$2" -p "$3" --raw CLUSTER GETKEYSINSLOT "$1" "$BATCH")',
      '    [ -n "$keys" ] || break',
      '    if [ -n "$MIGRATE_AUTH" ]; then',
      '      out=$(printf \'%s\\n\' "$keys" | tr \'\\n\' \'\\000\' | xargs -0 "$CLI" -h "$2" -p "$3" MIGRATE "$4" "$5" "" 0 "$TIMEOUT" AUTH "$MIGRATE_AUTH" KEYS)',
      '    else',
      '      out=$(printf \'%s\\n\' "$keys" | tr \'\\n\' \'\\000\' | xargs -0 "$CLI" -h "$2" -p "$3" MIGRATE "$4" "$5" "" 0 "$TIMEOUT" KEYS)',
      '    fi',
      '    case "$out" in OK|NOKEY) ;; *) echo "$2:$3: MIGRATE slot $1: $out" >&2; return 1 ;; esac',
      '  done',
      '}',
      '',
      '# move_range FIRST LAST FROM_HOST FROM_PORT FROM_ID TO_HOST TO_PORT TO_ID',
      'move_range() {',
      '  setslots "$1" "$2" IMPORTING "$5" | on_node "$6" "$7"',
      '  setslots "$1" "$2" MIGRATING "$8" | on_node "$3" "$4"',
      '  counts=$(s=$1; while [ "$s" -le "$2" ]; do echo "CLUSTER COUNTKEYSINSLOT $s"; s=$((s + 1)); done | "$CLI" -h "$3" -p "$4")',
      '  s=$1',
      '  for n in $counts; do',
      '    case "$n" in 0) ;; *[!0-9]*) echo "$3:$4: COUNTKEYSINSLOT $s: $n" >&2; return 1 ;; *) move_keys "$s" "$3" "$4" "$6" "$7" ;; esac',
      '    s=$((s + 1))',
      '  done',
      '  setslots "$1" "$2" NODE "$8" | on_node "$6" "$7"',
      '  # A donor that just gave away its last slot may already have turned into',
      '  # a replica of the receiver, or lost its own replica to it. It then',
      '  # refuses SETSLOT (Valkey 9 says NOREPLICAS, Valkey 8 closes the',
      '  # connection) and needs none: it learns the new owner from the cluster.',
      '  setslots "$1" "$2" NODE "$8" | on_node "$3" "$4" \'only with masters\\|master -> replica\\|^NOREPLICAS\'',
      '  first=$1 last=$2 to=$8',
      '  set -- $PRIMARIES',
      '  while [ $# -ge 2 ]; do',
      '    setslots "$first" "$last" NODE "$to" | "$CLI" -h "$1" -p "$2" > /dev/null 2>&1 || true',
      '    shift 2',
      '  done',
      '}',
      ''
    ];
    for (const mv of p.moves) {
      const f = byId.get(mv.from), t = byId.get(mv.to);
      lines.push('# ' + mv.slots + ' slots from ' + mv.fromNode + ' to ' + mv.toNode + ': ' + formatRanges(mv.ranges));
      for (const [a, b] of mv.ranges) lines.push('move_range ' + a + ' ' + b + ' ' + [quote(f.host), f.port, f.id, quote(t.host), t.port, t.id].join(' '));
    }
    lines.push('echo "Done: moved ' + (p.movedSlots || 0) + ' slots."');
    return lines.join('\n') + '\n';
  }

  return { SLOTS, keySlot, parseClusterNodes, parseSlotLoad, parseKeySizes, unquote, check, plan, script, rangesOf, formatRanges, findNode };
});
