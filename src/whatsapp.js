'use strict';

const fs = require('fs');
const { Client, LocalAuth, Poll } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
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

function contactIdFromNumber(number) {
  const clean = String(number).replace(/[^0-9]/g, '');
  return `${clean}@c.us`;
}

function numberFromContactId(id) {
  if (!id) return null;
  return String(id).split('@')[0];
}

function createWhatsApp(db = null) {
  let client = null;
  let ready = false;
  let readyResolvers = [];
  let destroyed = false; // set on intentional destroy() so reconnect loop stops

  function notifyReady() {
    ready = true;
    const resolvers = readyResolvers;
    readyResolvers = [];
    for (const r of resolvers) r();
  }

  function waitForReady(timeoutMs = 120000) {
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

  // Build a fresh Client, register all event listeners, and call initialize().
  // Retries on the "Execution context was destroyed" error which whatsapp-web.js
  // can surface when WhatsApp does an internal page navigation during startup.
  async function init(maxRetries = 3) {
    destroyed = false;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      // Destroy any previous instance before creating a new one.
      if (client) {
        try { await client.destroy(); } catch (_) { /* ignore */ }
        client = null;
      }
      ready = false;

      client = new Client({
        authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
        puppeteer: buildPuppeteerConfig(),
      });

      client.on('qr', (qr) => {
        logger.info('WhatsApp QR code — scan with your phone:');
        qrcode.generate(qr, { small: true });
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
        const isNavError =
          err && err.message &&
          (err.message.includes('Execution context was destroyed') ||
           err.message.includes('Target closed'));

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

  async function sendText(chatId, text, options = {}) {
    await ensureReady();
    return client.sendMessage(chatId, text, options);
  }

  async function sendPoll(chatId, question, options, { allowMultipleAnswers = true } = {}) {
    await ensureReady();
    const poll = new Poll(question, options, { allowMultipleAnswers });
    const msg = await client.sendMessage(chatId, poll);
    return msg;
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

    const chatId = msg.id && msg.id.remote;

    if (db && chatId) {
      const prevIds = db.getBotPinnedMessages(chatId);
      for (const prevId of prevIds) {
        try {
          const prevMsg = await getMessageById(chatId, prevId);
          if (prevMsg && typeof prevMsg.unpin === 'function') {
            await prevMsg.unpin();
            logger.info('[pinMessage] unpinned previous bot-pinned message', prevId);
          }
        } catch (err) {
          logger.warn('[pinMessage] could not unpin previous message', prevId, ':', err.message);
        }
        db.removeBotPinnedMessage(chatId, prevId);
      }
    }

    try {
      await msg.pin(durationSecs);
      logger.info('[pinMessage] message pinned for', durationSecs, 'seconds');
      if (db && chatId && msg.id._serialized) {
        db.addBotPinnedMessage(chatId, msg.id._serialized);
      }
    } catch (err) {
      logger.warn('[pinMessage] could not pin message (bot may not be a group admin):', err.message);
    }
  }

  // Fetch a message by chatId + serialized message id. Returns null if missing.
  async function getMessageById(chatId, msgId) {
    await ensureReady();
    try {
      const chat = await client.getChatById(chatId);
      const msgs = await chat.fetchMessages({ limit: 200 });
      const found = msgs.find((m) => m.id && m.id._serialized === msgId);
      if (found) return found;
      // Fallback: getMessageById on client if available
      if (typeof client.getMessageById === 'function') {
        return await client.getMessageById(msgId);
      }
      return null;
    } catch (err) {
      logger.warn('getMessageById error:', err.message);
      return null;
    }
  }

  // Returns { counts, voters, allVoters, options }
  // counts: { [optionName]: number }  — unique voters per option
  // allVoters: string[]               — every number that voted at all
  async function readPollVotes(chatId, pollMsgId) {
    await ensureReady();
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
    await ensureReady();
    const chat = await client.getChatById(groupId);
    if (!chat.isGroup) throw new Error(`Chat ${groupId} is not a group`);
    const participants = chat.participants || [];
    return participants.map((p) => numberFromContactId(p.id && p.id._serialized));
  }

  async function listChats() {
    await ensureReady();
    return client.getChats();
  }

  async function destroy() {
    destroyed = true;
    if (client) {
      try { await client.destroy(); } catch (_) { /* ignore */ }
    }
  }

  return {
    init,
    ensureReady,
    waitForReady,
    sendText,
    sendPoll,
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
  };
}

module.exports = { createWhatsApp, contactIdFromNumber, numberFromContactId };
