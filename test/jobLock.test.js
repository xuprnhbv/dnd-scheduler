'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { withJobLock } = require('../src/jobLock');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('withJobLock serializes runs of the same key', async () => {
  const order = [];
  let active = 0;
  let maxActive = 0;
  const task = (id) => async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    order.push(`start-${id}`);
    await sleep(30);
    order.push(`end-${id}`);
    active -= 1;
    return id;
  };

  const [r1, r2] = await Promise.all([
    withJobLock('k', task(1)),
    withJobLock('k', task(2)),
  ]);

  assert.equal(r1, 1);
  assert.equal(r2, 2);
  assert.equal(maxActive, 1, 'only one runner at a time for the same key');
  assert.deepEqual(order, ['start-1', 'end-1', 'start-2', 'end-2']);
});

test('withJobLock runs different keys concurrently', async () => {
  let active = 0;
  let maxActive = 0;
  const task = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await sleep(30);
    active -= 1;
  };

  await Promise.all([withJobLock('a', task), withJobLock('b', task)]);
  assert.equal(maxActive, 2, 'independent keys do not block each other');
});

test('withJobLock: a failing job does not wedge the lock for the next caller', async () => {
  await assert.rejects(withJobLock('k2', async () => { throw new Error('boom'); }));
  const r = await withJobLock('k2', async () => 'ok');
  assert.equal(r, 'ok');
});
