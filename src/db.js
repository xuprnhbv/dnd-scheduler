'use strict';

const path = require('path');
const Database = require('better-sqlite3');

const DEFAULT_DB_PATH = path.resolve(process.cwd(), 'state.db');

function open(dbPath = DEFAULT_DB_PATH) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return wrap(db);
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS poll_state (
      week_start TEXT PRIMARY KEY,
      main_poll_id TEXT,
      main_poll_timestamp INTEGER,
      tiebreaker_poll_id TEXT,
      tiebreaker_poll_timestamp INTEGER,
      winner_announced INTEGER NOT NULL DEFAULT 0,
      slots_locked INTEGER NOT NULL DEFAULT 0,
      reminder_sent INTEGER NOT NULL DEFAULT 0,
      winner_slot TEXT,
      tiebreaker_winner_announced INTEGER NOT NULL DEFAULT 0
    );

    DROP TABLE IF EXISTS weekly_slots;
  `);
  try {
    db.exec('ALTER TABLE poll_state ADD COLUMN calendar_event_link TEXT');
  } catch (err) {
    if (!err.message.includes('duplicate column name')) throw err;
  }
}

function rowToState(row) {
  if (!row) return null;
  return {
    weekStart: row.week_start,
    mainPollId: row.main_poll_id || null,
    mainPollTimestamp: row.main_poll_timestamp || null,
    tiebreakerPollId: row.tiebreaker_poll_id || null,
    tiebreakerPollTimestamp: row.tiebreaker_poll_timestamp || null,
    winnerAnnounced: row.winner_announced === 1,
    slotsLocked: row.slots_locked === 1,
    reminderSent: row.reminder_sent === 1,
    winnerSlot: row.winner_slot || null,
    tiebreakerWinnerAnnounced: row.tiebreaker_winner_announced === 1,
    calendarEventLink: row.calendar_event_link || null,
  };
}

function wrap(db) {
  const stmts = {
    getState: db.prepare('SELECT * FROM poll_state WHERE week_start = ?'),
    insertState: db.prepare(
      'INSERT OR IGNORE INTO poll_state (week_start) VALUES (?)',
    ),
    setMainPoll: db.prepare(
      'UPDATE poll_state SET main_poll_id = ?, main_poll_timestamp = ? WHERE week_start = ?',
    ),
    setReminderSent: db.prepare(
      'UPDATE poll_state SET reminder_sent = 1 WHERE week_start = ?',
    ),
    setWinner: db.prepare(
      'UPDATE poll_state SET winner_announced = 1, winner_slot = ? WHERE week_start = ?',
    ),
    setTiebreaker: db.prepare(
      'UPDATE poll_state SET tiebreaker_poll_id = ?, tiebreaker_poll_timestamp = ? WHERE week_start = ?',
    ),
    setTiebreakerWinner: db.prepare(
      'UPDATE poll_state SET tiebreaker_winner_announced = 1, winner_slot = ? WHERE week_start = ?',
    ),
    setCalendarEventLink: db.prepare(
      'UPDATE poll_state SET calendar_event_link = ? WHERE week_start = ?',
    ),
    allStates: db.prepare('SELECT * FROM poll_state ORDER BY week_start DESC LIMIT ?'),
  };

  function ensureState(weekStart) {
    stmts.insertState.run(weekStart);
    return rowToState(stmts.getState.get(weekStart));
  }

  function getState(weekStart) {
    return rowToState(stmts.getState.get(weekStart));
  }

  function setMainPoll(weekStart, pollId, timestamp) {
    ensureState(weekStart);
    stmts.setMainPoll.run(pollId, timestamp, weekStart);
  }

  function setReminderSent(weekStart) {
    ensureState(weekStart);
    stmts.setReminderSent.run(weekStart);
  }

  function setWinner(weekStart, slotLabel) {
    ensureState(weekStart);
    stmts.setWinner.run(slotLabel, weekStart);
  }

  function setTiebreaker(weekStart, pollId, timestamp) {
    ensureState(weekStart);
    stmts.setTiebreaker.run(pollId, timestamp, weekStart);
  }

  function setTiebreakerWinner(weekStart, slotLabel) {
    ensureState(weekStart);
    stmts.setTiebreakerWinner.run(slotLabel, weekStart);
  }

  function setCalendarEventLink(weekStart, link) {
    ensureState(weekStart);
    stmts.setCalendarEventLink.run(link, weekStart);
  }

  function recentStates(limit = 10) {
    return stmts.allStates.all(limit).map(rowToState);
  }

  function close() {
    db.close();
  }

  return {
    raw: db,
    ensureState,
    getState,
    setMainPoll,
    setReminderSent,
    setWinner,
    setTiebreaker,
    setTiebreakerWinner,
    setCalendarEventLink,
    recentStates,
    close,
  };
}

module.exports = { open };
