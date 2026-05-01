'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { DateTime } = require('luxon');

const {
  sessionMiddleware,
  requireAuth,
  checkPassword,
  createRateLimiter,
} = require('./auth');
const {
  nextPollWeekStart,
  currentWeekStart,
  weekRangeLabel,
} = require('../slots');
const postFormLink = require('../jobs/postFormLink');
const logger = require('../logger');
const { SCHEMA, SECTIONS, SECTION_TITLES } = require('./configSchema');
const {
  flattenForm,
  validateConfig,
  validateRuntimeConfig,
  backupAndWrite,
  hashPassword,
  readConfig,
  getNestedValue,
} = require('./configIO');

const VIEW_DIR = path.join(__dirname, 'views');
const LOGIN_HTML = fs.readFileSync(path.join(VIEW_DIR, 'login.html'), 'utf8');
const PANEL_HTML = fs.readFileSync(path.join(VIEW_DIR, 'panel.html'), 'utf8');
const EDIT_CONFIG_HTML = fs.readFileSync(path.join(VIEW_DIR, 'edit-config.html'), 'utf8');

// ─── HTML helpers ─────────────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function render(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_m, k) =>
    Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : '',
  );
}

// ─── Config form renderer ────────────────────────────────────────────────────

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function renderField(field, cfg, fieldErrors) {
  const val = getNestedValue(cfg, field.path);
  const errMsg = fieldErrors[field.path];
  const errClass = errMsg ? ' err-field' : '';
  const errHtml = errMsg ? `<div class="err">${escapeHtml(errMsg)}</div>` : '';
  const helpHtml = field.help ? `<div class="help">${escapeHtml(field.help)}</div>` : '';
  const name = escapeHtml(field.path);
  const labelHtml = `<label for="f-${name}">${escapeHtml(field.label)}${field.required ? ' <span style="color:#f88">*</span>' : ''}</label>`;

  let inputHtml;

  if (field.type === 'slotMap') {
    const rows = val && typeof val === 'object' ? Object.entries(val) : [];
    const rowsHtml = rows.map(([qid, slotLabel], i) => `
      <tr>
        <td><input type="text" name="${name}[${i}][questionId]" value="${escapeHtml(qid)}" placeholder="${escapeHtml(field.keyPlaceholder || '')}"/></td>
        <td><input type="text" name="${name}[${i}][slotLabel]" value="${escapeHtml(slotLabel)}" placeholder="${escapeHtml(field.valuePlaceholder || '')}"/></td>
        <td><button type="button" class="btn secondary small" onclick="removeRow(this)">−</button></td>
      </tr>`).join('');
    inputHtml = `
      <table class="slot-table">
        <thead><tr><th>Question ID</th><th>Slot label</th><th></th></tr></thead>
        <tbody id="tbody-${name}">${rowsHtml}</tbody>
      </table>
      <button type="button" class="btn secondary small add-row-btn"
        onclick="addSlotMapRow('${name}','${escapeHtml(field.keyPlaceholder||'')}','${escapeHtml(field.valuePlaceholder||'')}')">+ Add row</button>`;
    return `<div class="field">${labelHtml}<div>${inputHtml}${errHtml}${helpHtml}</div></div>`;
  }

  if (field.type === 'slotTimesMap') {
    const rows = val && typeof val === 'object' ? Object.entries(val) : [];
    const rowsHtml = rows.map(([slotLabel, slotCfg], i) => {
      const dow = String((slotCfg && slotCfg.dayOfWeek) || '').toLowerCase();
      const timeVal = (slotCfg && slotCfg.time) || '';
      const dayOpts = DAYS.map((d) => `<option value="${d}"${dow === d ? ' selected' : ''}>${d.charAt(0).toUpperCase() + d.slice(1)}</option>`).join('');
      return `
      <tr>
        <td><input type="text" name="${name}[${i}][slotLabel]" value="${escapeHtml(slotLabel)}" placeholder="${escapeHtml(field.keyPlaceholder || '')}"/></td>
        <td><select name="${name}[${i}][dayOfWeek]">${dayOpts}</select></td>
        <td><input type="text" name="${name}[${i}][time]" value="${escapeHtml(timeVal)}" placeholder="20:00" style="width:80px"/></td>
        <td><button type="button" class="btn secondary small" onclick="removeRow(this)">−</button></td>
      </tr>`;
    }).join('');
    inputHtml = `
      <table class="slot-table">
        <thead><tr><th>Slot label</th><th>Day of week</th><th>Time (HH:mm)</th><th></th></tr></thead>
        <tbody id="tbody-${name}">${rowsHtml}</tbody>
      </table>
      <button type="button" class="btn secondary small add-row-btn"
        onclick="addSlotTimesRow('${name}','${escapeHtml(field.keyPlaceholder||'')}')">+ Add row</button>`;
    return `<div class="field">${labelHtml}<div>${inputHtml}${errHtml}${helpHtml}</div></div>`;
  }

  if (field.type === 'password') {
    // Never echo back the current value — leave blank, keep current on save
    const pwId = `f-${name}`;
    inputHtml = `<div class="pw-wrap">
      <input type="password" id="${pwId}" name="${name}" autocomplete="off"
             placeholder="(leave blank to keep current)" class="${errClass.trim()}"/>
      <button type="button" class="btn secondary small" onclick="togglePw('${pwId}',this)">Show</button>
    </div>`;
    return `<div class="field">${labelHtml}<div>${inputHtml}${errHtml}${helpHtml}</div></div>`;
  }

  if (field.type === 'textarea') {
    const strVal = val != null ? escapeHtml(String(val)) : '';
    inputHtml = `<textarea id="f-${name}" name="${name}" class="${errClass.trim()}">${strVal}</textarea>`;
    return `<div class="field">${labelHtml}<div>${inputHtml}${errHtml}${helpHtml}</div></div>`;
  }

  // string / number / url
  const inputType = field.type === 'url' ? 'url' : field.type === 'number' ? 'number' : 'text';
  const strVal = val != null ? escapeHtml(String(val)) : '';
  const placeholder = field.placeholder ? ` placeholder="${escapeHtml(field.placeholder)}"` : '';
  inputHtml = `<input type="${inputType}" id="f-${name}" name="${name}" value="${strVal}"${placeholder} class="${errClass.trim()}"/>`;
  return `<div class="field">${labelHtml}<div>${inputHtml}${errHtml}${helpHtml}</div></div>`;
}

