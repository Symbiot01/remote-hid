'use strict';

const { WebSocketServer, WebSocket } = require('ws');
const { isAllowedOrigin, sessionFromCookieHeader } = require('./auth');
const { validLiveFrame, createLiveGate, releaseAllFrame } = require('./hid');

const MAX_CLIENTS = 4;
const KEY_EVENTS_PER_SEC = 250;

/**
 * @returns {() => boolean}
 */
function rateGate() {
  let windowStart = Date.now();
  let count = 0;
  return function allow() {
    const now = Date.now();
    if (now - windowStart >= 1000) {
      windowStart = now;
      count = 0;
    }
    count += 1;
    return count <= KEY_EVENTS_PER_SEC;
  };
}

/**
 * @param {import('http').Server} server
 * @param {{ config: { sessionSecret: string, nodeEnv: string }, hid: ReturnType<typeof import('./hid').createHidClient> }} opts
 */
function attachHidSocket(server, opts) {
  const { config, hid } = opts;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 });
  const live = createLiveGate();
  let clients = 0;

  server.on('upgrade', (req, socket, head) => {
    const path = (req.url || '').split('?')[0];
    if (path !== '/ws/hid') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!isAllowedOrigin(req, config.nodeEnv) || !sessionFromCookieHeader(req.headers.cookie, config.sessionSecret)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!hid.configured() || clients >= MAX_CLIENTS) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (browser) => {
    clients += 1;
    const allow = rateGate();
    /** @type {import('ws').WebSocket | null} */
    let upstream = null;
    let closed = false;

    const fail = (message) => {
      if (browser.readyState === WebSocket.OPEN) {
        browser.send(JSON.stringify({ type: 'error', message }));
      }
      try {
        browser.close();
      } catch {
        // already closing
      }
    };

    hid
      .liveHeaders()
      .then((headers) => {
        if (closed) return;
        upstream = new WebSocket(headers.wsUrl, {
          headers: { Cookie: headers.cookie, Origin: headers.origin },
          maxPayload: 4096,
        });
        upstream.on('message', (data, isBinary) => {
          if (browser.readyState !== WebSocket.OPEN) return;
          if (isBinary) return;
          const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
          if (text.length > 400) return;
          browser.send(text);
        });
        upstream.on('close', () => {
          if (browser.readyState === WebSocket.OPEN) browser.close();
        });
        upstream.on('error', () => {
          fail('HID relay is unavailable');
        });
      })
      .catch(() => {
        fail('HID relay is unavailable');
      });

    const releaseUpstream = () => {
      if (!upstream || upstream.readyState !== WebSocket.OPEN) return;
      try {
        upstream.send(releaseAllFrame());
      } catch {
        // the relay also releases when this socket closes
      }
    };

    browser.on('message', (data, isBinary) => {
      if (!isBinary) {
        const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
        const control = parseLiveControl(text);
        if (!control) return;
        if (control.type === 'leave') {
          if (live.leave(browser)) releaseUpstream();
          return;
        }
        const claimed = live.claim(browser, control.mode);
        if (!claimed.ok) {
          if (browser.readyState === WebSocket.OPEN) {
            browser.send(JSON.stringify({ type: 'error', message: claimed.error }));
          }
          return;
        }
        if (claimed.release) releaseUpstream();
        return;
      }
      if (!upstream || upstream.readyState !== WebSocket.OPEN) return;
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (!validLiveFrame(buf, live.modeFor(browser)) || !allow()) return;
      upstream.send(buf);
    });

    const stop = () => {
      if (closed) return;
      closed = true;
      clients = Math.max(0, clients - 1);
      if (live.leave(browser)) releaseUpstream();
      if (upstream) {
        try {
          upstream.close();
        } catch {
          // ignore
        }
      }
    };
    browser.on('close', stop);
    browser.on('error', stop);
  });
}

/**
 * @param {string} text
 */
function parseLiveControl(text) {
  if (text.length > 80) return null;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null;
  const keys = Object.keys(msg);
  if (msg.type === 'leave' && keys.length === 1) return { type: 'leave' };
  if (msg.type === 'live' && keys.length === 2 && (msg.mode === 'typing' || msg.mode === 'all')) {
    return { type: 'live', mode: msg.mode };
  }
  return null;
}

module.exports = { attachHidSocket, parseLiveControl };
