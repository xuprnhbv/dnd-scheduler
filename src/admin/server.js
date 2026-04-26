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
  nextPollWeekStart,
  currentWeekStart,
  weekRangeLabel,
} = require('../slots');
const postFormLink = require('../jobs/postFormLink');
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

function create({ config, db, whatsapp, googleForm }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
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

  app.use((req, res) => res.redirect('/login'));

  return app;
}

module.exports = { create, renderPanel, buildPanelContext };
