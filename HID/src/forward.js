'use strict';

const { WebSocket } = require('ws');

const KEY_EVENTS_PER_SEC = 250;
const MOUSE_EVENTS_PER_SEC = 250;
const FLAG_SEQ = 0x01;

const OP_KEY_DOWN = 1;
const OP_KEY_UP = 2;
const OP_RELEASE_ALL = 3;
const OP_MOUSE = 4;

/**
 * @param {number} usage
 * @returns {boolean}
 */
function isHidKeyboardUsage(usage) {
  if (!Number.isInteger(usage)) {
    return false;
  }
  if (usage >= 0xe0 && usage <= 0xe7) {
    return true;
  }
  return usage > 0 && usage < 0xa5;
}

/**
 * Expected total frame length for a live op.
 * @param {number} op
 * @returns {number|null}
 */
function expectedFrameLength(op) {
  if (op === OP_KEY_DOWN || op === OP_KEY_UP) {
    return 5; // header 4 + usage 1
  }
  if (op === OP_RELEASE_ALL) {
    return 4;
  }
  if (op === OP_MOUSE) {
    return 10; // header 4 + buttons + dx i16 + dy i16 + wheel i8
  }
  return null;
}

/**
 * Sliding 1s window per UI socket.
 * @returns {() => boolean}
 */
function createRateGate(limit) {
  let windowStart = Date.now();
  let count = 0;
  return function allow() {
    const now = Date.now();
    if (now - windowStart >= 1000) {
      windowStart = now;
      count = 0;
    }
    count += 1;
    return count <= limit;
  };
}

/**
 * Single-device binary HID forwarder.
 * Browser /ws/hid → device /ws/device. No JSON on the live path.
 */
class Forwarder {
  constructor() {
    /** @type {import('ws').WebSocket|null} */
    this.device = null;
    /** @type {Set<import('ws').WebSocket>} */
    this.uiClients = new Set();
  }

  isDeviceConnected() {
    return Boolean(this.device && this.device.readyState === WebSocket.OPEN);
  }

  /**
   * @param {import('ws').WebSocket} ws
   */
  addUiClient(ws) {
    this.uiClients.add(ws);
    this.sendUiStatus(ws);
  }

  /**
   * @param {import('ws').WebSocket} ws
   */
  removeUiClient(ws) {
    this.uiClients.delete(ws);
  }

  /**
   * @param {import('ws').WebSocket} ws
   */
  setDevice(ws) {
    if (this.device && this.device !== ws) {
      try {
        this.device.close(1000, 'replaced');
      } catch {
        // ignore
      }
    }
    this.device = ws;
    console.log('[device] connected');
    this.broadcastStatus();
  }

  /**
   * @param {import('ws').WebSocket} ws
   */
  clearDevice(ws) {
    if (this.device === ws) {
      this.device = null;
      console.log('[device] disconnected');
      this.broadcastStatus();
    }
  }

  /**
   * @param {import('ws').WebSocket} ws
   */
  sendUiStatus(ws) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: 'status',
          deviceConnected: this.isDeviceConnected(),
        })
      );
    }
  }

  broadcastStatus() {
    const msg = JSON.stringify({
      type: 'status',
      deviceConnected: this.isDeviceConnected(),
    });
    for (const ws of this.uiClients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    }
  }

  /**
   * Validate and forward a live binary frame. Drops if device down.
   * @param {Buffer} buf
   * @returns {{ ok: true } | { ok: false, message: string }}
   */
  forwardLiveFrame(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 4) {
      return { ok: false, message: 'Invalid frame' };
    }
    const op = buf[0];
    const flags = buf[1];
    const expected = expectedFrameLength(op);
    if (expected === null || buf.length !== expected) {
      return { ok: false, message: 'Invalid frame' };
    }
    if ((flags & FLAG_SEQ) === 0) {
      return { ok: false, message: 'Invalid frame' };
    }
    if (op === OP_KEY_DOWN || op === OP_KEY_UP) {
      const usage = buf[4];
      if (!isHidKeyboardUsage(usage)) {
        return { ok: false, message: 'Key not supported' };
      }
    }
    if (!this.isDeviceConnected()) {
      return { ok: false, message: 'Device not connected' };
    }
    try {
      this.device.send(buf);
      return { ok: true };
    } catch (err) {
      console.error('[forward] live send failed:', err.message);
      return { ok: false, message: 'Send failed' };
    }
  }

  /**
   * Build and send releaseAll (op 3).
   * @returns {{ ok: true } | { ok: false, message: string }}
   */
  releaseAll() {
    if (!this.isDeviceConnected()) {
      return { ok: false, message: 'Device not connected' };
    }
    const frame = Buffer.alloc(4);
    frame[0] = OP_RELEASE_ALL;
    frame[1] = FLAG_SEQ;
    frame.writeUInt16LE(0, 2);
    try {
      this.device.send(frame);
      return { ok: true };
    } catch (err) {
      console.error('[forward] release-all failed:', err.message);
      return { ok: false, message: 'Send failed' };
    }
  }

  /**
   * Dump paste: UTF-8 text to device. Never logs body.
   * @param {string} text
   * @returns {{ ok: true, chars: number } | { ok: false, message: string }}
   */
  sendPasteText(text) {
    if (typeof text !== 'string') {
      return { ok: false, message: 'Invalid payload' };
    }
    if (!this.isDeviceConnected()) {
      return { ok: false, message: 'Device not connected' };
    }
    try {
      this.device.send(text);
      const chars = Buffer.byteLength(text, 'utf8');
      console.log(`[paste] sent ${chars} chars`);
      return { ok: true, chars };
    } catch (err) {
      console.error('[paste] send failed:', err.message);
      return { ok: false, message: 'Send failed' };
    }
  }
}

module.exports = {
  Forwarder,
  createRateGate,
  KEY_EVENTS_PER_SEC,
  MOUSE_EVENTS_PER_SEC,
  OP_KEY_DOWN,
  OP_KEY_UP,
  OP_RELEASE_ALL,
  OP_MOUSE,
  FLAG_SEQ,
  isHidKeyboardUsage,
};
