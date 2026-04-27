'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { slotToDateRange } = require('../src/googlecalendar');

const SLOT_TIMES = {
  'Thu evening': { dayOfWeek: 'thursday', time: '20:00' },
  'Fri morning': { dayOfWeek: 'friday', time: '10:00' },
};
const WEEK_START = '2026-04-19'; // Sunday
const TZ = 'Asia/Jerusalem';

test('slotToDateRange: Thu evening is Thursday +4 days at 20:00', () => {
  const r = slotToDateRange(WEEK_START, 'Thu evening', SLOT_TIMES, 5, TZ);
  assert.ok(r !== null);
  assert.equal(r.start.toFormat('yyyy-MM-dd HH:mm'), '2026-04-23 20:00');
  assert.equal(r.end.toFormat('yyyy-MM-dd HH:mm'), '2026-04-24 01:00');
});

test('slotToDateRange: Fri morning is Friday +5 days at 10:00', () => {
  const r = slotToDateRange(WEEK_START, 'Fri morning', SLOT_TIMES, 5, TZ);
  assert.ok(r !== null);
  assert.equal(r.start.toFormat('yyyy-MM-dd HH:mm'), '2026-04-24 10:00');
  assert.equal(r.end.toFormat('yyyy-MM-dd HH:mm'), '2026-04-24 15:00');
});

test('slotToDateRange: unknown slot label returns null without throwing', () => {
  const r = slotToDateRange(WEEK_START, 'Sat afternoon', SLOT_TIMES, 5, TZ);
  assert.equal(r, null);
});

test('slotToDateRange: invalid dayOfWeek throws with descriptive message', () => {
  const bad = { 'Bad slot': { dayOfWeek: 'funday', time: '10:00' } };
  assert.throws(
    () => slotToDateRange(WEEK_START, 'Bad slot', bad, 5, TZ),
    /Invalid dayOfWeek/,
  );
});

test('slotToDateRange: invalid time format throws with descriptive message', () => {
  const bad = { 'Bad slot': { dayOfWeek: 'thursday', time: '8am' } };
  assert.throws(
    () => slotToDateRange(WEEK_START, 'Bad slot', bad, 5, TZ),
    /Invalid time/,
  );
});

test('slotToDateRange: custom duration is reflected in end time', () => {
  const r = slotToDateRange(WEEK_START, 'Thu evening', SLOT_TIMES, 3, TZ);
  assert.ok(r !== null);
  assert.equal(r.end.toMillis() - r.start.toMillis(), 3 * 60 * 60 * 1000);
});

test('slotToDateRange: null slotTimes returns null without throwing', () => {
  const r = slotToDateRange(WEEK_START, 'Thu evening', null, 5, TZ);
  assert.equal(r, null);
});
