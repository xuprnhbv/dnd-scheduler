'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const { DateTime } = require('luxon');

const {
  sessionMiddleware,
  requireAuth,
  checkPassword,
  createRateLimiter,
} = require('./auth');
const {
  expandTemplate,
  validateSlots,
  nextPollWeekStart,
  currentWeekStart,
  weekRangeLabel,
} = require('../slots');
const logger = require('../logger');

const VIEW_DIR = path.join(__dirname, 'views');
const LOGIN_HTML = fs.readFileSync(path.join(VIEW_DIR, 'login.html'), 'utf8');
const PANEL_HTML = fs.readFileSync(path.join(VIEW_DIR, 'panel.html'), 'utf8');

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

function renderEditor(slots, locked) {
  const dayOpts = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const rows = slots.map((s) => {
    const options = dayOpts
      .map((d) => `<option${d === s.day ? ' selected' : ''}>${d}</option>`)
      .join('');
    return `
      <div class="row">
        <select name="day"${locked ? ' disabled' : ''}>${options}</select>
        <input type="time" name="time" value="${escapeHtml(s.time)}" ${locked ? 'disabled' : 'required'} />
        <input type="number" name="durationHours" value="${escapeHtml(s.durationHours)}" min="0.5" max="24" step="0.5" ${locked ? 'disabled' : 'required'} />
        <span class="muted">hours</span>
        <button type="button" class="remove"${locked ? ' disabled' : ''} title="Remove">&times;</button>
      </div>`;
  }).join('');

  if (locked) {
    return `
      <p class="muted">This week's slots are locked — the poll has already been posted. You can edit next week's slots after the current week closes.</p>
      <div id="rows">${rows}</div>`;
  }

  return `
    <form id="slots-form">
      <div id="rows">${rows || ''}</div>
      <div class="actions">
        <button type="button" id="add-row" class="btn secondary">+ Add slot</button>
        <button type="button" id="reset-template" class="btn secondary">Reset to template</button>
        <button type="submit" class="btn">Save</button>
      </div>
    </form>`;
}

function buildPanelContext({ config, db, now = new Date() }) {
  const tz = config.timezone;
  const curWeek = currentWeekStart(now, tz);
  const nextWeek = nextPollWeekStart(now, tz);

  const curState = db.getState(curWeek) || {
    mainPollId: null, reminderSent: false, winnerAnnounced: false,
    winnerSlot: null, tiebreakerPollId: null, tiebreakerWinnerAnnounced: false,
  };
  const nextState = db.getState(nextWeek);

  const nextLocked = !!(nextState && nextState.slotsLocked);
  const storedSlots = db.getSlots(nextWeek);
  const slots = Array.isArray(storedSlots) && storedSlots.length > 0
    ? storedSlots
    : expandTemplate(config.slotTemplate);

  const nextPollTime = DateTime.fromISO(nextWeek, { zone: tz })
    .set({ hour: 10, minute: 0 })
    .toFormat('EEE dd LLL yyyy, HH:mm ZZZZ');

  return {
    tz,
    curWeek,
    nextWeek,
    curState,
    nextState,
    nextLocked,
    slots,
    nextPollTime,
  };
}

function renderPanel({ config, db, banner = '', now = new Date() }) {
  const ctx = buildPanelContext({ config, db, now });
  const template = expandTemplate(config.slotTemplate);

  return render(PANEL_HTML, {
    BANNER: banner,
    NEXT_WEEK: escapeHtml(weekRangeLabel(ctx.nextWeek, ctx.tz)),
    NEXT_POLL_TIME: escapeHtml(ctx.nextPollTime),
    LOCK_STATUS: ctx.nextLocked
      ? '<span class="locked">Locked (poll already posted)</span>'
      : '<span class="editable">Editable</span>',
    EDITOR: renderEditor(ctx.slots, ctx.nextLocked),
    CUR_WEEK: escapeHtml(weekRangeLabel(ctx.curWeek, ctx.tz)),
    CUR_POLL: ctx.curState.mainPollId ? 'Yes' : 'No',
    CUR_REMINDER: ctx.curState.reminderSent ? 'Yes' : 'No',
    CUR_WINNER_ANNOUNCED: ctx.curState.winnerAnnounced ? 'Yes' : 'No',
    CUR_WINNER_SLOT: ctx.curState.winnerSlot
      ? escapeHtml(ctx.curState.winnerSlot)
      : '<span class="muted">—</span>',
    CUR_TIEBREAKER: ctx.curState.tiebreakerPollId
      ? (ctx.curState.tiebreakerWinnerAnnounced ? 'Decided' : 'Active')
      : 'No',
    TEMPLATE_JSON: JSON.stringify(template),
  });
}

function create({ config, db }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // trust first proxy hop for req.ip
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json({ limit: '64kb' }));
  app.use(sessionMiddleware(config));

  const loginLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 5 });

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

  app.get('/', requireAuth, (req, res) => {
    try {
      let banner = '';
      if (req.query.saved) {
        banner = '<div class="banner">Saved.</div>';
      }
      res.type('text/html').send(renderPanel({ config, db, banner }));
    } catch (err) {
      logger.error('panel render error:', err);
      res.status(500).type('text/plain').send('Internal error');
    }
  });

  app.post('/slots', requireAuth, (req, res) => {
    try {
      const now = new Date();
      const targetWeek = nextPollWeekStart(now, config.timezone);
      const state = db.getState(targetWeek);
      if (state && state.slotsLocked) {
        return res.status(409).type('text/plain').send('Slots are locked for the target week.');
      }
      const body = req.body || {};
      const slots = Array.isArray(body.slots) ? body.slots.map((s) => ({
        day: String(s.day),
        time: String(s.time),
        durationHours: Number(s.durationHours),
      })) : null;
      const v = validateSlots(slots);
      if (!v.ok) return res.status(400).type('text/plain').send(v.error);
      db.upsertSlots(targetWeek, slots);
      logger.info(`admin updated slots for week ${targetWeek} (${slots.length} rows)`);
      return res.status(200).type('text/plain').send('OK');
    } catch (err) {
      logger.error('slots update error:', err);
      return res.status(500).type('text/plain').send('Internal error');
    }
  });

  app.use((req, res) => res.redirect('/login'));

  return app;
}

module.exports = { create, renderPanel, buildPanelContext };
