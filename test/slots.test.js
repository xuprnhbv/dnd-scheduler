'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  currentWeekStart,
  nextPollWeekStart,
  weekRangeLabel,
} = require('../src/slots');

test('currentWeekStart on a Wednesday returns the prior Sunday', () => {
  // 2026-04-22 is a Wednesday
  const wed = new Date('2026-04-22T12:00:00Z');
  assert.equal(currentWeekStart(wed, 'Asia/Jerusalem'), '2026-04-19');
});

test('currentWeekStart on a Sunday returns that Sunday', () => {
  const sun = new Date('2026-04-19T08:00:00Z'); // Jerusalem offset puts it same day
  assert.equal(currentWeekStart(sun, 'Asia/Jerusalem'), '2026-04-19');
});

test('nextPollWeekStart: before Sunday 10:00 on same week returns that Sunday', () => {
  const fri = new Date('2026-04-17T12:00:00Z');
  assert.equal(nextPollWeekStart(fri, 'Asia/Jerusalem'), '2026-04-19');
});

test('nextPollWeekStart: after Sunday 10:00 rolls to next Sunday', () => {
  // Sunday 2026-04-19 at 08:00 UTC = 11:00 Jerusalem -> rolls to 2026-04-26
  const sun = new Date('2026-04-19T08:00:00Z');
  assert.equal(nextPollWeekStart(sun, 'Asia/Jerusalem'), '2026-04-26');
});

test('nextPollWeekStart: Sunday early morning returns same Sunday', () => {
  // Sunday 2026-04-19 at 05:00 UTC = 08:00 Jerusalem -> 2026-04-19
  const sun = new Date('2026-04-19T05:00:00Z');
  assert.equal(nextPollWeekStart(sun, 'Asia/Jerusalem'), '2026-04-19');
});

test('weekRangeLabel spans the correct Sunday-to-Saturday', () => {
  const label = weekRangeLabel('2026-04-19', 'Asia/Jerusalem');
  assert.equal(label, '19 Apr – 25 Apr 2026');
});
