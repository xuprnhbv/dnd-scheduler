'use strict';

const logger = require('../logger');

function renderTemplate(tpl, vars) {
  return tpl.replace(/\{(\w+)\}/g, (_m, k) =>
    Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : `{${k}}`,
  );
}

// whatsapp-web.js occasionally resolves sendMessage with a degraded Message
// whose id._serialized is empty (the model isn't fully hydrated yet). The
// message DID go out, so any gate that stores the id must fall back to a
// non-empty value — an empty string reads back as null via db.js `|| null`,
// which re-opens the gate and causes a duplicate send on the next run. The
// synthetic id is only ever used as a truthy "done" marker.
//
// (The one id that is later re-fetched is the tiebreaker poll id, used to read
// votes. A synthetic value there means announceTiebreaker can't find the poll —
// rare, and still strictly better than posting a second tiebreaker poll, which
// is the alternative if the gate re-opens.)
function sentMessageId(msg, seed) {
  const serialized = msg && msg.id && msg.id._serialized ? msg.id._serialized : '';
  if (serialized) return { id: serialized, synthetic: false };
  return { id: `sent:${seed}:${Math.floor(Date.now() / 1000)}`, synthetic: true };
}

// Canonical ordering for any job stage that sends a WhatsApp message and then
// records that it happened. Getting this order wrong is what made the bot
// resend, so it lives in one place:
//
//   send        exactly one WhatsApp send. On failure it throws (see
//               whatsapp.js sendOnce) and nothing below runs, so no flag is
//               written and the send is never silently duplicated.
//   record(msg) write the DB flag NOW — the instant the send resolves and
//               BEFORE the pin. Optional: omit for stages that are intentionally
//               repeatable (e.g. the "DM hasn't voted yet" nudge).
//   pin(msg)    best-effort; a pin failure is swallowed here too, so it can
//               never un-record a stage that already went out.
//   after(msg)  side effects that must run only after the stage is recorded
//               (e.g. wiping last week's form responses). Runs last.
async function runStage({ whatsapp, send, record = null, after = null }) {
  const msg = await send();
  if (record) record(msg);
  try {
    await whatsapp.pinMessage(msg);
  } catch (err) {
    logger.warn('[runStage] pin failed (non-fatal):', err && err.message);
  }
  if (after) await after(msg);
  return msg;
}

module.exports = { renderTemplate, sentMessageId, runStage };
