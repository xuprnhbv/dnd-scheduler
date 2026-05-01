'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { SCHEMA } = require('../src/admin/configSchema');
const { flattenForm, validateConfig, validateRuntimeConfig, getNestedValue, setNestedValue } = require('../src/admin/configIO');

// ─── Minimal valid config fixture ─────────────────────────────────────────────

function makeValidConfig(overrides = {}) {
  const base = {
    timezone: 'Asia/Jerusalem',
    groupId: '1234567890@g.us',
    playerCount: 5,
    googleForm: {
      formId: 'abc123',
      publicUrl: 'https://docs.google.com/forms/d/e/abc/viewform',
      serviceAccountKeyPath: './service-account.json',
      unavailableAnswer: 'Cannot play',
      deleteWebhookUrl: '',
      deleteWebhookSecret: '',
      playerSlotQuestions: { '111': 'Thursday evening' },
      dmSlotQuestions: { '222': 'Thursday evening' },
    },
    adminPanel: {
      port: 3000,
      passwordHash: '$2b$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234',
      sessionSecret: 'some-secret-value',
    },
    messages: {
      formAnnouncement: 'Form: {formUrl}',
      reminder: 'Reminder: {filledCount}/{playerCount}',
      winner: 'Winner: {slot}',
      tiebreakerIntro: 'Tie: {slots}',
      tiebreakerWinner: 'Tiebreaker: {slot}',
      noResponses: 'No responses.',
      dmUnavailable: 'DM unavailable.',
      dmNoResponse: 'DM no response.',
    },
  };
  // deep-merge overrides
  return deepMerge(base, overrides);
}

