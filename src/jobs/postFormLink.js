'use strict';

const { DateTime } = require('luxon');
const { currentWeekStart, weekRangeLabel } = require('../slots');
const logger = require('../logger');
const { renderTemplate, sentMessageId, runStage } = require('./jobUtils');

async function run({ config, db, whatsapp, googleForm, now = new Date() }) {
  const tz = config.timezone;
  const weekStart = currentWeekStart(now, tz);
  const state = db.ensureState(weekStart);

  if (state.mainPollId) {
    logger.info(`[postFormLink] week ${weekStart} already announced (${state.mainPollId}); skipping`);
    return { skipped: true, weekStart };
  }

  const text = renderTemplate(config.messages.formAnnouncement, {
    weekStart: weekRangeLabel(weekStart, tz),
    formUrl: config.googleForm.publicUrl,
  });

  logger.info(`[postFormLink] announcing form for week ${weekStart}`);
  let msgId;
  await runStage({
    whatsapp,
    send: () => whatsapp.sendText(config.groupId, text),
    // Record the announcement the instant the send resolves and BEFORE pinning,
    // so neither a pin hiccup nor a degraded (empty-id) return can leave the
    // week unmarked — which would resend on the scheduler retry.
    record: (msg) => {
      const timestamp = Math.floor(DateTime.now().setZone(tz).toSeconds());
      const { id, synthetic } = sentMessageId(msg, weekStart);
      msgId = id;
      if (synthetic) {
        logger.warn(`[postFormLink] send returned no usable message id; recording synthetic id ${id}`);
      }
      db.setMainPoll(weekStart, id, timestamp);
    },
    // deleteAllResponses runs LAST: a send failure must never wipe last week's
    // responses without a replacement announcement having gone out.
    after: async () => {
      if (!googleForm) return;
      try {
        await googleForm.deleteAllResponses();
      } catch (err) {
        logger.warn(`[postFormLink] deleteAllResponses failed after announcement; clear manually if needed: ${err.message}`);
      }
    },
  });

  logger.info(`[postFormLink] announced form ${msgId} for week ${weekStart}`);
  return { skipped: false, weekStart, messageId: msgId };
}

module.exports = { run };
