'use strict';

const { slotToDateRange } = require('./googlecalendar');

function resolveSlotRange({ weekStart, slotLabel, config }) {
  const cal = config && config.googleCalendar;
  if (!cal) return null;
  const { slotTimes, eventDurationHours = 5 } = cal;
  if (!slotTimes || !Object.keys(slotTimes).length) return null;
  try {
    return slotToDateRange(weekStart, slotLabel, slotTimes, eventDurationHours, config.timezone);
  } catch {
    return null;
  }
}

module.exports = { resolveSlotRange, slotToDateRange };
