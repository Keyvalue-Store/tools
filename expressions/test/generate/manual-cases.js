// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Requests written by hand for record.js, each pinning down one rule of
// DynamoDB's: how it reads expressions, the errors it gives and the order
// it gives them in, and what it does to numbers, strings, lists and sets.

'use strict';
// node --test runs every .js file under a test folder; this one is data for record.js.
if (process.env.NODE_TEST_CONTEXT && require.main === module) return;

const ITEM = {
  pk: { S: 'k' }, n: { N: '5' }, s: { S: 'héllo' }, e: { S: '😀' }, ss: { SS: ['a', 'b'] }, ns: { NS: ['1', '2'] },
  bs: { BS: ['AAE='] }, l: { L: [{ N: '1' }, { N: '2' }, { N: '3' }] }, m: { M: { a: { N: '1' }, inr: { M: { x: { S: 'y' } } } } },
  b: { B: '/wA=' }, t: { BOOL: true }, z: { NULL: true }, em: { S: '' }
};
const N = (n) => ({ N: n });
const S = (s) => ({ S: s });
const V1 = { ':v': N('1') };

const cases = [];
function scan(note, FilterExpression, values, names, extra) {
  const request = Object.assign({ FilterExpression: FilterExpression }, extra || {});
  if (values) request.ExpressionAttributeValues = values;
  if (names) request.ExpressionAttributeNames = names;
  cases.push({ note: note, op: 'Scan', item: ITEM, request: request });
}
function update(note, UpdateExpression, values, names, extra) {
  const request = Object.assign({ Key: { pk: S('k') }, UpdateExpression: UpdateExpression, ReturnValues: 'ALL_NEW' }, extra || {});
  if (values) request.ExpressionAttributeValues = values;
  if (names) request.ExpressionAttributeNames = names;
  cases.push({ note: note, op: 'UpdateItem', item: ITEM, request: request });
}
function get(note, ProjectionExpression, names) {
  const request = { Key: { pk: S('k') }, ProjectionExpression: ProjectionExpression };
  if (names) request.ExpressionAttributeNames = names;
  cases.push({ note: note, op: 'GetItem', item: ITEM, request: request });
}
const QTABLE = [['pk', 'S'], ['sk', 'N']];
const QITEMS = [0, 1, 2, 3, 4].map((i) => ({ pk: S('p'), sk: N(String(i)), v: N(String(i * 10)) }));
function query(note, KeyConditionExpression, values, names, extra) {
  const request = Object.assign({ KeyConditionExpression: KeyConditionExpression }, extra || {});
  if (values) request.ExpressionAttributeValues = values;
  if (names) request.ExpressionAttributeNames = names;
  cases.push({ note: note, op: 'Query', table: QTABLE, items: QITEMS, request: request });
}

