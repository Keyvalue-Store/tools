// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// A tiny client for DynamoDB Local over plain HTTP, with no SDK, used by
// record.js to ask the real thing. DynamoDB Local doesn't check signatures,
// so the request carries a placeholder one. Port: DDB_PORT, 8000 by default.

'use strict';
// node --test runs every .js file under a test folder; this one is a helper for record.js.
if (process.env.NODE_TEST_CONTEXT && require.main === module) return;
const http = require('http');
const agent = new http.Agent({ keepAlive: true, maxSockets: 8 });

function call(op, body) {
  const data = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: +(process.env.DDB_PORT || 8000), method: 'POST', path: '/', agent: agent,
      headers: {
        'Content-Type': 'application/x-amz-json-1.0', 'X-Amz-Target': 'DynamoDB_20120810.' + op,
        'Authorization': 'AWS4-HMAC-SHA256 Credential=local/20261006/us-east-1/dynamodb/aws4_request, SignedHeaders=host;x-amz-date, Signature=0000',
        'X-Amz-Date': '20261006T000000Z', 'Content-Length': data.length
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let j;
        try { j = JSON.parse(text); } catch (e) { j = { raw: text }; }
        if (res.statusCode === 200) resolve({ ok: true, data: j });
        else resolve({ ok: false, status: res.statusCode, type: String(j.__type || '').split('#').pop(), message: j.message || j.Message || text });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

// Drops and creates a table. keys: [[name, type], ...], partition key first.
async function table(name, keys) {
  await call('DeleteTable', { TableName: name });
  const r = await call('CreateTable', {
    TableName: name, BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: keys.map(([n, t]) => ({ AttributeName: n, AttributeType: t })),
    KeySchema: keys.map(([n], i) => ({ AttributeName: n, KeyType: i === 0 ? 'HASH' : 'RANGE' }))
  });
  if (!r.ok) throw new Error(r.message);
}

module.exports = { call: call, table: table };
