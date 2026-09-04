'use strict';

// Serialize job runs by key across every trigger source in this process. The
// cron scheduler and the admin panel's manual-trigger routes can both call the
// same job, and each job's idempotency gate is a check-then-act with an `await`
// (the WhatsApp send) in the middle. Without a lock, a manual trigger racing the
// scheduled run passes the same still-open gate and both send — a duplicate.
//
// Each key owns a promise chain; a caller awaits the current tail before running,
// so at most one runner per key executes at a time. The second runner, once it
// acquires the lock, re-reads the (now-written) gate inside job.run() and skips.
//
// Keys are a small fixed set of job names, so the map never grows unbounded.

const chains = new Map();

function withJobLock(key, fn) {
  const prev = chains.get(key) || Promise.resolve();
  // Chain after prev regardless of how prev settled, so one job's failure does
  // not wedge the lock for the next caller.
  const next = prev.then(() => fn(), () => fn());
  // Store a never-rejecting tail so the next caller can await it without an
  // unhandled-rejection warning; the real result/rejection goes to this caller.
  chains.set(key, next.then(() => {}, () => {}));
  return next;
}

module.exports = { withJobLock };