// Reading expressions
scan('a reserved word as a name', 'status = :v', V1);
scan('the word is quoted as written', 'Status = :v', V1);
scan('a placeholder for a reserved word', '#s = :v', V1, { '#s': 'status' });
scan('names start with a letter', '1abc = :v', V1);
scan('no dash in a name', 'a-b = :v', V1);
scan('no underscore first', '_a = :v', V1);
scan('underscore and digits after the first letter', 'a_1 = :v', V1);
scan('no letters outside ASCII', 'aé = :v', V1);
scan('near starts at the beginning when nothing is before', '  1abc = :v', V1);
scan('near runs from the token before to the token after', 'n == :v', V1);
scan('error at the end', 'n = :v AND', V1);
scan('error at the end keeps trailing space', 'n = :v AND  ', V1);
scan('a stray closing parenthesis', 'n = :v)', V1);
scan('an unclosed parenthesis', '(n = :v', V1);
scan('nothing between parentheses in IN', 'n IN ()', V1);
scan('!= is not an operator', 'n != :v', V1);
scan('=> is not an operator', 'n => :v', V1);
scan('tab, newline and return are spaces', 'n\t=\r\n:v', V1);
scan('form feed is not', 'n\f= :v', V1);
scan('no-break space is not', 'n = :v', V1);
scan('a bare name is not a condition', 'n', V1);
scan('a parenthesized operand', 'n = (:v)', V1);
scan('a parenthesized name alone', '(n)', V1);
scan('double parentheses are refused', '((n = :v))', V1);
scan('double parentheses deep inside', 'n = :v AND (s = :v OR ((n = :v)))', V1);
scan('double parentheses before a later syntax error', '((n = :v)) =', V1);
scan('a syntax error before double parentheses', 'n = :v = ((n = :v))', V1);
scan('NOT NOT', 'NOT NOT n = :v', V1);
scan('keywords in any case', 'n = :v and not s = :v or n = :v', V1);
scan('function names are case sensitive', 'Attribute_Exists(n)', null);
scan('a space before the function parenthesis', 'attribute_exists (n)', null);
scan('a value after a dot', 'm.:v = :v', V1);
scan('a value after a dot with a space', 'contains(bs. :v)', V1);
scan('list index range', 'l[2147483648] = :v', V1);
scan('largest list index', 'l[2147483647] = :v', V1);
scan('index with a leading zero', 'l[01] = :v', V1);
scan('spaces inside brackets', 'l[ 1 ] = :v', V1);
scan('spaces around a dot', 'm. a = :v', V1);
scan('33 levels deep', 'm' + '.m'.repeat(32) + ' = :v', V1);
scan('32 levels deep', 'm' + '.m'.repeat(31) + ' = :v', V1);
scan('101 operands for IN', 'n IN (' + Array(101).fill(':v').join(',') + ')', V1);
scan('100 operands for IN', 'n IN (' + Array(100).fill(':v').join(',') + ')', V1);
scan('an expression over 4 KB', 'n = :v' + ' '.repeat(4100), V1);
scan('an empty filter is no filter', '', null);
scan('a filter of spaces', '   ', null);

// The order DynamoDB reports problems in
scan('reserved word before a later function name', 'status = :v AND foo(n) = :v', V1);
scan('function name before a later reserved word', 'foo(n) = :v AND status = :v', V1);
scan('function name before an undefined name', '#x = :v AND foo(n)', V1);
scan('undefined value before a later operand rule', 'n = :m AND contains(s, s)', V1);
scan('operand rule before a later undefined value', 'contains(s, s) AND n = :m', V1);
scan('size alone, wherever it is', 'n = :m AND size(n)', V1);
scan('nesting is checked with the placeholders', 'm' + '.m'.repeat(32) + ' = :v AND status = :v', V1);
scan('syntax before reserved words', 'status = :v =', V1);
scan('names then values when both are unused', 'n = :v', { ':v': N('1'), ':u': N('2') }, { '#u': 'x' });
scan('unused values in Java hash order', 'n = :a', { ':a': N('1'), ':b': N('1'), ':c': N('2'), ':aa': S('x') });
scan('unused names in Java hash order', 'n = :a', { ':a': N('1') }, { '#b': 'x', '#a': 'y', '#c': 'z' });
scan('unused values, more than twelve', 'n = :v0', Object.fromEntries(Array.from({ length: 15 }, (_, i) => [':v' + i, N(String(i))])));

