'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveSlotRange } = require('../src/sessionTime');

const TZ = 'Asia/Jerusalem';
const WEEK_START = '2026-04-19'; // Sunday
const baseConfig = {
  timezone: TZ,
  googleCalendar: {
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

test('resolveSlotRange returns null when googleCalendar config is missing', () => {
  const r = resolveSlotRange({ weekStart: WEEK_START, slotLabel: 'Thu evening', config: { timezone: TZ } });
  assert.equal(r, null);
});

test('resolveSlotRange returns null when slotTimes is empty', () => {
  const r = resolveSlotRange({
    weekStart: WEEK_START,
    slotLabel: 'Thu evening',
    config: { timezone: TZ, googleCalendar: { slotTimes: {} } },
  });
  assert.equal(r, null);
});

test('resolveSlotRange returns null for an unknown slot label', () => {
  const r = resolveSlotRange({ weekStart: WEEK_START, slotLabel: 'Sat afternoon', config: baseConfig });
  assert.equal(r, null);
});

test('resolveSlotRange swallows invalid slot config and returns null', () => {
  const config = {
    timezone: TZ,
    googleCalendar: {
      slotTimes: { Bad: { dayOfWeek: 'funday', time: '20:00' } },
    },
  };
  const r = resolveSlotRange({ weekStart: WEEK_START, slotLabel: 'Bad', config });
  assert.equal(r, null);
});

test('resolveSlotRange defaults eventDurationHours to 5 when not set', () => {
  const config = {
    timezone: TZ,
    googleCalendar: {
      slotTimes: { 'Thu evening': { dayOfWeek: 'thursday', time: '20:00' } },
    },
  };
  const r = resolveSlotRange({ weekStart: WEEK_START, slotLabel: 'Thu evening', config });
  assert.equal(r.end.toMillis() - r.start.toMillis(), 5 * 60 * 60 * 1000);
});
