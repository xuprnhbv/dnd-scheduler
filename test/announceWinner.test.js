'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  findTopOptions,
  tallyCounts,
  applyDmFilter,
} = require('../src/jobs/announceWinner');

test('tallyCounts counts each slot across player responses', () => {
  const counts = tallyCounts([
    ['Thu 20:00', 'Fri 20:00'],
    ['Fri 20:00'],
    ['Thu 20:00', 'Sat 10:00'],
  ]);
  assert.deepEqual(counts, {
    'Thu 20:00': 2,
    'Fri 20:00': 2,
    'Sat 10:00': 1,
  });
});

test('tallyCounts on empty responses returns empty object', () => {
  assert.deepEqual(tallyCounts([]), {});
});

test('findTopOptions picks the single max', () => {
  const res = findTopOptions({ A: 1, B: 3, C: 2 });
  assert.equal(res.max, 3);
  assert.deepEqual(res.tied, ['B']);
});

test('findTopOptions returns all tied slots', () => {
  const res = findTopOptions({ A: 2, B: 2, C: 1 });
  assert.equal(res.max, 2);
  assert.deepEqual(res.tied.sort(), ['A', 'B']);
});

test('findTopOptions on no counts returns max 0 and empty tied', () => {
  const res = findTopOptions({});
  assert.equal(res.max, 0);
  assert.deepEqual(res.tied, []);
});

test('applyDmFilter keeps only slots the DM can play', () => {
  const counts = { 'Thu 20:00': 3, 'Fri 20:00': 2, 'Sat 10:00': 1 };
  const { effectiveCounts, dmHadNoSlots } = applyDmFilter(counts, ['Thu 20:00', 'Sat 10:00']);
  assert.deepEqual(effectiveCounts, { 'Thu 20:00': 3, 'Sat 10:00': 1 });
  assert.equal(dmHadNoSlots, false);
});

test('applyDmFilter flags dmHadNoSlots when no overlap', () => {
  const counts = { 'Thu 20:00': 3 };
  const { effectiveCounts, dmHadNoSlots } = applyDmFilter(counts, ['Fri 20:00']);
  assert.deepEqual(effectiveCounts, {});
  assert.equal(dmHadNoSlots, true);
});

test('applyDmFilter on empty DM response filters everything out', () => {
  const { effectiveCounts, dmHadNoSlots } = applyDmFilter({ 'Thu 20:00': 3 }, []);
  assert.deepEqual(effectiveCounts, {});
  assert.equal(dmHadNoSlots, true);
});