function renderConfigForm(cfg, fieldErrors = {}, banner = '', changePwBanner = '', regenBanner = '') {
  let fieldsHtml = '';

  for (const section of SECTIONS) {
    const sectionFields = SCHEMA.filter((f) => f.section === section);
    const title = SECTION_TITLES[section] || section;
    fieldsHtml += `<div class="card"><h2>${escapeHtml(title)}</h2>`;
    for (const field of sectionFields) {
      fieldsHtml += renderField(field, cfg, fieldErrors);
    }
    fieldsHtml += '</div>';
  }

  return render(EDIT_CONFIG_HTML, {
    BANNER: banner,
    FIELDS_HTML: fieldsHtml,
    CHANGE_PW_BANNER: changePwBanner,
    REGEN_BANNER: regenBanner,
  });
}

// ─── Panel renderer ───────────────────────────────────────────────────────────

async function buildPanelContext({ config, db, googleForm, now = new Date() }) {
  const tz = config.timezone;
  const curWeek = currentWeekStart(now, tz);
  const nextWeek = nextPollWeekStart(now, tz);

  const curState = db.getState(curWeek) || {
    mainPollId: null, reminderSent: false, winnerAnnounced: false,
    winnerSlot: null, tiebreakerPollId: null, tiebreakerWinnerAnnounced: false,
  };

  const nextPollTime = DateTime.fromISO(nextWeek, { zone: tz })
    .set({ hour: 10, minute: 0 })
    .toFormat('EEE dd LLL yyyy, HH:mm ZZZZ');

  let filledCount = null;
  let dmResponded = null;
  if (googleForm) {
    try {
      const { playerResponses, dmResponse } = await googleForm.readResponses();
      filledCount = playerResponses.length;
      dmResponded = !!dmResponse;
    } catch (err) {
      logger.warn('[admin] readResponses failed:', err.message);
    }
  }

  return {
    tz,
    curWeek,
    nextWeek,
    curState,
    nextPollTime,
    filledCount,
    dmResponded,
  };
}

