'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { wrap } = require('../src/scheduler');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

test('wrap retries a failed job and stops once it succeeds', async () => {
  let calls = 0;
  const trigger = wrap('test:flaky', async () => {
    calls += 1;
    if (calls < 2) throw new Error('boom');
    return { ok: true };
  }, { retries: 2, retryDelayMs: 20 });

  await trigger();
  assert.equal(calls, 1, 'first attempt ran synchronously with the trigger');

  await sleep(150);
  assert.equal(calls, 2, 'one retry fired, then no more after success');
});

test('wrap gives up after exhausting retries', async () => {
  let calls = 0;
  const trigger = wrap('test:always-fails', async () => {
    calls += 1;
    throw new Error('boom');
  }, { retries: 2, retryDelayMs: 10 });

  await trigger();
  await sleep(150);
  assert.equal(calls, 3, 'initial attempt + 2 retries, then stop');
});

test('wrap does not retry when the job succeeds', async () => {
  let calls = 0;
  const trigger = wrap('test:healthy', async () => {
    calls += 1;
    return { ok: true };
  }, { retries: 2, retryDelayMs: 10 });

  await trigger();
  await sleep(80);
  assert.equal(calls, 1);
});

test('wrap skips a trigger while a previous run is still in progress', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const trigger = wrap('test:slow', async () => {
    calls += 1;
    await gate;
  }, { retries: 0 });

  const first = trigger();
  await trigger(); // fires while the first run is still awaiting → skipped
  release();
  await first;
  assert.equal(calls, 1);
});