// Functions and operands
scan('size counts UTF-16 units: an emoji is 2', 'size(e) = :v', { ':v': N('2') });
scan('size of a string', 'size(s) = :v', { ':v': N('5') });
scan('size of a number is no match', 'size(n) = :v', V1);
scan('size of a map', 'size(m) = :v', { ':v': N('2') });
scan('size of a value', 'size(:s) = :v', { ':s': S('abc'), ':v': N('3') });
scan('size of a number value', 'size(:v) = :v', V1);
scan('size alone', 'size(n)', null);
scan('size inside size', 'size(size(n)) = :v', V1);
scan('size in a function', 'begins_with(size(n), :v)', V1);
scan('attribute_exists of a value', 'attribute_exists(:v)', V1);
scan('attribute_exists compared', 'attribute_exists(n) = :v', V1);
scan('if_not_exists in a condition', 'n = if_not_exists(n, :v)', V1);
scan('list_append in a condition', 'list_append(l, :v) = :v', V1);
scan('two operands for attribute_exists', 'attribute_exists(n, m)', null);
scan('one operand for begins_with', 'begins_with(n)', null);
scan('attribute_type with a path', 'attribute_type(n, m)', null);
scan('attribute_type with a number', 'attribute_type(n, :v)', V1);
scan('attribute_type with an unknown type', 'attribute_type(n, :t)', { ':t': S('X') });
scan('attribute_type N', 'attribute_type(n, :t)', { ':t': S('N') });
scan('the same path twice', 'n = n', null);
scan('the same value twice', ':v = :v', V1);
scan('the same path twice in IN', 'n IN (n, :v)', V1);
scan('the same path twice in BETWEEN', 'n BETWEEN n AND :v', V1);
scan('a value first in BETWEEN', ':v BETWEEN n AND n', V1);
scan('contains of a path in itself', 'contains(s, s)', null);
scan('size(n) twice is fine', 'size(n) = size(n)', null);
scan('BETWEEN with reversed bounds', 'n BETWEEN :a AND :b', { ':a': N('9'), ':b': N('1') });
scan('BETWEEN keeps the bound as written', 'n BETWEEN :a AND :b', { ':a': N('9.9E125'), ':b': N('10') });
scan('BETWEEN with reversed string bounds', 'n BETWEEN :a AND :b', { ':a': S('zz'), ':b': S('aa') });
scan('BETWEEN with bounds of two types', 'n BETWEEN :a AND :b', { ':a': S('zz'), ':b': N('1') });
scan('< on a set value', 'ss < :v', { ':v': { SS: ['z'] } });
scan('< between a number and a string is no match', 'n < :v', { ':v': S('x') });
scan('begins_with of a number value', 'begins_with(s, :v)', V1);
scan('begins_with of a number attribute is no match', 'begins_with(n, :v)', { ':v': S('5') });
scan('contains on a list', 'contains(l, :v)', { ':v': N('2.0') });
scan('contains on a string set', 'contains(ss, :v)', { ':v': S('a') });
scan('contains of a number in a string', 'contains(s, :v)', V1);
scan('<> of a missing attribute is true', 'zz <> :v', V1);
scan('= of a missing attribute is false', 'zz = :v', V1);
scan('sets compare without order', 'ss = :v', { ':v': { SS: ['b', 'a'] } });
scan('numbers compare by value', 'l = :v', { ':v': { L: [N('1.0'), N('2'), N('3e0')] } });
scan('strings compare by UTF-8 bytes', 'e > :v', { ':v': S('｡') });
scan('the empty string', 'em = :v', { ':v': S('') });
scan('binary compares by bytes', 'b > :v', { ':v': { B: '/w==' } });

// Placeholders and values
scan('a name key that is not a placeholder', 'n = :v', V1, { 'x': 'n' });
scan('a value key that is not a placeholder', 'n = :v', { 'v': N('1') });
scan('empty names', 'n = :v', V1, {});
scan('empty values', 'n = :v', {});
scan('a name standing for nothing', '#n = :v', V1, { '#n': '' });
scan('placeholder names may start with a digit', '#1 = :2', { ':2': N('5') }, { '#1': 'n' });
scan('placeholder with a dash', '#a-b = :v', V1, { '#a-b': 'n' });
scan('a placeholder name over 255 bytes', '#' + 'a'.repeat(300) + ' = :v', V1, { ['#' + 'a'.repeat(300)]: 'n' });
scan('a placeholder value over 255 bytes', 'n = :' + 'v'.repeat(300), { [':' + 'v'.repeat(300)]: N('1') });
scan('a value with two types', 'n = :v', { ':v': { N: '1', S: 'x' } });
scan('a value with no type', 'n = :v', { ':v': {} });
scan('an empty string set', 'n = :v', { ':v': { SS: [] } });
scan('an empty number set', 'n = :v', { ':v': { NS: [] } });
scan('an empty binary set', 'n = :v', { ':v': { BS: [] } });
scan('a string set with a repeat', 'n = :v', { ':v': { SS: ['b', 'a', 'b'] } });
scan('a number set with a repeat', 'n = :v', { ':v': { NS: ['1', '1.0'] } });
scan('a binary set with a repeat', 'n = :v', { ':v': { BS: ['AA==', 'AA=='] } });
scan('a number that is not one', 'n = :v', { ':v': N('abc') });
scan('39 significant digits', 'n = :v', { ':v': N('123456789012345678901234567890123456789') });
scan('too large', 'n = :v', { ':v': N('1E+126') });
scan('too small', 'n = :v', { ':v': N('1E-131') });
scan('trailing zeros do not count as digits', 'n = :v', { ':v': N('1.0000000000000000000000000000000000000000') });
scan('NULL false', 'n = :v', { ':v': { NULL: false } });
scan('a bad number inside a list', 'n = :v', { ':v': { L: [N('x')] } });
scan('an Arabic-Indic digit is a digit', 'n = :v', { ':v': N('٥') });

