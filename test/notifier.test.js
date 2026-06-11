'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createNotifier } = require('../src/notifier');

// Swap global.fetch for a stub for the duration of fn(), then restore it.
async function withFetchStub(stub, fn) {
  const original = global.fetch;
  global.fetch = stub;
  try {
    return await fn();
  } finally {
    global.fetch = original;
  }
}

test('send() no-ops (no fetch) when notifications are disabled', async () => {
  let called = false;
  const notifier = createNotifier({ notifications: { ntfy: { enabled: false, topic: 'x' } } });
  await withFetchStub(async () => { called = true; return { ok: true }; }, async () => {
    const result = await notifier.send({ title: 'hi', message: 'yo' });
    assert.equal(result.sent, false);
    assert.equal(result.reason, 'not-configured');
  });
  assert.equal(called, false, 'fetch must not be called when disabled');
});

test('send() no-ops when enabled but topic is missing', async () => {
  let called = false;
  const notifier = createNotifier({ notifications: { ntfy: { enabled: true, topic: '' } } });
  await withFetchStub(async () => { called = true; return { ok: true }; }, async () => {
    const result = await notifier.send({ message: 'yo' });
    assert.equal(result.sent, false);
  });
  assert.equal(called, false);
});

test('send() POSTs to <server>/<topic> with the expected headers when configured', async () => {
  const calls = [];
  const config = {
    notifications: {
      ntfy: { enabled: true, server: 'https://ntfy.sh', topic: 'dnd-bot-secret', authToken: 'tok' },
    },
  };
  const notifier = createNotifier(config);
  await withFetchStub(async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, statusText: 'OK' };
  }, async () => {
    const result = await notifier.send({ title: 'T', message: 'body', priority: 'urgent', tags: 'warning' });
    assert.equal(result.sent, true);
  });

  assert.equal(calls.length, 1);
  const { url, opts } = calls[0];
  assert.equal(url, 'https://ntfy.sh/dnd-bot-secret');
  assert.equal(opts.method, 'POST');
  assert.equal(opts.body, 'body');
  assert.equal(opts.headers.Title, 'T');
  assert.equal(opts.headers.Priority, 'urgent');
  assert.equal(opts.headers.Tags, 'warning');
  assert.equal(opts.headers.Authorization, 'Bearer tok');
});

test('send() strips a trailing slash from the server URL', async () => {
  const calls = [];
  const notifier = createNotifier({ notifications: { ntfy: { enabled: true, server: 'https://ntfy.example.com/', topic: 't' } } });
  await withFetchStub(async (url) => { calls.push(url); return { ok: true, status: 200 }; }, async () => {
    await notifier.send({ message: 'x' });
  });
  assert.equal(calls[0], 'https://ntfy.example.com/t');
});

test('send() swallows a fetch rejection and reports not-sent', async () => {
  const notifier = createNotifier({ notifications: { ntfy: { enabled: true, topic: 't' } } });
  const result = await withFetchStub(async () => { throw new Error('network down'); }, async () => {
    return notifier.send({ message: 'x' });
  });
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'network down');
});

test('send() treats a non-2xx response as not-sent', async () => {
  const notifier = createNotifier({ notifications: { ntfy: { enabled: true, topic: 't' } } });
  const result = await withFetchStub(async () => ({ ok: false, status: 403, statusText: 'Forbidden' }), async () => {
    return notifier.send({ message: 'x' });
  });
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'http-403');
});

test('isConfigured reflects enabled + topic', () => {
  assert.equal(createNotifier({}).isConfigured(), false);
  assert.equal(createNotifier({ notifications: { ntfy: { enabled: true, topic: '' } } }).isConfigured(), false);
  assert.equal(createNotifier({ notifications: { ntfy: { enabled: false, topic: 't' } } }).isConfigured(), false);
  assert.equal(createNotifier({ notifications: { ntfy: { enabled: true, topic: 't' } } }).isConfigured(), true);
});
