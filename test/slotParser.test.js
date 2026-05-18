'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseSlotLabel, DEFAULT_TIME_KEYWORDS } = require('../src/slotParser');
// slotToDateRange integration tests live in test/googlecalendar.test.js — that
// file already imports src/googlecalendar.js which requires 'googleapis'.
// Avoid importing it here so this file stays runnable without native deps.

// ── parseSlotLabel ────────────────────────────────────────────────────────────

test('parseSlotLabel: שלישי ערב → tuesday 20:00', () => {
  const r = parseSlotLabel('שלישי ערב', DEFAULT_TIME_KEYWORDS);
  assert.deepEqual(r, { dayOfWeek: 'tuesday', time: '20:00' });
});

test('parseSlotLabel: יום ראשון בוקר → sunday 10:00 (with יום prefix)', () => {
  const r = parseSlotLabel('יום ראשון בוקר', DEFAULT_TIME_KEYWORDS);
  assert.deepEqual(r, { dayOfWeek: 'sunday', time: '10:00' });
});

test('parseSlotLabel: חמישי צהריים → thursday 13:00', () => {
  const r = parseSlotLabel('חמישי צהריים', DEFAULT_TIME_KEYWORDS);
  assert.deepEqual(r, { dayOfWeek: 'thursday', time: '13:00' });
});

test('parseSlotLabel: שישי בוקר → friday 10:00', () => {
  const r = parseSlotLabel('שישי בוקר', DEFAULT_TIME_KEYWORDS);
  assert.deepEqual(r, { dayOfWeek: 'friday', time: '10:00' });
});

test('parseSlotLabel: שבת ערב → saturday 20:00 (no special case in parser)', () => {
  // Saturday-evening override (18:00) must be done via slotTimes config, not the parser
  const r = parseSlotLabel('שבת ערב', DEFAULT_TIME_KEYWORDS);
  assert.deepEqual(r, { dayOfWeek: 'saturday', time: '20:00' });
});

test('parseSlotLabel: extra whitespace is normalized', () => {
  const r = parseSlotLabel('  שני  ערב  ', DEFAULT_TIME_KEYWORDS);
  assert.deepEqual(r, { dayOfWeek: 'monday', time: '20:00' });
});

test('parseSlotLabel: unknown day → null', () => {
  const r = parseSlotLabel('יום_כלשהו ערב', DEFAULT_TIME_KEYWORDS);
  assert.equal(r, null);
});

test('parseSlotLabel: unknown time keyword → null', () => {
  const r = parseSlotLabel('שלישי אחר_הצהריים', DEFAULT_TIME_KEYWORDS);
  assert.equal(r, null);
});

test('parseSlotLabel: extra tokens (3 words) → null', () => {
  const r = parseSlotLabel('שלישי ערב מוקדם', DEFAULT_TIME_KEYWORDS);
  assert.equal(r, null);
});

test('parseSlotLabel: empty string → null', () => {
  assert.equal(parseSlotLabel('', DEFAULT_TIME_KEYWORDS), null);
});

test('parseSlotLabel: non-string input → null', () => {
  assert.equal(parseSlotLabel(null, DEFAULT_TIME_KEYWORDS), null);
  assert.equal(parseSlotLabel(42, DEFAULT_TIME_KEYWORDS), null);
});

test('parseSlotLabel: custom timeKeywords are honored', () => {
  const r = parseSlotLabel('שלישי ערב', { 'ערב': '21:00' });
  assert.deepEqual(r, { dayOfWeek: 'tuesday', time: '21:00' });
});

test('parseSlotLabel: falls back to defaults when timeKeywords is empty object', () => {
  const r = parseSlotLabel('שלישי ערב', {});
  assert.deepEqual(r, { dayOfWeek: 'tuesday', time: '20:00' });
});

