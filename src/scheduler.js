'use strict';

const cron = require('node-cron');
const logger = require('./logger');

const postFormLink = require('./jobs/postFormLink');
const sendReminder = require('./jobs/sendReminder');
const announceWinner = require('./jobs/announceWinner');
const announceTiebreaker = require('./jobs/announceTiebreaker');

const RETRY_DELAY_MS = 10 * 60 * 1000;
const MAX_RETRIES = 2;

// Wrap a job for cron: log start/finish, and retry a failed run a couple of
// times before giving up until the next scheduled fire. Jobs are idempotent
// (they check DB flags before acting, and flip them only after a successful
// send), so re-running after a transient failure is safe — and without it a
// failed send would silently wait a whole week. The `running`/`retryPending`
// flags keep retries from stacking or overlapping a live run.
function wrap(name, fn, { retries = MAX_RETRIES, retryDelayMs = RETRY_DELAY_MS } = {}) {
  let running = false;
  let retryPending = false;

  const runAttempt = async (attempt) => {
    if (running) {
      logger.warn(`[cron] ${name} skipped — previous run still in progress`);
      return;
    }
    running = true;
    const start = Date.now();
    logger.info(`[cron] ${name} starting${attempt > 0 ? ` (retry ${attempt}/${retries})` : ''}`);
    try {
      const result = await fn();
      logger.info(`[cron] ${name} done in ${Date.now() - start}ms`, result || {});
    } catch (err) {
      logger.error(`[cron] ${name} failed:`, err);
      if (attempt < retries && !retryPending) {
        retryPending = true;
        logger.info(`[cron] ${name} retrying in ${Math.round(retryDelayMs / 60000)} min (${attempt + 1}/${retries})`);
        const timer = setTimeout(() => {
          retryPending = false;
          runAttempt(attempt + 1).catch((e) => logger.error(`[cron] ${name} retry crashed:`, e));
        }, retryDelayMs);
        if (typeof timer.unref === 'function') timer.unref();
      }
    } finally {
      running = false;
    }
  };

  return () => runAttempt(0);
}

function start({ config, db, whatsapp, googleForm }) {
  const tz = config.timezone;
  const ctx = { config, db, whatsapp, googleForm };

  // Warmups, 15 minutes before each job: verify the browser is actually alive
  // and pay any reinit cost (~1-2 min) BEFORE the send fires, so the message
  // goes out the moment the job starts.
  cron.schedule('15 8 * * 0', wrap('warmup:postFormLink', () => whatsapp.warmup()), { timezone: tz });
  cron.schedule('15 8 * * 2', wrap('warmup:sendReminder', () => whatsapp.warmup()), { timezone: tz });
  cron.schedule('15 8 * * 3', wrap('warmup:announceWinner', () => whatsapp.warmup()), { timezone: tz });

  // Sunday 08:30 — announce the form link in the group
  cron.schedule('30 8 * * 0', wrap('postFormLink', () => postFormLink.run(ctx)), { timezone: tz });

  // Tuesday 08:30 — remind everyone to fill the form
  cron.schedule('30 8 * * 2', wrap('sendReminder', () => sendReminder.run(ctx)), { timezone: tz });

  // Wednesday 08:30 — announce winner or trigger tiebreaker
  cron.schedule('30 8 * * 3', wrap('announceWinner', () => announceWinner.run(ctx)), { timezone: tz });

  // Wednesday 19:45 — warm up only when a tiebreaker job will actually run;
  // a warmup can force a reinit, which isn't worth risking for a no-op.
  cron.schedule('45 19 * * 3', wrap('warmup:announceTiebreaker', async () => {
    const state = db.getState(require('./slots').currentWeekStart(new Date(), tz));
    if (state && state.tiebreakerPollId) {
      return whatsapp.warmup();
    }
    return { skipped: true, reason: 'no-tiebreaker' };
  }), { timezone: tz });

  // Wednesday 20:00 — announce tiebreaker winner (no-op if none)
  cron.schedule('0 20 * * 3', wrap('announceTiebreaker', async () => {
    const state = db.getState(require('./slots').currentWeekStart(new Date(), tz));
    if (state && state.tiebreakerPollId) {
      return announceTiebreaker.run(ctx);
    }
    return { skipped: true, reason: 'no-tiebreaker' };
  }), { timezone: tz });

  logger.info(`Scheduler started (timezone ${tz})`);
}

module.exports = {
  start,
  wrap,
  jobs: {
    postFormLink,
    sendReminder,
    announceWinner,
    announceTiebreaker,
  },
};
