'use strict';

const { DateTime } = require('luxon');
const {
  currentWeekStart,
  expandTemplate,
  formatSlotLabel,
  weekRangeLabel,
} = require('../slots');
const logger = require('../logger');

function renderTemplate(tpl, vars) {
  return tpl.replace(/\{(\w+)\}/g, (_m, k) =>
    Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : `{${k}}`,
  );
}

async function run({ config, db, whatsapp, now = new Date() }) {
  const tz = config.timezone;
  const weekStart = currentWeekStart(now, tz);
  const state = db.ensureState(weekStart);

  if (state.mainPollId) {
    logger.info(`[createMainPoll] week ${weekStart} already has poll ${state.mainPollId}; skipping`);
    return { skipped: true, weekStart };
  }

  const stored = db.getSlots(weekStart);
  const slots = Array.isArray(stored) && stored.length > 0 ? stored : expandTemplate(config.slotTemplate);

  if (slots.length === 0) {
    logger.warn(`[createMainPoll] no slots to post for week ${weekStart}; aborting`);
    return { skipped: true, reason: 'no-slots', weekStart };
  }

  const labels = slots.map(formatSlotLabel);
  const durations = Array.from(new Set(slots.map((s) => s.durationHours)));
  const durationStr = durations.length === 1 ? String(durations[0]) : durations.join('/');

  const question = renderTemplate(config.messages.pollQuestion, {
    weekStart: weekRangeLabel(weekStart, tz),
    duration: durationStr,
  });

  logger.info(`[createMainPoll] posting poll for week ${weekStart} with ${labels.length} options`);
  const msg = await whatsapp.sendPoll(config.groupId, question, labels, {
    allowMultipleAnswers: true,
  });

  const pollId = msg.id && msg.id._serialized ? msg.id._serialized : String(msg.id || '');
  const timestamp = Math.floor(DateTime.now().setZone(tz).toSeconds());
  db.setMainPoll(weekStart, pollId, timestamp);
  db.setSlotsLocked(weekStart, true);

  // Persist the slots used (even if from template) so the record is stable.
  if (!stored) db.upsertSlots(weekStart, slots);

  logger.info(`[createMainPoll] posted poll ${pollId} for week ${weekStart}`);
  return { skipped: false, weekStart, pollId, optionCount: labels.length };
}

module.exports = { run };
