'use strict';

const fs = require('fs');
const path = require('path');
const { Client, LocalAuth, Poll, ScheduledEvent } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const logger = require('./logger');

// Detect a system Chrome/Chromium to prefer over Puppeteer's bundled build.
// On many Linux VPS setups the bundled Chromium has sandbox/context issues.
function findChromePath() {
  const candidates = [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/snap/bin/chromium',
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (_) { /* ignore */ }
  }
  return null; // fall back to Puppeteer's bundled Chromium
}

function buildPuppeteerConfig() {
  const executablePath = findChromePath();
  const cfg = {
    headless: true,
    // protocolTimeout: 0 disables the CDP command timeout that can fire
    // during WhatsApp's multi-step internal navigation, causing
    // "Execution context was destroyed" to propagate out of initialize().
    protocolTimeout: 0,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',        // avoid /dev/shm exhaustion on low-RAM VPS
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-sync',
      '--metrics-recording-only',
      '--mute-audio',
      '--no-default-browser-check',
      '--hide-scrollbars',
      '--disable-features=VizDisplayCompositor',
    ],
  };
  if (executablePath) {
    logger.info(`Puppeteer: using system Chrome at ${executablePath}`);
    cfg.executablePath = executablePath;
  } else {
    logger.info('Puppeteer: using bundled Chromium');
  }
  return cfg;
}

// Puppeteer-level transient errors that mean the underlying page/frame
// is gone. whatsapp-web.js does NOT fire 'disconnected' in these cases —
// the wwjs client still thinks it's ready while every op throws. The
// only recovery is a full client re-init.
const TRANSIENT_PATTERNS = [
  'Attempted to use detached Frame',
  'Execution context was destroyed',
  'Target closed',
  'Session closed',
  'Protocol error',
  'Most likely the page has been closed',
];

function isTransientPuppeteerError(err) {
  const m = err && err.message;
  return !!m && TRANSIENT_PATTERNS.some((p) => m.includes(p));
}

// Bound a raw Puppeteer call so it can't hang forever. The client is built
// with `protocolTimeout: 0` (needed so the CDP timeout doesn't fire during
// WhatsApp's multi-step startup navigation), which means an individual op
// that stalls in the browser would otherwise never settle. The rejection
// message is deliberately NOT a transient pattern, so callers treat a timeout
// as an ordinary (non-fatal, no-reinit) failure rather than triggering a
// retry/reinit storm.
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const AUTH_DATA_PATH = './.wwebjs_auth';
// LocalAuth (no clientId) stores the Chrome profile under <dataPath>/session.
const SESSION_PROFILE_DIR = path.join(AUTH_DATA_PATH, 'session');

// Remove stale Chrome singleton lock files left behind by a dirty exit
// (OOM kill, SIGKILL'd teardown). A stale SingletonLock makes the next
// Chrome launch hang or fail with "The browser is already running".
// Only called between teardown and the next launch, when init()'s
// single-flight guard guarantees nothing of ours is using the profile.
function clearStaleSingletonLocks() {
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try {
      fs.rmSync(path.join(SESSION_PROFILE_DIR, name), { force: true });
    } catch (_) { /* best-effort */ }
  }
}

function contactIdFromNumber(number) {
  const clean = String(number).replace(/[^0-9]/g, '');
  return `${clean}@c.us`;
}

function numberFromContactId(id) {
  if (!id) return null;
  return String(id).split('@')[0];
}

// Compares two serialized message ids, tolerating the trailing "_<participant>@lid"
// suffix that newer whatsapp-web.js versions sometimes append to (or omit from)
// the id depending on whether it was returned by sendMessage or fetchMessages.
function serializedIdsMatch(a, b) {
  if (a === b) return true;
  return a.startsWith(`${b}_`) || b.startsWith(`${a}_`);
}

