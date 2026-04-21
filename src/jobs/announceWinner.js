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

/**
 * If a dmNumber is configured, filter `counts` down to only the slots
 * that the DM voted for (i.e. the DM is available for those slots).
 * Returns { effectiveCounts, dmFiltered, dmHadNoSlots }.
 *   dmFiltered   — true if the filter was applied
 *   dmHadNoSlots — true if the DM voted for nothing (or didn't vote at all)
 */
function applyDmFilter(counts, voters, config) {
  if (!config.dmNumber) {
    return { effectiveCounts: counts, dmFiltered: false, dmHadNoSlots: false };
  }

  const dmNum = String(config.dmNumber).replace(/\D/g, '');
  const effectiveCounts = {};

  for (const [slot, count] of Object.entries(counts)) {
    const slotVoters = voters[slot] || [];
    if (slotVoters.map((n) => String(n).replace(/\D/g, '')).includes(dmNum)) {
      effectiveCounts[slot] = count;
    }
  }

  const dmHadNoSlots = Object.keys(effectiveCounts).length === 0;
  return { effectiveCounts, dmFiltered: true, dmHadNoSlots };
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

  const { counts, voters } = await whatsapp.readPollVotes(config.groupId, state.mainPollId);

  // --- DM availability filter ---
  const { effectiveCounts, dmFiltered, dmHadNoSlots } = applyDmFilter(counts, voters, config);

  if (dmFiltered) {
    if (dmHadNoSlots) {
      const msg = config.messages.dmUnavailable || '🎲 The DM has no available slots this week — session cancelled.';
      await whatsapp.sendText(config.groupId, msg);
      db.setWinner(weekStart, '');
      logger.info(`[announceWinner] DM (${config.dmNumber}) has no available slots for week ${weekStart}`);
      return { skipped: false, outcome: 'dm-unavailable' };
    }
    const eligible = Object.keys(effectiveCounts).join(', ');
    logger.info(`[announceWinner] DM filter applied — eligible slots: ${eligible}`);
  }

  const { max, tied } = findTopOptions(effectiveCounts);

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

  // Tie — post a tiebreaker poll with only the tied DM-approved options.
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

  logger.info(`[announceWinner] tie between ${tied.length} DM-approved options, tiebreaker ${pollId}`);
  return { skipped: false, outcome: 'tie', tied, tiebreakerPollId: pollId };
}

module.exports = { run, findTopOptions };
