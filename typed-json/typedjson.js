// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Typed JSON Converter. Turns DynamoDB's typed JSON, where every value is
// wrapped in its type ({"S": "Ana"}, {"N": "42"}), into plain JSON and back.
// It reads JSON with its own parser so numbers keep every digit: DynamoDB
// numbers have up to 38 significant digits, more than a JavaScript number
// holds. One file, no dependencies. In a browser it defines KVTypedJSON; in
// Node, require() returns the same functions.

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KVTypedJSON = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // A number kept as its exact text.
  class Num {
    constructor(text) { this.text = text; }
    toString() { return this.text; }
  }

  function ConvertError(message, path) {
    const e = new Error(path ? message + ' (at ' + path + ')' : message);
    e.path = path || '';
    return e;
  }

  // ---- JSON parser that keeps number text ----

  function parse(text) {
    let i = 0;
    const s = String(text);
    function fail(msg) {
      const before = s.slice(0, i);
      const line = before.split('\n').length;
      const col = i - before.lastIndexOf('\n');
      throw ConvertError(msg + ' at line ' + line + ', column ' + col);
    }
    function ws() { while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n' || s[i] === '\r')) i++; }
    function value() {
      ws();
      const c = s[i];
      if (c === '{') return object();
      if (c === '[') return array();
      if (c === '"') return string();
      if (c === 't') return word('true', true);
      if (c === 'f') return word('false', false);
      if (c === 'n') return word('null', null);
      if (c === '-' || (c >= '0' && c <= '9')) return number();
      if (c === undefined) fail('The JSON ends too early');
      fail('Unexpected character ' + JSON.stringify(c));
    }
    function word(w, v) { if (s.startsWith(w, i)) { i += w.length; return v; } fail('Unexpected word'); }
    function number() {
      const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(s.slice(i, i + 400));
      if (!m) fail('A number is not written correctly');
      i += m[0].length;
      return new Num(m[0]);
    }
    function string() {
      i++;
      let out = '';
      let start = i;
      while (true) {
        if (i >= s.length) fail('A string is not closed');
        const c = s.charCodeAt(i);
        if (c === 34) { out += s.slice(start, i); i++; return out; }
        if (c === 92) {
          out += s.slice(start, i);
          const n = s[i + 1];
          const map = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (n === 'u') {
            const h = s.slice(i + 2, i + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(h)) fail('A \\u escape needs four hex digits');
            out += String.fromCharCode(parseInt(h, 16));
            i += 6;
          } else if (map[n] !== undefined) { out += map[n]; i += 2; }
          else fail('Unknown escape \\' + n);
          start = i;
          continue;
        }
        if (c < 0x20) fail('A string contains a raw control character');
        i++;
      }
    }
    function array() {
      i++;
      const out = [];
      ws();
      if (s[i] === ']') { i++; return out; }
      while (true) {
        out.push(value());
        ws();
        if (s[i] === ',') { i++; continue; }
        if (s[i] === ']') { i++; return out; }
        fail('Expected , or ] in a list');
      }
    }
    function object() {
      i++;
      const out = Object.create(null);
      ws();
      if (s[i] === '}') { i++; return out; }
      while (true) {
        ws();
        if (s[i] !== '"') fail('Expected a name in quotes');
        const k = string();
        ws();
        if (s[i] !== ':') fail('Expected : after a name');
        i++;
        out[k] = value();
        ws();
        if (s[i] === ',') { i++; continue; }
        if (s[i] === '}') { i++; return out; }
        fail('Expected , or } in an object');
      }
    }
    const v = value();
    ws();
    if (i < s.length) fail('Extra text after the JSON');
    return v;
  }

  // Several JSON values, one per line (JSON Lines), as in DynamoDB's export to S3.
  function parseLines(text) {
    const out = [];
    const lines = String(text).split('\n');
    for (let n = 0; n < lines.length; n++) {
      if (!lines[n].trim()) continue;
      try { out.push(parse(lines[n])); }
      catch (e) { throw ConvertError(e.message.replace(/ at line \d+,/, ' at line ' + (n + 1) + ',')); }
    }
    return out;
  }

  // ---- writing JSON ----

  function quote(str) {
    let out = '"';
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      if (c === 34) out += '\\"';
      else if (c === 92) out += '\\\\';
      else if (c === 10) out += '\\n';
      else if (c === 13) out += '\\r';
      else if (c === 9) out += '\\t';
      else if (c === 8) out += '\\b';
      else if (c === 12) out += '\\f';
      else if (c < 0x20 || c === 0x2028 || c === 0x2029) out += '\\u' + c.toString(16).padStart(4, '0');
      else out += str[i];
    }
    return out + '"';
  }

  function stringify(v, indent) {
    const step = indent === undefined ? 2 : indent;
    function go(x, pad) {
      if (x === null) return 'null';
      if (x instanceof Num) return x.text;
      if (typeof x === 'string') return quote(x);
      if (typeof x === 'boolean') return x ? 'true' : 'false';
      if (typeof x === 'number') return Number.isFinite(x) ? String(x) : 'null';
      const inner = step ? pad + ' '.repeat(step) : '';
      const nl = step ? '\n' : '';
      const sep = step ? ': ' : ':';
      if (Array.isArray(x)) {
        if (!x.length) return '[]';
        return '[' + nl + x.map((y) => inner + go(y, inner)).join(',' + nl) + nl + pad + ']';
      }
      const keys = Object.keys(x);
      if (!keys.length) return '{}';
      return '{' + nl + keys.map((k) => inner + quote(k) + sep + go(x[k], inner)).join(',' + nl) + nl + pad + '}';
    }
    return go(v, '');
  }

  // ---- numbers ----

  const NUMBER_TEXT = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

  // DynamoDB accepts numbers such as "+.5" or "007"; plain JSON does not.
  // This rewrites them as valid JSON with the same value.
  function jsonNumber(text, path) {
    const t = String(text).trim();
    const m = NUMBER_TEXT.exec(t);
    if (!m) throw ConvertError('"' + text + '" is not a number', path);
    let sign = t[0] === '-' ? '-' : '';
    let body = t.replace(/^[+-]/, '');
    let exp = '';
    const e = body.search(/[eE]/);
    if (e >= 0) { exp = body.slice(e); body = body.slice(0, e); }
    let [whole, frac] = body.split('.');
    whole = (whole || '').replace(/^0+(?=\d)/, '') || '0';
    frac = frac || '';
    let out = whole + (frac ? '.' + frac : '');
    if (exp) {
      const ex = /^[eE]([+-]?)(\d+)$/.exec(exp);
      out += 'e' + (ex[1] === '-' ? '-' : '+') + (ex[2].replace(/^0+(?=\d)/, ''));
    }
    if (/^0(\.0*)?(e[+-]\d+)?$/.test(out)) sign = '';
    return sign + out;
  }

  function significantDigits(text) {
    const body = String(text).replace(/^[+-]/, '').replace(/[eE].*$/, '').replace('.', '');
    const trimmed = body.replace(/^0+/, '').replace(/0+$/, '');
    return trimmed.length;
  }

  // ---- typed to plain ----

  const TYPES = ['S', 'N', 'B', 'BOOL', 'NULL', 'M', 'L', 'SS', 'NS', 'BS'];

  function isAttr(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v) || v instanceof Num) return false;
    const k = Object.keys(v);
    return k.length === 1 && TYPES.includes(k[0]);
  }
  function isTypedItem(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v) || v instanceof Num) return false;
    const keys = Object.keys(v);
    return keys.length > 0 && keys.every((k) => isAttr(v[k]));
  }

  function fromAttr(av, path, stats) {
    if (!isAttr(av)) throw ConvertError('Expected a typed value such as {"S": "text"}', path);
    const type = Object.keys(av)[0];
    const v = av[type];
    const p = path + '.' + type;
    switch (type) {
      case 'S':
        if (typeof v !== 'string') throw ConvertError('An S value must be a string', p);
        return v;
      case 'N': {
        const text = v instanceof Num ? v.text : v;
        if (typeof text !== 'string') throw ConvertError('An N value must be a number written as a string', p);
        stats.numbers++;
        return new Num(jsonNumber(text, p));
      }
      case 'B':
        if (typeof v !== 'string') throw ConvertError('A B value must be base64 text', p);
        stats.binary++;
        return v;
      case 'BOOL':
        if (typeof v !== 'boolean') throw ConvertError('A BOOL value must be true or false', p);
        return v;
      case 'NULL':
        if (v !== true) throw ConvertError('A NULL value must be true', p);
        return null;
      case 'M': {
        if (!v || typeof v !== 'object' || Array.isArray(v) || v instanceof Num) throw ConvertError('An M value must be an object', p);
        const out = Object.create(null);
        for (const k of Object.keys(v)) out[k] = fromAttr(v[k], p + '.' + k, stats);
        return out;
      }
      case 'L':
        if (!Array.isArray(v)) throw ConvertError('An L value must be a list', p);
        return v.map((x, i) => fromAttr(x, p + '[' + i + ']', stats));
      case 'SS': case 'NS': case 'BS': {
        if (!Array.isArray(v)) throw ConvertError('A ' + type + ' value must be a list', p);
        stats.sets++;
        return v.map((x, i) => {
          const text = x instanceof Num ? x.text : x;
          if (typeof text !== 'string') throw ConvertError('Set members must be written as strings', p + '[' + i + ']');
          if (type === 'NS') { stats.numbers++; return new Num(jsonNumber(text, p + '[' + i + ']')); }
          if (type === 'BS') stats.binary++;
          return text;
        });
      }
    }
  }

  function fromItem(item, path, stats) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw ConvertError('Expected an item: an object of typed values', path);
    const out = Object.create(null);
    for (const k of Object.keys(item)) out[k] = fromAttr(item[k], (path ? path + '.' : '') + k, stats);
    stats.items++;
    return out;
  }

  // ---- plain to typed ----

  function toAttr(v, path, opt, stats) {
    if (v === null) return { NULL: true };
    if (typeof v === 'boolean') return { BOOL: v };
    if (typeof v === 'string') return { S: v };
    if (v instanceof Num || typeof v === 'number') {
      const text = v instanceof Num ? v.text : String(v);
      stats.numbers++;
      if (significantDigits(text) > 38) stats.precision.push(path);
      return { N: text };
    }
    if (Array.isArray(v)) {
      const set = opt.sets && v.length > 0 ? setType(v, opt.sets) : null;
      if (set) {
        stats.sets++;
        return set === 'SS' ? { SS: v.slice() } : { NS: v.map((x) => { stats.numbers++; return x instanceof Num ? x.text : String(x); }) };
      }
      return { L: v.map((x, i) => toAttr(x, path + '[' + i + ']', opt, stats)) };
    }
    if (typeof v === 'object') {
      const out = Object.create(null);
      for (const k of Object.keys(v)) out[k] = toAttr(v[k], path + '.' + k, opt, stats);
      return { M: out };
    }
    throw ConvertError('This value cannot be stored', path);
  }

  // A list becomes a set only when asked, when every member has the same
  // type, and when no member repeats, since DynamoDB refuses duplicates in sets.
  function setType(list, which) {
    if (list.every((x) => typeof x === 'string') && (which === 'strings' || which === 'both')) {
      return new Set(list).size === list.length ? 'SS' : null;
    }
    if (list.every((x) => x instanceof Num || typeof x === 'number') && (which === 'numbers' || which === 'both')) {
      const seen = new Set(list.map((x) => normalizedValue(x instanceof Num ? x.text : String(x))));
      return seen.size === list.length ? 'NS' : null;
    }
    return null;
  }
  // Numbers that DynamoDB treats as equal, such as 1 and 1.0, collide in a set.
  function normalizedValue(text) {
    const t = jsonNumber(text);
    const m = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(t);
    let digits = m[2] + (m[3] || '');
    let exp = (m[4] ? parseInt(m[4], 10) : 0) + m[2].length;
    const lead = digits.match(/^0*/)[0].length;
    digits = digits.slice(lead); exp -= lead;
    digits = digits.replace(/0+$/, '');
    if (!digits) return '0';
    return m[1] + '0.' + digits + 'e' + exp;
  }

  function toItem(obj, path, opt, stats) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj) || obj instanceof Num) {
      throw ConvertError('Only objects can become DynamoDB items. This is ' + describe(obj), path);
    }
    const out = Object.create(null);
    for (const k of Object.keys(obj)) out[k] = toAttr(obj[k], (path ? path + '.' : '') + k, opt, stats);
    stats.items++;
    return out;
  }
  function describe(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'a list';
    if (v instanceof Num) return 'a number';
    return 'a ' + typeof v;
  }

  // ---- whole documents ----

  function newStats() { return { items: 0, numbers: 0, binary: 0, sets: 0, precision: [] }; }

  // Work out what was pasted: which direction, and which shape.
  function detect(values) {
    const v = values.length === 1 ? values[0] : null;
    const allTypedLines = values.length > 1 && values.every((x) => x && typeof x === 'object' && (isTypedItem(x) || (x.Item && isTypedItem(x.Item))));
    if (allTypedLines) return { direction: 'toPlain', shape: values.every((x) => x.Item) ? 's3export' : 'lines' };
    if (values.length > 1) return { direction: 'toTyped', shape: 'lines' };
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Num)) {
      if (Array.isArray(v.Items) && (v.Items.length === 0 || v.Items.every(isTypedItem))) return { direction: 'toPlain', shape: 'items' };
      if (v.Item && isTypedItem(v.Item)) return { direction: 'toPlain', shape: 'item' };
      if (Array.isArray(v.Records) && v.Records.some((r) => r && r.dynamodb)) return { direction: 'toPlain', shape: 'stream' };
      if (v.Responses && typeof v.Responses === 'object' && Object.keys(v.Responses).every((t) => Array.isArray(v.Responses[t]))) return { direction: 'toPlain', shape: 'batchget' };
      if (isTypedItem(v)) return { direction: 'toPlain', shape: 'single' };
      return { direction: 'toTyped', shape: 'single' };
    }
    if (Array.isArray(v)) {
      if (v.length && v.every(isTypedItem)) return { direction: 'toPlain', shape: 'array' };
      return { direction: 'toTyped', shape: 'array' };
    }
    return { direction: 'toTyped', shape: 'single' };
  }

  const SHAPE_NAMES = {
    single: 'one item', array: 'a list of items', lines: 'one item per line (JSON Lines)',
    s3export: 'an export to S3 in DynamoDB JSON, one item per line', items: 'a Scan or Query result',
    item: 'a GetItem result', stream: 'DynamoDB Streams records', batchget: 'a BatchGetItem result'
  };

  // Convert a pasted document. options: { direction: 'auto' | 'toPlain' | 'toTyped',
  // sets: '' | 'strings' | 'numbers' | 'both', output: 'plain' | 'batch', table, indent }
  function convert(text, options) {
    const opt = Object.assign({ direction: 'auto', sets: '', output: 'plain', table: 'my-table', indent: 2 }, options || {});
    const src = String(text).trim();
    if (!src) return { text: '', note: '', stats: newStats() };
    let values;
    try { values = [parse(src)]; }
    catch (first) {
      // Not one JSON document. If the first line is a whole value on its own,
      // read the text as JSON Lines, and report errors by line.
      const firstLine = src.split('\n')[0];
      let firstIsWhole = false;
      try { parse(firstLine); firstIsWhole = true; } catch (e) { firstIsWhole = false; }
      if (!firstIsWhole) throw first;
      values = parseLines(src);
    }
    const found = detect(values);
    const direction = opt.direction === 'auto' ? found.direction : opt.direction;
    const stats = newStats();
    let out;
    let lines = false;
    let shape = found.shape;
    if (direction === 'toPlain') {
      if (values.length > 1) {
        out = values.map((x, n) => fromItem(x.Item && isTypedItem(x.Item) ? x.Item : x, 'line ' + (n + 1), stats));
        lines = true;
      } else {
        const v = values[0];
        if (shape === 'items') out = v.Items.map((x, n) => fromItem(x, 'Items[' + n + ']', stats));
        else if (shape === 'item') out = fromItem(v.Item, 'Item', stats);
        else if (shape === 'batchget') {
          out = Object.create(null);
          for (const t of Object.keys(v.Responses)) out[t] = v.Responses[t].map((x, n) => fromItem(x, 'Responses.' + t + '[' + n + ']', stats));
        } else if (shape === 'stream') {
          out = v.Records.map((r, n) => {
            const d = r.dynamodb || {};
            const rec = Object.create(null);
            if (r.eventName !== undefined) rec.eventName = r.eventName;
            for (const part of ['Keys', 'NewImage', 'OldImage']) if (d[part]) rec[part] = fromItem(d[part], 'Records[' + n + '].dynamodb.' + part, stats);
            return rec;
          });
        } else if (Array.isArray(v)) out = v.map((x, n) => fromItem(x, '[' + n + ']', stats));
        else out = fromItem(v, '', stats);
      }
    } else {
      if (values.length > 1) { out = values.map((x, n) => toItem(x, 'line ' + (n + 1), opt, stats)); lines = true; }
      else if (Array.isArray(values[0])) out = values[0].map((x, n) => toItem(x, '[' + n + ']', opt, stats));
      else out = toItem(values[0], '', opt, stats);
      if (opt.output === 'batch') {
        const items = Array.isArray(out) ? out : [out];
        const batches = [];
        for (let i = 0; i < items.length; i += 25) {
          const req = Object.create(null);
          req[opt.table] = items.slice(i, i + 25).map((it) => ({ PutRequest: { Item: it } }));
          batches.push(req);
        }
        out = batches;
        lines = true;
        shape = 'batch';
      }
    }
    const textOut = lines ? out.map((x) => stringify(x, 0)).join('\n') + '\n' : stringify(out, opt.indent) + '\n';
    return { text: textOut, direction: direction, shape: shape, shapeName: SHAPE_NAMES[shape] || '', stats: stats, count: Array.isArray(out) ? out.length : 1 };
  }

  return {
    Num: Num,
    parse: parse,
    parseLines: parseLines,
    stringify: stringify,
    jsonNumber: jsonNumber,
    significantDigits: significantDigits,
    isTypedItem: isTypedItem,
    fromAttr: (av) => fromAttr(av, '', newStats()),
    fromItem: (item) => fromItem(item, '', newStats()),
    toAttr: (v, opt) => toAttr(v, '', opt || {}, newStats()),
    toItem: (obj, opt) => toItem(obj, '', opt || {}, newStats()),
    detect: detect,
    convert: convert
  };
});