// Key conditions
query('partition key only', 'pk = :p', { ':p': S('p') });
query('with a sort key range', 'pk = :p AND sk > :s', { ':p': S('p'), ':s': N('2') });
query('in reverse', 'pk = :p', { ':p': S('p') }, null, { ScanIndexForward: false });
query('operands either way round', ':p = pk AND :s < sk', { ':p': S('p'), ':s': N('2') });
query('conditions in either order', 'sk > :s AND pk = :p', { ':p': S('p'), ':s': N('2') });
query('BETWEEN on the sort key', 'pk = :p AND sk BETWEEN :a AND :b', { ':p': S('p'), ':a': N('1'), ':b': N('3') });
query('OR', 'pk = :p OR sk > :s', { ':p': S('p'), ':s': N('2') });
query('NOT', 'pk = :p AND NOT sk = :s', { ':p': S('p'), ':s': N('2') });
query('<>', 'pk = :p AND sk <> :s', { ':p': S('p'), ':s': N('2') });
query('IN', 'pk = :p AND sk IN (:s)', { ':p': S('p'), ':s': N('2') });
query('no partition key', 'sk > :s', { ':s': N('2') });
query('partition key with >', 'pk > :p', { ':p': S('p') });
query('another attribute', 'pk = :p AND v > :s', { ':p': S('p'), ':s': N('2') });
query('two conditions on the sort key', 'pk = :p AND sk > :a AND sk < :b', { ':p': S('p'), ':a': N('1'), ':b': N('3') });
query('the wrong type for the partition key', 'pk = :n', { ':n': N('1') });
query('begins_with on a number sort key', 'pk = :p AND begins_with(sk, :b)', { ':p': S('p'), ':b': S('1') });
query('size in a key condition', 'pk = :p AND size(sk) > :s', { ':p': S('p'), ':s': N('0') });
query('attribute_exists in a key condition', 'pk = :p AND attribute_exists(sk)', { ':p': S('p') });
query('looking inside a key', 'pk.x = :p', { ':p': S('p') });
query('an empty partition key value', 'pk = :p', { ':p': S('') });
query('double parentheses', '((pk = :p))', { ':p': S('p') });
query('the filter cannot use the sort key', 'pk = :p', { ':p': S('p'), ':s': N('1') }, null, { FilterExpression: 'sk = :s' });
query('the filter comes first', 'pk = ', { ':p': S('p') }, null, { FilterExpression: 'v = ' });
query('then the projection', 'pk = ', { ':p': S('p') }, null, { ProjectionExpression: 'v,' });

