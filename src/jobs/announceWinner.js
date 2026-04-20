'use strict';

const { DateTime } = require('luxon');
const { currentWeekStart } = require('../slots');
const logger = require('../logger');

function renderTemplate(tpl, vars) {
  return tpl.replace(/\{(\w+)\}/g, (_m, k) =>
    Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : `{${k}}`,
  );
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

async function run({ config, db, whatsapp, now = new Date() }) {
  const weekStart = currentWeekStart(now, config.timezone);
  const state = db.getState(weekStart);

  if (!state || !state.mainPollId) {
    logger.info(`[announceWinner] no main poll for week ${weekStart}; skipping`);
    return { skipped: true, reason: 'no-poll' };
  }
  if (state.winnerAnnounced || state.tiebreakerPollId) {
    logger.info(`[announceWinner] already handled for week ${weekStart}; skipping`);
    return { skipped: true, reason: 'already-handled' };
  }

  const { counts } = await whatsapp.readPollVotes(config.groupId, state.mainPollId);
  const { max, tied } = findTopOptions(counts);

  if (max === 0) {
    await whatsapp.sendText(config.groupId, config.messages.noVotes);
    db.setWinner(weekStart, '');
    logger.info(`[announceWinner] no votes for week ${weekStart}`);
    return { skipped: false, outcome: 'no-votes' };
  }

  if (tied.length === 1) {
    const winner = tied[0];
    const text = renderTemplate(config.messages.winner, { slot: winner });
    await whatsapp.sendText(config.groupId, text);
    db.setWinner(weekStart, winner);
    logger.info(`[announceWinner] winner: ${winner}`);
    return { skipped: false, outcome: 'winner', winner };
  }

  // Tie — post a tiebreaker poll with the tied options only.
  const intro = renderTemplate(config.messages.tiebreakerIntro, {
    slots: tied.join(', '),
  });
  await whatsapp.sendText(config.groupId, intro);

  const msg = await whatsapp.sendPoll(config.groupId, intro, tied, {
    allowMultipleAnswers: false,
  });
  const pollId = msg.id && msg.id._serialized ? msg.id._serialized : String(msg.id || '');
  const ts = Math.floor(DateTime.now().setZone(config.timezone).toSeconds());
  db.setTiebreaker(weekStart, pollId, ts);

  logger.info(`[announceWinner] tie between ${tied.length} options, tiebreaker ${pollId}`);
  return { skipped: false, outcome: 'tie', tied, tiebreakerPollId: pollId };
}

module.exports = { run, findTopOptions };
