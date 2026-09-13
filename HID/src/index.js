'use strict';

const http = require('http');
const url = require('url');
const { WebSocketServer } = require('ws');

const { loadConfig } = require('./config');
const {
  sessionFromCookieHeader,
  isAllowedOrigin,
  verifyPassword,
} = require('./auth');
const { Forwarder, createRateGate, KEY_EVENTS_PER_SEC, MOUSE_EVENTS_PER_SEC, OP_MOUSE } = require('./forward');
const { CaptureHub } = require('./captureHub');
const { createApp } = require('./http');

const config = loadConfig();
const forwarder = new Forwarder();
const captureHub = new CaptureHub();
const app = createApp({ config, forwarder, captureHub });
const server = http.createServer(app);

const wssHid = new WebSocketServer({ noServer: true, maxPayload: 64 });
const wssDevice = new WebSocketServer({ noServer: true, maxPayload: 2048 });
const wssCapture = new WebSocketServer({
  noServer: true,
  maxPayload: 8 * 1024 * 1024,
});

server.on('upgrade', (req, socket, head) => {
  const parsed = url.parse(req.url || '', true);
  const pathname = parsed.pathname || '/';

  if (pathname === '/ws/hid') {
    if (!isAllowedOrigin(req, config.nodeEnv)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!sessionFromCookieHeader(req.headers.cookie, config.sessionSecret)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wssHid.handleUpgrade(req, socket, head, (ws) => {
      wssHid.emit('connection', ws, req);
    });
    return;
  }

  if (pathname === '/ws/device') {
    const token = typeof parsed.query.token === 'string' ? parsed.query.token : '';
    if (!verifyPassword(token, config.deviceToken)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wssDevice.handleUpgrade(req, socket, head, (ws) => {
      wssDevice.emit('connection', ws, req);
    });
    return;
  }

  if (pathname === '/ws/capture') {
    if (!config.captureToken) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
      return;
    }
    const token = typeof parsed.query.token === 'string' ? parsed.query.token : '';
    if (!verifyPassword(token, config.captureToken)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wssCapture.handleUpgrade(req, socket, head, (ws) => {
      wssCapture.emit('connection', ws, req);
    });
    return;
  }

  socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
  socket.destroy();
});

wssDevice.on('connection', (ws) => {
  forwarder.setDevice(ws);

  ws.on('message', () => {
    // device_ready JSON or keepalives; never log body, never forward to UI
  });

  ws.on('close', () => {
    forwarder.clearDevice(ws);
  });

  ws.on('error', () => {
    forwarder.clearDevice(ws);
  });
});

wssCapture.on('connection', (ws) => {
  captureHub.setSocket(ws);
});

wssHid.on('connection', (ws) => {
  forwarder.addUiClient(ws);
  const allowKey = createRateGate(KEY_EVENTS_PER_SEC);
  const allowMouse = createRateGate(MOUSE_EVENTS_PER_SEC);

  // One status JSON on connect so the badge updates before first key
  forwarder.sendUiStatus(ws);

  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
      try {
        const msg = JSON.parse(text);
        if (msg && msg.type === 'ping') {
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'pong' }));
          }
        }
      } catch {
        // ignore
      }
      return;
    }

    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const op = buf.length > 0 ? buf[0] : 0;
    const allow = op === OP_MOUSE ? allowMouse : allowKey;
    if (!allow()) {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'error', message: 'Too many input events' }));
      }
      return;
    }

    const result = forwarder.forwardLiveFrame(buf);
    if (!result.ok && result.message !== 'Key not supported') {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'error', message: result.message }));
      }
    }
  });

  ws.on('close', () => {
    forwarder.removeUiClient(ws);
    forwarder.releaseAll();
  });

  ws.on('error', () => {
    forwarder.removeUiClient(ws);
    forwarder.releaseAll();
  });
});

server.listen(config.port, config.host, () => {
  console.log('==============================================');
  console.log(` Operator console on ${config.host}:${config.port}`);
  console.log(` NODE_ENV=${config.nodeEnv}`);
  console.log(' DEVICE_TOKEN required for /ws/device');
  console.log(' CAPTURE_TOKEN required for /ws/capture');
  console.log('==============================================');
});

function shutdown() {
  console.log('[server] shutting down');
  forwarder.releaseAll();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