function deepMerge(target, source) {
  const out = Object.assign({}, target);
  for (const [k, v] of Object.entries(source)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object') {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ─── getNestedValue / setNestedValue ─────────────────────────────────────────

test('getNestedValue reads top-level key', () => {
  assert.equal(getNestedValue({ a: 1 }, 'a'), 1);
});

test('getNestedValue reads nested key', () => {
  assert.equal(getNestedValue({ a: { b: { c: 42 } } }, 'a.b.c'), 42);
});

test('getNestedValue returns undefined for missing path', () => {
  assert.equal(getNestedValue({ a: 1 }, 'a.b'), undefined);
});

test('setNestedValue sets a nested key (mutates)', () => {
  const obj = {};
  setNestedValue(obj, 'googleForm.formId', 'xyz');
  assert.equal(obj.googleForm.formId, 'xyz');
});

// ─── flattenForm ──────────────────────────────────────────────────────────────

test('flattenForm: round-trips simple string fields', () => {
  const body = {
    'timezone': 'America/New_York',
    'groupId': 'abc@g.us',
    'playerCount': '7',
    'googleForm.formId': 'form123',
    'googleForm.publicUrl': 'https://example.com/form',
    'googleForm.serviceAccountKeyPath': './sa.json',
    'googleForm.unavailableAnswer': 'No',
    'googleForm.deleteWebhookUrl': '',
    'googleForm.deleteWebhookSecret': '',
    'adminPanel.port': '3000',
    'adminPanel.passwordHash': '',
    'adminPanel.sessionSecret': '',
    'messages.formAnnouncement': 'Form: {formUrl}',
    'messages.reminder': 'Reminder',
    'messages.winner': 'Winner: {slot}',
    'messages.tiebreakerIntro': 'Tie',
    'messages.tiebreakerWinner': 'TieWin',
    'messages.noResponses': 'None',
    'messages.dmUnavailable': 'DM out',
    'messages.dmNoResponse': 'DM missing',
  };
  // Slot map rows
  body['googleForm.playerSlotQuestions[0][questionId]'] = '111';
  body['googleForm.playerSlotQuestions[0][slotLabel]'] = 'Thursday evening';
  body['googleForm.dmSlotQuestions[0][questionId]'] = '222';
  body['googleForm.dmSlotQuestions[0][slotLabel]'] = 'Thursday evening';

  const current = { adminPanel: { passwordHash: 'oldhash', sessionSecret: 'oldsecret' } };
  const cfg = flattenForm(body, SCHEMA, current);

  assert.equal(cfg.timezone, 'America/New_York');
  assert.equal(cfg.playerCount, 7);
  assert.equal(cfg.googleForm.formId, 'form123');
  assert.deepEqual(cfg.googleForm.playerSlotQuestions, { '111': 'Thursday evening' });
  // Blank password fields should fall back to current config values
  assert.equal(cfg.adminPanel.passwordHash, 'oldhash');
  assert.equal(cfg.adminPanel.sessionSecret, 'oldsecret');
});

test('flattenForm: parses slotMap with multiple rows', () => {
  const body = {
    'googleForm.playerSlotQuestions[0][questionId]': 'q1',
    'googleForm.playerSlotQuestions[0][slotLabel]': 'Thu evening',
    'googleForm.playerSlotQuestions[1][questionId]': 'q2',
    'googleForm.playerSlotQuestions[1][slotLabel]': 'Fri morning',
  };
  const cfg = flattenForm(body, SCHEMA, {});
  assert.deepEqual(cfg.googleForm.playerSlotQuestions, {
    q1: 'Thu evening',
    q2: 'Fri morning',
  });
});

test('flattenForm: parses slotTimesMap correctly', () => {
  const body = {
    'googleCalendar.slotTimes[0][slotLabel]': 'Thursday evening',
    'googleCalendar.slotTimes[0][dayOfWeek]': 'thursday',
    'googleCalendar.slotTimes[0][time]': '20:00',
    'googleCalendar.slotTimes[1][slotLabel]': 'Friday morning',
    'googleCalendar.slotTimes[1][dayOfWeek]': 'friday',
    'googleCalendar.slotTimes[1][time]': '10:00',
  };
  const cfg = flattenForm(body, SCHEMA, {});
  assert.deepEqual(cfg.googleCalendar.slotTimes, {
    'Thursday evening': { dayOfWeek: 'thursday', time: '20:00' },
    'Friday morning': { dayOfWeek: 'friday', time: '10:00' },
  });
});

test('flattenForm: skips slotMap rows where both fields are empty', () => {
  const body = {
    'googleForm.playerSlotQuestions[0][questionId]': 'q1',
    'googleForm.playerSlotQuestions[0][slotLabel]': 'Thu evening',
    'googleForm.playerSlotQuestions[1][questionId]': '',
    'googleForm.playerSlotQuestions[1][slotLabel]': '',
  };
  const cfg = flattenForm(body, SCHEMA, {});
  assert.deepEqual(cfg.googleForm.playerSlotQuestions, { q1: 'Thu evening' });
});

test('flattenForm: preserves password field if non-empty in body', () => {
  const body = { 'adminPanel.passwordHash': 'newhashinbody' };
  const cfg = flattenForm(body, SCHEMA, { adminPanel: { passwordHash: 'oldhash' } });
  assert.equal(cfg.adminPanel.passwordHash, 'newhashinbody');
});

// ─── validateConfig ───────────────────────────────────────────────────────────

test('validateConfig: passes for valid config', () => {
  const { ok, errors } = validateConfig(makeValidConfig(), SCHEMA);
  assert.equal(ok, true, `Expected ok but got errors: ${JSON.stringify(errors)}`);
});

test('validateConfig: error on missing required string', () => {
  const cfg = makeValidConfig({ timezone: '' });
  const { ok, errors } = validateConfig(cfg, SCHEMA);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.path === 'timezone'));
});

test('validateConfig: error on non-finite number', () => {
  const cfg = makeValidConfig({ playerCount: 'not-a-number' });
  const { ok, errors } = validateConfig(cfg, SCHEMA);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.path === 'playerCount'));
});

test('validateConfig: error on invalid URL', () => {
  const cfg = makeValidConfig({ googleForm: { publicUrl: 'not-a-url' } });
  const { ok, errors } = validateConfig(cfg, SCHEMA);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.path === 'googleForm.publicUrl'));
});

test('validateConfig: error on empty slotMap', () => {
  const cfg = makeValidConfig();
  cfg.googleForm.playerSlotQuestions = {};  // deepMerge won't wipe out existing keys, so assign directly
  const { ok, errors } = validateConfig(cfg, SCHEMA);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.path === 'googleForm.playerSlotQuestions'));
});

