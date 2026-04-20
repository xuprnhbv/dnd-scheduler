'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  formatSlotLabel,
  formatSlotLabels,
  expandTemplate,
  validateSlots,
  currentWeekStart,
  nextPollWeekStart,
} = require('../src/slots');

test('formatSlotLabel: 5h slot starting 10:00 on Thursday', () => {
  assert.equal(
    formatSlotLabel({ day: 'Thursday', time: '10:00', durationHours: 5 }),
    'Thursday 10:00\u201315:00',
  );
});

test('formatSlotLabel: crosses midnight wraps to 00:xx', () => {
  assert.equal(
    formatSlotLabel({ day: 'Saturday', time: '22:00', durationHours: 3 }),
    'Saturday 22:00\u201301:00',
  );
});

test('formatSlotLabel: half-hour duration', () => {
  assert.equal(
    formatSlotLabel({ day: 'Friday', time: '14:00', durationHours: 1.5 }),
    'Friday 14:00\u201315:30',
  );
});

test('expandTemplate produces day×time grid', () => {
  const expanded = expandTemplate({
    days: ['Thursday', 'Friday'],
    times: ['10:00', '20:00'],
    durationHours: 5,
  });
  assert.deepEqual(formatSlotLabels(expanded), [
    'Thursday 10:00\u201315:00',
    'Thursday 20:00\u201301:00',
    'Friday 10:00\u201315:00',
    'Friday 20:00\u201301:00',
  ]);
});

test('validateSlots accepts valid slots', () => {
  const res = validateSlots([
    { day: 'Thursday', time: '10:00', durationHours: 5 },
  ]);
  assert.equal(res.ok, true);
});

test('validateSlots rejects bad day', () => {
  const res = validateSlots([
    { day: 'Funday', time: '10:00', durationHours: 5 },
  ]);
  assert.equal(res.ok, false);
});

test('validateSlots rejects bad time', () => {
  const res = validateSlots([
    { day: 'Thursday', time: '25:00', durationHours: 5 },
  ]);
  assert.equal(res.ok, false);
});

test('validateSlots rejects bad duration', () => {
  const res = validateSlots([
    { day: 'Thursday', time: '10:00', durationHours: 0 },
  ]);
  assert.equal(res.ok, false);
  const res2 = validateSlots([
    { day: 'Thursday', time: '10:00', durationHours: 25 },
  ]);
  assert.equal(res2.ok, false);
});

test('validateSlots rejects empty', () => {
  assert.equal(validateSlots([]).ok, false);
});

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
  // Fri 2026-04-17 anytime -> next Sunday 2026-04-19
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
