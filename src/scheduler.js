'use strict';

const cron = require('node-cron');
const logger = require('./logger');

const createMainPoll = require('./jobs/createMainPoll');
const sendReminder = require('./jobs/sendReminder');
const announceWinner = require('./jobs/announceWinner');
const announceTiebreaker = require('./jobs/announceTiebreaker');
const seedNextWeekSlots = require('./jobs/seedNextWeekSlots');

function wrap(name, fn) {
  return async () => {
    const start = Date.now();
    logger.info(`[cron] ${name} starting`);
    try {
      const result = await fn();
      logger.info(`[cron] ${name} done in ${Date.now() - start}ms`, result || {});
    } catch (err) {
      logger.error(`[cron] ${name} failed:`, err);
    }
  };
}

function start({ config, db, whatsapp }) {
  const tz = config.timezone;
  const ctx = { config, db, whatsapp };

  // Sunday 10:00 — post main poll
  cron.schedule('0 10 * * 0', wrap('createMainPoll', () => createMainPoll.run(ctx)), { timezone: tz });

  // Tuesday 10:00 — remind non-voters
  cron.schedule('0 10 * * 2', wrap('sendReminder', () => sendReminder.run(ctx)), { timezone: tz });

  // Wednesday 10:00 — announce winner or trigger tiebreaker
  cron.schedule('0 10 * * 3', wrap('announceWinner', async () => {
    const result = await announceWinner.run(ctx);
    if (result && result.outcome !== 'tie') {
      await seedNextWeekSlots.run(ctx);
    }
    return result;
  }), { timezone: tz });

  // Wednesday 20:00 — announce tiebreaker winner (no-op if none)
  cron.schedule('0 20 * * 3', wrap('announceTiebreaker', async () => {
    const state = db.getState(require('./slots').currentWeekStart(new Date(), tz));
    if (state && state.tiebreakerPollId) {
      const result = await announceTiebreaker.run(ctx);
      await seedNextWeekSlots.run(ctx);
      return result;
    }
    return { skipped: true, reason: 'no-tiebreaker' };
  }), { timezone: tz });

  logger.info(`Scheduler started (timezone ${tz})`);
}

module.exports = {
  start,
  jobs: {
    createMainPoll,
    sendReminder,
    announceWinner,
    announceTiebreaker,
    seedNextWeekSlots,
  },
};
