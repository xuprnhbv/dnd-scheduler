'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const announceWinner = require('../src/jobs/announceWinner');
const {
  findTopOptions,
  tallyCounts,
  applyDmFilter,
} = announceWinner;

// --- fakes for run() behaviour tests ------------------------------------------

// getState/ensureState ignore the week key and return the single mutable state;
// run() only reads mainPollId / winnerAnnounced / tiebreakerPollId from it.
function makeDb(initial = { mainPollId: 'form1' }) {
  const state = { winnerAnnounced: false, tiebreakerPollId: null, ...initial };
  return {
    getState: () => ({ ...state }),
    ensureState: () => ({ ...state }),
    setWinner: (_w, slot) => { state.winnerAnnounced = true; state.winnerSlot = slot; },
    setTiebreaker: (_w, id, ts) => { state.tiebreakerPollId = id; state.tiebreakerPollTimestamp = ts; },
    _get: () => state,
  };
}

function makeWhatsapp({ pinThrows = false } = {}) {
  const calls = { sendText: [], sendPoll: [], sendEvent: [], pinned: [] };
  return {
    calls,
    async sendText(_chatId, text) { calls.sendText.push(text); return { id: { _serialized: `text_${calls.sendText.length}` } }; },
    async sendPoll(_chatId, question, options) { calls.sendPoll.push({ question, options }); return { id: { _serialized: `poll_${calls.sendPoll.length}` } }; },
    async sendEvent(_chatId, name) { calls.sendEvent.push(name); return { id: { _serialized: `event_${calls.sendEvent.length}` } }; },
    async pinMessage(m) { calls.pinned.push(m); if (pinThrows) throw new Error('pin boom'); },
  };
}

function makeConfig() {
  return {
    timezone: 'Asia/Jerusalem',
    groupId: 'g@g.us',
    // no sessionTimes → sendSessionAnnouncement falls back to sendText
    messages: {
      winner: 'Winner: {slot}',
      noResponses: 'no responses',
      tiebreakerIntro: 'tie among {slots}',
      dmUnavailable: 'dm unavailable',
    },
  };
}

const makeGoogleForm = (responses) => ({ async readResponses() { return responses; } });
const WED = new Date('2026-08-05T06:00:00Z');

test('run: tie path sends exactly one message — the poll, no redundant intro text', async () => {
  const db = makeDb();
  const whatsapp = makeWhatsapp();
  const googleForm = makeGoogleForm({
    playerResponses: [{ yes: ['A', 'B'], maybe: [] }, { yes: ['A', 'B'], maybe: [] }],
    dmResponse: ['A', 'B'],
  });
  const res = await announceWinner.run({ config: makeConfig(), db, whatsapp, googleForm, now: WED });

  assert.equal(res.outcome, 'tie');
  assert.equal(whatsapp.calls.sendPoll.length, 1, 'exactly one poll sent');
  assert.equal(whatsapp.calls.sendText.length, 0, 'no separate intro text (it lives in the poll question)');
  assert.ok(db._get().tiebreakerPollId, 'tiebreaker recorded before returning');
});

test('run: winner is recorded even when pinning throws (flag written before pin)', async () => {
  const db = makeDb();
  const whatsapp = makeWhatsapp({ pinThrows: true });
  const googleForm = makeGoogleForm({
    playerResponses: [{ yes: ['A'], maybe: [] }, { yes: ['A'], maybe: [] }],
    dmResponse: ['A'],
  });
  const res = await announceWinner.run({ config: makeConfig(), db, whatsapp, googleForm, now: WED });

  assert.equal(res.outcome, 'winner');
  assert.equal(res.winner, 'A');
  assert.equal(db._get().winnerAnnounced, true, 'winner recorded despite the pin failure');
});

test('run: an uncertain send failure propagates and records nothing', async () => {
  const db = makeDb();
  const whatsapp = makeWhatsapp();
  whatsapp.sendText = async () => { const e = new Error('sendText timed out'); e.uncertain = true; throw e; };
  const googleForm = makeGoogleForm({
    playerResponses: [{ yes: ['A'], maybe: [] }, { yes: ['A'], maybe: [] }],
    dmResponse: ['A'],
  });

  await assert.rejects(
    () => announceWinner.run({ config: makeConfig(), db, whatsapp, googleForm, now: WED }),
    (err) => err.uncertain === true,
  );
  assert.equal(db._get().winnerAnnounced, false, 'nothing recorded when the send is uncertain');
});