function createWhatsApp(db = null) {
  let client = null;
  let ready = false;
  let readyResolvers = [];
  let destroyed = false; // set on intentional destroy() so reconnect loop stops
  let initInFlight = null; // single-flight guard: the in-progress init() promise, if any
  let sessionLostNotified = false; // throttle the loud SESSION LOST error
  let lastReadyAt = null;
  let lastQrAt = null;
  let currentQrDataUrl = null;     // PNG data URL of the latest QR; null once ready

  function notifyReady() {
    ready = true;
    sessionLostNotified = false;
    currentQrDataUrl = null;
    lastReadyAt = new Date();
    const resolvers = readyResolvers;
    readyResolvers = [];
    for (const r of resolvers) r();
  }

  // 900s default: when the linked-device session expires the bot needs to wait
  // for a human to notice and scan a fresh QR. 300s was too tight if the admin
  // wasn't already watching the log.
  function waitForReady(timeoutMs = 900000) {
    if (ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        const idx = readyResolvers.indexOf(resolve);
        if (idx >= 0) readyResolvers.splice(idx, 1);
        reject(new Error('Timed out waiting for WhatsApp client to become ready'));
      }, timeoutMs);
      readyResolvers.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  // Single-flight wrapper around the real initialization. Multiple callers can
  // request a reinit concurrently — the liveness probe, the `disconnected`
  // handler, and every in-flight op that hits a transient error via
  // withTransientRetry. Without this guard each caller would run _initOnce in
  // parallel: one launches Chrome and locks the LocalAuth userDataDir, the rest
  // throw "The browser is already running for .../.wwebjs_auth/session", and the
  // client gets wedged in a permanent "initializing" state. Joining one shared
  // promise means N concurrent failures trigger exactly one reinit.
  function init(maxRetries = 3) {
    if (initInFlight) return initInFlight;
    initInFlight = _initOnce(maxRetries).finally(() => { initInFlight = null; });
    return initInFlight;
  }

  // Tear down the current client without letting a wedged browser hang us.
  // client.destroy() can stall forever (the client runs with protocolTimeout: 0),
  // and a leaked Chrome process keeps the LocalAuth profile locked so the next
  // launch fails with "The browser is already running" — which is how reinit
  // storms (and eventually lost auth) start. Bound destroy(), then force-kill
  // the browser process if it didn't go quietly.
  async function teardownClient() {
    if (!client) return;
    const old = client;
    client = null;
    ready = false;
    try {
      await withTimeout(old.destroy(), 60000, 'client.destroy');
    } catch (err) {
      logger.warn(`[whatsapp] client.destroy failed (${err.message}); force-killing browser process`);
      try {
        const proc = old.pupBrowser && old.pupBrowser.process && old.pupBrowser.process();
        if (proc && !proc.killed) proc.kill('SIGKILL');
      } catch (_) { /* best-effort */ }
    }
  }

  // Build a fresh Client, register all event listeners, and call initialize().
  // Retries on the "Execution context was destroyed" error which whatsapp-web.js
  // can surface when WhatsApp does an internal page navigation during startup.
  async function _initOnce(maxRetries = 3) {
    destroyed = false;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      // Destroy any previous instance before creating a new one, and clear
      // any singleton locks a dirty exit left in the profile dir.
      await teardownClient();
      clearStaleSingletonLocks();

      client = new Client({
        authStrategy: new LocalAuth({ dataPath: AUTH_DATA_PATH }),
        puppeteer: buildPuppeteerConfig(),
      });

      client.on('qr', (qr) => {
        lastQrAt = new Date();
        // A QR means the linked-device session is gone — only a human with the
        // phone can recover. Emit one loud ERROR per session-loss event so it
        // surfaces in monitoring/log scans instead of being buried under
        // info-level QR ascii art.
        if (!sessionLostNotified) {
          logger.error(
            '[whatsapp] LINKED DEVICE SESSION LOST — scan the QR with your ' +
            'phone (WhatsApp → Settings → Linked Devices). The current code ' +
            'is also rendered on the admin dashboard.',
          );
          sessionLostNotified = true;
        }
        logger.info('WhatsApp QR code — scan with your phone:');
        qrcode.generate(qr, { small: true });
        // Also render a PNG for the admin dashboard so the operator does not
        // need SSH access to re-link the session.
        QRCode.toDataURL(qr, { width: 320, margin: 1 })
          .then((url) => { if (!ready) currentQrDataUrl = url; })
          .catch((err) => logger.warn('[whatsapp] QR PNG generation failed:', err.message));
      });

      client.on('authenticated', () => logger.info('WhatsApp authenticated'));
      client.on('auth_failure', (msg) => logger.error('WhatsApp auth failure:', msg));

      client.on('ready', () => {
        logger.info('WhatsApp client ready');
        notifyReady();
      });

      // On disconnect, spin up a brand-new client after a short delay.
      // We use the module-level `init()` so the reconnect also gets retries.
      client.on('disconnected', (reason) => {
        logger.warn('WhatsApp disconnected:', reason);
        ready = false;
        if (destroyed) return; // intentional shutdown — don't reconnect
        setTimeout(() => {
          logger.info('Attempting to reinitialize WhatsApp client...');
          init().catch((err) => logger.error('Reinit failed:', err));
        }, 5000);
      });

      try {
        await client.initialize();
        return; // success — exit retry loop
      } catch (err) {
        // Retry on any transient puppeteer error — these happen when chrome
        // dies mid-launch (e.g. OOM-killed during the initial WhatsApp Web
        // navigation), not just on the two patterns we used to special-case.
        const isNavError = isTransientPuppeteerError(err);

        if (isNavError && attempt < maxRetries) {
          logger.warn(
            `WhatsApp init attempt ${attempt}/${maxRetries} failed ` +
            `(navigation/context error — WhatsApp is mid-redirect). ` +
            `Retrying in 5 s...`,
          );
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }

        // Non-navigation error or out of retries — propagate.
        throw err;
      }
    }
  }

  async function ensureReady() {
    if (!ready) await waitForReady();
  }

  // Pre-job health check: verify the underlying browser is actually alive
  // shortly before a scheduled send, so any reinit cost (~1-2 min) is paid
  // now instead of mid-job. A single getState() failure is common (transient
  // CDP hiccup) and a reinit gambles with the session, so only reinit after
  // two consecutive bad probes.
  async function warmup() {
    if (!ready) {
      logger.info('[warmup] client not ready — initializing');
      await init();
      return { reinit: true, reason: 'not-ready' };
    }
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const state = await withTimeout(client.getState(), 30000, 'getState');
        if (state === 'CONNECTED') return { reinit: false, state };
        logger.warn(`[warmup] getState returned ${state} (attempt ${attempt}/2)`);
      } catch (err) {
        logger.warn(`[warmup] getState failed (attempt ${attempt}/2): ${err.message}`);
      }
      if (attempt < 2) await new Promise((r) => setTimeout(r, 15000));
    }
    logger.warn('[warmup] client unhealthy — forcing reinit before the upcoming job');
    ready = false;
    await init();
    return { reinit: true, reason: 'unhealthy' };
  }

  // Run a WhatsApp operation, and if it fails with a transient Puppeteer
  // error (e.g. "Attempted to use detached Frame"), reinitialize the
  // client once and retry. ensureReady() lives inside `fn` so that the
  // retry waits for the fresh client to come up.
  async function withTransientRetry(opName, fn) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransientPuppeteerError(err)) throw err;
      logger.warn(
        `[whatsapp] ${opName} hit transient puppeteer error: ${err.message}. ` +
        `Reinitializing client and retrying once.`,
      );
      ready = false;
      await init();
      return await fn();
    }
  }

  // Sends are bounded so a wedged browser fails the job fast (and visibly)
  // instead of hanging it forever. The timeout error is deliberately NOT a
  // transient pattern: if the send actually landed but the ack stalled, a
  // reinit-and-resend would duplicate the message. Recovery comes from the
  // liveness probe healing the client and the scheduler retrying the job.
  const SEND_TIMEOUT_MS = 120000;

  async function sendText(chatId, text, options = {}) {
    return withTransientRetry('sendText', async () => {
      await ensureReady();
      return withTimeout(client.sendMessage(chatId, text, options), SEND_TIMEOUT_MS, 'sendText');
    });
  }

  async function sendPoll(chatId, question, options, { allowMultipleAnswers = true } = {}) {
    return withTransientRetry('sendPoll', async () => {
      await ensureReady();
      const poll = new Poll(question, options, { allowMultipleAnswers });
      return withTimeout(client.sendMessage(chatId, poll), SEND_TIMEOUT_MS, 'sendPoll');
    });
  }

  async function sendEvent(chatId, name, startTime, { endTime, description } = {}) {
    return withTransientRetry('sendEvent', async () => {
      await ensureReady();
      const event = new ScheduledEvent(name, startTime, {
        endTime,
        description,
        callType: 'none',
      });
      return withTimeout(client.sendMessage(chatId, event), SEND_TIMEOUT_MS, 'sendEvent');
    });
  }

  // Pin a message for the given duration (default 7 days).
  // WhatsApp only accepts three durations: 86400 (24h), 604800 (7d), 2592000 (30d).
  // Before pinning, unpins any messages previously pinned by the bot in the same chat.
  // Non-fatal: logs a warning if pinning/unpinning fails (e.g. bot is not a group admin).
  async function pinMessage(msg, durationSecs = 604800) {
    if (!msg || typeof msg.pin !== 'function') {
      logger.warn('[pinMessage] message does not support pin(); skipping');
      return;
    }

    return withTransientRetry('pinMessage', async () => {
      await ensureReady();
      const chatId = msg.id && msg.id.remote;

      if (db && chatId) {
        const prevIds = db.getBotPinnedMessages(chatId);
        for (const prevId of prevIds) {
          try {
            const prevMsg = await getMessageById(chatId, prevId);
            if (prevMsg && typeof prevMsg.unpin === 'function') {
              await withTimeout(prevMsg.unpin(), 30000, 'unpin');
              logger.info('[pinMessage] unpinned previous bot-pinned message', prevId);
            }
          } catch (err) {
            if (isTransientPuppeteerError(err)) throw err;
            logger.warn('[pinMessage] could not unpin previous message', prevId, ':', err.message);
          }
          db.removeBotPinnedMessage(chatId, prevId);
        }
      }

      try {
        await withTimeout(msg.pin(durationSecs), 30000, 'pin');
        logger.info('[pinMessage] message pinned for', durationSecs, 'seconds');
        if (db && chatId && msg.id._serialized) {
          db.addBotPinnedMessage(chatId, msg.id._serialized);
        }
      } catch (err) {
        if (isTransientPuppeteerError(err)) throw err;
        logger.warn('[pinMessage] could not pin message (bot may not be a group admin):', err.message);
      }
    });
  }

  // Fetch a message by chatId + serialized message id. Returns null if missing.
  // Fast path first: direct store lookup by id. Falls back to scanning recent
  // chat history, which tolerates the trailing "_<participant>@lid" suffix
  // mismatch between stored and fetched ids (see serializedIdsMatch).
  async function getMessageById(chatId, msgId) {
    return withTransientRetry('getMessageById', async () => {
      await ensureReady();
      if (typeof client.getMessageById === 'function') {
        try {
          const direct = await withTimeout(client.getMessageById(msgId), 30000, 'getMessageById');
          if (direct) return direct;
        } catch (err) {
          if (isTransientPuppeteerError(err)) throw err;
          logger.debug('getMessageById direct lookup missed, falling back to scan:', err.message);
        }
      }
      try {
        const chat = await withTimeout(client.getChatById(chatId), 30000, 'getChatById');
        const msgs = await withTimeout(chat.fetchMessages({ limit: 200 }), 30000, 'fetchMessages');
        const found = msgs.find((m) => m.id && m.id._serialized && serializedIdsMatch(m.id._serialized, msgId));
        return found || null;
      } catch (err) {
        if (isTransientPuppeteerError(err)) throw err;
        logger.warn('getMessageById error:', err.message);
        return null;
      }
    });
  }

  // Returns { counts, voters, allVoters, options }
  // counts: { [optionName]: number }  — unique voters per option
  // allVoters: string[]               — every number that voted at all
  async function readPollVotes(chatId, pollMsgId) {
    return withTransientRetry('readPollVotes', async () => {
      await ensureReady();
      return _readPollVotesInner(chatId, pollMsgId);
    });
  }

  async function _readPollVotesInner(chatId, pollMsgId) {
    const msg = await getMessageById(chatId, pollMsgId);
    if (!msg) throw new Error(`Poll message not found: ${pollMsgId}`);

    const options = (msg.pollOptions || (msg.poll && msg.poll.options) || []).map(
      (o, i) => ({ name: o.name || o.optionName || o, localId: o.localId != null ? o.localId : i }),
    );

    const rawVotes = msg.pollVotes || [];

    const optionVoters = new Map();
    for (const opt of options) optionVoters.set(opt.name, new Set());

    for (const vote of rawVotes) {
      const voter = numberFromContactId(
        vote.voter || (vote.sender && vote.sender._serialized) || vote.senderId,
      );
      if (!voter) continue;
      const selected = vote.selectedOptions || vote.selected || [];
      for (const sel of selected) {
        let name = null;
        if (sel && typeof sel === 'object') {
          name = sel.name || sel.optionName || null;
          if (!name && sel.localId != null) {
            const match = options.find((o) => o.localId === sel.localId);
            if (match) name = match.name;
          }
        } else if (typeof sel === 'number') {
          const match = options.find((o) => o.localId === sel);
          if (match) name = match.name;
        } else if (typeof sel === 'string') {
          name = sel;
        }
        if (name && optionVoters.has(name)) {
          optionVoters.get(name).add(voter);
        }
      }
    }

    const counts = {};
    const voters = {};
    for (const [name, set] of optionVoters.entries()) {
      counts[name] = set.size;
      voters[name] = Array.from(set);
    }
    const allVoters = new Set();
    for (const set of optionVoters.values()) {
      for (const v of set) allVoters.add(v);
    }
    return { counts, voters, allVoters: Array.from(allVoters), options: options.map((o) => o.name) };
  }

  async function getGroupParticipantNumbers(groupId) {
    return withTransientRetry('getGroupParticipantNumbers', async () => {
      await ensureReady();
      const chat = await withTimeout(client.getChatById(groupId), 30000, 'getChatById');
      if (!chat.isGroup) throw new Error(`Chat ${groupId} is not a group`);
      const participants = chat.participants || [];
      return participants.map((p) => numberFromContactId(p.id && p.id._serialized));
    });
  }

  async function listChats() {
    return withTransientRetry('listChats', async () => {
      await ensureReady();
      return client.getChats();
    });
  }

  async function destroy() {
    destroyed = true;
    await teardownClient();
  }

  return {
    init,
    ensureReady,
    waitForReady,
    warmup,
    sendText,
    sendPoll,
    sendEvent,
    pinMessage,
    getMessageById,
    readPollVotes,
    getGroupParticipantNumbers,
    listChats,
    destroy,
    contactIdFromNumber,
    numberFromContactId,
    get client() { return client; },
    get ready() { return ready; },
    // sessionLost is true when a QR has been shown since the last ready —
    // i.e. the linked-device session is gone and the bot is waiting for
    // a human to scan a fresh code.
    get sessionLost() { return !ready && sessionLostNotified; },
    get lastReadyAt() { return lastReadyAt; },
    get lastQrAt() { return lastQrAt; },
    get currentQrDataUrl() { return currentQrDataUrl; },
  };
}

module.exports = {
  createWhatsApp,
  contactIdFromNumber,
  numberFromContactId,
  isTransientPuppeteerError,
  withTimeout,
  TRANSIENT_PATTERNS,
};
