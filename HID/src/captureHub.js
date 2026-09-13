'use strict';

const crypto = require('crypto');
const { WebSocket } = require('ws');

const PHOTO_TIMEOUT_MS = 20000;
const PHOTO_MIN_INTERVAL_MS = 2000;
const MAX_JPEG_BYTES = 8 * 1024 * 1024;

/**
 * @typedef {{
 *   id: string,
 *   expectBytes: number | null,
 *   timer: NodeJS.Timeout,
 *   resolve: (v: { ok: true, body: Buffer } | { ok: false, status: number, error: string }) => void,
 * }} PendingPhoto
 */

/**
 * Pi outbound /ws/capture hub. One socket; one in-flight photo.
 */
class CaptureHub {
  constructor() {
    /** @type {import('ws').WebSocket|null} */
    this.socket = null;
    /** @type {PendingPhoto|null} */
    this.pending = null;
    /** @type {number} */
    this.lastPhotoAt = 0;
  }

  /**
   * @returns {boolean}
   */
  isConnected() {
    return Boolean(this.socket && this.socket.readyState === WebSocket.OPEN);
  }

  /**
   * @param {import('ws').WebSocket} ws
   */
  setSocket(ws) {
    if (this.socket && this.socket !== ws) {
      try {
        this.socket.close(4000, 'replaced');
      } catch {
        // ignore
      }
    }
    this.socket = ws;
    this._failPending(502, 'Capture reconnected');

    ws.on('message', (data, isBinary) => {
      this._onMessage(data, Boolean(isBinary));
    });

    ws.on('close', () => {
      if (this.socket === ws) {
        this.socket = null;
      }
      this._failPending(503, 'Capture disconnected');
    });

    ws.on('error', () => {
      if (this.socket === ws) {
        this.socket = null;
      }
      this._failPending(502, 'Capture socket error');
    });
  }

  /**
   * @param {import('ws').WebSocket} ws
   */
  clearSocket(ws) {
    if (this.socket === ws) {
      this.socket = null;
    }
    this._failPending(503, 'Capture disconnected');
  }

  /**
   * @returns {Promise<
   *   | { ok: true, body: Buffer, filename: string }
   *   | { ok: false, status: number, error: string }
   * >}
   */
  requestPhoto() {
    if (!this.isConnected()) {
      return Promise.resolve({
        ok: false,
        status: 503,
        error: 'Capture node offline',
      });
    }

    const now = Date.now();
    if (now - this.lastPhotoAt < PHOTO_MIN_INTERVAL_MS) {
      return Promise.resolve({ ok: false, status: 429, error: 'Rate limited' });
    }

    if (this.pending) {
      return Promise.resolve({ ok: false, status: 429, error: 'Capture busy' });
    }

    const id = crypto.randomUUID();
    const ws = this.socket;

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending && this.pending.id === id) {
          this.pending = null;
          resolve({ ok: false, status: 504, error: 'Capture timed out' });
        }
      }, PHOTO_TIMEOUT_MS);

      this.pending = {
        id,
        expectBytes: null,
        timer,
        resolve: (result) => {
          if (result.ok) {
            this.lastPhotoAt = Date.now();
            resolve({
              ok: true,
              body: result.body,
              filename: captureFilename(),
            });
          } else {
            resolve(result);
          }
        },
      };

      try {
        ws.send(JSON.stringify({ type: 'photo_req', id }));
      } catch {
        clearTimeout(timer);
        this.pending = null;
        resolve({ ok: false, status: 502, error: 'Capture send failed' });
      }
    });
  }

  /**
   * @param {import('ws').RawData} data
   * @param {boolean} isBinary
   */
  _onMessage(data, isBinary) {
    if (!isBinary) {
      const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'ping') {
        if (this.isConnected()) {
          this.socket.send(JSON.stringify({ type: 'pong' }));
        }
        return;
      }

      if (!this.pending) return;

      if (msg.type === 'photo_err' && msg.id === this.pending.id) {
        const err =
          typeof msg.error === 'string' && msg.error
            ? msg.error.slice(0, 200)
            : 'Capture failed';
        this._finishPending({ ok: false, status: 502, error: err });
        return;
      }

      if (msg.type === 'photo_meta' && msg.id === this.pending.id) {
        const n = Number(msg.bytes);
        if (!Number.isFinite(n) || n < 1 || n > MAX_JPEG_BYTES) {
          this._finishPending({
            ok: false,
            status: 502,
            error: 'Capture payload invalid',
          });
          return;
        }
        this.pending.expectBytes = n;
        return;
      }

      return;
    }

    if (!this.pending || this.pending.expectBytes === null) {
      return;
    }

    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const expect = this.pending.expectBytes;
    if (buf.length !== expect) {
      this._finishPending({
        ok: false,
        status: 502,
        error: 'Capture size mismatch',
      });
      return;
    }
    if (buf.length < 2 || buf[0] !== 0xff || buf[1] !== 0xd8) {
      this._finishPending({
        ok: false,
        status: 502,
        error: 'Capture returned unexpected type',
      });
      return;
    }

    this._finishPending({ ok: true, body: buf });
  }

  /**
   * @param {{ ok: true, body: Buffer } | { ok: false, status: number, error: string }} result
   */
  _finishPending(result) {
    if (!this.pending) return;
    const p = this.pending;
    this.pending = null;
    clearTimeout(p.timer);
    p.resolve(result);
  }

  /**
   * @param {number} status
   * @param {string} error
   */
  _failPending(status, error) {
    if (!this.pending) return;
    this._finishPending({ ok: false, status, error });
  }
}

/**
 * @returns {string}
 */
function captureFilename() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return (
    `capture-${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}.jpg`
  );
}

module.exports = {
  CaptureHub,
  PHOTO_TIMEOUT_MS,
  PHOTO_MIN_INTERVAL_MS,
  MAX_JPEG_BYTES,
};
