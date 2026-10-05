// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Hash Slot Calculator. Works out which of the 16,384 slots of a Redis or
// Valkey cluster a key belongs to, with the same CRC16 and hash-tag rules the
// servers use, and checks whether a multi-key command would fail with
// CROSSSLOT. One file, no dependencies. In a browser it defines KVSlots; in
// Node, require() returns the same functions.

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KVSlots = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SLOTS = 16384;

  // CRC16-CCITT, the XMODEM variant: polynomial 0x1021, starting value 0,
  // no bit reflection. This is the checksum in the cluster specification.
  const TABLE = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 8;
    for (let k = 0; k < 8; k++) c = (c & 0x8000) ? ((c << 1) ^ 0x1021) : (c << 1);
    TABLE[i] = c & 0xffff;
  }

  function crc16(bytes, start, end) {
    let crc = 0;
    const s = start || 0;
    const e = end === undefined ? bytes.length : end;
    for (let i = s; i < e; i++) crc = ((crc << 8) ^ TABLE[((crc >> 8) ^ bytes[i]) & 0xff]) & 0xffff;
    return crc;
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: false });

  function toBytes(key) {
    if (key instanceof Uint8Array) return key;
    return encoder.encode(String(key));
  }

  // Which bytes of the key get hashed. A key with a '{' followed later by a
  // '}', with at least one byte between them, is hashed on those bytes only.
  // Only the first '{' and the first '}' after it count.
  function hashedRange(bytes) {
    let s = -1;
    for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0x7b) { s = i; break; }
    if (s === -1) return { start: 0, end: bytes.length, tagged: false };
    let e = -1;
    for (let i = s + 1; i < bytes.length; i++) if (bytes[i] === 0x7d) { e = i; break; }
    if (e === -1 || e === s + 1) return { start: 0, end: bytes.length, tagged: false };
    return { start: s + 1, end: e, tagged: true };
  }

  function keySlot(key) {
    const bytes = toBytes(key);
    const r = hashedRange(bytes);
    return crc16(bytes, r.start, r.end) & (SLOTS - 1);
  }

  // Everything the page shows about one key.
  function describeKey(key) {
    const bytes = toBytes(key);
    const r = hashedRange(bytes);
    const crc = crc16(bytes, r.start, r.end);
    return {
      bytes: bytes,
      slot: crc & (SLOTS - 1),
      crc: crc,
      tagged: r.tagged,
      start: r.start,
      end: r.end,
      hashed: bytes.subarray(r.start, r.end)
    };
  }

  // ---- Reading keys the way people paste them ----

  // redis-cli and valkey-cli quote keys that are not plain printable text:
  // "user:\xe2\x82\xac". This turns that form back into the raw bytes.
  const isHex = (c) => c !== undefined && /^[0-9a-fA-F]$/.test(c);
  const isHexByte = (b) => (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66);
  const ESC = { 0x6e: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x61: 7, 0x22: 34, 0x5c: 92, 0x27: 39 };

  function unquoteBytes(b) {
    const out = [];
    for (let i = 0; i < b.length; i++) {
      if (b[i] === 0x5c && i + 1 < b.length) {
        const n = b[i + 1];
        if (n === 0x78 && isHexByte(b[i + 2]) && isHexByte(b[i + 3])) {
          out.push(parseInt(String.fromCharCode(b[i + 2], b[i + 3]), 16)); i += 3; continue;
        }
        if (Object.prototype.hasOwnProperty.call(ESC, n)) { out.push(ESC[n]); i += 1; continue; }
      }
      out.push(b[i]);
    }
    return new Uint8Array(out);
  }

  function unquote(str) { return unquoteBytes(encoder.encode(str)); }

  // One line to the key's bytes. Strips the "1) " numbering that redis-cli
  // puts in front of array items, and decodes "quoted" keys, unless raw is set.
  function lineToKey(b, raw) {
    if (raw) return b.slice();
    // Strip "1) " numbering, nested too, as in "2)   1) "key"".
    let s = 0;
    while (true) {
      let j = s;
      while (j < b.length && b[j] === 0x20) j++;
      let k = j;
      while (k < b.length && b[k] >= 0x30 && b[k] <= 0x39) k++;
      if (k > j && k + 1 < b.length && b[k] === 0x29 && b[k + 1] === 0x20) {
        s = k + 1;
        while (s < b.length && b[s] === 0x20) s++;
      } else break;
    }
    const rest = b.subarray(s);
    if (rest.length >= 2 && rest[0] === 0x22 && rest[rest.length - 1] === 0x22) return unquoteBytes(rest.subarray(1, rest.length - 1));
    return rest.slice();
  }

  // A file or pasted text, one key per line, to a list of keys as bytes.
  // Works on raw bytes, so keys that are not valid UTF-8 survive.
  function parseKeyBuffer(bytes, raw) {
    const keys = [];
    let start = 0;
    for (let i = 0; i <= bytes.length; i++) {
      if (i === bytes.length || bytes[i] === 0x0a) {
        let end = i;
        if (end > start && bytes[end - 1] === 0x0d) end--;
        if (end > start) keys.push(lineToKey(bytes.subarray(start, end), raw));
        start = i + 1;
      }
    }
    return keys;
  }

  function parseKeyLine(line, raw) { return lineToKey(encoder.encode(String(line).replace(/\r$/, '')), raw); }
  function parseKeyList(text, raw) { return parseKeyBuffer(encoder.encode(String(text)), raw); }

  // Bytes back to text for display, with bytes that are not valid UTF-8 or not
  // printable shown as \xHH, the way the command-line clients show them.
  function displayKey(bytes) {
    let printable = true;
    for (const b of bytes) if (b < 0x20 || b === 0x7f) { printable = false; break; }
    if (printable) {
      const text = decoder.decode(bytes);
      if (!text.includes('�')) return text;
    }
    let s = '';
    for (const b of bytes) {
      if (b === 0x5c) s += '\\\\';
      else if (b >= 0x20 && b < 0x7f) s += String.fromCharCode(b);
      else s += '\\x' + b.toString(16).padStart(2, '0');
    }
    return s;
  }

  // ---- Splitting a command line, with the same quoting rules as redis-cli ----

  function splitArgs(line) {
    const args = [];
    let i = 0;
    const s = Array.from(String(line));
    const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\v' || c === '\f';
    while (true) {
      while (i < s.length && isSpace(s[i])) i++;
      if (i >= s.length) return args;
      const cur = [];
      let inq = false, insq = false, done = false;
      while (!done) {
        if (inq) {
          if (i >= s.length) throw new Error('A double quote is not closed');
          const c = s[i];
          if (c === '\\' && s[i + 1] === 'x' && isHex(s[i + 2]) && isHex(s[i + 3])) {
            cur.push(parseInt(s[i + 2] + s[i + 3], 16)); i += 3;
          } else if (c === '\\' && i + 1 < s.length) {
            const n = s[i + 1];
            const map = { n: 10, r: 13, t: 9, b: 8, a: 7 };
            if (Object.prototype.hasOwnProperty.call(map, n)) cur.push(map[n]);
            else for (const b of encoder.encode(n)) cur.push(b);
            i += 1;
          } else if (c === '"') {
            if (i + 1 < s.length && !isSpace(s[i + 1])) throw new Error('A closing quote must be followed by a space');
            done = true;
          } else {
            for (const b of encoder.encode(c)) cur.push(b);
          }
        } else if (insq) {
          if (i >= s.length) throw new Error('A single quote is not closed');
          const c = s[i];
          if (c === '\\' && s[i + 1] === "'") { cur.push(39); i += 1; }
          else if (c === "'") {
            if (i + 1 < s.length && !isSpace(s[i + 1])) throw new Error('A closing quote must be followed by a space');
            done = true;
          } else for (const b of encoder.encode(c)) cur.push(b);
        } else {
          if (i >= s.length) { done = true; break; }
          const c = s[i];
          if (isSpace(c)) done = true;
          else if (c === '"') inq = true;
          else if (c === "'") insq = true;
          else for (const b of encoder.encode(c)) cur.push(b);
        }
        if (i < s.length) i++;
      }
      args.push(new Uint8Array(cur));
    }
  }

  // ---- Which arguments of a command are keys ----

  const all = (n) => range(1, n);
  const pairs = (n) => { const r = []; for (let i = 1; i < n; i += 2) r.push(i); return r; };
  const allButLast = (n) => range(1, n - 1);
  const firstTwo = (n) => range(1, Math.min(3, n));
  const fromTwo = (n) => range(2, n);
  function range(a, b) { const r = []; for (let i = a; i < b; i++) r.push(i); return r; }
  // zeroOk: scripts and functions may be called with no keys at all.
  function numkeysAt(pos, extra, zeroOk) {
    return function (n, args) {
      const count = parseInt(text(args[pos]), 10);
      if (!(count >= (zeroOk ? 0 : 1)) || pos + 1 + count > n) throw new Error('The number of keys does not match the arguments');
      const r = extra ? extra.slice() : [];
      for (let i = 0; i < count; i++) r.push(pos + 1 + i);
      return r;
    };
  }
  function streams(n, args) {
    for (let i = 1; i < n; i++) {
      if (text(args[i]).toUpperCase() === 'STREAMS') {
        const rest = n - i - 1;
        if (rest < 2 || rest % 2) throw new Error('STREAMS needs as many IDs as keys');
        return range(i + 1, i + 1 + rest / 2);
      }
    }
    throw new Error('STREAMS is missing');
  }
  // SORT key [BY pattern] [LIMIT offset count] [GET pattern ...] [ASC|DESC] [ALPHA] [STORE destination]
  // Read the way Redis 8.10.2 reads it: BY and GET take one argument and
  // LIMIT two, and if STORE appears more than once, the last one counts.
  // Valkey 9.1.2 doesn't skip the destination after STORE, so there a
  // destination named LIMIT, GET, BY or STORE is read again as an option.
  function sortKeys(n, args, skipDestination) {
    if (n < 2) return [];
    let store = 0;
    for (let i = 2; i < n; i++) {
      const t = text(args[i]).toUpperCase();
      if (t === 'LIMIT') i += 2;
      else if (t === 'STORE' && i + 1 < n) { store = i + 1; if (skipDestination) i += 1; }
      else if (t === 'GET' || t === 'BY') i += 1;
    }
    return store ? [1, store] : [1];
  }
  const sortStore = (n, args) => sortKeys(n, args, true);
  // MSETEX numkeys key value [key value ...] [options]
  function msetex(n, args) {
    const count = parseInt(text(args[1]), 10);
    if (!(count >= 1) || 1 + count * 2 > n - 1) throw new Error('The number of keys does not match the arguments');
    const r = [];
    for (let i = 0; i < count; i++) r.push(2 + i * 2);
    return r;
  }
  // MIGRATE host port key|"" db timeout [COPY] [REPLACE] [AUTH ...] [KEYS key ...]
  function migrate(n, args) {
    if (n > 3 && args[3].length === 0) {
      for (let i = 6; i < n; i++) if (text(args[i]).toUpperCase() === 'KEYS') return range(i + 1, n);
      return [];
    }
    return n > 3 ? [3] : [];
  }
  // GEORADIUS key longitude latitude radius unit [...] and
  // GEORADIUSBYMEMBER key member radius unit [...]. The servers look for STORE
  // or STOREDIST after the unit, and the last one counts. (For GEORADIUS,
  // Redis 8.10.2 starts one argument later than Valkey 9.1.2, which only
  // matters when the unit itself is STORE, which no server accepts.)
  function georadiusStore(n, args) {
    if (n < 2) return [];
    let store = 0;
    for (let i = 5; i < n; i++) {
      const t = text(args[i]).toUpperCase();
      if ((t === 'STORE' || t === 'STOREDIST') && i + 1 < n) { store = i + 1; i += 1; }
    }
    return store ? [1, store] : [1];
  }

  // Commands that take more than one key. Every other command is treated as
  // having a single key, which can never cross slots.
  const MULTI = {
    MGET: all, DEL: all, UNLINK: all, EXISTS: all, TOUCH: all, WATCH: all,
    SUNION: all, SINTER: all, SDIFF: all, SUNIONSTORE: all, SINTERSTORE: all, SDIFFSTORE: all,
    PFCOUNT: all, PFMERGE: all, SSUBSCRIBE: all, SUNSUBSCRIBE: all,
    MSET: pairs, MSETNX: pairs, MSETEX: msetex, MIGRATE: migrate,
    RENAME: firstTwo, RENAMENX: firstTwo, RPOPLPUSH: firstTwo, BRPOPLPUSH: firstTwo,
    LMOVE: firstTwo, BLMOVE: firstTwo, LMOVEM: firstTwo, BLMOVEM: firstTwo, SMOVE: firstTwo, COPY: firstTwo,
    LCS: firstTwo, GEOSEARCHSTORE: firstTwo, ZRANGESTORE: firstTwo,
    BLPOP: allButLast, BRPOP: allButLast, BZPOPMIN: allButLast, BZPOPMAX: allButLast,
    ZUNION: numkeysAt(1), ZINTER: numkeysAt(1), ZDIFF: numkeysAt(1), ZINTERCARD: numkeysAt(1),
    SINTERCARD: numkeysAt(1), SUNIONCARD: numkeysAt(1), SDIFFCARD: numkeysAt(1), LMPOP: numkeysAt(1), ZMPOP: numkeysAt(1),
    BLMPOP: numkeysAt(2), BZMPOP: numkeysAt(2),
    ZUNIONSTORE: numkeysAt(2, [1]), ZINTERSTORE: numkeysAt(2, [1]), ZDIFFSTORE: numkeysAt(2, [1]),
    EVAL: numkeysAt(2, null, true), EVALSHA: numkeysAt(2, null, true), EVAL_RO: numkeysAt(2, null, true),
    EVALSHA_RO: numkeysAt(2, null, true), FCALL: numkeysAt(2, null, true), FCALL_RO: numkeysAt(2, null, true),
    XREAD: streams, XREADGROUP: streams,
    BITOP: fromTwo,
    SORT: sortStore, SORT_RO: (n) => (n > 1 ? [1] : []),
    GEORADIUS: georadiusStore, GEORADIUSBYMEMBER: georadiusStore
  };

  // Commands with no key at all. Listed so the check does not mistake their
  // first argument for a key.
  const NO_KEY = new Set(['PING', 'ECHO', 'INFO', 'CLUSTER', 'CONFIG', 'CLIENT', 'SELECT', 'AUTH', 'HELLO',
    'FLUSHALL', 'FLUSHDB', 'DBSIZE', 'SCAN', 'KEYS', 'RANDOMKEY', 'TIME', 'SCRIPT', 'FUNCTION', 'MULTI', 'EXEC',
    'DISCARD', 'UNWATCH', 'PUBLISH', 'SUBSCRIBE', 'PSUBSCRIBE', 'SAVE', 'BGSAVE', 'LASTSAVE', 'SHUTDOWN',
    'COMMAND', 'MEMORY', 'LATENCY', 'SLOWLOG', 'MONITOR', 'DEBUG', 'QUIT', 'RESET', 'ROLE', 'WAIT', 'READONLY', 'READWRITE']);

  function text(b) { return b ? decoder.decode(b) : ''; }

  // Check a command: which arguments are keys, their slots, and whether a
  // cluster would accept it or answer CROSSSLOT.
  function checkCommand(line) {
    const args = Array.isArray(line) ? line.map(toBytes) : splitArgs(line);
    if (!args.length) return { error: 'Type a command, such as MGET user:{42}:name user:{42}:email' };
    const name = text(args[0]).toUpperCase();
    let positions;
    let known = true;
    try {
      if (NO_KEY.has(name)) positions = [];
      else if (MULTI[name]) positions = MULTI[name](args.length, args);
      else { positions = args.length > 1 ? [1] : []; known = false; }
    } catch (e) {
      return { command: name, error: e.message };
    }
    const keys = positions.map(function (p) {
      const d = describeKey(args[p]);
      return { position: p, bytes: args[p], slot: d.slot, tagged: d.tagged, start: d.start, end: d.end };
    });
    const slots = Array.from(new Set(keys.map((k) => k.slot)));
    const notes = [];
    if (name === 'MSETEX' && slots.length) notes.push(slots.length > 1 ? MSETEX_CROSS : MSETEX_ONE.replace('{slot}', slots[0]));
    if (name === 'SSUBSCRIBE' && keys.length) notes.push('These are shard channels, not keys, but a cluster places them in slots the same way and refuses channels from different slots in one call.');
    if (name === 'SUNSUBSCRIBE' && keys.length) notes.push(SUNSUBSCRIBE_NOTE);
    const result = {
      command: name,
      multiKey: !!MULTI[name],
      known: known || NO_KEY.has(name),
      keys: keys,
      slots: slots,
      crossSlot: slots.length > 1,
      notes: notes
    };
    if (name === 'SORT') {
      const valkey = sortKeys(args.length, args, false);
      if (valkey.join() !== positions.join()) {
        result.valkeyKeys = valkey.map((p) => args[p]);
        notes.push(SORT_NOTE.replace('{keys}', valkey.map((p) => displayKey(args[p])).join(', ')));
      }
    }
    return result;
  }

  // Seen in testing, October 2026: Valkey 9.1.2 does not look at MSETEX keys
  // when it routes the command, so it neither redirects nor refuses it. The
  // node that receives it writes the keys, whichever node owns their slots.
  const MSETEX_CROSS = 'Redis 8.10.2 answers CROSSSLOT here. Valkey 9.1.2 does not check MSETEX keys at all: in a test cluster the node that received the command wrote every key itself, even keys from slots other nodes own, and a later GET for those keys found nothing. Keep MSETEX keys in one slot.';
  const MSETEX_ONE = 'On Valkey 9.1.2, send MSETEX to the primary that owns slot {slot} yourself. That version does not redirect MSETEX: whichever node receives it writes the keys, even when it does not own their slot.';

  // Also seen in testing: Redis 8.10.2 runs SUNSUBSCRIBE on whichever node
  // receives it, while Valkey 9.1.2 routes it like SSUBSCRIBE.
  const SORT_NOTE = 'Valkey 9.1.2 finds other keys in this command: {keys}. It reads a destination named LIMIT, GET, BY or STORE as another option, so a Valkey cluster checks the wrong keys and may refuse the command or route it by the wrong key. Redis 8.10.2 reads it as shown. Give the destination another name.';
  const SUNSUBSCRIBE_NOTE = 'These are shard channels, not keys. Valkey 9.1.2 places them in slots like keys: channels from different slots get CROSSSLOT, and a node that does not own the slot answers MOVED. Redis 8.10.2 runs SUNSUBSCRIBE on any node, whatever the slots, since it only changes what this connection listens to.';

  // ---- Slot ranges and nodes ----

  // The even split valkey-cli --cluster create and redis-cli --cluster create
  // give a new cluster. The clients do this sum in 32-bit floats, so the same
  // rounding is reproduced here.
  function evenSplit(primaries) {
    const n = Math.max(1, Math.min(SLOTS, Math.floor(primaries)));
    const f = Math.fround;
    const per = f(SLOTS / n);
    const ranges = [];
    let first = 0;
    let cursor = f(0);
    for (let i = 0; i < n; i++) {
      let last = Math.round(f(f(cursor + per) - 1));
      if (last > SLOTS || i === n - 1) last = SLOTS - 1;
      if (last < first) last = first;
      ranges.push({ node: 'primary ' + (i + 1), ranges: [[first, last]] });
      first = last + 1;
      cursor = f(cursor + per);
    }
    return ranges;
  }

  // Read CLUSTER NODES output. Returns the primaries that own slots, in the
  // order the output lists them, each with its address and slot ranges.
  function parseClusterNodes(textIn) {
    const nodes = [];
    for (const raw of String(textIn).split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const parts = line.split(/\s+/);
      if (parts.length < 8 || !/^[0-9a-f]{40}$/i.test(parts[0])) continue;
      const flags = parts[2].split(',');
      if (!flags.includes('master')) continue;
      const addr = parts[1].split('@')[0];
      const hostname = (parts[1].split(',')[1]) || '';
      const ranges = [];
      for (let i = 8; i < parts.length; i++) {
        const t = parts[i];
        if (t.startsWith('[')) continue;
        const m = /^(\d+)(?:-(\d+))?$/.exec(t);
        if (!m) continue;
        const a = +m[1], b = m[2] === undefined ? a : +m[2];
        if (a <= b && b < SLOTS) ranges.push([a, b]);
      }
      if (!ranges.length) continue;
      nodes.push({ node: hostname ? hostname + ' (' + addr + ')' : addr, id: parts[0], ranges: ranges, failing: flags.includes('fail') });
    }
    return nodes;
  }

  // Slot number to node index, or -1 where no node owns the slot.
  function slotMap(nodes) {
    const map = new Int32Array(SLOTS).fill(-1);
    nodes.forEach(function (n, idx) {
      for (const r of n.ranges) for (let s = r[0]; s <= r[1]; s++) map[s] = idx;
    });
    return map;
  }

  // Count many keys by slot and by node.
  function analyze(keys, nodes) {
    const perSlot = new Uint32Array(SLOTS);
    const map = nodes && nodes.length ? slotMap(nodes) : null;
    const perNode = nodes ? new Array(nodes.length).fill(0) : [];
    let unowned = 0, tagged = 0;
    const tagCounts = new Map();
    const rows = [];
    for (const k of keys) {
      const d = describeKey(k);
      perSlot[d.slot]++;
      if (d.tagged) {
        tagged++;
        const tag = displayKey(d.hashed);
        tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      }
      let node = -1;
      if (map) { node = map[d.slot]; if (node < 0) unowned++; else perNode[node]++; }
      rows.push({ bytes: d.bytes, slot: d.slot, node: node, tagged: d.tagged, start: d.start, end: d.end });
    }
    let used = 0, busiest = 0;
    for (let s = 0; s < SLOTS; s++) if (perSlot[s]) { used++; if (perSlot[s] > busiest) busiest = perSlot[s]; }
    const topSlots = [];
    for (let s = 0; s < SLOTS; s++) if (perSlot[s]) topSlots.push([s, perSlot[s]]);
    topSlots.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    const topTags = Array.from(tagCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10);
    return {
      total: keys.length,
      usedSlots: used,
      busiestSlot: busiest,
      perSlot: perSlot,
      perNode: perNode,
      unowned: unowned,
      tagged: tagged,
      topSlots: topSlots.slice(0, 10),
      topTags: topTags,
      rows: rows
    };
  }

  return {
    SLOTS: SLOTS,
    crc16: crc16,
    hashedRange: hashedRange,
    keySlot: keySlot,
    describeKey: describeKey,
    toBytes: toBytes,
    unquote: unquote,
    parseKeyLine: parseKeyLine,
    parseKeyList: parseKeyList,
    parseKeyBuffer: parseKeyBuffer,
    displayKey: displayKey,
    splitArgs: splitArgs,
    checkCommand: checkCommand,
    evenSplit: evenSplit,
    parseClusterNodes: parseClusterNodes,
    slotMap: slotMap,
    analyze: analyze,
    multiKeyCommands: Object.keys(MULTI).sort()
  };
});
