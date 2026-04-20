'use strict';

const fs = require('fs');
const path = require('path');

const LOG_DIR = path.resolve(process.cwd(), 'logs');

let currentStream = null;
let currentDate = null;

function ensureDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function getStream() {
  const date = today();
  if (currentStream && currentDate === date) return currentStream;
  if (currentStream) {
    try { currentStream.end(); } catch (_err) { /* ignore */ }
  }
  ensureDir();
  const file = path.join(LOG_DIR, `bot-${date}.log`);
  currentStream = fs.createWriteStream(file, { flags: 'a' });
  currentDate = date;
  return currentStream;
}

function fmt(level, args) {
  const ts = new Date().toISOString();
  const parts = args.map((a) => {
    if (a instanceof Error) return a.stack || a.message;
    if (typeof a === 'object') {
      try { return JSON.stringify(a); } catch (_err) { return String(a); }
    }
    return String(a);
  });
  return `[${ts}] [${level}] ${parts.join(' ')}`;
}

function write(level, args) {
  const line = fmt(level, args);
  // stdout / stderr
  if (level === 'ERROR') {
    process.stderr.write(`${line}\n`);
  } else {
    process.stdout.write(`${line}\n`);
  }
  try {
    getStream().write(`${line}\n`);
  } catch (_err) {
    // Log sink failure must never crash the process.
  }
}

const logger = {
  info: (...args) => write('INFO', args),
  warn: (...args) => write('WARN', args),
  error: (...args) => write('ERROR', args),
  debug: (...args) => {
    if (process.env.DEBUG) write('DEBUG', args);
  },
};

module.exports = logger;
