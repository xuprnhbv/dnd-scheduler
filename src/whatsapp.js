'use strict';

const { Client, LocalAuth, Poll } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const logger = require('./logger');

function contactIdFromNumber(number) {
  const clean = String(number).replace(/[^0-9]/g, '');
  return `${clean}@c.us`;
}

function numberFromContactId(id) {
  if (!id) return null;
  return String(id).split('@')[0];
}

function createWhatsApp() {
  let client = null;
  let ready = false;
  let readyResolvers = [];

  function notifyReady() {
    ready = true;
    const resolvers = readyResolvers;
    readyResolvers = [];
    for (const r of resolvers) r();
  }

  function waitForReady(timeoutMs = 60000) {
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

  async function init() {
    client = new Client({
      authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
      puppeteer: {
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
        ],
      },
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

    client.on('disconnected', (reason) => {
      logger.warn('WhatsApp disconnected:', reason);
      ready = false;
      // Attempt reconnect
      setTimeout(() => {
        logger.info('Attempting to reinitialize WhatsApp client...');
        client.initialize().catch((err) => logger.error('Reinit failed:', err));
      }, 5000);
    });

    await client.initialize();
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

  // Returns a map: { [optionName]: Set<senderNumber> }
  // Counts each distinct voter once per option they selected.
  async function readPollVotes(chatId, pollMsgId) {
    await ensureReady();
    const msg = await getMessageById(chatId, pollMsgId);
    if (!msg) throw new Error(`Poll message not found: ${pollMsgId}`);

    const options = (msg.pollOptions || msg.poll && msg.poll.options || []).map(
      (o, i) => ({ name: o.name || o.optionName || o, localId: o.localId != null ? o.localId : i }),
    );

    // whatsapp-web.js emits 'vote_update' events; for reading historical
    // votes we rely on msg.pollVotes which the library populates.
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
        // selection can be a localId or an option object
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
    if (client) {
      try { await client.destroy(); } catch (_err) { /* ignore */ }
    }
  }

  return {
    init,
    ensureReady,
    waitForReady,
    sendText,
    sendPoll,
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