async function renderPanel({ config, db, googleForm, banner = '', now = new Date() }) {
  const ctx = await buildPanelContext({ config, db, googleForm, now });
  const playerCount = Number(config.playerCount) || 0;
  const formUrl = (config.googleForm && config.googleForm.publicUrl) || '';

  const responsesCell = ctx.filledCount == null
    ? '<span class="muted">—</span>'
    : `${escapeHtml(ctx.filledCount)} / ${escapeHtml(playerCount)}`;
  const dmCell = ctx.dmResponded == null
    ? '<span class="muted">—</span>'
    : (ctx.dmResponded ? 'Yes' : '<span class="locked">Not yet</span>');

  return render(PANEL_HTML, {
    BANNER: banner,
    NEXT_WEEK: escapeHtml(weekRangeLabel(ctx.nextWeek, ctx.tz)),
    NEXT_POLL_TIME: escapeHtml(ctx.nextPollTime),
    FORM_URL: escapeHtml(formUrl),
    FORM_URL_LINK: formUrl
      ? `<a href="${escapeHtml(formUrl)}" target="_blank" rel="noopener">Open form</a>`
      : '<span class="muted">—</span>',
    RESPONSES: responsesCell,
    DM_RESPONDED: dmCell,
    CUR_WEEK: escapeHtml(weekRangeLabel(ctx.curWeek, ctx.tz)),
    CUR_ANNOUNCED: ctx.curState.mainPollId ? 'Yes' : 'No',
    CUR_REMINDER: ctx.curState.reminderSent ? 'Yes' : 'No',
    CUR_WINNER_ANNOUNCED: ctx.curState.winnerAnnounced ? 'Yes' : 'No',
    CUR_WINNER_SLOT: ctx.curState.winnerSlot
      ? escapeHtml(ctx.curState.winnerSlot)
      : '<span class="muted">—</span>',
    CUR_TIEBREAKER: ctx.curState.tiebreakerPollId
      ? (ctx.curState.tiebreakerWinnerAnnounced ? 'Decided' : 'Active')
      : 'No',
    SEND_FORM_BUTTON: ctx.curState.mainPollId
      ? ''
      : `<form method="post" action="/send-form" style="margin-top:14px">
           <button type="submit" class="btn">📨 Send form link now</button>
         </form>`,
  });
}

// ─── Restart banner ───────────────────────────────────────────────────────────

const RESTART_BANNER = `<div class="banner success">
  ✅ Config saved. <strong>Restart the bot for changes to take effect.</strong>
  <div class="restart-cmds" style="margin-top:8px">
    <div style="font-size:12px;color:#aaa;margin-bottom:4px">tmux:</div>
    <code>tmux send-keys -t dnd-bot C-c Enter &amp;&amp; tmux send-keys -t dnd-bot 'node src/index.js' Enter</code>
    <div style="font-size:12px;color:#aaa;margin:6px 0 4px">systemd:</div>
    <code>sudo systemctl restart dnd-bot</code>
  </div>
</div>`;

// ─── App factory ──────────────────────────────────────────────────────────────

