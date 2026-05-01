'use strict';

const fs = require('fs');
const path = require('path');

const { SCHEMA } = require('./configSchema');

const CONFIG_PATH = path.resolve(process.cwd(), 'config.json');
const MAX_BACKUPS = 5;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Read a nested value from obj using a dot-separated path string. */
function getNestedValue(obj, dotPath) {
  return dotPath.split('.').reduce((o, k) => (o != null ? o[k] : undefined), obj);
}

/** Set a nested value on obj using a dot-separated path string (mutates). */
function setNestedValue(obj, dotPath, value) {
  const keys = dotPath.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i += 1) {
    if (cur[keys[i]] == null || typeof cur[keys[i]] !== 'object') {
      cur[keys[i]] = {};
    }
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}

// ─── flattenForm ──────────────────────────────────────────────────────────────

/**
 * Rebuild the nested config object from the flat/bracket form POST body.
 *
 * For plain fields the form uses name="googleForm.formId" (dot notation).
 * For slotMap rows: name="googleForm.playerSlotQuestions[0][questionId]" and
 *                   name="googleForm.playerSlotQuestions[0][slotLabel]"
 * For slotTimesMap: name="googleCalendar.slotTimes[0][slotLabel]",
 *                   name="googleCalendar.slotTimes[0][dayOfWeek]",
 *                   name="googleCalendar.slotTimes[0][time]"
 *
 * Returns a plain config object suitable for validateConfig / JSON.stringify.
 *
 * @param {Record<string, string|string[]>} body  express req.body
 * @param {object[]} schema  SCHEMA array
 * @param {object}   current  current config (used to preserve omitOnSave fields)
 * @returns {object}
 */
function flattenForm(body, schema, current = {}) {
  const cfg = {};

  for (const field of schema) {
    const rawKey = field.path; // e.g. "googleForm.formId"

    if (field.type === 'slotMap') {
      // Rows arrive as: rawKey[0][questionId] and rawKey[0][slotLabel]
      const map = {};
      let i = 0;
      while (true) {
        const qid = (body[`${rawKey}[${i}][questionId]`] || '').trim();
        const label = (body[`${rawKey}[${i}][slotLabel]`] || '').trim();
        if (qid === '' && label === '' && body[`${rawKey}[${i}][questionId]`] === undefined) break;
        if (qid !== '' && label !== '') {
          map[qid] = label;
        }
        i += 1;
        if (i > 200) break; // safety valve
      }
      setNestedValue(cfg, rawKey, map);
      continue;
    }

    if (field.type === 'slotTimesMap') {
      const map = {};
      let i = 0;
      while (true) {
        const slotLabel = (body[`${rawKey}[${i}][slotLabel]`] || '').trim();
        const dayOfWeek = (body[`${rawKey}[${i}][dayOfWeek]`] || '').trim();
        const time = (body[`${rawKey}[${i}][time]`] || '').trim();
        if (slotLabel === '' && dayOfWeek === '' && body[`${rawKey}[${i}][slotLabel]`] === undefined) break;
        if (slotLabel !== '') {
          map[slotLabel] = { dayOfWeek: dayOfWeek.toLowerCase(), time };
        }
        i += 1;
        if (i > 200) break;
      }
      setNestedValue(cfg, rawKey, map);
      continue;
    }

    const raw = body[rawKey];
    const strVal = Array.isArray(raw) ? raw[0] : (raw || '');
    const trimmed = strVal.trim();

    if (field.type === 'number') {
      const n = trimmed === '' ? undefined : Number(trimmed);
      setNestedValue(cfg, rawKey, n == null || isNaN(n) ? trimmed : n);
    } else {
      setNestedValue(cfg, rawKey, trimmed);
    }
  }

  // Preserve fields that were omitted from the form body (e.g. untouched password fields
  // whose values we never echo back to the browser). We keep the current config value.
  // Also handle the case where a password field was submitted as empty → keep current.
  for (const field of schema) {
    if (field.type === 'password') {
      const submitted = (body[field.path] || '').trim();
      if (submitted === '') {
        // User left it blank — keep whatever is in current config
        const existing = getNestedValue(current, field.path);
        if (existing !== undefined) {
          setNestedValue(cfg, field.path, existing);
        }
      }
    }
  }

  return cfg;
}

