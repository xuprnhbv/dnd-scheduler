'use strict';

const logger = require('./logger');

// Push-notification sender backed by ntfy (https://ntfy.sh by default).
//
// The bot's only failure mode that needs a human is a lost WhatsApp linked-device
// session — the operator has to scan a fresh QR on the admin dashboard. Without a
// push they only find out by chance. This module POSTs a short message to an ntfy
// topic; the operator subscribes to that topic in the ntfy phone app and gets a
// notification.
//
// Config lives at config.notifications.ntfy and is read LIVE on every send, so the
// admin panel can enable/disable or rotate the topic at runtime (it mutates the
// shared in-memory config object) without a restart.
//
// Every send is best-effort: it never throws and never blocks the caller — a push
// failure must not take down the bot or a scheduled job.

const DEFAULT_SERVER = 'https://ntfy.sh';
const SEND_TIMEOUT_MS = 10000;

function createNotifier(config) {
  function cfg() {
    return (config && config.notifications && config.notifications.ntfy) || {};
  }

  function isConfigured() {
    const c = cfg();
    return !!(c.enabled && c.topic);
  }

  async function send({ title, message, priority, tags } = {}) {
    const c = cfg();
    if (!c.enabled || !c.topic) {
      return { sent: false, reason: 'not-configured' };
    }

    const server = String(c.server || DEFAULT_SERVER).replace(/\/+$/, '');
    const url = `${server}/${encodeURIComponent(c.topic)}`;

    // ntfy carries metadata in HTTP headers, which must be ASCII — keep titles
    // English. The message body is sent as the request body and may be UTF-8.
    const headers = { 'Content-Type': 'text/plain; charset=utf-8' };
    if (title) headers.Title = title;
    if (priority) headers.Priority = String(priority);
    if (tags) headers.Tags = tags;
    if (c.authToken) headers.Authorization = `Bearer ${c.authToken}`;

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: message != null ? String(message) : '',
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      if (!res.ok) {
        logger.warn(`[notifier] ntfy responded ${res.status} ${res.statusText}`);
        return { sent: false, reason: `http-${res.status}` };
      }
      return { sent: true };
    } catch (err) {
      logger.warn('[notifier] ntfy send failed:', err.message);
      return { sent: false, reason: err.message };
    }
  }

  function sessionExpired() {
    return send({
      title: 'WhatsApp session expired',
      message:
        'The D&D bot lost its WhatsApp link — open the admin dashboard and scan ' +
        'the QR to re-link.',
      priority: 'urgent',
      tags: 'warning',
    });
  }

  function test() {
    return send({
      title: 'D&D bot notifications enabled',
      message:
        "You're subscribed. You'll be alerted here when the WhatsApp session " +
        'needs re-linking.',
      priority: 'default',
      tags: 'white_check_mark',
    });
  }

  return { send, sessionExpired, test, isConfigured };
}

module.exports = { createNotifier };