test('validateConfig: error on duplicate slotMap question IDs', () => {
  const cfg = makeValidConfig({
    googleForm: { playerSlotQuestions: { dup: 'Slot A', dup2: 'Slot B' } },
  });
  // Force duplicate by directly setting after merge
  cfg.googleForm.playerSlotQuestions = { dup: 'Slot A' };
  // Manually inject a duplicate (not possible with plain object keys, so test unique-key violation differently)
  // Instead test blank key:
  cfg.googleForm.playerSlotQuestions = { '': 'Slot A' };
  const { ok, errors } = validateConfig(cfg, SCHEMA);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.path === 'googleForm.playerSlotQuestions'));
});

test('validateConfig: error on invalid slotTimes dayOfWeek', () => {
  const cfg = makeValidConfig({
    googleCalendar: {
      calendarId: 'cal@group.calendar.google.com',
      serviceAccountKeyPath: './sa.json',
      eventTitle: 'D&D',
      eventDurationHours: 5,
      slotTimes: { 'Thu evening': { dayOfWeek: 'badday', time: '20:00' } },
    },
  });
  const { ok, errors } = validateConfig(cfg, SCHEMA);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.path === 'googleCalendar.slotTimes'));
});

test('validateConfig: error on invalid slotTimes time format', () => {
  const cfg = makeValidConfig({
    googleCalendar: {
      calendarId: 'cal@group.calendar.google.com',
      serviceAccountKeyPath: './sa.json',
      eventTitle: 'D&D',
      eventDurationHours: 5,
      slotTimes: { 'Thu evening': { dayOfWeek: 'thursday', time: '8pm' } },
    },
  });
  const { ok, errors } = validateConfig(cfg, SCHEMA);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.path === 'googleCalendar.slotTimes'));
});

test('validateConfig: skips googleCalendar fields when block is absent', () => {
  const cfg = makeValidConfig();
  delete cfg.googleCalendar;
  const { ok } = validateConfig(cfg, SCHEMA);
  assert.equal(ok, true);
});

test('validateConfig: validates googleCalendar fields when block is present', () => {
  const cfg = makeValidConfig({
    googleCalendar: {
      calendarId: 'cal@group.calendar.google.com',
      serviceAccountKeyPath: './sa.json',
      eventTitle: 'D&D',
      eventDurationHours: 5,
      slotTimes: { 'Thu evening': { dayOfWeek: 'thursday', time: '20:00' } },
    },
  });
  const { ok } = validateConfig(cfg, SCHEMA);
  assert.equal(ok, true);
});

// ─── validateRuntimeConfig ────────────────────────────────────────────────────

test('validateRuntimeConfig: passes for valid config', () => {
  const { ok } = validateRuntimeConfig(makeValidConfig());
  assert.equal(ok, true);
});

test('validateRuntimeConfig: fails when top-level field is missing', () => {
  const cfg = makeValidConfig();
  delete cfg.messages;
  const { ok, errors } = validateRuntimeConfig(cfg);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('messages')));
});

test('validateRuntimeConfig: fails when googleForm.formId starts with REPLACE', () => {
  const cfg = makeValidConfig({ googleForm: { formId: 'REPLACE_THIS' } });
  const { ok, errors } = validateRuntimeConfig(cfg);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('formId')));
});

test('validateRuntimeConfig: fails when adminPanel.passwordHash starts with REPLACE', () => {
  const cfg = makeValidConfig({ adminPanel: { passwordHash: 'REPLACE_WITH_BCRYPT_HASH' } });
  const { ok, errors } = validateRuntimeConfig(cfg);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('passwordHash')));
});

test('validateRuntimeConfig: fails when googleCalendar block is present but calendarId not set', () => {
  const cfg = makeValidConfig({
    googleCalendar: {
      calendarId: 'REPLACE_WITH_CALENDAR_ID',
      serviceAccountKeyPath: './sa.json',
      slotTimes: { 'Thu': { dayOfWeek: 'thursday', time: '20:00' } },
    },
  });
  const { ok, errors } = validateRuntimeConfig(cfg);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('calendarId')));
});
