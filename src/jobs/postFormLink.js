'use strict';

const { DateTime } = require('luxon');
const { currentWeekStart, weekRangeLabel } = require('../slots');
const logger = require('../logger');
const { renderTemplate } = require('./jobUtils');

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

  // Send + record-in-DB FIRST, then pin, then wipe last week's responses.
  // Otherwise a send failure (e.g. detached puppeteer frame) leaves the
  // group with no announcement AND the prior responses already deleted.
  logger.info(`[postFormLink] announcing form for week ${weekStart}`);
  const msg = await whatsapp.sendText(config.groupId, text);

  // Record the announcement immediately after the send succeeds, and BEFORE
  // pinning. Two real-world failure modes are guarded here:
  //   1. whatsapp-web.js occasionally resolves sendMessage with a degraded
  //      Message object whose id._serialized is empty (the model isn't fully
  //      hydrated yet — pin() is also missing, see the pinMessage warning).
  //      The message DID go out, so the week must still be marked announced.
  //      An empty string is not enough: db.js reads main_poll_id with `|| null`,
  //      so "" comes back as null and every downstream job (reminder, winner)
  //      treats the week as never announced and skips. Fall back to a synthetic
  //      non-empty id — mainPollId is only ever used as a truthy "announced"
  //      gate, never re-fetched as a message, so a synthetic value is safe.
  //   2. pinMessage can throw a transient puppeteer error; recording state
  //      before the pin means a pin failure can never leave the week unmarked
  //      (which would cause a duplicate announcement on the scheduler retry).
  const timestamp = Math.floor(DateTime.now().setZone(tz).toSeconds());
  const serialized = msg && msg.id && msg.id._serialized ? msg.id._serialized : '';
  const msgId = serialized || `sent:${weekStart}:${timestamp}`;
  if (!serialized) {
    logger.warn(`[postFormLink] send returned no usable message id; recording synthetic id ${msgId}`);
  }
  db.setMainPoll(weekStart, msgId, timestamp);

  await whatsapp.pinMessage(msg);

  if (googleForm) {
    try {
      await googleForm.deleteAllResponses();
    } catch (err) {
      logger.warn(`[postFormLink] deleteAllResponses failed after announcement; clear manually if needed: ${err.message}`);
    }
  }

  logger.info(`[postFormLink] announced form ${msgId} for week ${weekStart}`);
  return { skipped: false, weekStart, messageId: msgId };
}

module.exports = { run };
