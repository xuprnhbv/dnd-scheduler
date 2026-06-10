'use strict';

const { currentWeekStart } = require('../slots');
const logger = require('../logger');
const { renderTemplate } = require('./jobUtils');

async function run({ config, db, whatsapp, googleForm, now = new Date() }) {
  const weekStart = currentWeekStart(now, config.timezone);
  const state = db.getState(weekStart);

  if (!state || !state.mainPollId) {
    logger.info(`[sendReminder] no form announcement for week ${weekStart}; skipping`);
    return { skipped: true, reason: 'no-announcement' };
  }
  if (state.reminderSent) {
    logger.info(`[sendReminder] reminder already sent for week ${weekStart}; skipping`);
    return { skipped: true, reason: 'already-sent' };
  }

  const { playerResponses, dmResponse, attendanceCount, hasAttendance } = await googleForm.readResponses();
  // Count everyone who answered the "can I meet this week?" question (yes or no),
  // not just those who filled the availability grid. Fall back to grid responses
  // when no attendance question is configured.
  const filledCount = hasAttendance ? attendanceCount : playerResponses.length;
  const playerCount = Number(config.playerCount) || 0;

  if (playerCount > 0 && filledCount >= playerCount) {
    logger.info(`[sendReminder] ${filledCount}/${playerCount} already filled; skipping reminder`);
    db.setReminderSent(weekStart);
    return { skipped: true, reason: 'all-filled', filledCount, playerCount };
  }

  let text = renderTemplate(config.messages.reminder, {
    filledCount,
    playerCount,
    formUrl: config.googleForm.publicUrl,
  });

  if (!dmResponse && config.messages.dmNoResponse) {
    text += '\n\n' + renderTemplate(config.messages.dmNoResponse, {
      formUrl: config.googleForm.publicUrl,
    });
  }
  const msg = await whatsapp.sendText(config.groupId, text);
  await whatsapp.pinMessage(msg);
  db.setReminderSent(weekStart);

  logger.info(`[sendReminder] reminded — ${filledCount}/${playerCount} filled for week ${weekStart}`);
  return { skipped: false, filledCount, playerCount };
}

module.exports = { run };
