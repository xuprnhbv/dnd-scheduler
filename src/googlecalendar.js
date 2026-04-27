'use strict';

const path = require('path');
const { google } = require('googleapis');
const { DateTime } = require('luxon');
const logger = require('./logger');

const SCOPES = ['https://www.googleapis.com/auth/calendar.events'];

const DAY_OFFSETS = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

function resolveKeyPath(keyPath) {
  if (!keyPath) throw new Error('googleCalendar.serviceAccountKeyPath is not set');
  return path.isAbsolute(keyPath) ? keyPath : path.resolve(process.cwd(), keyPath);
}

// Convert a (weekStart, slotLabel) pair into a concrete { start, end } DateTime
// pair using the configured slotTimes map and duration. Returns null if the slot
// label has no entry in slotTimes (caller should skip event creation).
function slotToDateRange(weekStart, slotLabel, slotTimes, durationHours, timezone) {
  const slotConfig = slotTimes && slotTimes[slotLabel];
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

function createGoogleCalendar(calendarConfig) {
  if (!calendarConfig) return null;

  const {
    calendarId,
    serviceAccountKeyPath,
    eventTitle = 'D&D Session',
    eventDurationHours = 5,
    slotTimes,
  } = calendarConfig;

  if (!calendarId) throw new Error('googleCalendar.calendarId is not set');
  if (!slotTimes || !Object.keys(slotTimes).length) {
    throw new Error('googleCalendar.slotTimes must map slot labels to { dayOfWeek, time }');
  }

  const keyFile = resolveKeyPath(serviceAccountKeyPath);
  const auth = new google.auth.GoogleAuth({ keyFile, scopes: SCOPES });
  const calendar = google.calendar({ version: 'v3', auth });

  // Creates a calendar event for the resolved slot. Returns { ok, htmlLink, eventId }
  // on success, or { ok: false, reason } if the slot has no time mapping or the
  // API call failed. Failures are logged but never thrown — calendar trouble
  // must not block the WhatsApp winner announcement.
  async function createSessionEvent({ weekStart, slotLabel, timezone }) {
    let range;
    try {
      range = slotToDateRange(weekStart, slotLabel, slotTimes, eventDurationHours, timezone);
    } catch (err) {
      logger.warn(`[googleCalendar] ${err.message}; skipping event`);
      return { ok: false, reason: 'invalid-slot-config' };
    }
    if (!range) {
      logger.warn(`[googleCalendar] no slotTimes entry for "${slotLabel}"; skipping event`);
      return { ok: false, reason: 'no-slot-mapping' };
    }

    try {
      const res = await calendar.events.insert({
        calendarId,
        requestBody: {
          summary: eventTitle,
          start: { dateTime: range.start.toISO(), timeZone: timezone },
          end: { dateTime: range.end.toISO(), timeZone: timezone },
        },
      });
      const htmlLink = res.data && res.data.htmlLink;
      const eventId = res.data && res.data.id;
      logger.info(`[googleCalendar] event created: ${eventId} (${htmlLink})`);
      return { ok: true, htmlLink, eventId };
    } catch (err) {
      logger.warn(`[googleCalendar] event creation failed: ${err.message}`);
      return { ok: false, reason: 'api-error', error: err.message };
    }
  }

  return {
    createSessionEvent,
    get calendarId() { return calendarId; },
    get eventTitle() { return eventTitle; },
    get eventDurationHours() { return eventDurationHours; },
  };
}

module.exports = {
  createGoogleCalendar,
  slotToDateRange,
  DAY_OFFSETS,
};
