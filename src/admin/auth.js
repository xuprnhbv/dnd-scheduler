'use strict';

const bcrypt = require('bcrypt');
const session = require('express-session');

function sessionMiddleware(config) {
  return session({
    secret: config.adminPanel.sessionSecret,
    name: 'dnd.sid',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      // Mark Secure whenever we serve HTTPS (the default). Only an explicit
      // tls.enabled=false (e.g. TLS terminated by a reverse proxy in front of
      // plain HTTP) disables it, so cookies still work over HTTP in that mode.
      secure: !(config.adminPanel.tls && config.adminPanel.tls.enabled === false),
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  });
}

function requireAuth(req, res, next) {
  if (req.session && req.session.authed) return next();
  return res.redirect('/login');
}

async function checkPassword(plain, hash) {
  if (!plain || !hash) return false;
  try {
    return await bcrypt.compare(plain, hash);
  } catch (_err) {
    return false;
  }
}

function createRateLimiter({ windowMs = 15 * 60 * 1000, max = 5 } = {}) {
  const buckets = new Map(); // ip -> { count, resetAt }

  return function limiter(req, res, next) {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const now = Date.now();
    let bucket = buckets.get(ip);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(ip, bucket);
    }
    bucket.count += 1;
    if (bucket.count > max) {
      const secs = Math.ceil((bucket.resetAt - now) / 1000);
      res.status(429).type('text/plain').send(`Too many attempts. Try again in ${secs}s.`);
      return;
    }
    next();
  };
}

module.exports = {
  sessionMiddleware,
  requireAuth,
  checkPassword,
  createRateLimiter,
};
