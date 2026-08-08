'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const postFormLink = require('../src/jobs/postFormLink');

// Minimal in-memory stand-in for src/db.js — mirrors the `main_poll_id || null`
// read semantics that make an empty-string id indistinguishable from "never
// announced". Avoids loading the better-sqlite3 native addon in unit tests.
function makeDb() {
  const rows = new Map();
  function ensureState(weekStart) {
    if (!rows.has(weekStart)) rows.set(weekStart, { weekStart, mainPollId: null });
    return rows.get(weekStart);
  }
  return {
    ensureState,
    getState(weekStart) { return rows.get(weekStart) || null; },
    setMainPoll(weekStart, pollId, timestamp) {
      const s = ensureState(weekStart);
      s.mainPollId = pollId || null; // matches db.js rowToState `|| null`
      s.mainPollTimestamp = timestamp;
    },
  };
}

function makeConfig() {
  return {
    timezone: 'Asia/Jerusalem',
    groupId: 'group@g.us',
    messages: { formAnnouncement: 'Vote for {{weekStart}}: {{formUrl}}' },
    googleForm: { publicUrl: 'https://forms.example/abc' },
  };
}

// A fake whatsapp whose sendText returns whatever message object the test
// supplies, and records pin calls. googleForm.deleteAllResponses is spied on.
function makeCtx(sentMsg) {
  const database = makeDb();
  const calls = { pinned: [], deleted: 0 };
  const whatsapp = {
    async sendText() { return sentMsg; },
    async pinMessage(m) { calls.pinned.push(m); },
  };
  const googleForm = {
    async deleteAllResponses() { calls.deleted += 1; },
  };
  return { config: makeConfig(), db: database, whatsapp, googleForm, calls };
}

test('postFormLink records mainPollId from a healthy message', async () => {
  const ctx = makeCtx({ id: { _serialized: 'true_group@g.us_ABC123' }, pin() {} });
  const res = await postFormLink.run({ ...ctx, now: new Date('2026-08-02T05:30:00Z') });

  const state = ctx.db.getState(res.weekStart);
  assert.equal(state.mainPollId, 'true_group@g.us_ABC123');
  assert.equal(ctx.calls.deleted, 1);
});

test('postFormLink still marks the week announced when the returned message has no usable id', async () => {
  // Reproduces the real 2026-08-02 failure: whatsapp-web.js resolved
  // sendMessage with a degraded object (empty id._serialized, no pin()).
  // The message went out, so the week MUST be marked announced — an empty
  // main_poll_id reads back as null and every downstream job skips the week.
  const ctx = makeCtx({ id: { _serialized: '' } });
  const res = await postFormLink.run({ ...ctx, now: new Date('2026-08-02T05:30:00Z') });

  const state = ctx.db.getState(res.weekStart);
  assert.ok(state.mainPollId, 'mainPollId must be non-empty so reminder/winner jobs run');
  assert.match(state.mainPollId, /^sent:/);
  // Downstream gate (db.js `|| null`) must treat it as announced.
  assert.notEqual(state.mainPollId, null);
});

test('postFormLink is idempotent: skips when already announced', async () => {
  const ctx = makeCtx({ id: { _serialized: 'true_group@g.us_ABC123' }, pin() {} });
  const now = new Date('2026-08-02T05:30:00Z');
  await postFormLink.run({ ...ctx, now });
  const second = await postFormLink.run({ ...ctx, now });

  assert.equal(second.skipped, true);
  assert.equal(ctx.calls.deleted, 1, 'responses must not be wiped again on the idempotent skip');
});
