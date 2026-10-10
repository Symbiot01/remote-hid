'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const {
  verifyPassword,
  createSessionToken,
  sessionCookieHeader,
  clearSessionCookieHeader,
  requireSession,
} = require('./auth');
const { validateRun, executeRun } = require('./runner');
const {
  tokensMatch,
  bearer,
  openWhep,
  closeWhep,
  streamStatus,
  startIngest,
  grabFrame,
  SDP_MAX,
} = require('./stream');
const { createCameraControl } = require('./camera');
const { createCaptureControl } = require('./capture');
const { createHidClient, validatePaste } = require('./hid');

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX = 50;

/**
 * @param {{ config: ReturnType<typeof import('./config').loadConfig>, hid?: ReturnType<typeof createHidClient> }} opts
 */
function createApp(opts) {
  const { config } = opts;
  const hid = opts.hid || createHidClient(config);
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
          'style-src': ["'self'", "'unsafe-inline'"],
          'img-src': ["'self'", 'data:', 'blob:'],
          'worker-src': ["'self'", 'blob:'],
          'connect-src': ["'self'", 'stun:stun.l.google.com:19302'],
          'media-src': ["'self'", 'blob:', 'mediastream:'],
          'frame-ancestors': ["'none'"],
          'base-uri': ["'self'"],
          'form-action': ["'self'"],
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );

  const camera = createCameraControl({
    password: config.lookcamPassword,
    streamStatus,
  });
  const capture = createCaptureControl({ token: config.captureToken || '' });

  app.use((req, res, next) => {
    if (
      req.path === '/api/runs' ||
      req.path === '/api/bridge/h264' ||
      req.path === '/api/stream/whep' ||
      req.path === '/api/bridge/result' ||
      req.path === '/api/bridge/status' ||
      req.path === '/api/hid/paste' ||
      req.path === '/api/capture/jpeg' ||
      req.path === '/api/capture/h264'
    ) {
      return next();
    }
    return express.json({ limit: '1kb' })(req, res, next);
  });

  const loginLimiter = rateLimit({
    windowMs: LOGIN_WINDOW_MS,
    max: LOGIN_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    statusCode: 401,
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
    res.setHeader('Set-Cookie', sessionCookieHeader(token, { nodeEnv: config.nodeEnv }));
    return res.status(200).json({ ok: true });
  });

  app.post('/api/logout', (_req, res) => {
    res.setHeader('Set-Cookie', clearSessionCookieHeader({ nodeEnv: config.nodeEnv }));
    return res.status(200).json({ ok: true });
  });

  app.get('/api/session', requireSession(config.sessionSecret), (_req, res) => {
    res.status(200).json({ ok: true });
  });

  const runLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many runs' },
  });

  app.post(
    '/api/runs',
    requireSession(config.sessionSecret),
    runLimiter,
    express.json({ limit: '2mb' }),
    async (req, res) => {
      const problem = validateRun(req.body);
      if (problem) return res.status(400).json({ error: problem });
      try {
        return res.status(200).json(await executeRun(req.body));
      } catch (error) {
        if (error && error.code === 'BUSY') {
          return res.status(429).json({ error: 'A run is already in progress' });
        }
        console.error('run failed', error instanceof Error ? error.message : 'unknown');
        return res.status(500).json({ error: 'Runner failed' });
      }
    },
  );

  const whepLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many stream requests' },
  });

  app.get('/api/stream', requireSession(config.sessionSecret), (_req, res) => {
    res.status(200).json(streamStatus());
  });

  app.post(
    '/api/stream/whep',
    requireSession(config.sessionSecret),
    whepLimiter,
    express.raw({ type: 'application/sdp', limit: SDP_MAX }),
    async (req, res) => {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ error: 'Expected an SDP offer' });
      }
      try {
        const opened = await openWhep(config.streamWhepUrl, req.body);
        if (opened.id) res.setHeader('Location', `/api/stream/whep/${opened.id}`);
        res.setHeader('Content-Type', 'application/sdp');
        return res.status(201).send(opened.answer);
      } catch (error) {
        const status = error && error.status === 404 ? 404 : error && error.status === 429 ? 429 : 502;
        const message = status === 404 ? 'No signal' : status === 429 ? 'Too many viewers' : 'Stream is unavailable';
        return res.status(status).json({ error: message });
      }
    },
  );

  app.delete('/api/stream/whep/:id', requireSession(config.sessionSecret), async (req, res) => {
    if (!/^[a-f0-9]{32}$/.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const closed = await closeWhep(req.params.id);
    return res.status(closed ? 200 : 404).json({ ok: closed });
  });

  const bridgeLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many bridge attempts' },
  });

  app.post('/api/bridge/h264', bridgeLimiter, (req, res) => {
    if (!config.bridgeToken) return res.status(503).json({ error: 'Bridge ingest is not configured' });
    if (req.headers['content-type'] !== 'application/octet-stream') {
      return res.status(415).json({ error: 'Expected video bytes' });
    }
    if (!tokensMatch(bearer(req), config.bridgeToken)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    startIngest(req, config.streamSrtUrl, (result) => {
      if (res.headersSent) return;
      if (!result.ok) {
        const message = result.status === 409 ? 'A bridge is already connected' : 'Ingest is unavailable';
        res.status(result.status).json({ error: message });
        req.destroy();
        return;
      }
      res.status(200);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.write('ok\n');
    });
    req.on('close', () => {
      if (!res.writableEnded) res.end();
    });
  });

  const bridgePollLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many bridge attempts' },
  });

  function requireBridge(req, res) {
    if (!config.bridgeToken) {
      res.status(503).json({ error: 'Bridge ingest is not configured' });
      return false;
    }
    if (!tokensMatch(bearer(req), config.bridgeToken)) {
      res.status(401).json({ error: 'Unauthorized' });
      return false;
    }
    return true;
  }

  app.get('/api/bridge/poll', bridgePollLimiter, (req, res) => {
    if (!requireBridge(req, res)) return undefined;
    const raw = Number(req.query.wait);
    const waitMs = Number.isFinite(raw) ? Math.min(15, Math.max(1, Math.trunc(raw))) * 1000 : 8000;
    camera.hold(res, waitMs);
    return undefined;
  });

  app.post('/api/bridge/status', bridgePollLimiter, express.json({ limit: '8kb' }), (req, res) => {
    if (!requireBridge(req, res)) return undefined;
    const problem = camera.applyStatus(req.body);
    if (problem) return res.status(400).json({ error: problem });
    return res.status(200).json({ ok: true });
  });

  app.post('/api/bridge/result', bridgePollLimiter, express.json({ limit: '48kb' }), (req, res) => {
    if (!requireBridge(req, res)) return undefined;
    const problem = camera.submitResult(req.body);
    if (problem) return res.status(400).json({ error: problem });
    return res.status(200).json({ ok: true });
  });

  const watchLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 40,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many watch updates' },
  });

  const commandLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many camera commands' },
  });

  app.get('/api/camera', requireSession(config.sessionSecret), (_req, res) => {
    res.status(200).json(camera.snapshot());
  });

  app.post('/api/camera/watch', requireSession(config.sessionSecret), watchLimiter, (req, res) => {
    const problem = camera.watch(req.body);
    if (problem) return res.status(400).json({ error: problem });
    return res.status(200).json({ ok: true });
  });

  app.post('/api/camera/command', requireSession(config.sessionSecret), commandLimiter, async (req, res) => {
    const name = req.body && req.body.name;
    const args = req.body && req.body.args;
    const result = await camera.command(name, args);
    return res.status(result.status).json(result.payload);
  });

  const hidLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many HID requests' },
  });

  app.get('/api/hid/status', requireSession(config.sessionSecret), hidLimiter, async (_req, res) => {
    if (!hid.configured()) return res.status(200).json({ configured: false, deviceConnected: false });
    try {
      const result = await hid.status();
      if (result.status !== 200) return res.status(502).json({ error: 'HID relay is unavailable' });
      return res.status(200).json({ configured: true, deviceConnected: result.body.deviceConnected });
    } catch {
      return res.status(502).json({ error: 'HID relay is unavailable' });
    }
  });

  app.post(
    '/api/hid/paste',
    requireSession(config.sessionSecret),
    hidLimiter,
    express.json({ limit: '16kb' }),
    async (req, res) => {
      if (!hid.configured()) return res.status(503).json({ error: 'HID relay is not configured' });
      const paste = validatePaste(req.body);
      if ('error' in paste) return res.status(400).json({ error: paste.error });
      try {
        const result = await hid.paste(paste);
        return res.status(result.status === 200 || result.status === 409 ? result.status : 502).json(result.body);
      } catch {
        return res.status(502).json({ error: 'HID relay is unavailable' });
      }
    },
  );

  app.post('/api/hid/paste/cancel', requireSession(config.sessionSecret), hidLimiter, async (_req, res) => {
    if (!hid.configured()) return res.status(503).json({ error: 'HID relay is not configured' });
    try {
      await hid.cancel();
      return res.status(200).json({ ok: true });
    } catch {
      return res.status(502).json({ error: 'HID relay is unavailable' });
    }
  });

  function requireCapture(req, res) {
    if (!capture.configured()) {
      res.status(503).json({ error: 'Capture is not configured' });
      return false;
    }
    if (!capture.authorize(req)) {
      res.status(401).json({ error: 'Unauthorized' });
      return false;
    }
    return true;
  }

  const captureLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many capture requests' },
  });

  app.get('/api/capture', requireSession(config.sessionSecret), captureLimiter, (_req, res) => {
    const media = streamStatus();
    res.status(200).json(capture.status(media && media.desk));
  });

  app.post('/api/capture/snap', requireSession(config.sessionSecret), captureLimiter, async (_req, res) => {
    const result = await capture.requestSnap();
    if (result.status !== 200 || !result.body) {
      return res.status(result.status).json({ error: result.error || 'Capture failed' });
    }
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Disposition', 'attachment; filename="capture.jpg"');
    return res.status(200).send(result.body);
  });

  app.post('/api/capture/frame', requireSession(config.sessionSecret), captureLimiter, async (_req, res) => {
    const rtsp = config.captureRtspCam || 'rtsp://127.0.0.1:8554/cam';
    const result = await grabFrame(rtsp);
    if (!result.ok || !result.body) {
      const message = result.status === 504 ? 'Frame timed out' : 'No frame';
      return res.status(result.status || 502).json({ error: message });
    }
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Disposition', 'attachment; filename="frame.jpg"');
    return res.status(200).send(result.body);
  });

  const captureAgentLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many capture requests' },
  });

  app.get('/api/capture/poll', captureAgentLimiter, (req, res) => {
    if (!requireCapture(req, res)) return undefined;
    const raw = Number(req.query.wait);
    const waitMs = Number.isFinite(raw) ? Math.min(15, Math.max(1, Math.trunc(raw))) * 1000 : 8000;
    capture.poll(res, waitMs);
    return undefined;
  });

  app.post(
    '/api/capture/jpeg',
    captureAgentLimiter,
    express.raw({ limit: '4mb', type: 'image/jpeg' }),
    (req, res) => {
      if (!requireCapture(req, res)) return undefined;
      if (req.headers['content-type'] !== 'image/jpeg') {
        return res.status(415).json({ error: 'Expected a JPEG' });
      }
      const result = capture.acceptJpeg(req.body);
      if (result.status !== 200) return res.status(result.status).json({ error: result.error });
      return res.status(200).json({ ok: true });
    },
  );

  const captureIngestLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many capture requests' },
  });

  app.post('/api/capture/h264', captureIngestLimiter, (req, res) => {
    if (!requireCapture(req, res)) return undefined;
    if (req.headers['content-type'] !== 'application/octet-stream') {
      return res.status(415).json({ error: 'Expected video bytes' });
    }
    const deskUrl =
      config.streamDeskSrtUrl || 'srt://127.0.0.1:8890?streamid=publish:desk&pkt_size=1316';
    startIngest(
      req,
      deskUrl,
      (result) => {
        if (res.headersSent) return;
        if (!result.ok) {
          const message = result.status === 409 ? 'A capture is already publishing' : 'Ingest is unavailable';
          res.status(result.status).json({ error: message });
          req.destroy();
          return;
        }
        res.status(200);
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.write('ok\n');
      },
      'desk',
    );
    req.on('close', () => {
      if (!res.writableEnded) res.end();
    });
  });

  app.get('/api/hid/paste/progress', requireSession(config.sessionSecret), async (req, res) => {
    if (!hid.configured()) return res.status(503).json({ error: 'HID relay is not configured' });
    try {
      const upstream = await hid.openProgress();
      if (!upstream.ok || !upstream.body) return res.status(502).json({ error: 'HID relay is unavailable' });
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();
      const reader = upstream.body.getReader();
      req.on('close', () => {
        reader.cancel().catch(() => undefined);
      });
      while (true) {
        const chunk = await reader.read();
        if (chunk.done || res.writableEnded) break;
        res.write(Buffer.from(chunk.value));
      }
      res.end();
      return undefined;
    } catch {
      if (!res.headersSent) return res.status(502).json({ error: 'HID relay is unavailable' });
      return undefined;
    }
  });

  const publicDir = path.join(__dirname, 'public');
  const indexHtml = path.join(publicDir, 'index.html');
  app.use(
    express.static(publicDir, {
      maxAge: '1h',
      index: false,
      fallthrough: true,
    }),
  );
  app.get(['/', '/app'], (_req, res) => {
    if (!fs.existsSync(indexHtml)) return res.status(404).json({ error: 'Not found' });
    return res.sendFile(indexHtml);
  });
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  return app;
}

module.exports = { createApp, LOGIN_MAX, LOGIN_WINDOW_MS };
