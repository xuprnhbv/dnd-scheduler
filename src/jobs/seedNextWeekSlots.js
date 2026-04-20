'use strict';

const { DateTime } = require('luxon');
const { expandTemplate } = require('../slots');
const logger = require('../logger');

// Seeds a fresh editable weekly_slots row for the *next* upcoming week based
// on the configured slotTemplate. Idempotent: if a row already exists for the
// target week, does nothing.
async function run({ config, db, now = new Date() }) {
  const tz = config.timezone;
  // The next week_start is today's week_start + 7 days, where today is after
  // Wed 20:00 of the current week.
  const dt = DateTime.fromJSDate(now, { zone: tz }).startOf('day');
  const daysSinceSunday = dt.weekday === 7 ? 0 : dt.weekday;
  const thisWeekStart = dt.minus({ days: daysSinceSunday });
  const nextWeekStart = thisWeekStart.plus({ days: 7 }).toISODate();

  if (db.getSlots(nextWeekStart)) {
    logger.info(`[seedNextWeekSlots] slots already exist for ${nextWeekStart}; skipping`);
    return { skipped: true, weekStart: nextWeekStart };
  }

  const state = db.ensureState(nextWeekStart);
  if (state.slotsLocked) {
    logger.info(`[seedNextWeekSlots] ${nextWeekStart} is already locked; skipping`);
    return { skipped: true, weekStart: nextWeekStart };
  }

  const slots = expandTemplate(config.slotTemplate);
  db.upsertSlots(nextWeekStart, slots);
  db.setSlotsLocked(nextWeekStart, false);

  logger.info(`[seedNextWeekSlots] seeded ${slots.length} slots for ${nextWeekStart}`);
  return { skipped: false, weekStart: nextWeekStart, slotCount: slots.length };
}

module.exports = { run };
