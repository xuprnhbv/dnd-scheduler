'use strict';

const { DateTime } = require('luxon');
const { currentWeekStart, weekRangeLabel } = require('../slots');
const logger = require('../logger');

function renderTemplate(tpl, vars) {
  return tpl.replace(/\{(\w+)\}/g, (_m, k) =>
    Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : `{${k}}`,
  );
}

async function run({ config, db, whatsapp, googleForm, now = new Date() }) {
  const tz = config.timezone;
  const weekStart = currentWeekStart(now, tz);
  const state = db.ensureState(weekStart);

  if (state.mainPollId) {
    logger.info(`[postFormLink] week ${weekStart} already announced (${state.mainPollId}); skipping`);
    return { skipped: true, weekStart };
  }

  if (googleForm) {
    await googleForm.deleteAllResponses();
  }

  const text = renderTemplate(config.messages.formAnnouncement, {
    weekStart: weekRangeLabel(weekStart, tz),
    formUrl: config.googleForm.publicUrl,
  });

  logger.info(`[postFormLink] announcing form for week ${weekStart}`);
  const msg = await whatsapp.sendText(config.groupId, text);
  await whatsapp.pinMessage(msg);
  const msgId = msg && msg.id && msg.id._serialized ? msg.id._serialized : String((msg && msg.id) || '');
  const timestamp = Math.floor(DateTime.now().setZone(tz).toSeconds());
  db.setMainPoll(weekStart, msgId, timestamp);

  logger.info(`[postFormLink] announced form ${msgId} for week ${weekStart}`);
  return { skipped: false, weekStart, messageId: msgId };
}

module.exports = { run };
