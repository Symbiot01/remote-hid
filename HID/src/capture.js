'use strict';

const { tokensMatch, bearer } = require('./stream');

const AGENT_TTL_MS = 20_000;
const SNAP_MS = 15_000;
const JPEG_MAX = 4 * 1024 * 1024;

/**
 * Outbound capture agent. The browser never receives the bearer token.
 * @param {{ token?: string, now?: () => number, schedule?: typeof setTimeout, cancel?: typeof clearTimeout }} [options]
 */
function createCaptureControl(options = {}) {
  const token = typeof options.token === 'string' ? options.token : '';
  const now = options.now || Date.now;
  const schedule = options.schedule || setTimeout;
  const cancel = options.cancel || clearTimeout;
  let seenAt = 0;
  /** @type {{ res: import('express').Response, timer: NodeJS.Timeout } | null} */
  let poller = null;
  /**
   * @type {{
   *   resolve: (result: { status: number, error?: string, body?: Buffer }) => void,
   *   timer: NodeJS.Timeout,
   *   sent: boolean,
   *   receiving: boolean,
   * } | null}
   */
  let snap = null;

  function configured() {
    return token.length >= 16;
  }

  function online() {
    return configured() && now() - seenAt < AGENT_TTL_MS;
  }

  function touch() {
    seenAt = now();
  }

  function authorize(req) {
    return configured() && tokensMatch(bearer(req), token);
  }

  /**
   * @param {{ snap: boolean }} body
   * @param {import('express').Response | null} res
   */
  function reply(res, body) {
    if (!res || res.writableEnded || res.destroyed) return;
    res.status(200).json(body);
  }

  function wake() {
    if (!poller) return;
    const current = poller;
    poller = null;
    cancel(current.timer);
    const wanted = Boolean(snap && !snap.sent);
    if (snap && wanted) snap.sent = true;
    reply(current.res, { snap: wanted });
  }

  /**
   * @param {import('express').Response} res
   * @param {number} waitMs
   */
  function poll(res, waitMs) {
    if (!configured()) {
      res.status(503).json({ error: 'Capture is not configured' });
      return;
    }
    if (poller) {
      res.status(409).json({ error: 'A capture agent is already connected' });
      return;
    }
    touch();
    if (snap && !snap.sent) {
      snap.sent = true;
      reply(res, { snap: true });
      return;
    }
    const timer = schedule(() => {
      if (poller && poller.res === res) poller = null;
      reply(res, { snap: false });
    }, waitMs);
    poller = { res, timer };
    res.on('close', () => {
      if (poller && poller.res === res) {
        cancel(timer);
        poller = null;
      }
    });
  }

  function requestSnap() {
    if (!configured()) return Promise.resolve({ status: 503, error: 'Capture is not configured' });
    if (!online()) return Promise.resolve({ status: 409, error: 'Capture agent is offline' });
    if (snap) return Promise.resolve({ status: 409, error: 'A snapshot is already in progress' });
    return new Promise((resolve) => {
      const timer = schedule(() => {
        if (!snap || snap.resolve !== resolve) return;
        snap = null;
        resolve({ status: 504, error: 'Capture agent did not answer' });
      }, SNAP_MS);
      snap = { resolve, timer, sent: false, receiving: false };
      wake();
    });
  }

  /**
   * @param {Buffer} body
   */
  function acceptJpeg(body) {
    if (!snap || !snap.sent) return { status: 409, error: 'No snapshot is waiting' };
    if (snap.receiving) return { status: 409, error: 'A snapshot is already in progress' };
    if (!Buffer.isBuffer(body) || body.length < 4 || body.length > JPEG_MAX || body[0] !== 0xff || body[1] !== 0xd8) {
      return { status: 400, error: 'Expected a JPEG' };
    }
    snap.receiving = true;
    const current = snap;
    snap = null;
    cancel(current.timer);
    current.resolve({ status: 200, body });
    return { status: 200 };
  }

  function status(desk) {
    return {
      configured: configured(),
      agent: online() ? 'online' : 'offline',
      desk: Boolean(desk),
    };
  }

  return { configured, authorize, poll, requestSnap, acceptJpeg, status, online };
}

module.exports = { createCaptureControl, JPEG_MAX, AGENT_TTL_MS };
