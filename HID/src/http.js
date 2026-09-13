'use strict';

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const {
  verifyPassword,
  createSessionToken,
  sessionCookieHeader,
  clearSessionCookieHeader,
  sessionFromCookieHeader,
  requireSession,
  PASTE_MAX_CHARS,
} = require('./auth');
const { fetchStillJpeg } = require('./photo');
const {
  PasteJobRunner,
  clampInt,
  WPM_MIN,
  WPM_MAX,
  JITTER_MIN,
  JITTER_MAX,
} = require('./pasteJob');

/**
 * @param {{
 *   config: ReturnType<typeof import('./config').loadConfig>,
 *   forwarder: import('./forward').Forwarder,
 *   captureHub: import('./captureHub').CaptureHub,
 * }} opts
 */
function createApp(opts) {
  const { config, forwarder, captureHub } = opts;
  const pasteJobs = new PasteJobRunner(forwarder);
  const publicDir = path.join(__dirname, 'public');
  const indexHtml = path.join(publicDir, 'index.html');
  const app = express();

  if (config.trustProxy) {
    app.set('trust proxy', 1);
  }

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'"],
          'style-src': ["'self'"],
          'img-src': ["'self'", 'data:', 'blob:'],
          // Stream-test WHIP/WHEP fetch + STUN for ICE (media plane is separate host).
          'connect-src': ["'self'", ...(config.mediaOrigins || [config.mediaOrigin]), config.stunUrl],
          'media-src': ["'self'", 'blob:', 'mediastream:'],
          'frame-ancestors': ["'none'"],
          'base-uri': ["'self'"],
          'form-action': ["'self'"],
        },
      },
      crossOriginEmbedderPolicy: false,
    })
  );

  app.use(express.json({ limit: '8kb' }));

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Invalid password' },
  });

  app.get('/healthz', (_req, res) => {
    res.status(200).json({ ok: true });
  });

  app.post('/api/login', loginLimiter, (req, res) => {
    const password =
      req.body && typeof req.body.password === 'string' ? req.body.password : '';
    if (!verifyPassword(password, config.gatePassword)) {
      return res.status(401).json({ error: 'Invalid password' });
    }
    const token = createSessionToken(config.sessionSecret);
    res.setHeader(
      'Set-Cookie',
      sessionCookieHeader(token, { nodeEnv: config.nodeEnv })
    );
    return res.status(200).json({ ok: true });
  });

  app.post('/api/logout', (req, res) => {
    res.setHeader(
      'Set-Cookie',
      clearSessionCookieHeader({ nodeEnv: config.nodeEnv })
    );
    return res.status(200).json({ ok: true });
  });

  app.get('/api/status', requireSession(config.sessionSecret), (_req, res) => {
    res.json({
      deviceConnected: forwarder.isDeviceConnected(),
      captureConnected: captureHub.isConnected(),
    });
  });

  // Dump or paced paste. Pacing (WPM/jitter) is owned by this relay — not the ESP32.
  app.post('/api/paste', requireSession(config.sessionSecret), async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const text = typeof body.text === 'string' ? body.text : '';
    if (!text) {
      return res.status(400).json({ error: 'Empty text' });
    }
    if (text.length > PASTE_MAX_CHARS) {
      return res.status(400).json({ error: 'Text too long' });
    }

    const mode = body.mode === 'paced' ? 'paced' : 'dump';

    if (mode === 'dump') {
      const result = pasteJobs.dump(text);
      if (!result.ok) {
        return res.status(409).json({ error: result.message });
      }
      return res.status(200).json({
        ok: true,
        mode: 'dump',
        chars: text.length,
      });
    }

    const wpm = clampInt(body.wpm, WPM_MIN, WPM_MAX, 80);
    const jitterPct = clampInt(body.jitterPct, JITTER_MIN, JITTER_MAX, 25);

    try {
      const result = await pasteJobs.paced({ text, wpm, jitterPct });
      if (!result.ok) {
        return res.status(409).json({
          error: result.message,
          sent: result.sent,
          total: result.total,
        });
      }
      return res.status(200).json({
        ok: true,
        mode: 'paced',
        chars: result.chars,
        wpm,
        jitterPct,
      });
    } catch (err) {
      console.error('[paste] paced failed:', err && err.message);
      return res.status(500).json({ error: 'Paste failed' });
    }
  });

  app.post('/api/paste/cancel', requireSession(config.sessionSecret), (_req, res) => {
    pasteJobs.cancel();
    return res.status(200).json({ ok: true });
  });

  // Slice E — session → Pi via /ws/capture (CAPTURE_TOKEN never leaves the server).
  const photoLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Rate limited' },
  });

  app.post(
    '/api/photo',
    requireSession(config.sessionSecret),
    photoLimiter,
    async (_req, res) => {
      try {
        const result = await fetchStillJpeg(captureHub, {
          captureToken: config.captureToken,
        });
        if (!result.ok) {
          return res.status(result.status).json({ error: result.error });
        }
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${result.filename}"`
        );
        res.setHeader('Content-Length', String(result.body.length));
        return res.status(200).send(result.body);
      } catch {
        return res.status(500).json({ error: 'Photo failed' });
      }
    }
  );

  app.get('/app', requireSession(config.sessionSecret), (_req, res) => {
    res.sendFile(indexHtml);
  });

  app.get('/', (req, res) => {
    if (sessionFromCookieHeader(req.headers.cookie, config.sessionSecret)) {
      return res.redirect('/app');
    }
    return res.sendFile(indexHtml);
  });

  // Vite build assets (hashed JS/CSS under /assets)
  app.use(
    express.static(publicDir, {
      maxAge: '1h',
      index: false,
      fallthrough: true,
    })
  );

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  return app;
}

module.exports = { createApp };