function create({ config, db, whatsapp, googleForm }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  // extended:false uses querystring (not qs), which keeps bracket-notation keys literal —
  // that's what flattenForm expects when reading slot-map row fields.
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json({ limit: '64kb' }));
  app.use(sessionMiddleware(config));

  const loginLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 5 });

  // ── Auth routes ────────────────────────────────────────────────────────────

  app.get('/login', (req, res) => {
    if (req.session && req.session.authed) return res.redirect('/');
    const err = req.query.err ? '<div class="err">Invalid password.</div>' : '';
    res.type('text/html').send(render(LOGIN_HTML, { ERROR: err }));
  });

  app.post('/login', loginLimiter, async (req, res) => {
    try {
      const { password } = req.body || {};
      const ok = await checkPassword(password, config.adminPanel.passwordHash);
      if (!ok) {
        logger.warn(`admin login failed from ${req.ip}`);
        return res.redirect('/login?err=1');
      }
      req.session.authed = true;
      logger.info(`admin login success from ${req.ip}`);
      return res.redirect('/');
    } catch (err) {
      logger.error('login error:', err);
      return res.status(500).type('text/plain').send('Internal error');
    }
  });

  app.post('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login'));
  });

  // ── Dashboard ──────────────────────────────────────────────────────────────

  app.get('/', requireAuth, async (req, res) => {
    try {
      let banner = '';
      if (req.query.sent) banner = '<div class="banner">✓ Form link sent to the group.</div>';
      if (req.query.err === 'already-sent') banner = '<div class="banner error">Form link was already sent this week.</div>';
      const html = await renderPanel({ config, db, googleForm, banner });
      res.type('text/html').send(html);
    } catch (err) {
      logger.error('panel render error:', err);
      res.status(500).type('text/plain').send('Internal error');
    }
  });

  app.post('/send-form', requireAuth, async (req, res) => {
    try {
      const now = new Date();
      const weekStart = currentWeekStart(now, config.timezone);
      const state = db.getState(weekStart);
      if (state && state.mainPollId) {
        logger.warn('admin tried to send form link but it was already sent');
        return res.redirect('/?err=already-sent');
      }
      logger.info('admin manually triggering postFormLink');
      await postFormLink.run({ config, db, whatsapp, googleForm });
      return res.redirect('/?sent=1');
    } catch (err) {
      logger.error('admin send-form error:', err);
      return res.status(500).type('text/plain').send('Error: ' + escapeHtml(err.message));
    }
  });

  // ── Config editor ──────────────────────────────────────────────────────────

  app.get('/config', requireAuth, (req, res) => {
    try {
      const cfg = readConfig();
      let banner = '';
      if (req.query.saved) banner = RESTART_BANNER;
      const html = renderConfigForm(cfg, {}, banner);
      res.type('text/html').send(html);
    } catch (err) {
      logger.error('config GET error:', err);
      res.status(500).type('text/plain').send('Internal error');
    }
  });

  app.post('/config', requireAuth, (req, res) => {
    try {
      const current = readConfig();
      const newCfg = flattenForm(req.body, SCHEMA, current);

      // Schema-level validation (form checks)
      const formResult = validateConfig(newCfg, SCHEMA);
      if (!formResult.ok) {
        const fieldErrors = {};
        for (const e of formResult.errors) fieldErrors[e.path] = e.message;
        const banner = `<div class="banner error">Please fix the errors below before saving.</div>`;
        const html = renderConfigForm(newCfg, fieldErrors, banner);
        return res.type('text/html').send(html);
      }

      // Runtime validation (startup-level checks)
      const runtimeResult = validateRuntimeConfig(newCfg);
      if (!runtimeResult.ok) {
        const banner = `<div class="banner error">${runtimeResult.errors.map(escapeHtml).join('<br>')}</div>`;
        const html = renderConfigForm(newCfg, {}, banner);
        return res.type('text/html').send(html);
      }

      const backupPath = backupAndWrite(newCfg);
      logger.info(`[admin] config saved; backup at ${backupPath}`);
      return res.redirect('/config?saved=1');
    } catch (err) {
      logger.error('config POST error:', err);
      res.status(500).type('text/plain').send('Internal error: ' + escapeHtml(err.message));
    }
  });

  // ── Change password ────────────────────────────────────────────────────────

  app.post('/config/change-password', requireAuth, async (req, res) => {
    try {
      const { new_password: newPw } = req.body || {};
      if (!newPw || String(newPw).length < 8) {
        const banner = '<div class="banner error">Password must be at least 8 characters.</div>';
        const cfg = readConfig();
        const html = renderConfigForm(cfg, {}, '', banner);
        return res.type('text/html').send(html);
      }
      const hash = await hashPassword(String(newPw));
      const cfg = readConfig();
      cfg.adminPanel = cfg.adminPanel || {};
      cfg.adminPanel.passwordHash = hash;
      // Update the in-memory config so the running process accepts the new hash
      config.adminPanel.passwordHash = hash;
      const backupPath = backupAndWrite(cfg);
      logger.info(`[admin] password changed; backup at ${backupPath}`);
      const banner = '<div class="banner success">✅ Password updated. No restart needed.</div>';
      const html = renderConfigForm(cfg, {}, '', banner);
      return res.type('text/html').send(html);
    } catch (err) {
      logger.error('change-password error:', err);
      res.status(500).type('text/plain').send('Internal error');
    }
  });

  // ── Regenerate session secret ──────────────────────────────────────────────

  app.post('/config/regenerate-secret', requireAuth, (req, res) => {
    try {
      const newSecret = crypto.randomBytes(48).toString('hex');
      const cfg = readConfig();
      cfg.adminPanel = cfg.adminPanel || {};
      cfg.adminPanel.sessionSecret = newSecret;
      const backupPath = backupAndWrite(cfg);
      logger.info(`[admin] session secret regenerated; backup at ${backupPath}`);
      // Destroy the current session so the user is redirected to /login
      req.session.destroy(() => res.redirect('/login?msg=secret-regenerated'));
    } catch (err) {
      logger.error('regenerate-secret error:', err);
      res.status(500).type('text/plain').send('Internal error');
    }
  });

  // ── Fallback ───────────────────────────────────────────────────────────────

  app.use((req, res) => res.redirect('/login'));

  return app;
}

module.exports = { create, renderPanel, buildPanelContext, renderConfigForm };
