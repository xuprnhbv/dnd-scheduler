'use strict';

const { DateTime } = require('luxon');
const { currentWeekStart } = require('../slots');
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

function tallyCounts(playerResponses) {
  const counts = {};
  for (const slots of playerResponses) {
    for (const slot of slots) {
      counts[slot] = (counts[slot] || 0) + 1;
    }
  }
  return counts;
}

function findTopOptions(counts) {
  let max = 0;
  for (const v of Object.values(counts)) if (v > max) max = v;
  if (max === 0) return { max: 0, tied: [] };
  const tied = Object.entries(counts)
    .filter(([, v]) => v === max)
    .map(([name]) => name);
  return { max, tied };
}

// Keep only slots the DM said they can play (from the DM-only question).
// Returns { effectiveCounts, dmHadNoSlots }.
function applyDmFilter(counts, dmResponse) {
  const allowed = new Set(dmResponse);
  const effectiveCounts = {};
  for (const [slot, count] of Object.entries(counts)) {
    if (allowed.has(slot)) effectiveCounts[slot] = count;
  }
  return {
    effectiveCounts,
    dmHadNoSlots: Object.keys(effectiveCounts).length === 0,
  };
}

async function run({ config, db, whatsapp, googleForm, googleCalendar, now = new Date() }) {
  const weekStart = currentWeekStart(now, config.timezone);
  const state = db.getState(weekStart);

  if (!state || !state.mainPollId) {
    logger.info(`[announceWinner] no form announcement for week ${weekStart}; skipping`);
    return { skipped: true, reason: 'no-announcement' };
  }
  if (state.winnerAnnounced || state.tiebreakerPollId) {
    logger.info(`[announceWinner] already handled for week ${weekStart}; skipping`);
    return { skipped: true, reason: 'already-handled' };
  }

  const { playerResponses, dmResponse } = await googleForm.readResponses();

  if (!dmResponse) {
    const dmNoResponseText = config.messages.dmNoResponse
      || "⏳ The DM hasn't filled the form yet — holding off on picking a slot.";
    const dmNoResponseMsg = await whatsapp.sendText(config.groupId, dmNoResponseText);
    await whatsapp.pinMessage(dmNoResponseMsg);
    logger.info(`[announceWinner] DM has not responded yet for week ${weekStart}; will retry`);
    return { skipped: false, outcome: 'dm-no-response' };
  }

  const counts = tallyCounts(playerResponses);

  if (Object.keys(counts).length === 0) {
    const noRespMsg = await whatsapp.sendText(config.groupId, config.messages.noResponses);
    await whatsapp.pinMessage(noRespMsg);
    db.setWinner(weekStart, '');
    logger.info(`[announceWinner] no responses for week ${weekStart}`);
    return { skipped: false, outcome: 'no-responses' };
  }

  const { effectiveCounts, dmHadNoSlots } = applyDmFilter(counts, dmResponse);

  if (dmHadNoSlots) {
    const dmUnavailText = config.messages.dmUnavailable
      || '🎲 The DM has no available slots this week — session cancelled.';
    const dmUnavailMsg = await whatsapp.sendText(config.groupId, dmUnavailText);
    await whatsapp.pinMessage(dmUnavailMsg);
    db.setWinner(weekStart, '');
    logger.info(`[announceWinner] DM has no slots overlapping player picks for week ${weekStart}`);
    return { skipped: false, outcome: 'dm-unavailable' };
  }

  const eligible = Object.keys(effectiveCounts).join(', ');
  logger.info(`[announceWinner] DM filter applied — eligible slots: ${eligible}`);

  const { tied } = findTopOptions(effectiveCounts);

  if (tied.length === 1) {
    const winner = tied[0];
    db.setWinner(weekStart, winner);

    let calendarLink = null;
    if (googleCalendar) {
      const cal = await googleCalendar.createSessionEvent({ weekStart, slotLabel: winner, timezone: config.timezone });
      if (cal.ok) {
        calendarLink = cal.htmlLink;
        db.setCalendarEventLink(weekStart, calendarLink);
        logger.info(`[announceWinner] calendar event created: ${calendarLink}`);
      } else {
        logger.warn(`[announceWinner] calendar event skipped: ${cal.reason}`);
      }
    }

    const raw = renderTemplate(config.messages.winner, { slot: winner, calendarLink: calendarLink || '' });
    const text = appendCalendarLink(raw, calendarLink);
    const winnerMsg = await whatsapp.sendText(config.groupId, text);
    await whatsapp.pinMessage(winnerMsg);
    logger.info(`[announceWinner] winner: ${winner}`);
    return { skipped: false, outcome: 'winner', winner };
  }

  // Tie — post a tiebreaker WhatsApp poll with only the tied DM-approved options.
  const intro = renderTemplate(config.messages.tiebreakerIntro, {
    slots: tied.join(', '),
  });
  await whatsapp.sendText(config.groupId, intro);

  const msg = await whatsapp.sendPoll(config.groupId, intro, tied, {
    allowMultipleAnswers: false,
  });
  await whatsapp.pinMessage(msg);
  const pollId = msg.id && msg.id._serialized ? msg.id._serialized : String(msg.id || '');
  const ts = Math.floor(DateTime.now().setZone(config.timezone).toSeconds());
  db.setTiebreaker(weekStart, pollId, ts);

  logger.info(`[announceWinner] tie between ${tied.length} DM-approved options, tiebreaker ${pollId}`);
  return { skipped: false, outcome: 'tie', tied, tiebreakerPollId: pollId };
}

module.exports = { run, findTopOptions, tallyCounts, applyDmFilter };
