// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Expression Tester. Reads the expressions a DynamoDB request carries (key
// conditions, filters, conditions, updates and projections), checks them the
// way DynamoDB does, in the same order and with the same error messages, and
// runs them against sample items: which items a query or filter returns, what
// an update leaves behind, what a projection keeps. One file, no
// dependencies. In a browser it defines KVExpressions; in Node, require()
// returns the same functions.

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KVExpressions = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---- Reserved words ----

  // AWS's list of reserved words, as DynamoDB Local 3.3.1 enforces it. CONVERT
  // and SIZE are on the published list but DynamoDB accepts them as names, and
  // AND, OR, NOT, BETWEEN, IN, SET, REMOVE, ADD and DELETE are keywords, which
  // give a syntax error instead. Checked word by word; see test/results/.
  const RESERVED = new Set([
    'ABORT ABSOLUTE ACTION AFTER AGENT AGGREGATE ALL ALLOCATE ALTER ANALYZE ANY ARCHIVE ARE ARRAY AS ASC',
    'ASCII ASENSITIVE ASSERTION ASYMMETRIC AT ATOMIC ATTACH ATTRIBUTE AUTH AUTHORIZATION AUTHORIZE AUTO',
    'AVG BACK BACKUP BASE BATCH BEFORE BEGIN BIGINT BINARY BIT BLOB BLOCK BOOLEAN BOTH BREADTH BUCKET',
    'BULK BY BYTE CALL CALLED CALLING CAPACITY CASCADE CASCADED CASE CAST CATALOG CHAR CHARACTER CHECK',
    'CLASS CLOB CLOSE CLUSTER CLUSTERED CLUSTERING CLUSTERS COALESCE COLLATE COLLATION COLLECTION COLUMN',
    'COLUMNS COMBINE COMMENT COMMIT COMPACT COMPILE COMPRESS CONDITION CONFLICT CONNECT CONNECTION',
    'CONSISTENCY CONSISTENT CONSTRAINT CONSTRAINTS CONSTRUCTOR CONSUMED CONTINUE COPY CORRESPONDING COUNT',
    'COUNTER CREATE CROSS CUBE CURRENT CURSOR CYCLE DATA DATABASE DATE DATETIME DAY DEALLOCATE DEC',
    'DECIMAL DECLARE DEFAULT DEFERRABLE DEFERRED DEFINE DEFINED DEFINITION DELIMITED DEPTH DEREF DESC',
    'DESCRIBE DESCRIPTOR DETACH DETERMINISTIC DIAGNOSTICS DIRECTORIES DISABLE DISCONNECT DISTINCT',
    'DISTRIBUTE DO DOMAIN DOUBLE DROP DUMP DURATION DYNAMIC EACH ELEMENT ELSE ELSEIF EMPTY ENABLE END',
    'EQUAL EQUALS ERROR ESCAPE ESCAPED EVAL EVALUATE EXCEEDED EXCEPT EXCEPTION EXCEPTIONS EXCLUSIVE EXEC',
    'EXECUTE EXISTS EXIT EXPLAIN EXPLODE EXPORT EXPRESSION EXTENDED EXTERNAL EXTRACT FAIL FALSE FAMILY',
    'FETCH FIELDS FILE FILTER FILTERING FINAL FINISH FIRST FIXED FLATTERN FLOAT FOR FORCE FOREIGN FORMAT',
    'FORWARD FOUND FREE FROM FULL FUNCTION FUNCTIONS GENERAL GENERATE GET GLOB GLOBAL GO GOTO GRANT',
    'GREATER GROUP GROUPING HANDLER HASH HAVE HAVING HEAP HIDDEN HOLD HOUR IDENTIFIED IDENTITY IF IGNORE',
    'IMMEDIATE IMPORT INCLUDING INCLUSIVE INCREMENT INCREMENTAL INDEX INDEXED INDEXES INDICATOR INFINITE',
    'INITIALLY INLINE INNER INNTER INOUT INPUT INSENSITIVE INSERT INSTEAD INT INTEGER INTERSECT INTERVAL',
    'INTO INVALIDATE IS ISOLATION ITEM ITEMS ITERATE JOIN KEY KEYS LAG LANGUAGE LARGE LAST LATERAL LEAD',
    'LEADING LEAVE LEFT LENGTH LESS LEVEL LIKE LIMIT LIMITED LINES LIST LOAD LOCAL LOCALTIME',
    'LOCALTIMESTAMP LOCATION LOCATOR LOCK LOCKS LOG LOGED LONG LOOP LOWER MAP MATCH MATERIALIZED MAX',
    'MAXLEN MEMBER MERGE METHOD METRICS MIN MINUS MINUTE MISSING MOD MODE MODIFIES MODIFY MODULE MONTH',
    'MULTI MULTISET NAME NAMES NATIONAL NATURAL NCHAR NCLOB NEW NEXT NO NONE NULL NULLIF NUMBER NUMERIC',
    'OBJECT OF OFFLINE OFFSET OLD ON ONLINE ONLY OPAQUE OPEN OPERATOR OPTION ORDER ORDINALITY OTHER',
    'OTHERS OUT OUTER OUTPUT OVER OVERLAPS OVERRIDE OWNER PAD PARALLEL PARAMETER PARAMETERS PARTIAL',
    'PARTITION PARTITIONED PARTITIONS PATH PERCENT PERCENTILE PERMISSION PERMISSIONS PIPE PIPELINED PLAN',
    'POOL POSITION PRECISION PREPARE PRESERVE PRIMARY PRIOR PRIVATE PRIVILEGES PROCEDURE PROCESSED',
    'PROJECT PROJECTION PROPERTY PROVISIONING PUBLIC PUT QUERY QUIT QUORUM RAISE RANDOM RANGE RANK RAW',
    'READ READS REAL REBUILD RECORD RECURSIVE REDUCE REF REFERENCE REFERENCES REFERENCING REGEXP REGION',
    'REINDEX RELATIVE RELEASE REMAINDER RENAME REPEAT REPLACE REQUEST RESET RESIGNAL RESOURCE RESPONSE',
    'RESTORE RESTRICT RESULT RETURN RETURNING RETURNS REVERSE REVOKE RIGHT ROLE ROLES ROLLBACK ROLLUP',
    'ROUTINE ROW ROWS RULE RULES SAMPLE SATISFIES SAVE SAVEPOINT SCAN SCHEMA SCOPE SCROLL SEARCH SECOND',
    'SECTION SEGMENT SEGMENTS SELECT SELF SEMI SENSITIVE SEPARATE SEQUENCE SERIALIZABLE SESSION SETS',
    'SHARD SHARE SHARED SHORT SHOW SIGNAL SIMILAR SKEWED SMALLINT SNAPSHOT SOME SOURCE SPACE SPACES',
    'SPARSE SPECIFIC SPECIFICTYPE SPLIT SQL SQLCODE SQLERROR SQLEXCEPTION SQLSTATE SQLWARNING START STATE',
    'STATIC STATUS STORAGE STORE STORED STREAM STRING STRUCT STYLE SUB SUBMULTISET SUBPARTITION SUBSTRING',
    'SUBTYPE SUM SUPER SYMMETRIC SYNONYM SYSTEM TABLE TABLESAMPLE TEMP TEMPORARY TERMINATED TEXT THAN',
    'THEN THROUGHPUT TIME TIMESTAMP TIMEZONE TINYINT TO TOKEN TOTAL TOUCH TRAILING TRANSACTION TRANSFORM',
    'TRANSLATE TRANSLATION TREAT TRIGGER TRIM TRUE TRUNCATE TTL TUPLE TYPE UNDER UNDO UNION UNIQUE UNIT',
    'UNKNOWN UNLOGGED UNNEST UNPROCESSED UNSIGNED UNTIL UPDATE UPPER URL USAGE USE USER USERS USING UUID',
    'VACUUM VALUE VALUED VALUES VARCHAR VARIABLE VARIANCE VARINT VARYING VIEW VIEWS VIRTUAL VOID WAIT',
    'WHEN WHENEVER WHERE WHILE WINDOW WITH WITHIN WITHOUT WORK WRAPPED WRITE YEAR ZONE'
  ].join(' ').split(' '));
  const KEYWORDS = new Set(['AND', 'OR', 'NOT', 'BETWEEN', 'IN', 'SET', 'REMOVE', 'ADD', 'DELETE']);

  function isReserved(word) { return RESERVED.has(String(word).toUpperCase()); }

  // ---- Errors ----

  // What DynamoDB answers instead of running a request. type is the
  // exception name (ValidationException, ConditionalCheckFailedException),
  // message its text, code a short name for the kind of problem, and where
  // the expression and the place in it, when the problem has one.
  class DynamoError extends Error {
    constructor(type, message, info) {
      super(message);
      this.name = 'DynamoError';
      this.type = type;
      this.code = (info && info.code) || 'invalid';
      if (info) for (const k of Object.keys(info)) if (k !== 'code') this[k] = info[k];
    }
  }
  function invalid(message, info) { return new DynamoError('ValidationException', message, info); }

  // A problem with the input that DynamoDB itself would not get as far as
  // checking, such as JSON that does not parse. Not a DynamoDB answer.
  class InputError extends Error {
    constructor(message) { super(message); this.name = 'InputError'; }
  }

  // ---- Numbers ----

  // DynamoDB numbers are exact decimals of up to 38 significant digits. A
  // number is kept as sign, coefficient and exponent: sign × coef × 10^exp.
  // keep is the count of zeros after the point that a zero result of
  // arithmetic keeps, since DynamoDB prints 1E-130 - 1E-130 as 0.000…0.
  function makeNum(sign, coef, exp, keep) {
    if (coef === 0n) return { sign: 0, coef: 0n, exp: 0, keep: keep > 0 ? keep : 0 };
    while (coef % 10n === 0n) { coef /= 10n; exp++; }
    return { sign: sign, coef: coef, exp: exp, keep: 0 };
  }

  // The value of a Unicode decimal digit, as Java's Character.digit gives it:
  // DynamoDB accepts any script's digits, so "١" (Arabic-Indic one) is 1.
  function digitValue(ch) {
    const cp = ch.codePointAt(0);
    if (cp >= 48 && cp <= 57) return cp - 48;
    if (!/^\p{Nd}$/u.test(ch)) return -1;
    let start = cp;
    while (start > 0 && /^\p{Nd}$/u.test(String.fromCodePoint(start - 1))) start--;
    return (cp - start) % 10;
  }

  const NUM_ERRORS = {
    convert: 'A value provided cannot be converted into a number',
    precision: 'DynamoDB only supports precision up to 38 digits',
    overflow: 'Number overflow. Attempting to store a number with magnitude larger than supported range',
    underflow: 'Number underflow. Attempting to store a number with magnitude smaller than supported range'
  };

  // Reads a number the way Java's BigDecimal does: an optional sign, digits
  // with an optional point, and an optional exponent. Returns a number or
  // the name of what is wrong.
  function readNumber(text) {
    const s = String(text);
    const chars = Array.from(s);
    let i = 0, sign = 1;
    if (chars[0] === '+' || chars[0] === '-') { if (chars[0] === '-') sign = -1; i++; }
    let digits = '', frac = 0, seenPoint = false, any = false;
    for (; i < chars.length; i++) {
      const c = chars[i];
      if (c === '.') { if (seenPoint) return 'convert'; seenPoint = true; continue; }
      if (c === 'e' || c === 'E') break;
      const d = digitValue(c);
      if (d < 0) return 'convert';
      digits += d; any = true;
      if (seenPoint) frac++;
    }
    if (!any) return 'convert';
    let exp = 0;
    if (i < chars.length) {
      i++;
      let esign = 1, edigits = '';
      if (chars[i] === '+' || chars[i] === '-') { if (chars[i] === '-') esign = -1; i++; }
      for (; i < chars.length; i++) {
        const d = digitValue(chars[i]);
        if (d < 0) return 'convert';
        edigits += d;
      }
      if (!edigits) return 'convert';
      const e = Number(edigits.replace(/^0+(?=\d)/, ''));
      if (edigits.replace(/^0+/, '').length > 10 || e > 2147483647) return 'convert';
      exp = esign * e;
    }
    const scale = frac - exp;
    if (scale > 2147483647 || scale < -2147483648) return 'convert';
    return makeNum(sign, BigInt(digits), exp - frac, 0);
  }

  function digitCount(n) { return n.coef === 0n ? 1 : n.coef.toString().length; }

  // The checks DynamoDB makes on every number it keeps, in its order.
  function numberProblem(n) {
    if (n.sign === 0) return null;
    if (digitCount(n) > 38) return 'precision';
    const top = n.exp + digitCount(n) - 1;
    if (top >= 126) return 'overflow';
    if (top < -130) return 'underflow';
    return null;
  }

  function parseNumber(text) {
    const n = readNumber(text);
    if (typeof n === 'string') return n;
    return numberProblem(n) || n;
  }

  // Plain digits, never an exponent, as DynamoDB writes numbers.
  function numberText(n) {
    if (n.sign === 0) return n.keep > 0 ? '0.' + '0'.repeat(n.keep) : '0';
    const d = n.coef.toString();
    let out;
    if (n.exp >= 0) out = d + '0'.repeat(n.exp);
    else {
      const point = d.length + n.exp;
      out = point > 0 ? d.slice(0, point) + '.' + d.slice(point) : '0.' + '0'.repeat(-point) + d;
    }
    return (n.sign < 0 ? '-' : '') + out;
  }

  function align(a, b) {
    const e = Math.min(a.exp, b.exp);
    return [BigInt(a.sign) * a.coef * 10n ** BigInt(a.exp - e), BigInt(b.sign) * b.coef * 10n ** BigInt(b.exp - e), e];
  }
  function compareNumbers(a, b) {
    if (a.sign !== b.sign || a.sign === 0) return a.sign < b.sign ? -1 : a.sign > b.sign ? 1 : 0;
    const [x, y] = align(a, b);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  // The digits after the point a number was written with, for a zero result.
  function scaleOf(n) { return n.sign === 0 ? n.keep : -n.exp; }
  function addNumbers(a, b, subtract) {
    const bb = subtract ? { sign: -b.sign, coef: b.coef, exp: b.exp, keep: b.keep } : b;
    const e = Math.min(a.sign === 0 ? 0 : a.exp, bb.sign === 0 ? 0 : bb.exp);
    const xa = a.sign === 0 ? 0n : BigInt(a.sign) * a.coef * 10n ** BigInt(a.exp - e);
    const xb = bb.sign === 0 ? 0n : BigInt(bb.sign) * bb.coef * 10n ** BigInt(bb.exp - e);
    const sum = xa + xb;
    if (sum === 0n) return makeNum(0, 0n, 0, Math.max(scaleOf(a), scaleOf(b)));
    return makeNum(sum < 0n ? -1 : 1, sum < 0n ? -sum : sum, e, 0);
  }

  // ---- JSON that keeps every digit of its numbers ----

  class JsonNumber {
    constructor(text) { this.text = text; }
    toString() { return this.text; }
  }

  function parseJson(text) {
    let i = 0;
    const s = String(text);
    function fail(msg) {
      const before = s.slice(0, i);
      const line = before.split('\n').length;
      const col = i - before.lastIndexOf('\n');
      throw new InputError(msg + ' at line ' + line + ', column ' + col);
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
      return new JsonNumber(m[0]);
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
      const out = new Map();
      ws();
      if (s[i] === '}') { i++; return out; }
      while (true) {
        ws();
        if (s[i] !== '"') fail('Expected a name in quotes');
        const k = string();
        ws();
        if (s[i] !== ':') fail('Expected : after a name');
        i++;
        out.set(k, value());
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

  // Several items: a JSON list, JSON Lines (one item per line), or items one
  // after another. Returns parsed JSON values.
  function parseJsonItems(text) {
    const t = String(text).trim();
    if (!t) return [];
    if (t[0] === '[') {
      const v = parseJson(t);
      if (Array.isArray(v)) return v;
    }
    try { return [parseJson(t)]; }
    catch (e) {
      const out = [];
      const lines = t.split('\n');
      for (let n = 0; n < lines.length; n++) {
        const line = lines[n].trim().replace(/,$/, '');
        if (!line) continue;
        try { out.push(parseJson(line)); }
        catch (e2) { throw new InputError('Item on line ' + (n + 1) + ': ' + e2.message.replace(/ at line \d+,/, ' at')); }
      }
      return out;
    }
  }

  // ---- Attribute values ----

  // Inside the tester a value is { t: type, v: contents }: S text, N number,
  // B bytes, BOOL, NULL, L list, M Map of name to value, SS/NS/BS lists.
  const TYPES = ['S', 'N', 'B', 'SS', 'NS', 'BS', 'M', 'L', 'NULL', 'BOOL'];
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  function fromBase64(text) {
    const s = String(text).replace(/[\s]/g, '');
    if (s.length % 4 === 1 || /[^A-Za-z0-9+/=]/.test(s) || /=[^=]/.test(s)) return null;
    const out = [];
    let buf = 0, bits = 0;
    for (const c of s) {
      if (c === '=') break;
      buf = (buf << 6) | B64.indexOf(c); bits += 6;
      if (bits >= 8) { bits -= 8; out.push((buf >> bits) & 0xff); }
    }
    return Uint8Array.from(out);
  }
  function toBase64(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
      out += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4 || 0)];
      out += b === undefined ? '=' : B64[((b & 15) << 2) | (c >> 6 || 0)];
      out += c === undefined ? '=' : B64[c & 63];
    }
    return out;
  }
  const utf8 = new TextEncoder();
  function utf8Bytes(s) { return utf8.encode(s); }

  // A problem with one value, worded as DynamoDB words it.
  class ValueProblem extends Error {}
  const typeOfJson = (v) => v === null ? 'null' : Array.isArray(v) ? 'list' : v instanceof Map ? 'object' : v instanceof JsonNumber ? 'number' : typeof v;

  // Typed JSON ({"S": "Ana"}) to a value, with DynamoDB's checks. The JSON
  // types DynamoDB's own parser accepts in place of strings ({"N": 5},
  // {"BOOL": "true"}) are accepted too.
  function fromTyped(json) {
    if (json === null) throw new ValueProblem('The supplied Item contains a null AttributeValue');
    if (!(json instanceof Map)) throw new InputError('Expected a typed value such as {"S": "text"}, found ' + typeOfJson(json));
    const keys = [...json.keys()].filter((k) => TYPES.includes(k) && json.get(k) !== null);
    if (keys.length === 0) throw new ValueProblem('Supplied AttributeValue is empty, must contain exactly one of the supported datatypes');
    if (keys.length > 1) throw new ValueProblem('Supplied AttributeValue has more than one datatypes set, must contain exactly one of the supported datatypes');
    const t = keys[0];
    const v = json.get(t);
    const text = (x) => {
      if (typeof x === 'string') return x;
      if (x instanceof JsonNumber) return x.text;
      if (typeof x === 'boolean') return String(x);
      throw new InputError('A ' + t + ' value must be written as a string, found ' + typeOfJson(x));
    };
    const num = (x) => {
      const n = parseNumber(text(x));
      if (typeof n === 'string') throw new ValueProblem(NUM_ERRORS[n]);
      return n;
    };
    const bytes = (x) => {
      const b = fromBase64(text(x));
      if (!b) throw new InputError('A B value must be base64 text');
      return b;
    };
    const bool = (x) => {
      if (typeof x === 'boolean') return x;
      if (typeof x === 'string' && /^(true|false)$/i.test(x)) return x.toLowerCase() === 'true';
      throw new InputError('A ' + t + ' value must be true or false');
    };
    switch (t) {
      case 'S': return { t: 'S', v: text(v) };
      case 'N': return { t: 'N', v: num(v), text: text(v) };
      case 'B': return { t: 'B', v: bytes(v) };
      case 'BOOL': return { t: 'BOOL', v: bool(v) };
      case 'NULL':
        if (!bool(v)) throw new ValueProblem('One or more parameter values were invalid: Null attribute value types must have the value of true');
        return { t: 'NULL', v: true };
      case 'L':
        if (!Array.isArray(v)) throw new InputError('An L value must be a list');
        return { t: 'L', v: v.map(fromTyped) };
      case 'M': {
        if (!(v instanceof Map)) throw new InputError('An M value must be an object');
        const m = new Map();
        for (const [k, x] of v) m.set(k, fromTyped(x));
        return { t: 'M', v: m };
      }
      case 'SS': case 'NS': case 'BS': {
        if (!Array.isArray(v)) throw new InputError('A ' + t + ' value must be a list');
        if (v.length === 0) {
          throw new ValueProblem('One or more parameter values were invalid: ' + (t === 'SS' ? 'An string set  may not be empty'
            : t === 'NS' ? 'An number set  may not be empty' : 'Binary sets should not be empty'));
        }
        if (t === 'SS') {
          const list = v.map(text);
          if (new Set(list).size !== list.length) throw new ValueProblem('One or more parameter values were invalid: Input collection [' + list.join(', ') + '] contains duplicates');
          return { t: 'SS', v: list };
        }
        if (t === 'NS') {
          const list = v.map(num);
          if (new Set(list.map(numberText)).size !== list.length) throw new ValueProblem('Input collection contains duplicates');
          return { t: 'NS', v: list };
        }
        const list = v.map(bytes);
        if (new Set(list.map(toBase64)).size !== list.length) throw new ValueProblem('One or more parameter values were invalid: Input collection of type BS contains duplicates.');
        return { t: 'BS', v: list };
      }
    }
  }

  // Plain JSON to a value, the way the DynamoDB document clients convert it:
  // text to S, numbers to N, true/false to BOOL, null to NULL, lists to L and
  // objects to M.
  function fromPlain(json) {
    if (json === null) return { t: 'NULL', v: true };
    if (typeof json === 'boolean') return { t: 'BOOL', v: json };
    if (typeof json === 'string') return { t: 'S', v: json };
    if (json instanceof JsonNumber) {
      const n = parseNumber(json.text);
      if (typeof n === 'string') throw new ValueProblem(NUM_ERRORS[n]);
      return { t: 'N', v: n };
    }
    if (Array.isArray(json)) return { t: 'L', v: json.map(fromPlain) };
    if (json instanceof Map) {
      const m = new Map();
      for (const [k, x] of json) m.set(k, fromPlain(x));
      return { t: 'M', v: m };
    }
    throw new InputError('This value cannot be stored');
  }

  function isTypedJson(json) {
    if (!(json instanceof Map) || json.size !== 1) return false;
    const [k, v] = [...json][0];
    if (!TYPES.includes(k)) return false;
    if (k === 'L' || k === 'SS' || k === 'NS' || k === 'BS') return Array.isArray(v);
    if (k === 'M') return v instanceof Map;
    if (k === 'BOOL' || k === 'NULL') return typeof v === 'boolean';
    return typeof v === 'string' || v instanceof JsonNumber;
  }
  // An item or a map of values is typed when every member is a typed value.
  function looksTyped(map) {
    if (!(map instanceof Map) || map.size === 0) return false;
    for (const v of map.values()) if (!isTypedJson(v)) return false;
    return true;
  }

  // A value back to typed JSON, ready for JSON.stringify.
  function toTyped(av) {
    switch (av.t) {
      case 'S': return { S: av.v };
      case 'N': return { N: numberText(av.v) };
      case 'B': return { B: toBase64(av.v) };
      case 'BOOL': return { BOOL: av.v };
      case 'NULL': return { NULL: true };
      case 'L': return { L: av.v.map(toTyped) };
      case 'M': { const o = {}; for (const [k, x] of av.v) o[k] = toTyped(x); return { M: o }; }
      case 'SS': return { SS: av.v.slice() };
      case 'NS': return { NS: av.v.map(numberText) };
      case 'BS': return { BS: av.v.map(toBase64) };
    }
  }
  function itemToTyped(item) {
    const o = {};
    for (const [k, v] of item) o[k] = toTyped(v);
    return o;
  }
  // A value as plain JSON text, for showing to people.
  function toPlainText(av) {
    switch (av.t) {
      case 'S': return JSON.stringify(av.v);
      case 'N': return numberText(av.v);
      case 'B': return 'b64:' + toBase64(av.v);
      case 'BOOL': return String(av.v);
      case 'NULL': return 'null';
      case 'L': return '[' + av.v.map(toPlainText).join(', ') + ']';
      case 'M': return '{' + [...av.v].map(([k, x]) => JSON.stringify(k) + ': ' + toPlainText(x)).join(', ') + '}';
      case 'SS': return '<<' + av.v.map((x) => JSON.stringify(x)).join(', ') + '>>';
      case 'NS': return '<<' + av.v.map(numberText).join(', ') + '>>';
      case 'BS': return '<<' + av.v.map((x) => 'b64:' + toBase64(x)).join(', ') + '>>';
    }
  }

  function compareBytes(a, b) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return a.length - b.length;
  }
  // Strings compare by their UTF-8 bytes, so "¿" (C2 BF) sorts after "z".
  function compareStrings(a, b) { return compareBytes(utf8Bytes(a), utf8Bytes(b)); }

  function sameValue(a, b) {
    if (a.t !== b.t) return false;
    switch (a.t) {
      case 'S': return a.v === b.v;
      case 'N': return compareNumbers(a.v, b.v) === 0;
      case 'B': return compareBytes(a.v, b.v) === 0;
      case 'BOOL': return a.v === b.v;
      case 'NULL': return true;
      case 'L': return a.v.length === b.v.length && a.v.every((x, i) => sameValue(x, b.v[i]));
      case 'M':
        if (a.v.size !== b.v.size) return false;
        for (const [k, x] of a.v) { const y = b.v.get(k); if (!y || !sameValue(x, y)) return false; }
        return true;
      case 'SS': return a.v.length === b.v.length && a.v.every((x) => b.v.includes(x));
      case 'NS': return a.v.length === b.v.length && a.v.every((x) => b.v.some((y) => compareNumbers(x, y) === 0));
      case 'BS': return a.v.length === b.v.length && a.v.every((x) => b.v.some((y) => compareBytes(x, y) === 0));
    }
    return false;
  }
  // -1, 0 or 1 for two values of the same scalar type; null when they can't be ordered.
  function order(a, b) {
    if (a.t !== b.t) return null;
    if (a.t === 'S') { const c = compareStrings(a.v, b.v); return c < 0 ? -1 : c > 0 ? 1 : 0; }
    if (a.t === 'N') return compareNumbers(a.v, b.v);
    if (a.t === 'B') { const c = compareBytes(a.v, b.v); return c < 0 ? -1 : c > 0 ? 1 : 0; }
    return null;
  }
  function cloneValue(av) {
    switch (av.t) {
      case 'L': return { t: 'L', v: av.v.map(cloneValue) };
      case 'M': { const m = new Map(); for (const [k, x] of av.v) m.set(k, cloneValue(x)); return { t: 'M', v: m }; }
      case 'SS': case 'NS': case 'BS': return { t: av.t, v: av.v.slice() };
      default: return av;
    }
  }
  function cloneItem(item) { const m = new Map(); for (const [k, v] of item) m.set(k, cloneValue(v)); return m; }

  // ---- Java's hash order ----

  // Where DynamoDB lists several keys in one message (unused placeholders),
  // it lists them in the order of a Java HashSet. These give that order.
  function javaHash(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
    return h;
  }
  // total: how many keys the set was made from, which sets its size.
  function javaSetOrder(keys, total) {
    let cap = 1;
    const want = Math.max(Math.floor((total === undefined ? keys.length : total) / 0.75) + 1, 16);
    while (cap < want) cap *= 2;
    const slot = (k) => { const h = javaHash(k); return ((h ^ (h >>> 16)) & (cap - 1)) >>> 0; };
    return keys.map((k, i) => [slot(k), i, k]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((x) => x[2]);
  }

  // ---- Reading expressions ----

  // Tokens: id (a name), name (#placeholder), value (:placeholder), int (a
  // list index), the keywords, operators and punctuation, bad (a character
  // DynamoDB does not accept) and EOF.
  function tokenize(text) {
    const toks = [];
    const s = text;
    let i = 0;
    const isLetter = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
    const isWord = (c) => isLetter(c) || (c >= '0' && c <= '9') || c === '_';
    while (i < s.length) {
      const c = s[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
      const start = i;
      let t;
      if (isLetter(c)) {
        while (i < s.length && isWord(s[i])) i++;
        const w = s.slice(start, i);
        t = KEYWORDS.has(w.toUpperCase()) ? w.toUpperCase() : 'id';
      } else if (c === '#' || c === ':') {
        i++;
        while (i < s.length && isWord(s[i])) i++;
        t = i === start + 1 ? 'bad' : (c === '#' ? 'name' : 'value');
      } else if (c >= '0' && c <= '9') {
        i++;
        if (c !== '0') while (i < s.length && s[i] >= '0' && s[i] <= '9') i++;
        t = 'int';
      } else if (c === '<' && s[i + 1] === '>') { i += 2; t = '<>'; }
      else if (c === '<' && s[i + 1] === '=') { i += 2; t = '<='; }
      else if (c === '>' && s[i + 1] === '=') { i += 2; t = '>='; }
      else if ('=<>()[],.+-'.includes(c)) { i++; t = c; }
      else { i++; t = 'bad'; }
      toks.push({ t: t, text: s.slice(start, i), start: start, end: i, n: toks.length });
    }
    toks.push({ t: 'EOF', text: '<EOF>', start: s.length, end: s.length, n: toks.length });
    return toks;
  }

  const COMPARATORS = new Set(['=', '<>', '<', '<=', '>', '>=']);

  // A syntax error, reported the way DynamoDB reports it: the token where
  // reading stopped, and the text from the token before it to the one after.
  class SyntaxProblem extends Error {
    constructor(tokens, at, text) {
      const tok = tokens[at];
      const from = at > 0 ? tokens[at - 1].start : 0;
      const to = at + 1 < tokens.length ? tokens[at + 1].end : tok.end;
      super('Syntax error; token: "' + tok.text + '", near: "' + text.slice(from, to) + '"');
      this.at = at;
      this.start = tok.start;
      this.end = Math.max(tok.end, tok.start + 1);
    }
  }

  class RedundantParens extends Error {
    constructor(node) { super('The expression has redundant parentheses;'); this.node = node; }
  }

  function Parser(text) {
    this.text = text;
    this.toks = tokenize(text);
    this.i = 0;
  }
  Parser.prototype = {
    peek(k) { return this.toks[Math.min(this.i + (k || 0), this.toks.length - 1)]; },
    next() { return this.toks[this.i++]; },
    is(t) { return this.peek().t === t; },
    fail(at) { throw new SyntaxProblem(this.toks, at === undefined ? this.i : at, this.text); },
    expect(t) { if (!this.is(t)) this.fail(); return this.next(); },
    end() { if (!this.is('EOF')) this.fail(); },

    // Tries the alternatives in order; keeps the first that reads, or throws
    // the error of the one that read furthest, as DynamoDB's parser does.
    choose(alts) {
      const at = this.i;
      let best = null;
      for (const alt of alts) {
        this.i = at;
        try { return alt.call(this); }
        catch (e) {
          if (!(e instanceof SyntaxProblem)) throw e;
          if (!best || e.at > best.at) best = e;
        }
      }
      this.i = at;
      throw best;
    },

    // ---- conditions ----
    condition() {
      let left = this.andCond();
      while (this.is('OR')) {
        const tok = this.next();
        const right = this.andCond();
        left = { k: 'or', a: left, b: right, tok: tok, start: left.start, end: right.end };
      }
      return left;
    },
    andCond() {
      let left = this.notCond();
      while (this.is('AND')) {
        const tok = this.next();
        const right = this.notCond();
        left = { k: 'and', a: left, b: right, tok: tok, start: left.start, end: right.end };
      }
      return left;
    },
    notCond() {
      if (this.is('NOT')) {
        const tok = this.next();
        const a = this.notCond();
        return { k: 'not', a: a, tok: tok, start: tok.start, end: a.end };
      }
      return this.primary();
    },
    primary() {
      if (this.is('(')) {
        return this.choose([
          function () {
            const open = this.next();
            const inner = this.condition();
            const close = this.expect(')');
            return this.paren(open, inner, close, true);
          },
          function () { return this.comparison(); }
        ]);
      }
      return this.comparison();
    },
    // operand comparator operand | operand BETWEEN operand AND operand |
    // operand IN (operand, ...) | function
    comparison() {
      const a = this.operand();
      const tok = this.peek();
      if (COMPARATORS.has(tok.t)) {
        this.next();
        const b = this.operand();
        return { k: 'cmp', op: tok.t, a: a, b: b, tok: tok, start: a.start, end: b.end };
      }
      if (tok.t === 'BETWEEN') {
        this.next();
        const lo = this.operand();
        this.expect('AND');
        const hi = this.operand();
        return { k: 'between', a: a, lo: lo, hi: hi, tok: tok, start: a.start, end: hi.end };
      }
      if (tok.t === 'IN') {
        this.next();
        this.expect('(');
        const list = [this.operand()];
        while (this.is(',')) { this.next(); list.push(this.operand()); }
        const close = this.expect(')');
        return { k: 'in', a: a, list: list, tok: tok, start: a.start, end: close.end };
      }
      if (a.k === 'call') { a.asCondition = true; return a; }
      this.fail();
    },
    operand() {
      const tok = this.peek();
      if (tok.t === 'value') { this.next(); return { k: 'value', name: tok.text, tok: tok, start: tok.start, end: tok.end }; }
      if (tok.t === '(') {
        const open = this.next();
        const inner = this.operand();
        const close = this.expect(')');
        return this.paren(open, inner, close, false);
      }
      if (tok.t === 'id' && this.peek(1).t === '(') return this.call();
      if (tok.t === 'id' || tok.t === 'name') return this.path();
      this.fail();
    },
    // DynamoDB refuses two parentheses straight around the same thing, and
    // says so as soon as it reads the outer one, before any later syntax error.
    paren(open, inner, close, cond) {
      const node = { k: 'paren', inner: inner, start: open.start, end: close.end, cond: cond };
      if (inner.k === 'paren') throw new RedundantParens(node);
      return node;
    },
    call() {
      const nameTok = this.next();
      this.expect('(');
      const args = [this.operand()];
      while (this.is(',')) { this.next(); args.push(this.operand()); }
      const close = this.expect(')');
      return { k: 'call', name: nameTok.text, args: args, tok: nameTok, start: nameTok.start, end: close.end };
    },
    // A document path: a name, then .name or [index] steps.
    path() {
      const first = this.peek();
      if (first.t !== 'id' && first.t !== 'name') this.fail();
      this.next();
      const parts = [{ name: first.text, ph: first.t === 'name', tok: first }];
      let end = first.end;
      while (this.is('.') || this.is('[')) {
        if (this.next().t === '.') {
          // DynamoDB's grammar also takes a :value after a dot, then fails
          // with an internal error when it runs it.
          const t = this.peek();
          if (t.t !== 'id' && t.t !== 'name' && t.t !== 'value') this.fail();
          this.next();
          parts.push({ name: t.text, ph: t.t === 'name', val: t.t === 'value', tok: t });
          end = t.end;
        } else {
          const t = this.expect('int');
          const close = this.expect(']');
          parts.push({ index: t.text, tok: t });
          end = close.end;
        }
      }
      return { k: 'path', parts: parts, start: first.start, end: end };
    },

    // ---- updates ----
    update() {
      const clauses = [];
      do {
        const kw = this.peek();
        if (kw.t === 'SET') {
          this.next();
          const actions = [this.setAction()];
          while (this.is(',')) { this.next(); actions.push(this.setAction()); }
          clauses.push({ kw: 'SET', tok: kw, actions: actions });
        } else if (kw.t === 'REMOVE') {
          this.next();
          const actions = [{ path: this.path() }];
          while (this.is(',')) { this.next(); actions.push({ path: this.path() }); }
          clauses.push({ kw: 'REMOVE', tok: kw, actions: actions });
        } else if (kw.t === 'ADD' || kw.t === 'DELETE') {
          this.next();
          const action = () => {
            const p = this.path();
            const v = this.expect('value');
            return { path: p, value: { k: 'value', name: v.text, tok: v, start: v.start, end: v.end } };
          };
          const actions = [action()];
          while (this.is(',')) { this.next(); actions.push(action()); }
          clauses.push({ kw: kw.t, tok: kw, actions: actions });
        } else this.fail();
      } while (!this.is('EOF'));
      return { k: 'update', clauses: clauses, start: 0, end: this.text.length };
    },
    setAction() {
      const path = this.path();
      this.expect('=');
      const a = this.operand();
      if (this.is('+') || this.is('-')) {
        const tok = this.next();
        const b = this.operand();
        return { path: path, value: { k: 'arith', op: tok.t, a: a, b: b, tok: tok, start: a.start, end: b.end } };
      }
      return { path: path, value: a };
    },

    // ---- projections ----
    projection() {
      const paths = [this.path()];
      while (this.is(',')) { this.next(); paths.push(this.path()); }
      return { k: 'projection', paths: paths, start: 0, end: this.text.length };
    }
  };

  function parse(text, kind) {
    const p = new Parser(text);
    let ast;
    if (kind === 'update') ast = p.update();
    else if (kind === 'projection') ast = p.projection();
    else ast = p.condition();
    p.end();
    return ast;
  }

  // ---- Checking expressions ----

  const EXPRESSIONS = {
    key: 'KeyConditionExpression', filter: 'FilterExpression', condition: 'ConditionExpression',
    update: 'UpdateExpression', projection: 'ProjectionExpression'
  };
  const CONDITION_FUNCTIONS = { attribute_exists: 1, attribute_not_exists: 1, attribute_type: 2, begins_with: 2, contains: 2 };
  const OPERAND_FUNCTIONS = { size: 1 };
  const UPDATE_FUNCTIONS = { if_not_exists: 2, list_append: 2 };
  const ALL_FUNCTIONS = Object.assign({}, CONDITION_FUNCTIONS, OPERAND_FUNCTIONS, UPDATE_FUNCTIONS);
  const TYPE_NAMES = '{N,BS,L,B,NULL,M,S,SS,NS,BOOL}';
  const ANY_TYPE = '{SS,M,DECIMAL,DOUBLESET,HDS,N,B,DICT,INTSET,BOOL,HD,BS,INT,DECIMALSET,NULL,FLOAT,FS,S,L,NS,DOUBLE}';
  const LONG_TYPE = { S: 'STRING', N: 'NUMBER', B: 'BINARY', BOOL: 'BOOLEAN', NULL: 'NULL', L: 'LIST', M: 'MAP', SS: 'STRING_SET', NS: 'NUMBER_SET', BS: 'BINARY_SET' };

  // Children of a node in the order DynamoDB visits them.
  function children(n) {
    switch (n.k) {
      case 'or': case 'and': return [n.a, n.b];
      case 'not': return [n.a];
      case 'paren': return [n.inner];
      case 'cmp': return [n.a, n.b];
      case 'between': return [n.a, n.lo, n.hi];
      case 'in': return [n.a].concat(n.list);
      case 'call': return n.args;
      case 'arith': return [n.a, n.b];
      case 'update': {
        const out = [];
        for (const c of n.clauses) for (const a of c.actions) { out.push(a.path); if (a.value) out.push(a.value); }
        return out;
      }
      case 'projection': return n.paths;
    }
    return [];
  }
  function walk(n, fn, ctx) {
    fn(n, ctx);
    for (const c of children(n)) walk(c, fn, n);
  }
  function unwrap(n) { while (n && n.k === 'paren') n = n.inner; return n; }

  // Where in the expression a problem is, for showing it.
  function at(node) { return node ? { start: node.start, end: node.end } : {}; }

  // The static type of an operand: a value's type, N for size(), null for a
  // document path, whose type depends on the item.
  function staticType(n, values) {
    n = unwrap(n);
    if (n.k === 'value') { const v = values.get(n.name); return v ? v.t : null; }
    if (n.k === 'call' && n.name === 'size') return 'N';
    return null;
  }
  function pathKey(p, names) {
    return p.parts.map((x) => x.index !== undefined ? '[' + x.index + ']' : (x.ph ? (names.has(x.name) ? names.get(x.name) : x.name) : x.name));
  }
  function samePath(a, b, names) {
    a = unwrap(a); b = unwrap(b);
    if (a.k !== 'path' || b.k !== 'path') return false;
    return pathKey(a, names).join('\u0000') === pathKey(b, names).join('\u0000');
  }
  function pathText(p, names) { return '[' + pathKey(p, names).join(', ') + ']'; }
  function boundText(av) {
    if (av.t === 'S') return 'AttributeValue: {S:' + av.v + '}';
    if (av.t === 'N') return 'AttributeValue: {N:' + (av.text !== undefined ? av.text : numberText(av.v)) + '}';
    if (av.t === 'B') return 'AttributeValue: {B:java.nio.HeapByteBuffer[pos=0 lim=' + av.v.length + ' cap=' + av.v.length + ']}';
    return 'AttributeValue: {' + av.t + ':' + toPlainText(av) + '}';
  }

  // The checks on one parsed expression, in DynamoDB's order. Each pass walks
  // the whole expression and stops at the first problem.
  function checkExpression(ast, kind, ctx) {
    const label = EXPRESSIONS[kind];
    const err = (message, node, code) => invalid('Invalid ' + label + ': ' + message, Object.assign({ code: code, expression: label }, at(node)));
    const inUpdate = kind === 'update';

    // Pass 1, in the order the expression is written: reserved words, list
    // indexes, function names and where each function is used.
    const checkArity = (n) => {
      if (n.args.length !== ALL_FUNCTIONS[n.name]) {
        throw err('Incorrect number of operands for operator or function; operator or function: ' + n.name + ', number of operands: ' + n.args.length, n.tok, 'function-operands');
      }
    };
    const visit1 = (n, place) => {
      // place: 'condition' where a condition is expected, 'operand' inside one.
      if (n.k === 'path') {
        for (const part of n.parts) {
          if (part.index !== undefined) {
            if (part.index.length > 10 || Number(part.index) > 2147483647) {
              throw err('List index is not within the allowable range; index: [' + part.index + ']', part.tok, 'index-range');
            }
          } else if (!part.ph && !part.val && isReserved(part.name)) {
            throw err('Attribute name is a reserved keyword; reserved keyword: ' + part.name, part.tok, 'reserved-word');
          }
        }
        return;
      }
      if (n.k === 'call') {
        if (!Object.prototype.hasOwnProperty.call(ALL_FUNCTIONS, n.name)) throw err('Invalid function name; function: ' + n.name, n.tok, 'function-name');
        if (inUpdate) {
          if (!UPDATE_FUNCTIONS[n.name]) throw err('The function is not allowed in an update expression; function: ' + n.name, n.tok, 'function-place');
        } else {
          if (UPDATE_FUNCTIONS[n.name]) throw err('The function is not allowed in a condition expression; function: ' + n.name, n.tok, 'function-place');
          const wantCondition = place === 'condition';
          if (wantCondition !== Boolean(CONDITION_FUNCTIONS[n.name])) throw err('The function is not allowed to be used this way in an expression; function: ' + n.name, n.tok, 'function-place');
        }
        // An update's functions are counted later, with the placeholders.
        if (!inUpdate) checkArity(n);
        for (const a of n.args) visit1(a, 'operand');
        return;
      }
      if (n.k === 'paren') return visit1(n.inner, place);
      if (n.k === 'or' || n.k === 'and' || n.k === 'not') { for (const c of children(n)) visit1(c, 'condition'); return; }
      for (const c of children(n)) visit1(c, 'operand');
    };
    const actions = inUpdate ? ast.clauses.flatMap((c) => c.actions.map((a) => ({ kw: c.kw, a: a }))) : null;
    if (inUpdate) {
      // An update is read a section at a time, in the order the sections
      // first appear, and each of SET, REMOVE, ADD and DELETE may appear once.
      const sections = [];
      for (const c of ast.clauses) {
        let sec = sections.find((x) => x.kw === c.kw);
        if (!sec) { sec = { kw: c.kw, clauses: [] }; sections.push(sec); }
        sec.clauses.push(c);
      }
      for (const sec of sections) {
        for (const c of sec.clauses) for (const a of c.actions) { visit1(a.path, 'operand'); if (a.value) visit1(a.value, 'operand'); }
        if (sec.clauses.length > 1) throw err('The "' + sec.kw + '" section can only be used once in an update expression;', sec.clauses[1].tok, 'repeated-section');
      }
    } else if (kind === 'projection') for (const p of ast.paths) visit1(p, 'operand');
    else visit1(ast, 'condition');

    const names = ctx.names, values = ctx.values;

    // An update's paths must not overlap. DynamoDB checks this before it looks
    // at the values, reading the #names of the paths as it goes.
    if (inUpdate) {
      for (const x of actions) {
        for (const part of x.a.path.parts) {
          if (part.ph && !names.has(part.name)) throw err('An expression attribute name used in the document path is not defined; attribute name: ' + part.name, part.tok, 'undefined-name');
        }
      }
      checkOverlaps(actions.map((x) => x.a.path), names, err);
    }

    // Pass 2: placeholders, operands and their types.
    const usePath = (p) => {
      let depth = 0;
      for (const part of p.parts) {
        depth++;
        if (part.val) throw err('Internal server error', part.tok, 'value-in-path');
        if (part.ph) {
          if (!names.has(part.name)) throw err('An expression attribute name used in the document path is not defined; attribute name: ' + part.name, part.tok, 'undefined-name');
          ctx.usedNames.add(part.name);
        }
      }
      if (depth > 32) throw err('The document path has too many nesting levels; nesting levels: ' + depth, p, 'nesting');
    };
    const typeProblem = (op, type, node) => err('Incorrect operand type for operator or function; operator or function: ' + op + ', operand type: ' + type, node, 'operand-type');
    const distinct = (op, first, rest, node) => {
      if (unwrap(first).k !== 'path') return;
      for (const r of rest) {
        if (samePath(first, r, names)) {
          throw err('The first operand must be distinct from the remaining operands for this operator or function; operator: ' + op + ', first operand: ' + pathText(unwrap(first), names), node, 'same-operand');
        }
      }
    };
    const visit2 = (n) => {
      switch (n.k) {
        case 'path': usePath(n); return;
        case 'value':
          if (!values.has(n.name)) throw err('An expression attribute value used in expression is not defined; attribute value: ' + n.name, n, 'undefined-value');
          ctx.usedValues.add(n.name);
          return;
        case 'paren': visit2(n.inner); return;
        case 'or': case 'and': case 'not': for (const c of children(n)) visit2(c); return;
        case 'cmp': {
          visit2(n.a); visit2(n.b);
          distinct(n.op, n.a, [n.b], n);
          if (n.op !== '=' && n.op !== '<>') {
            for (const o of [n.a, n.b]) {
              const t = staticType(o, values);
              if (t && t !== 'S' && t !== 'N' && t !== 'B') throw typeProblem(n.op, t, o);
            }
          }
          return;
        }
        case 'between': {
          visit2(n.a); visit2(n.lo); visit2(n.hi);
          distinct('BETWEEN', n.a, [n.lo, n.hi], n);
          for (const o of [n.a, n.lo, n.hi]) {
            const t = staticType(o, values);
            if (t && t !== 'S' && t !== 'N' && t !== 'B') throw typeProblem('BETWEEN', t, o);
          }
          const lo = unwrap(n.lo), hi = unwrap(n.hi);
          if (lo.k === 'value' && hi.k === 'value') {
            const a = values.get(lo.name), b = values.get(hi.name);
            if (a.t !== b.t) throw err('The BETWEEN operator requires same data type for lower and upper bounds; lower bound operand: ' + boundText(a) + ', upper bound operand: ' + boundText(b), n, 'between-bounds');
            if (order(a, b) > 0) throw err('The BETWEEN operator requires upper bound to be greater than or equal to lower bound; lower bound operand: ' + boundText(a) + ', upper bound operand: ' + boundText(b), n, 'between-bounds');
          }
          return;
        }
        case 'in':
          visit2(n.a);
          for (const o of n.list) visit2(o);
          if (n.list.length > 100) throw err('The IN operator is provided with too many operands; number of operands: ' + n.list.length, n, 'in-operands');
          distinct('IN', n.a, n.list, n);
          return;
        case 'call': {
          if (inUpdate) checkArity(n);
          for (const a of n.args) visit2(a);
          const first = unwrap(n.args[0]);
          const needsPath = n.name === 'attribute_exists' || n.name === 'attribute_not_exists' || n.name === 'attribute_type' || n.name === 'if_not_exists';
          if (needsPath && first.k !== 'path') throw err('Operator or function requires a document path; operator or function: ' + n.name, n, 'needs-path');
          if (n.name !== 'size' && n.name !== 'list_append') distinct(n.name, n.args[0], n.args.slice(1), n);
          if (n.name === 'size') {
            const t = staticType(n.args[0], values);
            if (t && !['S', 'B', 'SS', 'NS', 'BS', 'L', 'M'].includes(t)) throw typeProblem('size', t, n.args[0]);
          } else if (n.name === 'begins_with') {
            for (const o of n.args) { const t = staticType(o, values); if (t && t !== 'S' && t !== 'B') throw typeProblem('begins_with', t, o); }
          } else if (n.name === 'attribute_type') {
            const second = unwrap(n.args[1]);
            if (second.k !== 'value') throw typeProblem('attribute_type', second.k === 'call' && second.name === 'size' ? 'N' : ANY_TYPE, second);
            const v = values.get(second.name);
            if (v.t !== 'S') throw typeProblem('attribute_type', v.t, second);
            if (!TYPES.includes(v.v)) throw err('Invalid attribute type name found; type: ' + v.v + ', valid types: ' + TYPE_NAMES, second, 'type-name');
          } else if (n.name === 'list_append') {
            for (const o of n.args) { const t = staticType(o, values); if (t && t !== 'L') throw typeProblem('list_append', t, o); }
          }
          return;
        }
        case 'arith':
          visit2(n.a); visit2(n.b);
          for (const o of [n.a, n.b]) { const t = staticType(o, values); if (t && t !== 'N') throw typeProblem(n.op, t, o); }
          return;
      }
    };

    if (inUpdate) {
      // DynamoDB checks an update's actions from the last back to the first:
      // every #name first, then the values and their types.
      const backwards = actions.slice().reverse();
      const namesOnly = (n) => {
        if (n.k === 'path') {
          for (const part of n.parts) {
            if (part.ph && !names.has(part.name)) throw err('An expression attribute name used in the document path is not defined; attribute name: ' + part.name, part.tok, 'undefined-name');
          }
          return;
        }
        for (const c of children(n)) namesOnly(c);
      };
      for (const x of backwards) { namesOnly(x.a.path); if (x.a.value) namesOnly(x.a.value); }
      for (const x of backwards) {
        visit2(x.a.path);
        if (x.a.value) visit2(x.a.value);
        if (x.kw === 'ADD' || x.kw === 'DELETE') {
          const t = staticType(x.a.value, values);
          const ok = x.kw === 'ADD' ? ['N', 'SS', 'NS', 'BS'] : ['SS', 'NS', 'BS'];
          if (t && !ok.includes(t)) {
            throw err('Incorrect operand type for operator or function; operator: ' + x.kw + ', operand type: ' + LONG_TYPE[t] + ', typeSet: ALLOWED_FOR_' + x.kw + '_OPERAND', x.a.value, 'operand-type');
          }
        }
      }
    } else if (kind === 'projection') {
      for (const p of ast.paths) visit2(p);
      checkOverlaps(ast.paths, names, err);
    } else visit2(ast);
  }

  // Two paths in one update or projection may not be the same, or one inside
  // the other, or use one attribute as a list and as a map. DynamoDB puts
  // the paths in a tree and reports the first clash it meets walking it,
  // newest branch first; this does the same.
  function checkOverlaps(paths, names, err) {
    const keys = paths.map((p) => pathKey(p, names));
    const root = { kids: new Map(), ends: [] };
    keys.forEach((key, i) => {
      let node = root;
      for (const k of key) {
        if (!node.kids.has(k)) node.kids.set(k, { kids: new Map(), ends: [], born: i, key: k });
        node = node.kids.get(k);
      }
      node.ends.push(i);
    });
    const entries = (node) => [...node.kids.values()].map((k) => ({ i: k.born, kid: k }))
      .concat(node.ends.map((i) => ({ i: i, kid: null })))
      .sort((a, b) => b.i - a.i || (a.kid ? 1 : -1));
    // A path that ends inside a branch: follow the newest entry down.
    const endIn = (node) => {
      for (;;) {
        const e = entries(node)[0];
        if (!e.kid) return e.i;
        node = e.kid;
      }
    };
    const clash = (what, x, y) => {
      const a = Math.min(x, y), b = Math.max(x, y);
      throw err('Two document paths ' + what + ' with each other; must remove or rewrite one of these paths; path one: [' + keys[a].join(', ') + '], path two: [' + keys[b].join(', ') + ']',
        paths[b], what === 'overlap' ? 'overlap' : 'conflict');
    };
    const isIndex = (k) => k.startsWith('[');
    // Each entry, newest first, after the branch below it, against the other
    // entries of its node, newest first.
    const visit = (node) => {
      const list = entries(node);
      for (const e of list) {
        if (e.kid) visit(e.kid);
        for (const x of list) {
          if (x === e) continue;
          if (!e.kid || !x.kid) {
            clash('overlap', e.kid ? endIn(e.kid) : e.i, x.kid ? endIn(x.kid) : x.i);
          }
          if (isIndex(x.kid.key) !== isIndex(e.kid.key)) clash('conflict', endIn(x.kid), endIn(e.kid));
        }
      }
    };
    visit(root);
  }

  // ---- The request ----

  // The expressions each operation takes, in the order DynamoDB checks them.
  const OPERATIONS = {
    Query: ['filter', 'projection', 'key'],
    Scan: ['filter', 'projection'],
    GetItem: ['projection'],
    PutItem: ['condition'],
    DeleteItem: ['condition'],
    UpdateItem: ['update', 'condition']
  };

  // Reads ExpressionAttributeNames: a map of #name to an attribute name.
  function readNames(json) {
    if (json === undefined || json === null) return null;
    if (!(json instanceof Map)) throw new InputError('ExpressionAttributeNames must be a JSON object such as {"#n": "name"}');
    if (json.size === 0) throw invalid('ExpressionAttributeNames must not be empty', { code: 'empty-map' });
    const out = new Map();
    for (const [k, v] of json) {
      if (utf8Bytes(k).length > 255) throw invalid('ExpressionAttributeNames contains invalid key: The expression attribute map contains a key that is too long; size of key: ' + utf8Bytes(k).length, { code: 'map-key' });
      if (!/^#[A-Za-z0-9_]+$/.test(k)) throw invalid('ExpressionAttributeNames contains invalid key: Syntax error; key: "' + k + '"', { code: 'map-key' });
      if (typeof v !== 'string') throw new InputError('The name for ' + k + ' must be a string');
      if (v === '') throw invalid('ExpressionAttributeNames contains invalid value: Empty attribute name for key ' + k, { code: 'empty-name' });
      out.set(k, v);
    }
    return out;
  }

  // Reads ExpressionAttributeValues, typed ({":v": {"N": "1"}}) or plain
  // ({":v": 1}). typed: true, false or undefined to decide by looking.
  function readValues(json, typed) {
    if (json === undefined || json === null) return null;
    if (!(json instanceof Map)) throw new InputError('ExpressionAttributeValues must be a JSON object such as {":v": {"S": "text"}}');
    if (json.size === 0) throw invalid('ExpressionAttributeValues must not be empty', { code: 'empty-map' });
    const isTyped = typed === undefined ? looksTyped(json) : typed;
    for (const k of json.keys()) {
      if (utf8Bytes(k).length > 255) throw invalid('ExpressionAttributeValues contains invalid key: The expression attribute map contains a key that is too long;', { code: 'map-key' });
      if (!/^:[A-Za-z0-9_]+$/.test(k)) throw invalid('ExpressionAttributeValues contains invalid key: Syntax error; key: "' + k + '"', { code: 'map-key' });
    }
    const out = new Map();
    for (const k of javaSetOrder([...json.keys()])) {
      try { out.set(k, isTyped ? fromTyped(json.get(k)) : fromPlain(json.get(k))); }
      catch (e) {
        if (e instanceof ValueProblem) throw invalid('ExpressionAttributeValues contains invalid value: ' + e.message + ' for key ' + k, { code: 'bad-value' });
        if (e instanceof InputError) throw new InputError(k + ': ' + e.message);
        throw e;
      }
    }
    // Keep the order the request gave.
    const ordered = new Map();
    for (const k of json.keys()) ordered.set(k, out.get(k));
    return { map: ordered, typed: isTyped };
  }

  // Reads one item, typed or plain.
  function readItem(json, typed) {
    if (!(json instanceof Map)) throw new InputError('An item must be a JSON object');
    const isTyped = typed === undefined ? looksTyped(json) : typed;
    const item = new Map();
    for (const [k, v] of json) {
      try { item.set(k, isTyped ? fromTyped(v) : fromPlain(v)); }
      catch (e) {
        if (e instanceof ValueProblem || e instanceof InputError) throw new InputError('Item attribute ' + k + ': ' + e.message);
        throw e;
      }
    }
    return item;
  }

  // Checks a whole request the way DynamoDB does, and returns what it found:
  // the parsed expressions, the placeholders used and unused, or the error
  // DynamoDB would answer with.
  //
  // req: { operation, KeyConditionExpression, FilterExpression,
  //   ConditionExpression, UpdateExpression, ProjectionExpression,
  //   ExpressionAttributeNames, ExpressionAttributeValues (JSON as returned
  //   by parseJson, or plain objects), typed (true/false/undefined),
  //   keySchema: { partition: {name, type}, sort: {name, type} } }
  function check(req) {
    const out = { operation: req.operation || guessOperation(req), expressions: {}, error: null };
    const kinds = OPERATIONS[out.operation] || ['key', 'filter', 'condition', 'update', 'projection'];
    try {
      const names = readNames(toJson(req.ExpressionAttributeNames));
      // GetItem takes no values; DynamoDB ignores any that are sent.
      const valuesRead = out.operation === 'GetItem' ? null : readValues(toJson(req.ExpressionAttributeValues), req.typed);
      const ctx = {
        names: names || new Map(), values: valuesRead ? valuesRead.map : new Map(),
        usedNames: new Set(), usedValues: new Set()
      };
      out.names = ctx.names; out.values = ctx.values; out.valuesTyped = valuesRead ? valuesRead.typed : undefined;
      for (const kind of kinds) {
        const text = req[EXPRESSIONS[kind]];
        if (text === undefined || text === null) continue;
        const label = EXPRESSIONS[kind];
        if (text === '') throw invalid('Invalid ' + label + ': The expression can not be empty;', { code: 'empty', expression: label });
        const size = utf8Bytes(text).length;
        if (size > 4096) throw invalid('Invalid ' + label + ': Expression size has exceeded the maximum allowed size; expression size: ' + size, { code: 'too-long', expression: label });
        let ast;
        try { ast = parse(text, kind === 'update' ? 'update' : kind === 'projection' ? 'projection' : 'condition'); }
        catch (e) {
          if (e instanceof SyntaxProblem) throw invalid('Invalid ' + label + ': ' + e.message, { code: 'syntax', expression: label, start: e.start, end: e.end });
          if (e instanceof RedundantParens) throw invalid('Invalid ' + label + ': ' + e.message, { code: 'redundant-parentheses', expression: label, start: e.node.start, end: e.node.end });
          throw e;
        }
        checkExpression(ast, kind, ctx);
        out.expressions[kind] = { text: text, ast: ast };
      }
      const unusedNames = [...ctx.names.keys()].filter((k) => !ctx.usedNames.has(k));
      if (unusedNames.length) throw invalid('Value provided in ExpressionAttributeNames unused in expressions: keys: {' + javaSetOrder(unusedNames, ctx.names.size).join(', ') + '}', { code: 'unused-name', keys: unusedNames });
      const unusedValues = [...ctx.values.keys()].filter((k) => !ctx.usedValues.has(k));
      if (unusedValues.length) throw invalid('Value provided in ExpressionAttributeValues unused in expressions: keys: {' + javaSetOrder(unusedValues, ctx.values.size).join(', ') + '}', { code: 'unused-value', keys: unusedValues });
      if (req.keySchema) {
        for (const kind of kinds) {
          const e = out.expressions[kind];
          if (!e || kind === 'key') continue;
          // An update's are checked when it runs, after its condition.
          if (kind !== 'update') checkKeyPaths(e.ast, ctx, req.keySchema);
        }
      }
      if (out.expressions.key) checkKeyCondition(out.expressions.key.ast, ctx, req.keySchema, out);
      // A Query's filter can't use the key attributes; the key condition does that.
      if (out.operation === 'Query' && out.expressions.filter && req.keySchema) {
        const keys = [req.keySchema.partition && req.keySchema.partition.name, req.keySchema.sort && req.keySchema.sort.name].filter(Boolean);
        walk(out.expressions.filter.ast, (n) => {
          if (n.k !== 'path') return;
          const name = pathKey(n, ctx.names)[0];
          if (keys.includes(name)) throw invalid('Filter Expression can only contain non-primary key attributes: Primary key attribute: ' + name, Object.assign({ code: 'filter-key' }, at(n)));
        });
      }

    } catch (e) {
      if (e instanceof DynamoError) out.error = e;
      else throw e;
    }
    return out;
  }

  function guessOperation(req) {
    if (req.UpdateExpression !== undefined) return 'UpdateItem';
    if (req.KeyConditionExpression !== undefined) return 'Query';
    if (req.FilterExpression !== undefined) return 'Scan';
    if (req.ConditionExpression !== undefined) return 'PutItem';
    if (req.ProjectionExpression !== undefined) return 'GetItem';
    return 'Scan';
  }

  // Plain JavaScript objects to the JSON form the readers take.
  function toJson(v) {
    if (v === undefined || v === null || v instanceof Map || v instanceof JsonNumber) return v;
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return new JsonNumber(String(v));
    if (Array.isArray(v)) return v.map(toJson);
    if (typeof v === 'object') { const m = new Map(); for (const k of Object.keys(v)) m.set(k, toJson(v[k])); return m; }
    return v;
  }

  // ---- Key conditions ----

  // The rules a Query's key condition must follow, beyond what any condition
  // must: equality on the partition key, at most one condition on the sort
  // key, AND only.
  function checkKeyCondition(ast, ctx, schema, out) {
    const parts = [];
    const visit = (n) => {
      n = n.k === 'paren' ? n.inner : n;
      if (n.k === 'and') { visit(n.a); visit(n.b); return; }
      if (n.k === 'or') throw invalid('Invalid operator used in KeyConditionExpression: OR', Object.assign({ code: 'key-operator' }, at(n.tok)));
      if (n.k === 'not') throw invalid('Invalid operator used in KeyConditionExpression: NOT', Object.assign({ code: 'key-operator' }, at(n.tok)));
      if (n.k === 'in') throw invalid('Invalid operator used in KeyConditionExpression: IN', Object.assign({ code: 'key-operator' }, at(n.tok)));
      if (n.k === 'cmp' && n.op === '<>') throw invalid('Invalid operator used in KeyConditionExpression: <>', Object.assign({ code: 'key-operator' }, at(n.tok)));
      if (n.k === 'call' && n.name !== 'begins_with') throw invalid('Invalid operator used in KeyConditionExpression: ' + n.name, Object.assign({ code: 'key-operator' }, at(n.tok)));
      parts.push(n);
    };
    visit(ast);
    const conds = [];
    for (const p of parts) {
      let path, op, vals;
      const operands = p.k === 'cmp' ? [p.a, p.b] : p.k === 'between' ? [p.a, p.lo, p.hi] : p.args;
      if (operands.some((o) => { const u = unwrap(o); return u.k === 'call'; })) throw invalid('KeyConditionExpressions cannot contain nested operations', Object.assign({ code: 'key-nested' }, at(p)));
      if (p.k === 'cmp') {
        const a = unwrap(p.a), b = unwrap(p.b);
        if (a.k === 'path') { path = a; vals = [b]; op = p.op; }
        else { path = b; vals = [a]; op = { '<': '>', '<=': '>=', '>': '<', '>=': '<=', '=': '=' }[p.op]; }
      } else if (p.k === 'between') { path = unwrap(p.a); vals = [unwrap(p.lo), unwrap(p.hi)]; op = 'BETWEEN'; }
      else { path = unwrap(p.args[0]); vals = [unwrap(p.args[1])]; op = 'begins_with'; }
      conds.push({ node: p, path: path, op: op, vals: vals });
    }
    out.keyConditions = conds;
    if (!schema || !schema.partition || !schema.partition.name) return;
    const keyName = (p) => p.k === 'path' ? pathKey(p, ctx.names)[0] : null;
    const counts = new Map();
    for (const c of conds) {
      if (c.path.k !== 'path') throw invalid('Query condition missed key schema element', { code: 'key-missing' });
      const name = keyName(c.path);
      if (c.path.parts.length > 1 && (name === schema.partition.name || (schema.sort && name === schema.sort.name))) {
        throw invalid("Key attributes must be scalars; list random access '[]' and map lookup '.' are not allowed: Key: " + name, Object.assign({ code: 'key-scalar' }, at(c.path)));
      }
      counts.set(name, (counts.get(name) || 0) + 1);
    }
    for (const n of counts.values()) if (n > 1) throw invalid('KeyConditionExpressions must only contain one condition per key', { code: 'key-twice' });
    const pk = conds.find((c) => keyName(c.path) === schema.partition.name);
    const sk = schema.sort && schema.sort.name ? conds.find((c) => keyName(c.path) === schema.sort.name) : null;
    if (!pk || conds.some((c) => c !== pk && c !== sk)) throw invalid('Query condition missed key schema element', { code: 'key-missing' });
    if (pk.op !== '=') throw invalid('Query key condition not supported', Object.assign({ code: 'key-partition-op' }, at(pk.node)));
    for (const c of [pk, sk]) {
      if (!c) continue;
      const type = c === pk ? schema.partition.type : schema.sort.type;
      for (const v of c.vals) {
        const av = v.k === 'value' ? ctx.values.get(v.name) : null;
        if (!av) continue;
        if (av.t !== type) throw invalid('One or more parameter values were invalid: Condition parameter type does not match schema type', { code: 'key-type' });
        if (av.t === 'S' && av.v === '') throw invalid('One or more parameter values are not valid. The AttributeValue for a key attribute cannot contain an empty string value. Key: ' + keyName(c.path), { code: 'key-empty' });
      }
    }
    out.partition = pk; out.sort = sk || null;
  }

  // Key attributes hold plain values, so no expression may look inside them.
  function checkKeyPaths(ast, ctx, schema) {
    const keys = [schema.partition && schema.partition.name, schema.sort && schema.sort.name].filter(Boolean);
    walk(ast, (n) => {
      if (n.k !== 'path' || n.parts.length < 2) return;
      const name = pathKey(n, ctx.names)[0];
      if (keys.includes(name)) {
        throw invalid("Key attributes must be scalars; list random access '[]' and map lookup '.' are not allowed: Key: " + name, Object.assign({ code: 'key-scalar' }, at(n)));
      }
    });
  }

  // An update may not touch the key attributes.
  function checkKeyUpdate(ast, ctx, schema) {
    const keys = [schema.partition && schema.partition.name, schema.sort && schema.sort.name].filter(Boolean);
    for (const c of ast.clauses) {
      for (const a of c.actions) {
        const name = pathKey(a.path, ctx.names)[0];
        if (keys.includes(name)) {
          throw invalid('One or more parameter values were invalid: Cannot update attribute ' + name + '. This attribute is part of the key', Object.assign({ code: 'key-update' }, at(a.path)));
        }
      }
    }
  }

  // ---- Running expressions ----

  // The value at a document path in an item, or undefined.
  function resolve(path, item, names) {
    let cur = null;
    for (let i = 0; i < path.parts.length; i++) {
      const part = path.parts[i];
      if (i === 0) { cur = item.get(part.ph ? names.get(part.name) : part.name); }
      else if (part.index !== undefined) cur = cur && cur.t === 'L' ? cur.v[Number(part.index)] : undefined;
      else cur = cur && cur.t === 'M' ? cur.v.get(part.ph ? names.get(part.name) : part.name) : undefined;
      if (!cur) return undefined;
    }
    return cur;
  }

  function sizeOf(av) {
    switch (av.t) {
      case 'S': return av.v.length;
      case 'B': return av.v.length;
      case 'SS': case 'NS': case 'BS': case 'L': return av.v.length;
      case 'M': return av.v.size;
    }
    return undefined;
  }
  function numberValue(n) { return { t: 'N', v: makeNum(n === 0 ? 0 : 1, BigInt(n), 0, 0) }; }

  // An operand's value for one item, or undefined.
  function operandValue(n, item, ctx) {
    n = unwrap(n);
    if (n.k === 'value') return ctx.values.get(n.name);
    if (n.k === 'path') return resolve(n, item, ctx.names);
    if (n.k === 'call' && n.name === 'size') {
      const v = operandValue(n.args[0], item, ctx);
      if (!v) return undefined;
      const s = sizeOf(v);
      return s === undefined ? undefined : numberValue(s);
    }
    return undefined;
  }

  // Whether a condition holds for an item. trace collects every part's answer.
  function holds(n, item, ctx, trace) {
    let r;
    switch (n.k) {
      case 'paren': r = holds(n.inner, item, ctx, trace); break;
      case 'or': { const a = holds(n.a, item, ctx, trace); const b = holds(n.b, item, ctx, trace); r = a || b; break; }
      case 'and': { const a = holds(n.a, item, ctx, trace); const b = holds(n.b, item, ctx, trace); r = a && b; break; }
      case 'not': r = !holds(n.a, item, ctx, trace); break;
      case 'cmp': {
        const a = operandValue(n.a, item, ctx), b = operandValue(n.b, item, ctx);
        if (n.op === '=') r = Boolean(a && b && sameValue(a, b));
        else if (n.op === '<>') r = !(a && b && sameValue(a, b));
        else {
          const o = a && b ? order(a, b) : null;
          r = o === null ? false : n.op === '<' ? o < 0 : n.op === '<=' ? o <= 0 : n.op === '>' ? o > 0 : o >= 0;
        }
        break;
      }
      case 'between': {
        const a = operandValue(n.a, item, ctx), lo = operandValue(n.lo, item, ctx), hi = operandValue(n.hi, item, ctx);
        const x = a && lo ? order(lo, a) : null, y = a && hi ? order(a, hi) : null;
        r = x !== null && y !== null && x <= 0 && y <= 0;
        break;
      }
      case 'in': {
        const a = operandValue(n.a, item, ctx);
        r = Boolean(a) && n.list.some((o) => { const v = operandValue(o, item, ctx); return v && sameValue(a, v); });
        break;
      }
      case 'call': r = callHolds(n, item, ctx); break;
      default: r = false;
    }
    if (trace) trace.set(n, r);
    return r;
  }
  function callHolds(n, item, ctx) {
    const a = operandValue(n.args[0], item, ctx);
    switch (n.name) {
      case 'attribute_exists': return Boolean(a);
      case 'attribute_not_exists': return !a;
      case 'attribute_type': { const t = operandValue(n.args[1], item, ctx); return Boolean(a) && a.t === t.v; }
      case 'begins_with': {
        const b = operandValue(n.args[1], item, ctx);
        if (!a || !b || a.t !== b.t) return false;
        if (a.t === 'S') return compareBytes(utf8Bytes(a.v).subarray(0, utf8Bytes(b.v).length), utf8Bytes(b.v)) === 0 && utf8Bytes(a.v).length >= utf8Bytes(b.v).length;
        if (a.t === 'B') return a.v.length >= b.v.length && compareBytes(a.v.subarray(0, b.v.length), b.v) === 0;
        return false;
      }
      case 'contains': {
        const b = operandValue(n.args[1], item, ctx);
        if (!a || !b) return false;
        if (a.t === 'S') return b.t === 'S' && a.v.includes(b.v);
        if (a.t === 'SS') return b.t === 'S' && a.v.includes(b.v);
        if (a.t === 'NS') return b.t === 'N' && a.v.some((x) => compareNumbers(x, b.v) === 0);
        if (a.t === 'BS') return b.t === 'B' && a.v.some((x) => compareBytes(x, b.v) === 0);
        if (a.t === 'L') return a.v.some((x) => sameValue(x, b));
        if (a.t === 'B') return b.t === 'B' && bytesInclude(a.v, b.v);
        return false;
      }
    }
    return false;
  }
  function bytesInclude(hay, needle) {
    outer: for (let i = 0; i + needle.length <= hay.length; i++) {
      for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
      return true;
    }
    return false;
  }

  // ---- Updates ----

  function runtime(message, code) { return invalid(message, { code: code }); }
  const TYPE_ERROR = 'An operand in the update expression has an incorrect data type';
  const MISSING_ERROR = 'The provided expression refers to an attribute that does not exist in the item';
  const PATH_ERROR = 'The document path provided in the update expression is invalid for update';

  // The value a SET action writes, worked out from the item as it was.
  // types: only report wrong types, and pass over attributes that are
  // missing (DynamoDB looks at types first, then at what is missing).
  function setValue(n, item, ctx, typesOnly) {
    n = unwrap(n);
    if (n.k === 'arith') {
      const a = setValue(n.a, item, ctx, typesOnly);
      if (a && a.t !== 'N') throw runtime(TYPE_ERROR, 'runtime-type');
      const b = setValue(n.b, item, ctx, typesOnly);
      if (b && b.t !== 'N') throw runtime(TYPE_ERROR, 'runtime-type');
      if (!a || !b) return undefined;
      return { t: 'N', v: addNumbers(a.v, b.v, n.op === '-') };
    }
    if (n.k === 'call' && n.name === 'if_not_exists') {
      const cur = resolve(unwrap(n.args[0]), item, ctx.names);
      return cur ? cur : setValue(n.args[1], item, ctx, typesOnly);
    }
    if (n.k === 'call' && n.name === 'list_append') {
      const a = setValue(n.args[0], item, ctx, typesOnly);
      if (a && a.t !== 'L') throw runtime(TYPE_ERROR, 'runtime-type');
      const b = setValue(n.args[1], item, ctx, typesOnly);
      if (b && b.t !== 'L') throw runtime(TYPE_ERROR, 'runtime-type');
      if (!a || !b) return undefined;
      return { t: 'L', v: a.v.concat(b.v) };
    }
    if (n.k === 'value') return ctx.values.get(n.name);
    const v = resolve(n, item, ctx.names);
    if (!v && !typesOnly) throw runtime(MISSING_ERROR, 'missing-attribute');
    return v;
  }
  function checkedNumber(n) {
    const p = numberProblem(n);
    if (p) throw runtime(NUM_ERRORS[p], 'number-' + p);
    return n;
  }

  // Whether the place a path writes to can exist: everything before its last
  // step must be there, and be a map before a name or a list before an index.
  function writable(key, item) {
    if (key.length === 1) return true;
    const parent = resolveKey(key.slice(0, -1), item);
    if (!parent) return false;
    return key[key.length - 1].startsWith('[') ? parent.t === 'L' : parent.t === 'M';
  }

  // Applies an update to a copy of the item and returns it. Every value is
  // worked out from the item as it was before the update. DynamoDB reports
  // problems in this order: a wrong type anywhere, then, section by section
  // from the last written to the first, a path it can't write to and then an
  // attribute a SET reads that isn't there.
  function applyUpdate(ast, item, ctx) {
    const acts = [];
    ast.clauses.forEach((c, ci) => c.actions.forEach((a) => acts.push({ kw: c.kw, clause: ci, a: a, key: pathKey(a.path, ctx.names) })));
    // A path whose parent is there but is not a map or list as the path needs.
    for (const x of acts) {
      if (x.key.length > 1) {
        const parent = resolveKey(x.key.slice(0, -1), item);
        if (parent && !writable(x.key, item)) throw runtime(PATH_ERROR, 'bad-path');
      }
    }
    // Types.
    for (const x of acts) {
      if (x.kw === 'SET') {
        try { x.value = setValue(x.a.value, item, ctx, false); }
        catch (e) { if (e.code === 'runtime-type') throw e; x.failure = e; }
      }
      else if (x.kw === 'ADD' || x.kw === 'DELETE') {
        const v = ctx.values.get(x.a.value.name);
        const cur = writable(x.key, item) ? resolve(x.a.path, item, ctx.names) : undefined;
        if (cur) {
          const ok = x.kw === 'ADD' ? (v.t === 'N' && cur.t === 'N') || (cur.t === v.t && /S$/.test(v.t)) : cur.t === v.t;
          if (!ok) throw runtime(TYPE_ERROR, 'runtime-type');
          if (x.kw === 'ADD' && v.t === 'N') checkedNumber(addNumbers(cur.v, v.v));
        }
      }
    }
    // Paths, then missing attributes, a section at a time from the last.
    for (let ci = ast.clauses.length - 1; ci >= 0; ci--) {
      const inClause = acts.filter((x) => x.clause === ci);
      for (const x of inClause) if (!writable(x.key, item)) throw runtime(PATH_ERROR, 'bad-path');
      for (const x of inClause) if (x.failure) throw x.failure;
    }
    // Numbers out of range, as they are written.
    for (const x of acts) if (x.kw === 'SET' && x.value && x.value.t === 'N') checkedNumber(x.value.v);
    for (const x of acts) if (x.kw === 'SET') x.value = cloneValue(x.value);
    // Work out every write from the item as it was.
    const writes = [];
    for (const x of acts) {
      if (x.kw === 'SET') writes.push({ kind: 'set', key: x.key, value: x.value });
      else if (x.kw === 'REMOVE') writes.push({ kind: 'remove', key: x.key });
      else {
        const v = ctx.values.get(x.a.value.name);
        const cur = resolve(x.a.path, item, ctx.names);
        if (x.kw === 'ADD') {
          const next = !cur ? cloneValue(v) : v.t === 'N' ? { t: 'N', v: checkedNumber(addNumbers(cur.v, v.v)) } : setUnion(cur, v);
          writes.push({ kind: 'set', key: x.key, value: next });
        } else if (cur) {
          const next = setMinus(cur, v);
          writes.push(next.v.length ? { kind: 'set', key: x.key, value: next } : { kind: 'remove', key: x.key });
        }
      }
    }
    const out = cloneItem(item);
    // Removals from lists use the positions the items had before the update,
    // and new list entries past the end are added in the order of their index.
    const listOps = new Map();
    for (const w of writes) {
      const last = w.key.length - 1;
      if (last === 0) {
        if (w.kind === 'set') out.set(w.key[0], w.value); else out.delete(w.key[0]);
        continue;
      }
      const parent = resolveKey(w.key.slice(0, last), out);
      if (parent.t === 'M') {
        if (w.kind === 'set') parent.v.set(w.key[last], w.value); else parent.v.delete(w.key[last]);
        continue;
      }
      const parentKey = w.key.slice(0, last).join('\u0000');
      if (!listOps.has(parentKey)) listOps.set(parentKey, { list: parent, ops: [] });
      listOps.get(parentKey).ops.push({ index: Number(w.key[last].slice(1, -1)), w: w });
    }
    for (const { list, ops } of listOps.values()) {
      const old = list.v.slice();
      const removed = new Set();
      const appended = [];
      for (const { index, w } of ops) {
        if (w.kind === 'remove') { if (index < old.length) removed.add(index); }
        else if (index < old.length) old[index] = w.value;
        else appended.push({ index: index, value: w.value });
      }
      appended.sort((a, b) => a.index - b.index);
      list.v = old.filter((x, i) => !removed.has(i)).concat(appended.map((a) => a.value));
    }
    return out;
  }
  function resolveKey(key, item) {
    let cur = item.get(key[0]);
    for (let i = 1; i < key.length && cur; i++) {
      const k = key[i];
      if (k.startsWith('[')) cur = cur.t === 'L' ? cur.v[Number(k.slice(1, -1))] : undefined;
      else cur = cur.t === 'M' ? cur.v.get(k) : undefined;
    }
    return cur;
  }
  function setUnion(a, b) {
    const out = a.v.slice();
    for (const x of b.v) if (!setHas(a, x)) out.push(x);
    return { t: a.t, v: out };
  }
  function setMinus(a, b) { return { t: a.t, v: a.v.filter((x) => !setHas(b, x)) }; }
  function setHas(set, x) {
    if (set.t === 'SS') return set.v.includes(x);
    if (set.t === 'NS') return set.v.some((y) => compareNumbers(x, y) === 0);
    return set.v.some((y) => compareBytes(x, y) === 0);
  }

  // ---- Projections ----

  function project(paths, item, names) {
    const out = new Map();
    // Build a tree of the requested paths, then copy along it.
    const tree = new Map();
    for (const p of paths) {
      let node = tree;
      const key = pathKey(p, names);
      key.forEach((k, i) => {
        if (!node.has(k)) node.set(k, i === key.length - 1 ? true : new Map());
        node = node.get(k);
      });
    }
    const copy = (src, sub) => {
      if (sub === true) return cloneValue(src);
      if (src.t === 'M') {
        const m = new Map();
        for (const [k, s] of sub) {
          if (k.startsWith('[') || !src.v.has(k)) continue;
          const v = copy(src.v.get(k), s);
          if (v) m.set(k, v);
        }
        return m.size ? { t: 'M', v: m } : null;
      }
      if (src.t === 'L') {
        const idx = [...sub.keys()].filter((k) => k.startsWith('[')).map((k) => [Number(k.slice(1, -1)), k]).sort((a, b) => a[0] - b[0]);
        const l = [];
        for (const [i, k] of idx) {
          if (i >= src.v.length) continue;
          const v = copy(src.v[i], sub.get(k));
          if (v) l.push(v);
        }
        return l.length ? { t: 'L', v: l } : null;
      }
      return null;
    };
    for (const [k, sub] of tree) {
      if (!item.has(k)) continue;
      const v = copy(item.get(k), sub);
      if (v) out.set(k, v);
    }
    return out;
  }

  // ---- Running a whole request ----

  // Runs a request against sample items and returns what DynamoDB would do.
  // req as for check(), plus items (Maps from readItem) for Query and Scan,
  // and item (the current item, or null for none) for the item operations.
  function run(req) {
    const result = check(req);
    if (result.error) return result;
    const ctx = { names: result.names, values: result.values };
    const ex = result.expressions;
    const op = result.operation;
    try {
      if (op === 'Query' || op === 'Scan') {
        let items = (req.items || []).map((item, i) => ({ index: i, item: item }));
        if (op === 'Query' && ex.key) {
          const kt = new Map();
          items = items.filter((x) => holds(ex.key.ast, x.item, ctx, kt));
          if (req.keySchema && req.keySchema.sort && req.keySchema.sort.name) {
            const sk = req.keySchema.sort.name;
            items.sort((x, y) => {
              const a = x.item.get(sk), b = y.item.get(sk);
              if (!a || !b) return 0;
              return order(a, b) || 0;
            });
            if (req.ScanIndexForward === false) items.reverse();
          }
        }
        result.items = items.map((x) => {
          const trace = new Map();
          const keep = ex.filter ? holds(ex.filter.ast, x.item, ctx, trace) : true;
          return { index: x.index, item: x.item, match: keep, trace: trace, projected: ex.projection ? project(ex.projection.ast.paths, x.item, ctx.names) : null };
        });
        if (op === 'Query' && ex.key) {
          const matched = new Set(result.items.map((x) => x.index));
          result.notMatchingKey = (req.items || []).map((item, i) => ({ index: i, item: item })).filter((x) => !matched.has(x.index));
        }
        return result;
      }
      const current = req.item || null;
      if (op === 'GetItem') {
        result.after = current && ex.projection ? project(ex.projection.ast.paths, current, ctx.names) : current;
        return result;
      }
      if (ex.condition) {
        const trace = new Map();
        result.conditionTrace = trace;
        result.conditionHolds = holds(ex.condition.ast, current || new Map(), ctx, trace);
        if (!result.conditionHolds) {
          result.error = new DynamoError('ConditionalCheckFailedException', 'The conditional request failed', { code: 'condition-failed' });
          return result;
        }
      }
      if (op === 'UpdateItem' && ex.update) {
        if (req.keySchema) {
          for (const c of ex.update.ast.clauses) for (const a of c.actions) if (a.value) checkKeyPaths(a.value, ctx, req.keySchema);
          checkKeyUpdate(ex.update.ast, ctx, req.keySchema);
        }
        const base = current ? current : new Map();
        const start = new Map(base);
        if (!current && req.key) for (const [k, v] of req.key) start.set(k, v);
        result.before = current;
        result.after = applyUpdate(ex.update.ast, start, ctx);
        result.changed = changedAttributes(current || new Map(), result.after);
      } else if (op === 'PutItem') {
        result.before = current;
        result.after = req.newItem || null;
      } else if (op === 'DeleteItem') {
        result.before = current;
        result.after = null;
      }
    } catch (e) {
      if (e instanceof DynamoError) result.error = e;
      else throw e;
    }
    return result;
  }
  function changedAttributes(before, after) {
    const out = [];
    for (const k of new Set([...before.keys(), ...after.keys()])) {
      const a = before.get(k), b = after.get(k);
      if (!a && b) out.push({ name: k, change: 'added', after: b });
      else if (a && !b) out.push({ name: k, change: 'removed', before: a });
      else if (!sameValue(a, b)) out.push({ name: k, change: 'changed', before: a, after: b });
    }
    return out;
  }

  // ---- Reading a pasted request ----

  // Reads the JSON a program sends: the input of an SDK call or of the AWS
  // command line's --cli-input-json, typed or plain. Returns the fields the
  // tester uses.
  function readRequest(text) {
    const json = parseJson(text);
    if (!(json instanceof Map)) throw new InputError('Expected a JSON object: the parameters of a Query, Scan, GetItem, PutItem, UpdateItem or DeleteItem call');
    const get = (k) => { for (const [key, v] of json) if (key.toLowerCase() === k.toLowerCase()) return v; return undefined; };
    const req = {};
    for (const k of ['KeyConditionExpression', 'FilterExpression', 'ConditionExpression', 'UpdateExpression', 'ProjectionExpression']) {
      const v = get(k);
      if (v !== undefined) {
        if (typeof v !== 'string') throw new InputError(k + ' must be a string');
        req[k] = v;
      }
    }
    if (get('ExpressionAttributeNames') !== undefined) req.ExpressionAttributeNames = get('ExpressionAttributeNames');
    if (get('ExpressionAttributeValues') !== undefined) req.ExpressionAttributeValues = get('ExpressionAttributeValues');
    if (get('Key') instanceof Map) req.Key = get('Key');
    if (get('Item') instanceof Map) req.Item = get('Item');
    if (typeof get('ScanIndexForward') === 'boolean') req.ScanIndexForward = get('ScanIndexForward');
    if (typeof get('TableName') === 'string') req.TableName = get('TableName');
    if (typeof get('IndexName') === 'string') req.IndexName = get('IndexName');
    req.operation = guessOperation(req);
    if (req.operation === 'PutItem' && req.ConditionExpression === undefined && req.Item) req.operation = 'PutItem';
    return req;
  }

  // ---- Placeholders for reserved and awkward names ----

  // Rewrites the names in an expression that need a placeholder (reserved
  // words, and names DynamoDB can't read as written) as #placeholders, and
  // returns the new expression with the ExpressionAttributeNames to add.
  // Names already written as placeholders are left alone.
  function escapeNames(text, existing) {
    const names = new Map(existing instanceof Map ? existing : Object.entries(existing || {}));
    const toks = tokenize(text);
    let out = '';
    let last = 0;
    const used = new Map([...names].map(([k, v]) => [v, k]));
    const added = [];
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.t !== 'id') continue;
      const isCall = toks[i + 1] && toks[i + 1].t === '(' && ALL_FUNCTIONS[t.text];
      if (isCall || !isReserved(t.text)) continue;
      let ph = used.get(t.text);
      if (!ph) {
        let base = '#' + t.text.replace(/[^A-Za-z0-9_]/g, '_');
        ph = base;
        let n = 2;
        while (names.has(ph)) ph = base + n++;
        names.set(ph, t.text);
        used.set(t.text, ph);
        added.push(ph);
      }
      out += text.slice(last, t.start) + ph;
      last = t.end;
    }
    out += text.slice(last);
    const obj = {};
    for (const [k, v] of names) obj[k] = v;
    return { expression: out, names: obj, added: added };
  }

  // ---- Explanations ----

  // What an error means and what to do about it, in plain words.
  const HELP = {
    'syntax': 'DynamoDB could not read the expression past the marked token. Check for a missing operand, a stray character, or a name that needs a #placeholder.',
    'reserved-word': 'The name is one of DynamoDB\'s reserved words. Write a placeholder such as #name in the expression and map it in ExpressionAttributeNames.',
    'undefined-name': 'The expression uses a #placeholder that ExpressionAttributeNames doesn\'t define. Add it, or fix the spelling.',
    'undefined-value': 'The expression uses a :placeholder that ExpressionAttributeValues doesn\'t define. Add it, or fix the spelling.',
    'unused-name': 'Every key in ExpressionAttributeNames has to appear in one of the request\'s expressions. Remove the ones the expressions don\'t use.',
    'unused-value': 'Every key in ExpressionAttributeValues has to appear in one of the request\'s expressions. Remove the ones the expressions don\'t use.',
    'redundant-parentheses': 'Two pairs of parentheses wrap the same thing. Remove one pair.',
    'function-name': 'DynamoDB has no function by that name. Function names are case sensitive: attribute_exists, attribute_not_exists, attribute_type, begins_with, contains and size in conditions, if_not_exists and list_append in updates.',
    'function-place': 'The function can\'t be used in this place. attribute_exists, attribute_not_exists, attribute_type, begins_with and contains are conditions on their own. size gives a number to compare. if_not_exists and list_append only work in an update\'s SET.',
    'function-operands': 'The function was given the wrong number of operands.',
    'operand-type': 'A value has a type this operator or function can\'t use, for example a number where text is needed.',
    'same-operand': 'DynamoDB refuses to compare an attribute with itself. Use a :value placeholder for one side.',
    'needs-path': 'This function needs an attribute name as its first operand, not a :value.',
    'between-bounds': 'In BETWEEN, both bounds need the same type and the first must not be greater than the second.',
    'in-operands': 'IN takes at most 100 values.',
    'nesting': 'A document path can go at most 32 levels deep.',
    'index-range': 'A list index must be between 0 and 2147483647.',
    'type-name': 'attribute_type needs one of the type names S, SS, N, NS, B, BS, BOOL, NULL, L or M.',
    'overlap': 'Two paths in the same update or projection are the same, or one is inside the other. Keep one of them.',
    'conflict': 'Two paths use the same attribute once as a list and once as a map.',
    'repeated-section': 'Each of SET, REMOVE, ADD and DELETE can appear once. Put all the actions of one kind after a single keyword, separated by commas.',
    'empty': 'The expression is empty. Leave the parameter out instead.',
    'too-long': 'An expression can be at most 4 KB.',
    'empty-map': 'Leave the parameter out instead of sending an empty map.',
    'map-key': 'Keys in ExpressionAttributeNames start with #, keys in ExpressionAttributeValues with :, followed by letters, digits or _.',
    'empty-name': 'A placeholder can\'t stand for an empty attribute name.',
    'bad-value': 'One of the values in ExpressionAttributeValues is not a valid DynamoDB value.',
    'key-operator': 'A key condition can only use =, <, <=, >, >=, BETWEEN and begins_with, joined with AND.',
    'key-nested': 'A key condition can\'t use size() or other functions inside a comparison.',
    'key-twice': 'A key condition can have one condition for the partition key and one for the sort key.',
    'key-missing': 'A key condition needs partition key = :value, and can only add a condition on the table\'s or index\'s sort key. Other attributes go in a FilterExpression.',
    'key-partition-op': 'The partition key can only be matched with =.',
    'key-type': 'A value has a different type than the key attribute in the table\'s key schema.',
    'key-empty': 'Key attributes can\'t be empty strings.',
    'key-scalar': 'Key attributes are plain values, so a key condition can\'t look inside them with . or [].',
    'filter-key': 'In a Query, conditions on the partition and sort key belong in the KeyConditionExpression, not the filter.',
    'key-update': 'An update can\'t change the table\'s key attributes. Write a new item instead.',
    'missing-attribute': 'The update reads an attribute the item doesn\'t have, for example in a + b. Use if_not_exists(attribute, :default) to supply a starting value.',
    'runtime-type': 'An attribute in the item has a different type than the update needs, for example ADD of a number to a string.',
    'bad-path': 'The update writes inside an attribute that doesn\'t exist or isn\'t a map or list. Create the parent map or list first.',
    'number-precision': 'The result would need more than 38 significant digits.',
    'number-overflow': 'The result is larger than DynamoDB numbers allow.',
    'number-underflow': 'The result is closer to zero than DynamoDB numbers allow.',
    'value-in-path': 'A :value can\'t be part of a document path. DynamoDB Local fails on this with an internal error; write the name, or a #placeholder.',
    'condition-failed': 'The condition was false for the item, so DynamoDB made no change.'
  };
  function explain(err) { return err && HELP[err.code] || ''; }

  return {
    // reading input
    parseJson: parseJson, parseJsonItems: parseJsonItems, readRequest: readRequest,
    readItem: readItem, readNames: readNames, readValues: readValues, looksTyped: looksTyped,
    // expressions
    tokenize: tokenize, parse: parse, check: check, run: run, escapeNames: escapeNames, explain: explain,
    // values
    fromTyped: fromTyped, fromPlain: fromPlain, toTyped: toTyped, itemToTyped: itemToTyped, toPlainText: toPlainText,
    parseNumber: parseNumber, numberText: numberText, addNumbers: addNumbers, compareNumbers: compareNumbers,
    sameValue: sameValue, compareStrings: compareStrings,
    isReserved: isReserved, RESERVED: RESERVED, OPERATIONS: OPERATIONS, EXPRESSIONS: EXPRESSIONS,
    DynamoError: DynamoError, InputError: InputError, JsonNumber: JsonNumber,
    javaSetOrder: javaSetOrder, unwrap: unwrap, children: children
  };
});
