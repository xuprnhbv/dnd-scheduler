'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isTransientPuppeteerError } = require('../src/whatsapp');

test('isTransientPuppeteerError matches the real detached-frame error from 2026-05-17', () => {
  const err = new Error("Attempted to use detached Frame '24FAC92D739D98B4A8BAD55F93F528D0'.");
  assert.equal(isTransientPuppeteerError(err), true);
});

test('isTransientPuppeteerError matches all classified puppeteer transient errors', () => {
  const messages = [
    'Execution context was destroyed, most likely because of a navigation.',
    'Target closed.',
    'Protocol error (Runtime.callFunctionOn): Session closed. Most likely the page has been closed.',
    'Protocol error: foo',
  ];
  for (const m of messages) {
    assert.equal(isTransientPuppeteerError(new Error(m)), true, `should match: ${m}`);
  }
});

test('isTransientPuppeteerError ignores non-transient application errors', () => {
  assert.equal(isTransientPuppeteerError(new Error('Poll message not found: ABC')), false);
  assert.equal(isTransientPuppeteerError(new Error('Chat foo is not a group')), false);
  assert.equal(isTransientPuppeteerError(null), false);
  assert.equal(isTransientPuppeteerError(undefined), false);
  assert.equal(isTransientPuppeteerError({}), false);
  assert.equal(isTransientPuppeteerError(new Error('')), false);
});
