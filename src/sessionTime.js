'use strict';

const { slotToDateRange } = require('./googlecalendar');

function resolveSlotRange({ weekStart, slotLabel, config }) {
  const cal = config && config.googleCalendar;
  if (!cal) return null;
  const { slotTimes, eventDurationHours = 5, slotTimeKeywords } = cal;
  try {
    return slotToDateRange(weekStart, slotLabel, slotTimes, eventDurationHours, config.timezone, slotTimeKeywords);
  } catch {
    return null;
  }
}

module.exports = { resolveSlotRange, slotToDateRange };
