'use strict';

const { currentWeekStart } = require('../slots');
const { contactIdFromNumber } = require('../whatsapp');
const logger = require('../logger');

function renderTemplate(tpl, vars) {
  return tpl.replace(/\{(\w+)\}/g, (_m, k) =>
    Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : `{${k}}`,
  );
}

async function run({ config, db, whatsapp, now = new Date() }) {
  const weekStart = currentWeekStart(now, config.timezone);
  const state = db.getState(weekStart);

  if (!state || !state.mainPollId) {
    logger.info(`[sendReminder] no main poll for week ${weekStart}; skipping`);
    return { skipped: true, reason: 'no-poll' };
  }
  if (state.reminderSent) {
    logger.info(`[sendReminder] reminder already sent for week ${weekStart}; skipping`);
    return { skipped: true, reason: 'already-sent' };
  }

  const { allVoters } = await whatsapp.readPollVotes(config.groupId, state.mainPollId);
  const voted = new Set(allVoters);

  // Members from config, intersected with group participants so we don't tag
  // numbers that aren't in the group.
  let groupNumbers;
  try {
    groupNumbers = new Set(await whatsapp.getGroupParticipantNumbers(config.groupId));
  } catch (err) {
    logger.warn('[sendReminder] could not fetch group participants, proceeding with config only:', err.message);
    groupNumbers = null;
  }

  const nonVoters = config.members.filter((m) => {
    const num = String(m.number).replace(/[^0-9]/g, '');
    if (voted.has(num)) return false;
    if (groupNumbers && !groupNumbers.has(num)) return false;
    return true;
  });

  if (nonVoters.length === 0) {
    logger.info(`[sendReminder] everyone has voted for week ${weekStart}; skipping`);
    db.setReminderSent(weekStart);
    return { skipped: true, reason: 'all-voted' };
  }

  const mentionIds = nonVoters.map((m) => contactIdFromNumber(m.number));
  const mentionText = nonVoters.map((m) => `@${String(m.number).replace(/[^0-9]/g, '')}`).join(' ');

  const text = renderTemplate(config.messages.reminder, { mentions: mentionText });
  await whatsapp.sendText(config.groupId, text, { mentions: mentionIds });
  db.setReminderSent(weekStart);

  logger.info(`[sendReminder] reminded ${nonVoters.length} non-voters for week ${weekStart}`);
  return { skipped: false, reminded: nonVoters.length };
}

module.exports = { run };
