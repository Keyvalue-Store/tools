// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Keyspace Map. Reads a list of keys, such as the output of `redis-cli --scan`,
// and shows what is in it: the prefixes as a tree with counts, the naming
// patterns behind the keys with IDs and hashes folded together, and naming
// slips worth a look. One file, no dependencies. In a browser it defines
// KVKeyspace; in Node, require() returns the same functions.

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KVKeyspace = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const encoder = new TextEncoder();
  const strict = new TextDecoder('utf-8', { fatal: true });
  const loose = new TextDecoder('utf-8', { fatal: false });

  // ---- reading key lists (one key per line, raw or as redis-cli quotes them) ----

  const isHexByte = (b) => (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66);
  const ESC = { 0x6e: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x61: 7, 0x22: 34, 0x5c: 92, 0x27: 39 };
  function unquoteBytes(b) {
    const out = [];
    for (let i = 0; i < b.length; i++) {
      if (b[i] === 0x5c && i + 1 < b.length) {
        const n = b[i + 1];
        if (n === 0x78 && isHexByte(b[i + 2]) && isHexByte(b[i + 3])) { out.push(parseInt(String.fromCharCode(b[i + 2], b[i + 3]), 16)); i += 3; continue; }
        if (Object.prototype.hasOwnProperty.call(ESC, n)) { out.push(ESC[n]); i += 1; continue; }
      }
      out.push(b[i]);
    }
    return new Uint8Array(out);
  }
  function lineToKey(b, raw) {
    if (raw) return b.slice();
    let s = 0;
    while (true) {
      let j = s;
      while (j < b.length && b[j] === 0x20) j++;
      let k = j;
      while (k < b.length && b[k] >= 0x30 && b[k] <= 0x39) k++;
      if (k > j && k + 1 < b.length && b[k] === 0x29 && b[k + 1] === 0x20) { s = k + 1; while (s < b.length && b[s] === 0x20) s++; }
      else break;
    }
    const rest = b.subarray(s);
    if (rest.length >= 2 && rest[0] === 0x22 && rest[rest.length - 1] === 0x22) return unquoteBytes(rest.subarray(1, rest.length - 1));
    return rest.slice();
  }
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
  function parseKeyList(text, raw) { return parseKeyBuffer(encoder.encode(String(text)), raw); }

  // Key bytes as text; bytes that are not valid UTF-8 or not printable as \xHH.
  function keyText(bytes) {
    try {
      const t = strict.decode(bytes);
      if (!/[\x00-\x1f\x7f]/.test(t)) return { text: t, clean: true };
    } catch (e) { /* not valid UTF-8 */ }
    let s = '';
    for (const c of bytes) s += (c >= 0x20 && c < 0x7f && c !== 0x5c) ? String.fromCharCode(c) : (c === 0x5c ? '\\\\' : '\\x' + c.toString(16).padStart(2, '0'));
    return { text: s, clean: false };
  }

  // ---- separators and segments ----

  const SEPARATORS = [':', '/', '|', '#', '.', '_', '-'];

  // The separator most keys use. ':' wins ties, and '.', '_' and '-' only count
  // when no stronger sign is there, since they also turn up inside words.
  function guessSeparator(texts) {
    const sample = texts.length > 20000 ? texts.filter((_, i) => i % Math.ceil(texts.length / 20000) === 0) : texts;
    let best = '', bestShare = 0;
    for (const sep of SEPARATORS) {
      let n = 0;
      for (const t of sample) if (t.includes(sep)) n++;
      const share = n / (sample.length || 1);
      const weak = sep === '.' || sep === '_' || sep === '-';
      if (share >= (weak ? 0.6 : 0.3) && share > bestShare + (weak ? 0.15 : 0)) { best = sep; bestShare = share; }
    }
    return best;
  }

  // Placeholders use angle brackets, since braces mean hash tags in keys.
  const CLASSES = [
    ['<uuid>', /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/],
    ['<id>', /^\d+$/],
    ['<date>', /^\d{4}-\d{2}(-\d{2}([T ]\d{2}(:\d{2}(:\d{2}(\.\d+)?)?)?Z?)?)?$/],
    ['<email>', /^[^@\s]+@[^@\s]+\.[^@\s]+$/],
    ['<ip>', /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/],
    ['<hex>', /^(?=.*\d)(?=.*[a-fA-F])[0-9a-fA-F]{12,}$/],
    ['<token>', /^(?=.*\d)(?=.*[A-Za-z])[A-Za-z0-9_+=\/-]{20,}$/]
  ];

  // What a segment stands for: a class such as <id>, or null to keep the
  // text itself. A segment in braces, a hash tag, keeps its braces: {<id>}.
  function classify(seg) {
    const tag = /^\{(.+)\}$/.exec(seg);
    const inner = tag ? tag[1] : seg;
    for (const [name, re] of CLASSES) if (re.test(inner)) return tag ? '{' + name + '}' : name;
    return null;
  }

  function split(text, sep) {
    if (!sep) return [text];
    return text.split(sep);
  }

  // ---- the map ----

  function newNode(name) { return { name: name, count: 0, bytes: 0, children: new Map(), examples: [] }; }

  // Build the map. options: { separator: 'auto' | '' | ':' ..., fold: true, foldBusy: true, raw }
  function analyze(keys, options) {
    const opt = Object.assign({ separator: 'auto', fold: true, foldBusy: true }, options || {});
    const texts = keys.map((k) => keyText(k));
    const sep = opt.separator === 'auto' ? guessSeparator(texts.map((t) => t.text)) : opt.separator;
    const root = newNode('');
    let totalBytes = 0, longest = 0;
    const findings = { noSeparator: [], otherSeparator: [], unclean: [], long: [], emptySegment: [] };
    texts.forEach((t, idx) => {
      const len = keys[idx].length;
      totalBytes += len;
      if (len > longest) longest = len;
      if (!t.clean) findings.unclean.push(t.text);
      if (len > 256) findings.long.push(t.text);
      if (sep && !t.text.includes(sep)) findings.noSeparator.push(t.text);
      if (sep) {
        const first = t.text.split(sep)[0];
        for (const other of [':', '/', '|', '#']) if (other !== sep && first.includes(other)) { findings.otherSeparator.push(t.text); break; }
        if (t.text.split(sep).some((s, i, a) => s === '' && !(a.length === 1))) findings.emptySegment.push(t.text);
      }
      const segs = split(t.text, sep);
      let node = root;
      node.count++; node.bytes += len;
      for (let i = 0; i < segs.length; i++) {
        const raw = segs[i];
        const name = (opt.fold ? classify(raw) : null) || raw;
        let child = node.children.get(name);
        if (!child) { child = newNode(name); node.children.set(name, child); }
        child.count++;
        child.bytes += len;
        if (i === segs.length - 1) child.ends = (child.ends || 0) + 1;
        if (child.examples.length < 3) child.examples.push(t.text);
        node = child;
      }
    });
    if (opt.foldBusy) foldBusy(root);
    const patterns = [];
    collect(root, [], sep, patterns);
    patterns.sort((a, b) => b.count - a.count || (a.pattern < b.pattern ? -1 : 1));
    const prefixes = Array.from(root.children.values()).map((c) => c.name);
    return {
      separator: sep,
      total: keys.length,
      totalBytes: totalBytes,
      longest: longest,
      root: root,
      patterns: patterns,
      findings: summarizeFindings(findings, prefixes, root, sep)
    };
  }

  // A level with a great many children that each hold a key or two is a level
  // of names, such as user names, not of categories. Merge those children
  // into one <*> child so the map shows the shape, not every name.
  function foldBusy(node) {
    for (const child of node.children.values()) foldBusy(child);
    const kids = Array.from(node.children.values());
    if (kids.length <= 50) return;
    const small = kids.filter((k) => k.count <= 2 && !k.name.includes('<'));
    if (small.length < kids.length * 0.8) return;
    let star = node.children.get('<*>');
    if (!star) { star = newNode('<*>'); }
    for (const k of small) { mergeInto(star, k); node.children.delete(k.name); }
    node.children.set('<*>', star);
  }
  function mergeInto(dst, src) {
    dst.count += src.count;
    dst.bytes += src.bytes;
    if (src.ends) dst.ends = (dst.ends || 0) + src.ends;
    for (const e of src.examples) if (dst.examples.length < 3) dst.examples.push(e);
    for (const [name, c] of src.children) {
      let d = dst.children.get(name);
      if (!d) { d = newNode(name); dst.children.set(name, d); }
      mergeInto(d, c);
    }
  }

  // Every path where keys end is a pattern.
  function collect(node, path, sep, out) {
    for (const child of node.children.values()) {
      const p = path.concat(child.name);
      if (child.ends) out.push({ pattern: p.join(sep || ''), count: child.ends, examples: child.examples.slice(0, 3), bytes: endsBytes(child) });
      collect(child, p, sep, out);
    }
  }
  // Bytes of the keys that end at this node: its own bytes minus its children's.
  function endsBytes(node) {
    let b = node.bytes;
    for (const c of node.children.values()) b -= c.bytes;
    return b;
  }

  function distance1(a, b) {
    if (a === b) return false;
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1) || (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
    return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
  }

  function summarizeFindings(f, prefixes, root, sep) {
    const out = [];
    const ex = (list) => list.slice(0, 3);
    if (sep && f.noSeparator.length) out.push({ kind: 'noSeparator', label: `Keys with no "${sep}"`, count: f.noSeparator.length, examples: ex(f.noSeparator),
      text: `have no "${sep}" at all, so they sit outside every prefix.` });
    if (f.otherSeparator.length) out.push({ kind: 'otherSeparator', label: 'Keys with another separator in their first part', count: f.otherSeparator.length, examples: ex(f.otherSeparator),
      text: `use another separator in their first part, while most keys use "${sep}".` });
    const lower = new Map();
    for (const p of prefixes) {
      const k = p.toLowerCase();
      if (!lower.has(k)) lower.set(k, []);
      lower.get(k).push(p);
    }
    const caseGroups = Array.from(lower.values()).filter((g) => g.length > 1);
    if (caseGroups.length) out.push({ kind: 'case', label: 'Prefixes that differ only in case', count: caseGroups.length, examples: caseGroups.slice(0, 3).map((g) => g.join(' / ')),
      text: 'prefixes differ only in upper and lower case.' });
    // Prefixes one letter apart, among the 3,000 biggest, biggest first.
    const near = [];
    const named = Array.from(root.children.values()).sort((a, b) => b.count - a.count)
      .map((c) => c.name).filter((p) => p.length >= 3 && !p.includes('<')).slice(0, 3000);
    for (let i = 0; i < named.length; i++) for (let j = i + 1; j < named.length; j++) {
      if (named[i].toLowerCase() !== named[j].toLowerCase() && distance1(named[i], named[j])) near.push(named[i] + ' / ' + named[j]);
    }
    if (near.length) out.push({ kind: 'near', label: 'Prefixes one letter apart', count: near.length, examples: ex(near), text: 'prefixes are one letter apart, which is often a typo.' });
    if (f.emptySegment.length) out.push({ kind: 'empty', label: 'Keys with an empty part', count: f.emptySegment.length, examples: ex(f.emptySegment),
      text: `have an empty part, such as "${sep}${sep}" or a "${sep}" at the end.` });
    if (f.long.length) out.push({ kind: 'long', label: 'Keys longer than 256 bytes', count: f.long.length, examples: ex(f.long.map((k) => k.slice(0, 80) + '…')),
      text: 'are longer than 256 bytes. Every key name is kept in memory, so long names cost memory on every key.' });
    if (f.unclean.length) out.push({ kind: 'unclean', label: 'Keys with control characters or invalid UTF-8', count: f.unclean.length, examples: ex(f.unclean),
      text: 'contain control characters or bytes that are not valid UTF-8.' });
    return out;
  }

  // The tree as plain objects, biggest first, for display and JSON.
  function tree(node, maxChildren) {
    const kids = Array.from(node.children.values()).sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1));
    const limit = maxChildren || 50;
    const shown = kids.slice(0, limit).map((k) => tree(k, maxChildren));
    const rest = kids.slice(limit);
    return {
      name: node.name, count: node.count, bytes: node.bytes, ends: node.ends || 0, examples: node.examples,
      children: shown,
      more: rest.length ? { nodes: rest.length, count: rest.reduce((a, k) => a + k.count, 0) } : null
    };
  }

  return {
    parseKeyBuffer: parseKeyBuffer,
    parseKeyList: parseKeyList,
    keyText: keyText,
    guessSeparator: guessSeparator,
    classify: classify,
    analyze: analyze,
    tree: tree
  };
});