test('tallyCounts counts yes and maybe across player responses', () => {
  const counts = tallyCounts([
    { yes: ['Thu 20:00', 'Fri 20:00'], maybe: ['Sat 10:00'] },
    { yes: ['Fri 20:00'], maybe: ['Thu 20:00'] },
    { yes: ['Thu 20:00', 'Sat 10:00'], maybe: [] },
  ]);
  assert.deepEqual(counts.yes, {
    'Thu 20:00': 2,
    'Fri 20:00': 2,
    'Sat 10:00': 1,
  });
  assert.deepEqual(counts.maybe, {
    'Sat 10:00': 1,
    'Thu 20:00': 1,
  });
});

test('tallyCounts on empty responses returns empty maps', () => {
  assert.deepEqual(tallyCounts([]), { yes: {}, maybe: {} });
});

test('findTopOptions picks the single max', () => {
  const res = findTopOptions({ A: 1, B: 3, C: 2 });
  assert.equal(res.max, 3);
  assert.deepEqual(res.tied, ['B']);
});

test('findTopOptions returns all tied slots', () => {
  const res = findTopOptions({ A: 2, B: 2, C: 1 });
  assert.equal(res.max, 2);
  assert.deepEqual(res.tied.sort(), ['A', 'B']);
});

test('findTopOptions on no counts returns max 0 and empty tied', () => {
  const res = findTopOptions({});
  assert.equal(res.max, 0);
  assert.deepEqual(res.tied, []);
});

test('applyDmFilter keeps only slots the DM can play (yes/maybe shape)', () => {
  const counts = {
    yes:   { 'Thu 20:00': 3, 'Fri 20:00': 2, 'Sat 10:00': 1 },
    maybe: { 'Fri 20:00': 1, 'Sat 10:00': 2 },
  };
  const { effectiveCounts, dmHadNoSlots } = applyDmFilter(counts, ['Thu 20:00', 'Sat 10:00']);
  assert.deepEqual(effectiveCounts.yes, { 'Thu 20:00': 3, 'Sat 10:00': 1 });
  assert.deepEqual(effectiveCounts.maybe, { 'Sat 10:00': 2 });
  assert.equal(dmHadNoSlots, false);
});

test('applyDmFilter flags dmHadNoSlots when no yes overlap', () => {
  const counts = { yes: { 'Thu 20:00': 3 }, maybe: {} };
  const { effectiveCounts, dmHadNoSlots } = applyDmFilter(counts, ['Fri 20:00']);
  assert.deepEqual(effectiveCounts.yes, {});
  assert.deepEqual(effectiveCounts.maybe, {});
  assert.equal(dmHadNoSlots, true);
});

test('applyDmFilter on empty DM response filters everything out', () => {
  const { effectiveCounts, dmHadNoSlots } = applyDmFilter(
    { yes: { 'Thu 20:00': 3 }, maybe: { 'Thu 20:00': 1 } },
    [],
  );
  assert.deepEqual(effectiveCounts.yes, {});
  assert.deepEqual(effectiveCounts.maybe, {});
  assert.equal(dmHadNoSlots, true);
});

test('applyDmFilter still supports legacy flat-counts shape', () => {
  const counts = { 'Thu 20:00': 3, 'Fri 20:00': 2 };
  const { effectiveCounts, dmHadNoSlots } = applyDmFilter(counts, ['Thu 20:00']);
  assert.deepEqual(effectiveCounts, { 'Thu 20:00': 3 });
  assert.equal(dmHadNoSlots, false);
});

test('yes-tie broken by maybe-counts resolves to single winner', () => {
  const { yes, maybe } = tallyCounts([
    { yes: ['Thu 20:00', 'Fri 20:00'], maybe: ['Sat 10:00'] },
    { yes: ['Thu 20:00'],              maybe: ['Fri 20:00'] },
    { yes: ['Fri 20:00'],              maybe: ['Fri 20:00'] },
  ]);
  // yes: Thu=2, Fri=2 (tie)
  const top = findTopOptions(yes);
  assert.deepEqual(top.tied.sort(), ['Fri 20:00', 'Thu 20:00']);
  const maybeAmongTied = {};
  for (const s of top.tied) maybeAmongTied[s] = maybe[s] || 0;
  const second = findTopOptions(maybeAmongTied);
  assert.deepEqual(second.tied, ['Fri 20:00']);
});

test('yes-tie still tied on maybe stays a tie', () => {
  const { yes, maybe } = tallyCounts([
    { yes: ['Thu 20:00', 'Fri 20:00'], maybe: [] },
    { yes: ['Thu 20:00', 'Fri 20:00'], maybe: [] },
  ]);
  const top = findTopOptions(yes);
  assert.deepEqual(top.tied.sort(), ['Fri 20:00', 'Thu 20:00']);
  const maybeAmongTied = {};
  for (const s of top.tied) maybeAmongTied[s] = maybe[s] || 0;
  const second = findTopOptions(maybeAmongTied);
  assert.equal(second.max, 0);
});
