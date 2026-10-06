// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Holds the open snapshot off the page's main thread, so reading a big file
// doesn't freeze the page. The page sends { id, method, args } and gets
// back { id, value } or { id, error }.

importScripts('../kubernetes.js', '../revisions.js', 'session.js');
const session = self.KVRevisionsSession(self.KVRevisions);
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const digest = self.crypto && self.crypto.subtle ? async (body) => hex(new Uint8Array(await self.crypto.subtle.digest('SHA-256', body))) : null;

self.onmessage = async (ev) => {
  const { id, method, args } = ev.data;
  try {
    if (method === 'ping') return self.postMessage({ id: id, value: 'pong' });
    const value = method === 'open' ? await session.open(args[0], args[1], digest) : session[method].apply(null, args);
    self.postMessage({ id: id, value: value });
  } catch (err) {
    self.postMessage({ id: id, error: err && err.message ? err.message : String(err) });
  }
};
