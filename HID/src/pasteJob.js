'use strict';

/** Firmware accepts WS text frames with length in (0, 256). */
const DEVICE_TEXT_MAX = 200;

const WPM_MIN = 20;
const WPM_MAX = 180;
const JITTER_MIN = 0;
const JITTER_MAX = 50;

/**
 * @param {number} wpm
 * @param {number} jitterPct
 * @param {string} ch
 */
function nextDelayMs(wpm, jitterPct, ch) {
  const charsPerSec = (wpm * 5) / 60;
  const baseMs = 1000 / charsPerSec;
  const j = jitterPct / 100;
  const scale = 1 + (Math.random() * 2 - 1) * j;
  let ms = baseMs * scale;
  if (ch === '\n') ms *= 2;
  else if (ch === '.' || ch === '!' || ch === '?') ms *= 1.5;
  return Math.max(8, Math.round(ms));
}

/**
 * @param {string} text
 * @returns {string[]}
 */
function dumpChunks(text) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + DEVICE_TEXT_MAX, text.length);
    // Avoid splitting a UTF-16 surrogate pair.
    if (end < text.length) {
      const code = text.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    }
    if (end <= i) end = i + 1;
    chunks.push(text.slice(i, end));
    i = end;
  }
  return chunks;
}

/**
 * One global paced paste job. Timing lives on the relay, not the ESP32.
 * Device only receives short text frames and Keyboard.print each immediately.
 */
class PasteJobRunner {
  /**
   * @param {import('./forward').Forwarder} forwarder
   */
  constructor(forwarder) {
    this.forwarder = forwarder;
    /** @type {AbortController | null} */
    this._abort = null;
    this._running = false;
  }

  isRunning() {
    return this._running;
  }

  cancel() {
    if (this._abort) this._abort.abort();
    this.forwarder.releaseAll();
  }

  /**
   * Dump: send text ASAP in ≤DEVICE_TEXT_MAX chunks (no inter-char delay).
   * @param {string} text
   */
  dump(text) {
    if (this._running) {
      return { ok: false, message: 'Paste already running' };
    }
    if (!this.forwarder.isDeviceConnected()) {
      return { ok: false, message: 'Device not connected' };
    }
    const parts = dumpChunks(text);
    let chars = 0;
    for (const part of parts) {
      const result = this.forwarder.sendPasteText(part);
      if (!result.ok) return result;
      chars += result.chars;
    }
    return { ok: true, chars, mode: 'dump' };
  }

  /**
   * Paced: relay sleeps between single-code-unit sends using WPM + jitter.
   * ESP32 USB print rate is unrelated to these intervals.
   * @param {{ text: string, wpm: number, jitterPct: number }} opts
   */
  async paced(opts) {
    const { text, wpm, jitterPct } = opts;
    if (this._running) {
      return { ok: false, message: 'Paste already running' };
    }
    if (!this.forwarder.isDeviceConnected()) {
      return { ok: false, message: 'Device not connected' };
    }

    this._running = true;
    this._abort = new AbortController();
    const { signal } = this._abort;
    let sent = 0;

    try {
      for (let i = 0; i < text.length; i += 1) {
        if (signal.aborted) {
          return { ok: false, message: 'Cancelled', sent, total: text.length };
        }
        if (!this.forwarder.isDeviceConnected()) {
          return { ok: false, message: 'Device not connected', sent, total: text.length };
        }

        const ch = text[i];
        // Skip unpaired high surrogates; pair with next unit when present.
        if (ch.charCodeAt(0) >= 0xd800 && ch.charCodeAt(0) <= 0xdbff) {
          const next = text[i + 1];
          const unit =
            next && next.charCodeAt(0) >= 0xdc00 && next.charCodeAt(0) <= 0xdfff
              ? ch + next
              : ch;
          if (unit.length === 2) i += 1;
          const result = this.forwarder.sendPasteText(unit);
          if (!result.ok) return { ...result, sent, total: text.length };
          sent += 1;
          await sleep(nextDelayMs(wpm, jitterPct, unit[0]), signal);
          continue;
        }

        const result = this.forwarder.sendPasteText(ch);
        if (!result.ok) return { ...result, sent, total: text.length };
        sent += 1;

        if (i < text.length - 1) {
          await sleep(nextDelayMs(wpm, jitterPct, ch), signal);
        }
      }
      return { ok: true, chars: sent, mode: 'paced', wpm, jitterPct };
    } finally {
      this._running = false;
      this._abort = null;
    }
  }
}

/**
 * @param {number} ms
 * @param {AbortSignal} signal
 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      return;
    }
    const t = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  }).catch((err) => {
    if (err && err.name === 'AbortError') return;
    throw err;
  });
}

/**
 * @param {unknown} raw
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 */
function clampInt(raw, min, max, fallback) {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

module.exports = {
  PasteJobRunner,
  clampInt,
  WPM_MIN,
  WPM_MAX,
  JITTER_MIN,
  JITTER_MAX,
  DEVICE_TEXT_MAX,
};
