'use strict';

const { DateTime } = require('luxon');

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
  let candidate;
  if (dt.weekday === 7) {
    candidate = dt.startOf('day');
  } else {
    const daysUntilSunday = 7 - dt.weekday;
    candidate = dt.startOf('day').plus({ days: daysUntilSunday });
  }
  const pollMoment = candidate.set({ hour: 10, minute: 0, second: 0, millisecond: 0 });
  if (dt >= pollMoment) {
    return candidate.plus({ days: 7 }).toISODate();
  }
  return candidate.toISODate();
}

function weekRangeLabel(weekStartIso, timezone) {
  const start = DateTime.fromISO(weekStartIso, { zone: timezone });
  const end = start.plus({ days: 6 });
  return `${start.toFormat('dd LLL')} – ${end.toFormat('dd LLL yyyy')}`;
}

module.exports = {
  currentWeekStart,
  nextPollWeekStart,
  weekRangeLabel,
};
