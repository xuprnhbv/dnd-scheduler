'use strict';

const { currentWeekStart } = require('../slots');
const { findTopOptions, sendSessionAnnouncement } = require('./announceWinner');
const logger = require('../logger');
const { renderTemplate } = require('./jobUtils');

async function run({ config, db, whatsapp, googleForm, now = new Date() }) {
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

  const text = renderTemplate(config.messages.tiebreakerWinner, { slot: winner });
  const winnerMsg = await sendSessionAnnouncement({
    whatsapp, config, weekStart, slotLabel: winner, text,
  });
  await whatsapp.pinMessage(winnerMsg);
  // Mark announced only after the message actually went out; if sendSessionAnnouncement
  // throws, the week stays unannounced and a retry will re-send.
  db.setTiebreakerWinner(weekStart, winner);

  logger.info(`[announceTiebreaker] tiebreaker winner: ${winner}`);
  return { skipped: false, winner };
}

module.exports = { run };
