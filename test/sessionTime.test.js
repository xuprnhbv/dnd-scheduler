'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveSlotRange, slotToDateRange } = require('../src/sessionTime');
const { DEFAULT_TIME_KEYWORDS } = require('../src/slotParser');

const TZ = 'Asia/Jerusalem';
const WEEK_START = '2026-04-19'; // Sunday

// ── resolveSlotRange (reads from config.sessionTimes) ────────────────────────

const baseConfig = {
  timezone: TZ,
  sessionTimes: {
    eventDurationHours: 5,
    slotTimes: {
      'Thu evening': { dayOfWeek: 'thursday', time: '20:00' },
    },
  },
};

test('resolveSlotRange returns start/end for a configured slot', () => {
  const r = resolveSlotRange({ weekStart: WEEK_START, slotLabel: 'Thu evening', config: baseConfig });
  assert.ok(r);
  assert.equal(r.start.toFormat('yyyy-MM-dd HH:mm'), '2026-04-23 20:00');
  assert.equal(r.end.toFormat('yyyy-MM-dd HH:mm'), '2026-04-24 01:00');
});

test('resolveSlotRange returns null when sessionTimes config is missing', () => {
  const r = resolveSlotRange({ weekStart: WEEK_START, slotLabel: 'Thu evening', config: { timezone: TZ } });
  assert.equal(r, null);
});

test('resolveSlotRange returns null for an unknown non-Hebrew label', () => {
  const r = resolveSlotRange({ weekStart: WEEK_START, slotLabel: 'Sat afternoon', config: baseConfig });
  assert.equal(r, null);
});

test('resolveSlotRange swallows invalid slot config and returns null', () => {
  const config = {
    timezone: TZ,
    sessionTimes: {
      slotTimes: { Bad: { dayOfWeek: 'funday', time: '20:00' } },
    },
  };
  const r = resolveSlotRange({ weekStart: WEEK_START, slotLabel: 'Bad', config });
  assert.equal(r, null);
});

test('resolveSlotRange defaults eventDurationHours to 5 when not set', () => {
  const config = {
    timezone: TZ,
    sessionTimes: {
      slotTimes: { 'Thu evening': { dayOfWeek: 'thursday', time: '20:00' } },
    },
  };
  const r = resolveSlotRange({ weekStart: WEEK_START, slotLabel: 'Thu evening', config });
  assert.equal(r.end.toMillis() - r.start.toMillis(), 5 * 60 * 60 * 1000);
});

// ── slotToDateRange (low-level helper) ───────────────────────────────────────

const SLOT_TIMES = {
  'Thu evening': { dayOfWeek: 'thursday', time: '20:00' },
  'Fri morning': { dayOfWeek: 'friday', time: '10:00' },
};

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

test('slotToDateRange: resolves Hebrew label via parser when not in slotTimes', () => {
  const r = slotToDateRange(WEEK_START, 'שלישי ערב', {}, 5, TZ, DEFAULT_TIME_KEYWORDS);
  assert.ok(r !== null);
  assert.equal(r.start.toFormat('yyyy-MM-dd HH:mm'), '2026-04-21 20:00');
  assert.equal(r.end.toFormat('yyyy-MM-dd HH:mm'), '2026-04-22 01:00');
});

test('slotToDateRange: slotTimes override wins over parser for שבת ערב', () => {
  const slotTimes = { 'שבת ערב': { dayOfWeek: 'saturday', time: '18:00' } };
  const r = slotToDateRange(WEEK_START, 'שבת ערב', slotTimes, 5, TZ, DEFAULT_TIME_KEYWORDS);
  assert.ok(r !== null);
  assert.equal(r.start.toFormat('HH:mm'), '18:00');
});

test('slotToDateRange: returns null when label is unparseable and not in slotTimes', () => {
  const r = slotToDateRange(WEEK_START, 'gibberish slot', {}, 5, TZ, DEFAULT_TIME_KEYWORDS);
  assert.equal(r, null);
});

test('slotToDateRange: resolves Hebrew label with null slotTimes via parser', () => {
  const r = slotToDateRange(WEEK_START, 'חמישי בוקר', null, 5, TZ, DEFAULT_TIME_KEYWORDS);
  assert.ok(r !== null);
  assert.equal(r.start.toFormat('yyyy-MM-dd HH:mm'), '2026-04-23 10:00');
});
