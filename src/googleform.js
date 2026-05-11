'use strict';

const path = require('path');
const { google } = require('googleapis');
const logger = require('./logger');

const SCOPES = [
  'https://www.googleapis.com/auth/forms.body.readonly',
  'https://www.googleapis.com/auth/forms.responses.readonly',
];

function resolveKeyPath(keyPath) {
  if (!keyPath) throw new Error('googleForm.serviceAccountKeyPath is not set');
  return path.isAbsolute(keyPath) ? keyPath : path.resolve(process.cwd(), keyPath);
}

// Walk a response's `answers` map and return the array of text answers for
// a given questionId, or null if the question was not answered.
function extractAnswers(response, questionId) {
  const answers = response && response.answers;
  if (!answers || !answers[questionId]) return null;
  const textAnswers = answers[questionId].textAnswers;
  if (!textAnswers || !Array.isArray(textAnswers.answers)) return null;
  return textAnswers.answers.map((a) => String(a.value));
}

function createGoogleForm(formConfig) {
  if (!formConfig) throw new Error('googleForm config is missing');
  const {
    formId,
    serviceAccountKeyPath,
    playerSlotQuestions,  // { questionId: slotLabel, ... }  one entry per grid row
    dmSlotQuestions,      // { questionId: slotLabel, ... }  one entry per grid row
    unavailableAnswer,
    maybeAnswer,
    deleteWebhookUrl,
    deleteWebhookSecret,
  } = formConfig;

  if (!formId) throw new Error('googleForm.formId is not set');
  if (!playerSlotQuestions || !Object.keys(playerSlotQuestions).length)
    throw new Error('googleForm.playerSlotQuestions is not set');
  if (!dmSlotQuestions || !Object.keys(dmSlotQuestions).length)
    throw new Error('googleForm.dmSlotQuestions is not set');

  // The column value that means "cannot play". Anything else = can play,
  // unless it matches the optional `maybeAnswer` ("might come"), which is
  // tracked separately and used only as a secondary tiebreaker.
  const cannotPlay = unavailableAnswer || 'לא יכול';
  const mightPlay = maybeAnswer || null;

  const keyFile = resolveKeyPath(serviceAccountKeyPath);
  const auth = new google.auth.GoogleAuth({ keyFile, scopes: SCOPES });
  const forms = google.forms({ version: 'v1', auth });

  // Returns { playerSlots: [label, ...], dmSlots: [label, ...] }
  // Labels come directly from config (no API call needed).
  function getSlotOptions() {
    return {
      playerSlots: Object.values(playerSlotQuestions),
      dmSlots: Object.values(dmSlotQuestions),
    };
  }

  // Given a raw form response and a { questionId: slotLabel } map,
  // returns { yes: [labels...], maybe: [labels...] } where `yes` is slots the
  // respondent can play (answer is neither cannotPlay nor mightPlay) and
  // `maybe` is slots they marked as "might come".
  // Returns null if none of the questionIds were answered at all.
  function slotsFromGridAnswers(response, slotMap) {
    const answers = response.answers || {};
    const ids = Object.keys(slotMap);
    const anyAnswered = ids.some((id) => answers[id]);
    if (!anyAnswered) return null;

    const yes = [];
    const maybe = [];
    for (const id of ids) {
      if (!answers[id]) continue; // unanswered row — treat as unavailable
      const val = extractAnswers(response, id);
      if (!val) continue;
      const v = val[0];
      if (v === cannotPlay) continue;
      if (mightPlay && v === mightPlay) maybe.push(slotMap[id]);
      else yes.push(slotMap[id]);
    }
    return { yes, maybe };
  }

  // Returns { playerResponses, dmResponse, rawCount }
  //   playerResponses: Array<{ yes: string[], maybe: string[] }>
  //                                       — each entry = the slot labels this
  //                                       player marked "can play" (yes) and
  //                                       "might come" (maybe). Only includes
  //                                       responses that answered at least one
  //                                       player slot row.
  //   dmResponse:      string[] | null  — slot labels the DM can run.
  //                                       null if no DM response yet.
  //                                       Most-recent DM response wins if >1.
  //   rawCount:        number           — total responses in the form.
  async function readResponses() {
    let responses = [];
    let pageToken;
    do {
      const res = await forms.forms.responses.list({ formId, pageSize: 5000, pageToken });
      responses = responses.concat(res.data.responses || []);
      pageToken = res.data.nextPageToken;
    } while (pageToken);

    const playerResponses = [];
    let dmResponse = null;
    let dmResponseTime = 0;

    for (const r of responses) {
      const playerSlots = slotsFromGridAnswers(r, playerSlotQuestions);
      if (playerSlots !== null) playerResponses.push(playerSlots);

      const dmSlots = slotsFromGridAnswers(r, dmSlotQuestions);
      if (dmSlots !== null) {
        const t = Date.parse(r.lastSubmittedTime || r.createTime || 0) || 0;
        if (t >= dmResponseTime) {
          // DM availability is binary; only "yes" counts as can-run.
          dmResponse = dmSlots.yes;
          dmResponseTime = t;
        }
      }
    }

    return { playerResponses, dmResponse, rawCount: responses.length };
  }

  // POSTs the configured shared secret to the Apps Script webhook bound to the
  // form, which calls FormApp.getActiveForm().deleteAllResponses(). Non-fatal:
  // logs and swallows on failure so it cannot block the winner announcement.
  async function deleteAllResponses() {
    if (!deleteWebhookUrl || !deleteWebhookSecret) {
      logger.warn('[googleForm] deleteAllResponses called but deleteWebhookUrl/Secret not configured; skipping');
      return { ok: false, reason: 'not-configured' };
    }
    try {
      const res = await fetch(deleteWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: deleteWebhookSecret }),
        redirect: 'follow',
      });
      const text = await res.text();
      if (!res.ok) {
        logger.warn(`[googleForm] delete webhook returned ${res.status}: ${text.slice(0, 200)}`);
        return { ok: false, status: res.status, body: text };
      }
      logger.info('[googleForm] all form responses deleted');
      return { ok: true };
    } catch (err) {
      logger.warn('[googleForm] delete webhook error:', err.message);
      return { ok: false, error: err.message };
    }
  }

  return {
    getSlotOptions,
    readResponses,
    deleteAllResponses,
    get formId() { return formId; },
  };
}

module.exports = { createGoogleForm };
