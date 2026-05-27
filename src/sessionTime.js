'use strict';

const { DateTime } = require('luxon');
const { parseSlotLabel, DEFAULT_TIME_KEYWORDS } = require('./slotParser');

const DAY_OFFSETS = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

// Convert a (weekStart, slotLabel) pair into { start, end } luxon DateTimes.
// Resolution order: explicit slotTimes override first, then parseSlotLabel using
// slotTimeKeywords (defaults to בוקר/צהריים/ערב). Returns null if the label
// can't be resolved either way.
function slotToDateRange(weekStart, slotLabel, slotTimes, durationHours, timezone, slotTimeKeywords) {
  let slotConfig = slotTimes && slotTimes[slotLabel];
  if (!slotConfig) {
    slotConfig = parseSlotLabel(slotLabel, slotTimeKeywords || DEFAULT_TIME_KEYWORDS);
  }
  if (!slotConfig) return null;
  const dayOffset = DAY_OFFSETS[String(slotConfig.dayOfWeek || '').toLowerCase()];
  if (dayOffset == null) {
    throw new Error(`Invalid dayOfWeek "${slotConfig.dayOfWeek}" for slot "${slotLabel}"`);
  }
  const timeStr = String(slotConfig.time || '');
  const m = /^(\d{1,2}):(\d{2})$/.exec(timeStr);
  if (!m) {
    throw new Error(`Invalid time "${timeStr}" for slot "${slotLabel}" — expected "HH:mm"`);
  }
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  const start = DateTime.fromISO(weekStart, { zone: timezone })
    .plus({ days: dayOffset })
    .set({ hour, minute, second: 0, millisecond: 0 });
  const end = start.plus({ hours: durationHours });
  return { start, end };
}

function resolveSlotRange({ weekStart, slotLabel, config }) {
  const st = config && config.sessionTimes;
  if (!st) return null;
  const { slotTimes, eventDurationHours = 5, slotTimeKeywords } = st;
  try {
    return slotToDateRange(weekStart, slotLabel, slotTimes, eventDurationHours, config.timezone, slotTimeKeywords);
  } catch {
    return null;
  }
}

module.exports = { resolveSlotRange, slotToDateRange, DAY_OFFSETS };
