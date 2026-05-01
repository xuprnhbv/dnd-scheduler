'use strict';

const { currentWeekStart } = require('../slots');
const { findTopOptions } = require('./announceWinner');
const logger = require('../logger');

function renderTemplate(tpl, vars) {
  return tpl.replace(/\{(\w+)\}/g, (_m, k) =>
    Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : `{${k}}`,
  );
}

function appendCalendarLink(text, link) {
  if (!link) return text;
  if (text.includes('{calendarLink}')) return text.replace('{calendarLink}', link);
  return `${text}\n📅 ${link}`;
}

async function run({ config, db, whatsapp, googleForm, googleCalendar, now = new Date() }) {
  const weekStart = currentWeekStart(now, config.timezone);
  const state = db.getState(weekStart);

  if (!state || !state.tiebreakerPollId) {
    logger.info(`[announceTiebreaker] no tiebreaker poll for week ${weekStart}; skipping`);
    return { skipped: true, reason: 'no-tiebreaker' };
  }
  if (state.tiebreakerWinnerAnnounced) {
    logger.info(`[announceTiebreaker] already announced for week ${weekStart}; skipping`);
    return { skipped: true, reason: 'already-announced' };
  }

  const { counts } = await whatsapp.readPollVotes(config.groupId, state.tiebreakerPollId);
  const { max, tied } = findTopOptions(counts);

  // If still tied in tiebreaker, pick the first one deterministically.
  let winner;
  if (max === 0) {
    // No votes in tiebreaker — fall back to the first tied option from the
    // original poll. We re-read the tiebreaker's option list for that.
    const optionNames = Object.keys(counts);
    winner = optionNames[0] || '(none)';
  } else {
    winner = tied[0];
  }

  db.setTiebreakerWinner(weekStart, winner);

  let calendarLink = null;
  if (googleCalendar) {
    const cal = await googleCalendar.createSessionEvent({ weekStart, slotLabel: winner, timezone: config.timezone });
    if (cal.ok) {
      calendarLink = cal.htmlLink;
      db.setCalendarEventLink(weekStart, calendarLink);
      logger.info(`[announceTiebreaker] calendar event created: ${calendarLink}`);
    } else {
      logger.warn(`[announceTiebreaker] calendar event skipped: ${cal.reason}`);
    }
  }

  const raw = renderTemplate(config.messages.tiebreakerWinner, { slot: winner, calendarLink: calendarLink || '' });
  const text = appendCalendarLink(raw, calendarLink);
  const winnerMsg = await whatsapp.sendText(config.groupId, text);
  await whatsapp.pinMessage(winnerMsg);

  logger.info(`[announceTiebreaker] tiebreaker winner: ${winner}`);
  return { skipped: false, winner };
}

module.exports = { run };
