'use strict';

const fs = require('fs');
const path = require('path');

const logger = require('./logger');
const dbLib = require('./db');
const { createWhatsApp } = require('./whatsapp');
const { createGoogleForm } = require('./googleform');
const { createGoogleCalendar } = require('./googlecalendar');
const scheduler = require('./scheduler');
const adminServer = require('./admin/server');
const { currentWeekStart } = require('./slots');

const CONFIG_PATH = path.resolve(process.cwd(), 'config.json');

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    logger.error(`config.json not found at ${CONFIG_PATH}. Copy config.example.json and fill it in.`);
    process.exit(1);
  }
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  const cfg = JSON.parse(raw);
  const missing = [];
  for (const k of ['timezone', 'groupId', 'playerCount', 'googleForm', 'adminPanel', 'messages']) {
    if (cfg[k] == null) missing.push(k);
  }
  if (missing.length) {
    logger.error(`config.json missing fields: ${missing.join(', ')}`);
    process.exit(1);
  }
  for (const k of ['formId', 'publicUrl', 'serviceAccountKeyPath']) {
    if (!cfg.googleForm[k] || String(cfg.googleForm[k]).startsWith('REPLACE')) {
      logger.error(`config.googleForm.${k} is not set`);
      process.exit(1);
    }
  }
  for (const k of ['playerSlotQuestions', 'dmSlotQuestions']) {
    if (!cfg.googleForm[k] || typeof cfg.googleForm[k] !== 'object' || !Object.keys(cfg.googleForm[k]).length) {
      logger.error(`config.googleForm.${k} must be an object mapping questionId → slot label`);
      process.exit(1);
    }
  }
  if (!cfg.adminPanel.passwordHash || cfg.adminPanel.passwordHash.startsWith('REPLACE')) {
    logger.error('config.adminPanel.passwordHash is not set. Run: node bin/hash-password.js <your-password>');
    process.exit(1);
  }
  if (cfg.googleCalendar) {
    for (const k of ['calendarId', 'serviceAccountKeyPath', 'slotTimes']) {
      if (cfg.googleCalendar[k] == null || String(cfg.googleCalendar[k]).startsWith('REPLACE')) {
        logger.error(`config.googleCalendar.${k} is not set (remove the googleCalendar block to disable calendar events)`);
        process.exit(1);
      }
    }
    if (typeof cfg.googleCalendar.slotTimes !== 'object' || !Object.keys(cfg.googleCalendar.slotTimes).length) {
      logger.error('config.googleCalendar.slotTimes must be an object mapping slot label → { dayOfWeek, time }');
      process.exit(1);
    }
  }
  return cfg;
}

const TEST_JOBS = {
  'post-form-link': 'postFormLink',
  'send-reminder': 'sendReminder',
  'announce-winner': 'announceWinner',
  'announce-tiebreaker': 'announceTiebreaker',
};

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { test: null };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--test' && args[i + 1]) {
      out.test = args[i + 1];
      i += 1;
    }
  }
  return out;
}

async function runTestJob(jobKey, ctx) {
  const jobName = TEST_JOBS[jobKey];
  if (!jobName) {
    logger.error(`Unknown test job: ${jobKey}. Valid: ${Object.keys(TEST_JOBS).join(', ')}`);
    process.exit(2);
  }
  const job = scheduler.jobs[jobName];
  logger.info(`[test] running ${jobName}...`);
  const result = await job.run(ctx);
  logger.info(`[test] ${jobName} result:`, result || {});
}

async function main() {
  const args = parseArgs(process.argv);
  const config = loadConfig();
  const db = dbLib.open();
  const googleForm = createGoogleForm(config.googleForm);
  const googleCalendar = config.googleCalendar
    ? createGoogleCalendar(config.googleCalendar)
    : null;
  if (googleCalendar) {
    logger.info(`Google Calendar enabled (calendarId=${googleCalendar.calendarId}, ${googleCalendar.eventDurationHours}h "${googleCalendar.eventTitle}")`);
  }

  const whatsapp = createWhatsApp(db);
  await whatsapp.init();
  await whatsapp.ensureReady();

  const ctx = { config, db, whatsapp, googleForm, googleCalendar };

  if (args.test) {
    try {
      await runTestJob(args.test, ctx);
    } finally {
      await whatsapp.destroy();
      db.close();
    }
    process.exit(0);
    return;
  }

  scheduler.start(ctx);

  const app = adminServer.create({ config, db, whatsapp, googleForm, googleCalendar });
  const port = config.adminPanel.port || 3000;
  app.listen(port, () => {
    logger.info(`Admin panel listening on :${port}`);
  });

  const weekStart = currentWeekStart(new Date(), config.timezone);
  const state = db.getState(weekStart);
  logger.info(`Startup: current week ${weekStart}`, state || { note: 'no state yet' });

  // Print group IDs whenever a message arrives from a group. Send any message
  // to the D&D WhatsApp group and the ID appears in the log.
  if (config.groupId.startsWith('REPLACE')) {
    logger.info('groupId not set yet — send any message to your D&D group and the ID will appear here.');
    const logGroupMsg = (msg) => {
      if (msg.from && msg.from.endsWith('@g.us')) {
        logger.info(`GROUP ID FOUND  ->  ${msg.from}  (group message body: "${(msg.body || '').slice(0, 40)}")`);
      }
    };
    whatsapp.client.on('message', logGroupMsg);
    whatsapp.client.on('message_create', logGroupMsg);
  }

  process.on('SIGTERM', async () => {
    logger.info('SIGTERM received, shutting down');
    await whatsapp.destroy();
    db.close();
    process.exit(0);
  });
  process.on('SIGINT', async () => {
    logger.info('SIGINT received, shutting down');
    await whatsapp.destroy();
    db.close();
    process.exit(0);
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection:', reason);
  });
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception:', err);
  });
}

main().catch((err) => {
  logger.error('Fatal error in main:', err);
  process.exit(1);
});
