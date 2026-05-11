'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  findTopOptions,
  tallyCounts,
  applyDmFilter,
} = require('../src/jobs/announceWinner');

test('tallyCounts counts yes and maybe across player responses', () => {
  const counts = tallyCounts([
    { yes: ['Thu 20:00', 'Fri 20:00'], maybe: ['Sat 10:00'] },
    { yes: ['Fri 20:00'], maybe: ['Thu 20:00'] },
    { yes: ['Thu 20:00', 'Sat 10:00'], maybe: [] },
  ]);
  assert.deepEqual(counts.yes, {
    'Thu 20:00': 2,
    'Fri 20:00': 2,
    'Sat 10:00': 1,
  });
  assert.deepEqual(counts.maybe, {
    'Sat 10:00': 1,
    'Thu 20:00': 1,
  });
});

test('tallyCounts on empty responses returns empty maps', () => {
  assert.deepEqual(tallyCounts([]), { yes: {}, maybe: {} });
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

test('applyDmFilter keeps only slots the DM can play (yes/maybe shape)', () => {
  const counts = {
    yes:   { 'Thu 20:00': 3, 'Fri 20:00': 2, 'Sat 10:00': 1 },
    maybe: { 'Fri 20:00': 1, 'Sat 10:00': 2 },
  };
  const { effectiveCounts, dmHadNoSlots } = applyDmFilter(counts, ['Thu 20:00', 'Sat 10:00']);
  assert.deepEqual(effectiveCounts.yes, { 'Thu 20:00': 3, 'Sat 10:00': 1 });
  assert.deepEqual(effectiveCounts.maybe, { 'Sat 10:00': 2 });
  assert.equal(dmHadNoSlots, false);
});

test('applyDmFilter flags dmHadNoSlots when no yes overlap', () => {
  const counts = { yes: { 'Thu 20:00': 3 }, maybe: {} };
  const { effectiveCounts, dmHadNoSlots } = applyDmFilter(counts, ['Fri 20:00']);
  assert.deepEqual(effectiveCounts.yes, {});
  assert.deepEqual(effectiveCounts.maybe, {});
  assert.equal(dmHadNoSlots, true);
});

test('applyDmFilter on empty DM response filters everything out', () => {
  const { effectiveCounts, dmHadNoSlots } = applyDmFilter(
    { yes: { 'Thu 20:00': 3 }, maybe: { 'Thu 20:00': 1 } },
    [],
  );
  assert.deepEqual(effectiveCounts.yes, {});
  assert.deepEqual(effectiveCounts.maybe, {});
  assert.equal(dmHadNoSlots, true);
});

test('applyDmFilter still supports legacy flat-counts shape', () => {
  const counts = { 'Thu 20:00': 3, 'Fri 20:00': 2 };
  const { effectiveCounts, dmHadNoSlots } = applyDmFilter(counts, ['Thu 20:00']);
  assert.deepEqual(effectiveCounts, { 'Thu 20:00': 3 });
  assert.equal(dmHadNoSlots, false);
});

test('yes-tie broken by maybe-counts resolves to single winner', () => {
  const { yes, maybe } = tallyCounts([
    { yes: ['Thu 20:00', 'Fri 20:00'], maybe: ['Sat 10:00'] },
    { yes: ['Thu 20:00'],              maybe: ['Fri 20:00'] },
    { yes: ['Fri 20:00'],              maybe: ['Fri 20:00'] },
  ]);
  // yes: Thu=2, Fri=2 (tie)
  const top = findTopOptions(yes);
  assert.deepEqual(top.tied.sort(), ['Fri 20:00', 'Thu 20:00']);
  const maybeAmongTied = {};
  for (const s of top.tied) maybeAmongTied[s] = maybe[s] || 0;
  const second = findTopOptions(maybeAmongTied);
  assert.deepEqual(second.tied, ['Fri 20:00']);
});

test('yes-tie still tied on maybe stays a tie', () => {
  const { yes, maybe } = tallyCounts([
    { yes: ['Thu 20:00', 'Fri 20:00'], maybe: [] },
    { yes: ['Thu 20:00', 'Fri 20:00'], maybe: [] },
  ]);
  const top = findTopOptions(yes);
  assert.deepEqual(top.tied.sort(), ['Fri 20:00', 'Thu 20:00']);
  const maybeAmongTied = {};
  for (const s of top.tied) maybeAmongTied[s] = maybe[s] || 0;
  const second = findTopOptions(maybeAmongTied);
  assert.equal(second.max, 0);
});
