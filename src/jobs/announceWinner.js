'use strict';

const { DateTime } = require('luxon');
const { currentWeekStart } = require('../slots');
const { resolveSlotRange } = require('../sessionTime');
const logger = require('../logger');
const { renderTemplate, sentMessageId, runStage } = require('./jobUtils');

const EVENT_TITLE_FORMAT = 'ccc, LLL d';

async function sendSessionAnnouncement({ whatsapp, config, weekStart, slotLabel, text }) {
  const range = resolveSlotRange({ weekStart, slotLabel, config });
  if (!range) {
    logger.warn('[announceWinner] slot times not configured; falling back to text announcement');
    return whatsapp.sendText(config.groupId, text);
  }
  const title = `\u{1F3B2} D&D Session - ${range.start.toFormat(EVENT_TITLE_FORMAT)}`;
  return whatsapp.sendEvent(config.groupId, title, range.start.toJSDate(), {
    endTime: range.end.toJSDate(),
    description: text,
  });
}

function tallyCounts(playerResponses) {
  const yes = {};
  const maybe = {};
  for (const r of playerResponses) {
    const y = (r && r.yes) || [];
    const m = (r && r.maybe) || [];
    for (const slot of y) yes[slot] = (yes[slot] || 0) + 1;
    for (const slot of m) maybe[slot] = (maybe[slot] || 0) + 1;
  }
  return { yes, maybe };
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
// `counts` may be a plain { slot: n } map (legacy) or { yes, maybe } pair.
// Returns the same shape as the input, plus dmHadNoSlots based on yes-counts
// (a slot with only "maybe" votes does not on its own make the DM available).
function applyDmFilter(counts, dmResponse) {
  const allowed = new Set(dmResponse);
  const filter = (m) => {
    const out = {};
    for (const [slot, count] of Object.entries(m || {})) {
      if (allowed.has(slot)) out[slot] = count;
    }
    return out;
  };
  if (counts && (counts.yes || counts.maybe)) {
    const yes = filter(counts.yes);
    const maybe = filter(counts.maybe);
    // Winner selection is driven by "yes" votes; "maybe" is only a tiebreaker.
    // If no DM-allowed slot has any yes vote, the DM has no usable slot.
    return {
      effectiveCounts: { yes, maybe },
      dmHadNoSlots: Object.keys(yes).length === 0,
    };
  }
  const effectiveCounts = filter(counts);
  return {
    effectiveCounts,
    dmHadNoSlots: Object.keys(effectiveCounts).length === 0,
  };
}

async function run({ config, db, whatsapp, googleForm, now = new Date() }) {
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
    // Intentionally repeatable: no gate is written, so the next scheduled run
    // re-nudges if the DM still hasn't voted.
    const dmNoResponseText = config.messages.dmNoResponse
      || "⏳ The DM hasn't filled the form yet — holding off on picking a slot.";
    await runStage({
      whatsapp,
      send: () => whatsapp.sendText(config.groupId, dmNoResponseText),
    });
    logger.info(`[announceWinner] DM has not responded yet for week ${weekStart}; will retry`);
    return { skipped: false, outcome: 'dm-no-response' };
  }

  const counts = tallyCounts(playerResponses);

  if (Object.keys(counts.yes).length === 0 && Object.keys(counts.maybe).length === 0) {
    await runStage({
      whatsapp,
      send: () => whatsapp.sendText(config.groupId, config.messages.noResponses),
      record: () => db.setWinner(weekStart, ''),
    });
    logger.info(`[announceWinner] no responses for week ${weekStart}`);
    return { skipped: false, outcome: 'no-responses' };
  }

  const { effectiveCounts, dmHadNoSlots } = applyDmFilter(counts, dmResponse);

  if (dmHadNoSlots) {
    const dmUnavailText = config.messages.dmUnavailable
      || '🎲 The DM has no available slots this week — session cancelled.';
    await runStage({
      whatsapp,
      send: () => whatsapp.sendText(config.groupId, dmUnavailText),
      record: () => db.setWinner(weekStart, ''),
    });
    logger.info(`[announceWinner] DM has no slots overlapping player picks for week ${weekStart}`);
    return { skipped: false, outcome: 'dm-unavailable' };
  }

  const eligible = Object.keys(effectiveCounts.yes).join(', ');
  logger.info(`[announceWinner] DM filter applied — eligible slots: ${eligible}`);

  let { tied } = findTopOptions(effectiveCounts.yes);

  if (tied.length > 1) {
    // Yes-vote tie: re-rank tied slots by "might come" counts.
    const maybeAmongTied = {};
    for (const slot of tied) maybeAmongTied[slot] = effectiveCounts.maybe[slot] || 0;
    const maybeTop = findTopOptions(maybeAmongTied);
    if (maybeTop.max > 0 && maybeTop.tied.length === 1) {
      logger.info(`[announceWinner] yes-vote tie broken by maybe-counts: ${tied.join(', ')} -> ${maybeTop.tied[0]}`);
      tied = maybeTop.tied;
    } else if (maybeTop.max > 0 && maybeTop.tied.length < tied.length) {
      // Maybe narrowed the tie but didn't fully resolve it — poll on the narrower set.
      logger.info(`[announceWinner] yes-vote tie narrowed by maybe-counts: ${tied.join(', ')} -> ${maybeTop.tied.join(', ')}`);
      tied = maybeTop.tied;
    }
  }

  if (tied.length === 1) {
    const winner = tied[0];
    const text = renderTemplate(config.messages.winner, { slot: winner });
    await runStage({
      whatsapp,
      send: () => sendSessionAnnouncement({ whatsapp, config, weekStart, slotLabel: winner, text }),
      // Record only after the send resolves and before the pin; a mid-send
      // failure leaves the week unannounced so a later run retries cleanly.
      record: () => db.setWinner(weekStart, winner),
    });
    logger.info(`[announceWinner] winner: ${winner}`);
    return { skipped: false, outcome: 'winner', winner };
  }

  // Tie — post a tiebreaker WhatsApp poll with only the tied DM-approved options.
  // The poll's question already carries the intro, so we do NOT also send it as
  // a separate text message (that was a redundant second send and the worst
  // duplicate-window in the old code).
  const intro = renderTemplate(config.messages.tiebreakerIntro, {
    slots: tied.join(', '),
  });
  let pollId;
  await runStage({
    whatsapp,
    send: () => whatsapp.sendPoll(config.groupId, intro, tied, { allowMultipleAnswers: false }),
    record: (msg) => {
      const ts = Math.floor(DateTime.now().setZone(config.timezone).toSeconds());
      const { id, synthetic } = sentMessageId(msg, `tie:${weekStart}`);
      pollId = id;
      if (synthetic) {
        logger.warn(`[announceWinner] tiebreaker poll returned no usable id; recorded synthetic ${id} (vote-reading may fail)`);
      }
      db.setTiebreaker(weekStart, id, ts);
    },
  });

  logger.info(`[announceWinner] tie between ${tied.length} DM-approved options, tiebreaker ${pollId}`);
  return { skipped: false, outcome: 'tie', tied, tiebreakerPollId: pollId };
}

module.exports = { run, findTopOptions, tallyCounts, applyDmFilter, sendSessionAnnouncement };
