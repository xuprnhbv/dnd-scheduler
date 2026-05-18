'use strict';

const { currentWeekStart } = require('../slots');
const { findTopOptions, sendSessionAnnouncement } = require('./announceWinner');
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

  // Reuse a calendar event from a prior attempt that crashed mid-flight,
  // so retries don't create duplicate events on the same calendar.
  let calendarLink = state.calendarEventLink || null;
  let slotUnparsed = false;
  if (googleCalendar && !calendarLink) {
    const cal = await googleCalendar.createSessionEvent({ weekStart, slotLabel: winner, timezone: config.timezone });
    if (cal.ok) {
      calendarLink = cal.htmlLink;
      db.setCalendarEventLink(weekStart, calendarLink);
      logger.info(`[announceTiebreaker] calendar event created: ${calendarLink}`);
    } else {
      logger.warn(`[announceTiebreaker] calendar event skipped: ${cal.reason}`);
      if (cal.reason === 'no-slot-mapping') slotUnparsed = true;
    }
  }

  const raw = renderTemplate(config.messages.tiebreakerWinner, { slot: winner, calendarLink: calendarLink || '' });
  const text = appendCalendarLink(raw, calendarLink);
  const winnerMsg = await sendSessionAnnouncement({
    whatsapp, config, weekStart, slotLabel: winner, text,
  });
  await whatsapp.pinMessage(winnerMsg);
  // Warn after the pin — so a transient failure of this follow-up doesn't block
  // the tiebreaker announcement itself from being marked as done.
  if (slotUnparsed && config.messages.unparsedWinner) {
    const warnText = renderTemplate(config.messages.unparsedWinner, { slot: winner });
    await whatsapp.sendText(config.groupId, warnText);
  }
  // Mark announced only after the message actually went out; if sendSessionAnnouncement
  // throws, the week stays unannounced and a retry will re-send.
  db.setTiebreakerWinner(weekStart, winner);

  logger.info(`[announceTiebreaker] tiebreaker winner: ${winner}`);
  return { skipped: false, winner };
}

module.exports = { run };
