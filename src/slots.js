'use strict';

const { DateTime } = require('luxon');

const DAY_NAMES = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];

const DAY_TO_ISO = Object.freeze({
  Monday: 1,
  Tuesday: 2,
  Wednesday: 3,
  Thursday: 4,
  Friday: 5,
  Saturday: 6,
  Sunday: 7,
});

function isValidDayName(day) {
  return Object.prototype.hasOwnProperty.call(DAY_TO_ISO, day);
}

function isValidTime(time) {
  if (typeof time !== 'string') return false;
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(time);
  return Boolean(m);
}

function isValidDuration(hours) {
  return typeof hours === 'number' && isFinite(hours) && hours > 0 && hours <= 24;
}

// Returns an ISO date string (YYYY-MM-DD) for the Sunday that starts the week
// containing `at` in the given timezone. "Week starts Sunday" — used both for
// storage keys and for rendering week ranges. If `at` is already a Sunday at
// any time, it is the week_start.
function currentWeekStart(at, timezone) {
  const dt = DateTime.fromJSDate(at, { zone: timezone }).startOf('day');
  // luxon weekday: 1=Mon ... 7=Sun
  const wd = dt.weekday;
  const daysSinceSunday = wd === 7 ? 0 : wd;
  return dt.minus({ days: daysSinceSunday }).toISODate();
}

// Returns the ISO date for the upcoming Sunday relative to `at` in the given TZ.
// If `at` is exactly Sunday 00:00 or later on Sunday, returns *this* Sunday.
// In other words: the Sunday whose 10:00 cron is the next one that will fire
// (assuming `at` is before that 10:00; if `at` is after Sunday 10:00, this
// returns the next week's Sunday).
function nextPollWeekStart(at, timezone) {
  const dt = DateTime.fromJSDate(at, { zone: timezone });
  const sundayThisWeek = dt.startOf('day').set({ weekday: 7 });
  // `set({ weekday: 7 })` maps to the Sunday of the current ISO week (Mon-based).
  // If today is Sunday, sundayThisWeek is today at 00:00.
  let candidate;
  if (dt.weekday === 7) {
    candidate = dt.startOf('day');
  } else {
    // next Sunday
    const daysUntilSunday = 7 - dt.weekday;
    candidate = dt.startOf('day').plus({ days: daysUntilSunday });
  }
  const pollMoment = candidate.set({ hour: 10, minute: 0, second: 0, millisecond: 0 });
  if (dt >= pollMoment) {
    return candidate.plus({ days: 7 }).toISODate();
  }
  return candidate.toISODate();
}

// Expand { days: [...], times: [...], durationHours } into an ordered array
// of slot objects: [{ day, time, durationHours }, ...].
function expandTemplate(template) {
  if (!template || !Array.isArray(template.days) || !Array.isArray(template.times)) {
    return [];
  }
  const out = [];
  for (const day of template.days) {
    for (const time of template.times) {
      out.push({ day, time, durationHours: template.durationHours });
    }
  }
  return out;
}

// Format HH:MM into HH:MM (24h, padded). Accepts H:MM too.
function pad2(n) {
  return n < 10 ? `0${n}` : `${n}`;
}

function formatSlotLabel(slot) {
  const [hStr, mStr] = slot.time.split(':');
  const startH = parseInt(hStr, 10);
  const startM = parseInt(mStr, 10);
  const totalMinutes = startH * 60 + startM + slot.durationHours * 60;
  const endH = Math.floor(totalMinutes / 60) % 24;
  const endM = Math.round(totalMinutes % 60);
  const start = `${pad2(startH)}:${pad2(startM)}`;
  const end = `${pad2(endH)}:${pad2(endM)}`;
  return `${slot.day} ${start}\u2013${end}`;
}

function formatSlotLabels(slots) {
  return slots.map(formatSlotLabel);
}

function validateSlots(slots) {
  if (!Array.isArray(slots) || slots.length === 0) {
    return { ok: false, error: 'At least one slot is required.' };
  }
  for (let i = 0; i < slots.length; i += 1) {
    const s = slots[i];
    if (!s || typeof s !== 'object') {
      return { ok: false, error: `Row ${i + 1}: invalid slot.` };
    }
    if (!isValidDayName(s.day)) {
      return { ok: false, error: `Row ${i + 1}: invalid day "${s.day}".` };
    }
    if (!isValidTime(s.time)) {
      return { ok: false, error: `Row ${i + 1}: invalid time "${s.time}".` };
    }
    if (!isValidDuration(s.durationHours)) {
      return { ok: false, error: `Row ${i + 1}: duration must be 0 < h ≤ 24.` };
    }
  }
  return { ok: true };
}

function weekRangeLabel(weekStartIso, timezone) {
  const start = DateTime.fromISO(weekStartIso, { zone: timezone });
  const end = start.plus({ days: 6 });
  return `${start.toFormat('dd LLL')} – ${end.toFormat('dd LLL yyyy')}`;
}

module.exports = {
  DAY_NAMES,
  DAY_TO_ISO,
  isValidDayName,
  isValidTime,
  isValidDuration,
  currentWeekStart,
  nextPollWeekStart,
  expandTemplate,
  formatSlotLabel,
  formatSlotLabels,
  validateSlots,
  weekRangeLabel,
};
