'use strict';

const crypto = require('crypto');
const cookie = require('cookie');
const signature = require('cookie-signature');

const COOKIE_NAME = 'op_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Timing-safe string compare. Length mismatches still spend a compare.
 * @param {string} provided
 * @param {string} expected
 * @returns {boolean}
 */
function verifyPassword(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') {
    return false;
  }
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    const dummy = Buffer.alloc(a.length);
    crypto.timingSafeEqual(a, dummy);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

/**
 * @param {string} sessionSecret
 * @returns {string}
 */
function createSessionToken(sessionSecret) {
  const payload = JSON.stringify({
    v: 1,
    exp: Date.now() + SESSION_TTL_MS,
    n: crypto.randomBytes(16).toString('hex'),
  });
  return signature.sign(payload, sessionSecret);
}

/**
 * @param {string|undefined} signedValue
 * @param {string} sessionSecret
 * @returns {boolean}
 */
function isValidSession(signedValue, sessionSecret) {
  if (!signedValue || typeof signedValue !== 'string') {
    return false;
  }
  const unsigned = signature.unsign(signedValue, sessionSecret);
  if (unsigned === false) {
    return false;
  }
  try {
    const data = JSON.parse(unsigned);
    if (!data || data.v !== 1 || typeof data.exp !== 'number') {
      return false;
    }
    if (Date.now() > data.exp) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} signedToken
 * @param {{ nodeEnv: string }} opts
 * @returns {string}
 */
function sessionCookieHeader(signedToken, opts) {
  return cookie.serialize(COOKIE_NAME, signedToken, {
    httpOnly: true,
    sameSite: 'strict',
    secure: opts.nodeEnv === 'production',
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

/**
 * @param {{ nodeEnv: string }} opts
 * @returns {string}
 */
function clearSessionCookieHeader(opts) {
  return cookie.serialize(COOKIE_NAME, '', {
    httpOnly: true,
    sameSite: 'strict',
    secure: opts.nodeEnv === 'production',
    path: '/',
    maxAge: 0,
  });
}

/**
 * @param {string|undefined} cookieHeader
 * @param {string} sessionSecret
 * @returns {boolean}
 */
function sessionFromCookieHeader(cookieHeader, sessionSecret) {
  if (!cookieHeader) {
    return false;
  }
  const parsed = cookie.parse(cookieHeader);
  return isValidSession(parsed[COOKIE_NAME], sessionSecret);
}

/**
 * @param {string} sessionSecret
 */
function requireSession(sessionSecret) {
  return function requireSessionMiddleware(req, res, next) {
    if (!sessionFromCookieHeader(req.headers.cookie, sessionSecret)) {
      if (req.path.startsWith('/api/')) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      return res.redirect('/');
    }
    return next();
  };
}

/**
 * Browser WebSocket upgrades must come from this host.
 * In development the Vite server on port 5173 is also allowed.
 * @param {import('http').IncomingMessage} req
 * @param {string} nodeEnv
 */
function isAllowedOrigin(req, nodeEnv) {
  const origin = req.headers.origin;
  if (!origin) return nodeEnv !== 'production';
  try {
    const parsed = new URL(origin);
    const hostHeader = req.headers.host;
    if (!hostHeader) return false;
    if (parsed.host === hostHeader) return true;
    if (nodeEnv !== 'production') {
      const viteDev =
        (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') && parsed.port === '5173';
      if (viteDev) return true;
    }
    return false;
  } catch {
    return false;
  }
}

module.exports = {
  COOKIE_NAME,
  SESSION_TTL_MS,
  verifyPassword,
  createSessionToken,
  isValidSession,
  sessionCookieHeader,
  clearSessionCookieHeader,
  sessionFromCookieHeader,
  requireSession,
  isAllowedOrigin,
};