// Updates
update('add one', 'SET n = n + :one', { ':one': N('1') });
update('arithmetic with a missing attribute', 'SET x = x + :one', { ':one': N('1') });
update('if_not_exists gives a start value', 'SET x = if_not_exists(x, :z) + :one', { ':one': N('1'), ':z': N('0') });
update('arithmetic on a string attribute', 'SET n = s + :one', { ':one': N('1') });
update('arithmetic on a string value', 'SET n = :s + :one', { ':one': N('1'), ':s': S('x') });
update('only one + per value', 'SET n = n - :one - :one', { ':one': N('1') });
update('list_append at the end', 'SET l = list_append(l, :v)', { ':v': { L: [N('4')] } });
update('list_append at the front', 'SET l = list_append(:v, l)', { ':v': { L: [N('0')] } });
update('list_append of a number', 'SET l = list_append(l, :v)', V1);
update('list_append to a missing list', 'SET x = list_append(if_not_exists(x, :e), :v)', { ':v': { L: [N('4')] }, ':e': { L: [] } });
update('set past the end of a list appends', 'SET l[10] = :v', { ':v': S('b') });
update('several past the end go in index order', 'SET l[11] = :w, l[10] = :v', { ':v': S('b'), ':w': S('c') });
update('remove two list entries by their old positions', 'REMOVE l[0], l[2]', null);
update('set and remove in one list', 'SET l[0] = :v REMOVE l[1]', { ':v': S('b') });
update('remove past the end does nothing', 'REMOVE l[5]', null);
update('remove a missing attribute does nothing', 'REMOVE x', null);
update('remove inside a missing map', 'REMOVE zz.y', null);
update('remove inside a string', 'REMOVE s[0]', null);
update('set inside a missing map', 'SET q.b = :v', { ':v': S('b') });
update('set inside a string', 'SET s.b = :v', { ':v': S('b') });
update('overlapping paths', 'SET m = :v, m.a = :v', { ':v': S('b') });
update('the same list entry twice', 'SET l[0] = :v REMOVE l[0]', { ':v': S('b') });
update('a list and a map at once', 'REMOVE m.x, m[1]', null);
update('SET twice', 'SET n = :v SET s = :v', { ':v': S('b') });
update('keywords in lower case', 'set n = :v', { ':v': N('9') });
update('a trailing comma', 'SET n = :v,', { ':v': N('9') });
update('an empty update', '', null);
update('a key attribute', 'SET pk = :v', { ':v': S('b') });
update('add to a number', 'ADD n :v', { ':v': N('2') });
update('add to a missing number', 'ADD x :v', { ':v': N('2') });
update('add to a string set', 'ADD ss :v', { ':v': { SS: ['c', 'a'] } });
update('add a number set to a string set', 'ADD ss :v', { ':v': { NS: ['1'] } });
update('add a string', 'ADD s :v', { ':v': S('x') });
update('add a list', 'ADD l :v', { ':v': { L: [N('1')] } });
update('add inside a map', 'ADD m.a :v', V1);
update('add a placeholder name instead of a value', 'ADD n #x', null, { '#x': 'n' });
update('delete from a string set', 'DELETE ss :v', { ':v': { SS: ['a'] } });
update('delete every member', 'DELETE ss :v', { ':v': { SS: ['a', 'b'] } });
update('delete a number', 'DELETE ns :v', V1);
update('delete from a missing set', 'DELETE xs :v', { ':v': { SS: ['zz'] } });
update('swap two attributes', 'SET n = s, s = n', null);
update('a placeholder name with a dot', 'SET #a = :v', V1, { '#a': 'm.a' });
update('precision of a sum', 'SET n = :a + :b', { ':a': N('12345678901234567890123456789012345678'), ':b': N('0.1') });
update('overflow of a sum', 'SET n = :a + :b', { ':a': N('5E125'), ':b': N('5E125') });
update('underflow of a difference', 'SET n = :a - :b', { ':a': N('2E-130'), ':b': N('1.5E-130') });
update('a zero difference keeps its decimals', 'SET n = :a - :b', { ':a': N('1.5'), ':b': N('1.5') });
update('a tiny zero difference', 'SET n = :a - :b', { ':a': N('1E-130'), ':b': N('1E-130') });
update('decimal sums are exact', 'SET n = :a + :b', { ':a': N('0.1'), ':b': N('0.2') });
update('the condition is checked first', 'SET n = s + :v', { ':v': N('1'), ':w': N('6') }, null, { ConditionExpression: 'n = :w' });
update('the update expression is checked before the condition', 'SET status = :v', V1, null, { ConditionExpression: 'size = :v' });
update('a function in the update', 'SET n = size(s)', null);
update('if_not_exists of a value', 'SET n = if_not_exists(:v, n)', V1);
update('a type error before a missing attribute', 'SET a = zz, b = s + :n', { ':n': N('1') });
update('the last section first for value types', 'ADD a :s DELETE b :n', { ':s': S('x'), ':n': N('1') });

// Projections
get('two attributes', 'n, s');
get('list entries keep their order', 'l[2], l[0]');
get('inside a map', 'm.inr.x, m.a');
get('a missing attribute', 'x');
get('the same path twice', 'n, n');
get('one path inside another', 'm.inr, m.inr.x');
get('a list and a map', 'l[0], l.x');
get('an empty projection', '');
get('a trailing comma', 'n,');
get('a placeholder and a name for the same attribute', '#a, n', { '#a': 'n' });

module.exports = cases;
