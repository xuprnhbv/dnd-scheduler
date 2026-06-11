'use strict';

const fs = require('fs');
const path = require('path');

const logger = require('./logger');
const dbLib = require('./db');
const { createWhatsApp, withTimeout } = require('./whatsapp');
const { createGoogleForm } = require('./googleform');
const scheduler = require('./scheduler');
const adminServer = require('./admin/server');
const { ensureCert } = require('./admin/tls');
const { currentWeekStart } = require('./slots');

const CONFIG_PATH = path.resolve(process.cwd(), 'config.json');
const { validateRuntimeConfig } = require('./admin/configIO');

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    logger.error(`config.json not found at ${CONFIG_PATH}. Copy config.example.json and fill it in.`);
    process.exit(1);
  }
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  const cfg = JSON.parse(raw);
  const { ok, errors } = validateRuntimeConfig(cfg);
  if (!ok) {
    for (const e of errors) logger.error(e);
    process.exit(1);
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

  const whatsapp = createWhatsApp(db);
  await whatsapp.init();

  const ctx = { config, db, whatsapp, googleForm };

  if (args.test) {
    // --test mode still blocks on ready — the test job needs WhatsApp.
    await whatsapp.ensureReady();
    try {
      await runTestJob(args.test, ctx);
    } finally {
      await whatsapp.destroy();
      db.close();
    }
    process.exit(0);
    return;
  }

  // Start the admin panel and scheduler BEFORE waiting for WhatsApp to be
  // ready. The admin dashboard is how the operator finds out the session is
  // dead — it must come up even when WhatsApp is QR-stuck. Scheduled jobs
  // are cron-driven and idempotent; a job firing while !ready will throw
  // and be retried on the next tick.
  scheduler.start(ctx);

  // Liveness probe: catch a silently-detached puppeteer frame BEFORE a
  // scheduled job hits it. whatsapp-web.js does not fire 'disconnected'
  // for puppeteer-level detachment, so without this we only find out at
  // the next scheduled send — which may be a week away.
  // Probe getState() periodically; only force a reinit after several
  // consecutive failures. A single getState() error is common (puppeteer
  // mid-navigation, transient timeout) and reinit gambles with the
  // session — repeated reinits eventually lose auth and force a QR scan.
  // A probe that resolves to a non-CONNECTED state (null, UNPAIRED, ...)
  // counts as a failure too, and each probe is timeout-bounded so a hung
  // CDP call can't pile up dangling probes (the client runs with
  // protocolTimeout: 0).
  const LIVENESS_INTERVAL_MS = 5 * 60 * 1000;
  const LIVENESS_FAILURE_THRESHOLD = 4;
  const LIVENESS_PROBE_TIMEOUT_MS = 30 * 1000;
  let livenessFailures = 0;
  const livenessHandle = setInterval(async () => {
    if (!whatsapp.ready) return;
    let failureReason = null;
    try {
      const state = await withTimeout(
        whatsapp.client.getState(), LIVENESS_PROBE_TIMEOUT_MS, 'liveness getState',
      );
      if (state === 'CONNECTED') {
        if (livenessFailures > 0) {
          logger.info(`[liveness] probe recovered after ${livenessFailures} failure(s) (state=${state})`);
        }
        livenessFailures = 0;
      } else {
        failureReason = `state=${state}`;
      }
    } catch (err) {
      failureReason = err.message;
    }
    if (failureReason) {
      livenessFailures += 1;
      logger.warn(`[liveness] probe failed (${livenessFailures}/${LIVENESS_FAILURE_THRESHOLD}): ${failureReason}`);
      if (livenessFailures >= LIVENESS_FAILURE_THRESHOLD) {
        logger.warn('[liveness] failure threshold reached — forcing reinit');
        livenessFailures = 0;
        try { await whatsapp.init(); }
        catch (reinitErr) { logger.error('[liveness] reinit failed:', reinitErr); }
      }
    }
  }, LIVENESS_INTERVAL_MS);
  livenessHandle.unref();

  const app = adminServer.create({ config, db, whatsapp, googleForm });
  const port = config.adminPanel.port || 3000;
  const tlsCfg = config.adminPanel.tls || {};
  const tlsEnabled = tlsCfg.enabled !== false; // default on
  if (tlsEnabled) {
    const { cert, key } = ensureCert({ certPath: tlsCfg.certPath, keyPath: tlsCfg.keyPath });
    require('https').createServer({ cert, key }, app).listen(port, () => {
      logger.info(`Admin panel listening on https://:${port}`);
    });
  } else {
    app.listen(port, () => {
      logger.info(`Admin panel listening on :${port}`);
    });
  }

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
    clearInterval(livenessHandle);
    await whatsapp.destroy();
    db.close();
    process.exit(process.env.DND_RESTART_REQUESTED ? 1 : 0);
  });
  process.on('SIGINT', async () => {
    logger.info('SIGINT received, shutting down');
    clearInterval(livenessHandle);
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