// ─── validateConfig ───────────────────────────────────────────────────────────

const VALID_DAYS = new Set(['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']);
const TIME_RE = /^\d{1,2}:\d{2}$/;

/**
 * Validate a config object against the schema.
 *
 * @param {object}   cfg     Config object (nested)
 * @param {object[]} schema  SCHEMA array
 * @returns {{ ok: boolean, errors: Array<{ path: string, message: string }> }}
 */
function validateConfig(cfg, schema) {
  const errors = [];

  // Determine whether the googleCalendar block is active (any field is set)
  const calFields = schema.filter((f) => f.section === 'googleCalendar');
  const calActive = calFields.some((f) => {
    const v = getNestedValue(cfg, f.path);
    if (f.type === 'slotTimesMap') return v != null && typeof v === 'object' && Object.keys(v).length > 0;
    return v != null && v !== '';
  });

  for (const field of schema) {
    const value = getNestedValue(cfg, field.path);
    const isCalField = field.section === 'googleCalendar';

    // Skip optional calendar fields when the whole block is absent
    if (isCalField && !calActive) continue;

    // ── Required check ────────────────────────────────────────────────────────
    if (field.required || (isCalField && calActive)) {
      if (field.type === 'slotMap' || field.type === 'slotTimesMap') {
        if (value == null || typeof value !== 'object' || Object.keys(value).length === 0) {
          errors.push({ path: field.path, message: `${field.label}: at least one row is required.` });
          continue;
        }
      } else if (value == null || String(value).trim() === '') {
        errors.push({ path: field.path, message: `${field.label}: required.` });
        continue;
      }
    } else {
      // Not required — skip type checks if empty
      if (value == null || String(value).trim() === '') continue;
      if ((field.type === 'slotMap' || field.type === 'slotTimesMap') &&
          (typeof value !== 'object' || Object.keys(value).length === 0)) continue;
    }

    // ── Type-specific checks ──────────────────────────────────────────────────
    if (field.type === 'number') {
      if (!Number.isFinite(value)) {
        errors.push({ path: field.path, message: `${field.label}: must be a number.` });
      }
    } else if (field.type === 'url') {
      try {
        new URL(String(value));
      } catch (_e) {
        errors.push({ path: field.path, message: `${field.label}: must be a valid URL.` });
      }
    } else if (field.type === 'slotMap') {
      const seen = new Set();
      for (const [qid, label] of Object.entries(value)) {
        if (!qid.trim()) {
          errors.push({ path: field.path, message: `${field.label}: question IDs cannot be blank.` });
          break;
        }
        if (!label || !String(label).trim()) {
          errors.push({ path: field.path, message: `${field.label}: slot labels cannot be blank.` });
          break;
        }
        if (seen.has(qid)) {
          errors.push({ path: field.path, message: `${field.label}: duplicate question ID "${qid}".` });
          break;
        }
        seen.add(qid);
      }
    } else if (field.type === 'slotTimesMap') {
      const seenLabels = new Set();
      for (const [label, cfg2] of Object.entries(value)) {
        if (!label.trim()) {
          errors.push({ path: field.path, message: `${field.label}: slot labels cannot be blank.` });
          break;
        }
        if (seenLabels.has(label)) {
          errors.push({ path: field.path, message: `${field.label}: duplicate slot label "${label}".` });
          break;
        }
        seenLabels.add(label);

        const dow = String(cfg2.dayOfWeek || '').toLowerCase().trim();
        if (!VALID_DAYS.has(dow)) {
          errors.push({ path: field.path, message: `${field.label} "${label}": dayOfWeek must be a day name (e.g. "thursday").` });
          break;
        }
        if (!TIME_RE.test(String(cfg2.time || ''))) {
          errors.push({ path: field.path, message: `${field.label} "${label}": time must be HH:mm (e.g. "20:00").` });
          break;
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

// ─── backupAndWrite ───────────────────────────────────────────────────────────

/**
 * Atomically backup config.json and write the new content.
 * Keeps only the newest MAX_BACKUPS backup files.
 *
 * @param {object} cfg  Config object to write
 * @returns {string}    Path of the backup file created
 */
function backupAndWrite(cfg) {
  const dir = path.dirname(CONFIG_PATH);
  const ts = Date.now();
  const backupPath = `${CONFIG_PATH}.bak.${ts}`;

  // Backup current file (if it exists)
  if (fs.existsSync(CONFIG_PATH)) {
    fs.copyFileSync(CONFIG_PATH, backupPath);
  }

  // Write new config
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8');

  // Prune old backups
  try {
    const pattern = path.basename(CONFIG_PATH) + '.bak.';
    const backups = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(pattern))
      .map((f) => ({ name: f, ts: Number(f.split('.bak.')[1]) || 0 }))
      .sort((a, b) => b.ts - a.ts);

    for (const old of backups.slice(MAX_BACKUPS)) {
      try { fs.unlinkSync(path.join(dir, old.name)); } catch (_e) { /* ignore */ }
    }
  } catch (_e) { /* pruning is best-effort */ }

  return backupPath;
}

// ─── hashPassword ─────────────────────────────────────────────────────────────

/**
 * Hash a plaintext password with bcrypt (cost factor 12).
 * bcrypt is lazy-required so the module can be loaded in test environments
 * where the native binary hasn't been compiled.
 * @param {string} plain
 * @returns {Promise<string>}
 */
async function hashPassword(plain) {
  // eslint-disable-next-line global-require
  const bcrypt = require('bcrypt');
  return bcrypt.hash(plain, 12);
}

// ─── readConfig ───────────────────────────────────────────────────────────────

/**
 * Read and parse config.json from disk (no validation).
 * Returns {} if the file does not exist.
 */
function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (_e) {
    return {};
  }
}

// ─── validateRuntimeConfig ────────────────────────────────────────────────────

/**
 * Validate a parsed config object for runtime requirements (startup check).
 * Does NOT call process.exit() — returns { ok, errors } so callers decide.
 *
 * This mirrors the checks previously inlined in loadConfig() in src/index.js.
 * The admin panel's POST /config calls this before writing the new file.
 *
 * @param {object} cfg  Parsed config object
 * @returns {{ ok: boolean, errors: string[] }}
 */
function validateRuntimeConfig(cfg) {
  const errors = [];

  for (const k of ['timezone', 'groupId', 'playerCount', 'googleForm', 'adminPanel', 'messages']) {
    if (cfg[k] == null) errors.push(`missing field: ${k}`);
  }
  if (errors.length) return { ok: false, errors };

  for (const k of ['formId', 'publicUrl', 'serviceAccountKeyPath']) {
    if (!cfg.googleForm[k] || String(cfg.googleForm[k]).startsWith('REPLACE')) {
      errors.push(`config.googleForm.${k} is not set`);
    }
  }
  for (const k of ['playerSlotQuestions', 'dmSlotQuestions']) {
    if (!cfg.googleForm[k] || typeof cfg.googleForm[k] !== 'object' || !Object.keys(cfg.googleForm[k]).length) {
      errors.push(`config.googleForm.${k} must be an object mapping questionId → slot label`);
    }
  }
  if (!cfg.adminPanel.passwordHash || String(cfg.adminPanel.passwordHash).startsWith('REPLACE')) {
    errors.push('config.adminPanel.passwordHash is not set. Run: node bin/hash-password.js <your-password>');
  }
  if (cfg.googleCalendar) {
    for (const k of ['calendarId', 'serviceAccountKeyPath', 'slotTimes']) {
      if (cfg.googleCalendar[k] == null || String(cfg.googleCalendar[k]).startsWith('REPLACE')) {
        errors.push(`config.googleCalendar.${k} is not set (remove the googleCalendar block to disable calendar events)`);
      }
    }
    if (typeof cfg.googleCalendar.slotTimes !== 'object' || !Object.keys(cfg.googleCalendar.slotTimes).length) {
      errors.push('config.googleCalendar.slotTimes must be an object mapping slot label → { dayOfWeek, time }');
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true, errors: [] };
}

module.exports = {
  flattenForm,
  validateConfig,
  validateRuntimeConfig,
  backupAndWrite,
  hashPassword,
  readConfig,
  getNestedValue,
  setNestedValue,
};
