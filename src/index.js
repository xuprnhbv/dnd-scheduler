'use strict';

const fs = require('fs');
const path = require('path');

const logger = require('./logger');
const dbLib = require('./db');
const { createWhatsApp } = require('./whatsapp');
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
  for (const k of ['timezone', 'groupId', 'members', 'slotTemplate', 'adminPanel', 'messages']) {
    if (!cfg[k]) missing.push(k);
  }
  if (missing.length) {
    logger.error(`config.json missing fields: ${missing.join(', ')}`);
    process.exit(1);
  }
  if (!cfg.adminPanel.passwordHash || cfg.adminPanel.passwordHash.startsWith('REPLACE')) {
    logger.error('config.adminPanel.passwordHash is not set. Run: node bin/hash-password.js <your-password>');
    process.exit(1);
  }
  return cfg;
}

const TEST_JOBS = {
  'create-poll': 'createMainPoll',
  'send-reminder': 'sendReminder',
  'announce-winner': 'announceWinner',
  'announce-tiebreaker': 'announceTiebreaker',
  'seed-next-week': 'seedNextWeekSlots',
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

  const whatsapp = createWhatsApp();
  await whatsapp.init();
  await whatsapp.ensureReady();

  const ctx = { config, db, whatsapp };

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

  // Normal run: schedule jobs + start admin panel
  scheduler.start(ctx);

  const app = adminServer.create({ config, db });
  const port = config.adminPanel.port || 3000;
  app.listen(port, () => {
    logger.info(`Admin panel listening on :${port}`);
  });

  // Log current state on startup
  const weekStart = currentWeekStart(new Date(), config.timezone);
  const state = db.getState(weekStart);
  logger.info(`Startup: current week ${weekStart}`, state || { note: 'no state yet' });

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
