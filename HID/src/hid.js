'use strict';

const PASTE_MAX_CHARS = 4000;
const WPM_MIN = 20;
const WPM_MAX = 300;
const JITTER_MIN = 0;
const JITTER_MAX = 50;

const OP_KEY_DOWN = 1;
const OP_KEY_UP = 2;
const OP_RELEASE_ALL = 3;
const OP_MOUSE = 4;
const ESCAPE_USAGE = 0x29;
const BLOCKED_WITHOUT_ALL = new Set([0xe0, 0xe2, 0xe3, 0xe4, 0xe6, 0xe7, ESCAPE_USAGE]);

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 */
function integerIn(value, min, max) {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/**
 * @param {number} usage
 */
function isKeyboardUsage(usage) {
  if (!Number.isInteger(usage)) return false;
  if (usage >= 0xe0 && usage <= 0xe7) return true;
  return usage > 0 && usage < 0xa5;
}

/**
 * @param {number} usage
 * @param {'typing' | 'all' | null} mode
 */
function usageAllowed(usage, mode) {
  if (!isKeyboardUsage(usage)) return false;
  if (mode === 'all') return true;
  return !BLOCKED_WITHOUT_ALL.has(usage);
}

/**
 * Key frames follow the live mode. Mouse is only allowed while live.
 * `null` is the idle socket: typing keys and release-all, no mouse.
 * @param {Buffer} buf
 * @param {'typing' | 'all' | null} [mode]
 */
function validLiveFrame(buf, mode = null) {
  if (!Buffer.isBuffer(buf) || buf.length < 4 || buf.length > 10) return false;
  const op = buf[0];
  if (op === OP_RELEASE_ALL) return buf.length === 4;
  if (op === OP_KEY_DOWN || op === OP_KEY_UP) {
    return buf.length === 5 && usageAllowed(buf[4], mode);
  }
  if (op !== OP_MOUSE || (mode !== 'typing' && mode !== 'all') || buf.length !== 10) return false;
  return buf[4] <= 7;
}

/**
 * One live operator. A second socket keeps the idle key rules.
 */
function createLiveGate() {
  /** @type {unknown} */
  let owner = null;
  /** @type {'typing' | 'all' | null} */
  let mode = null;

  return {
    /**
     * @param {unknown} id
     * @param {unknown} next
     */
    claim(id, next) {
      if (next !== 'typing' && next !== 'all') return { ok: false, error: 'Invalid mode' };
      if (owner && owner !== id) return { ok: false, error: 'Live mode is already in use' };
      const release = owner === id && mode !== next;
      owner = id;
      mode = next;
      return { ok: true, mode, release };
    },
    /**
     * @param {unknown} id
     */
    leave(id) {
      if (owner !== id) return false;
      owner = null;
      mode = null;
      return true;
    },
    /**
     * @param {unknown} id
     * @returns {'typing' | 'all' | null}
     */
    modeFor(id) {
      return owner === id ? mode : null;
    },
  };
}

function releaseAllFrame() {
  const frame = Buffer.alloc(4);
  frame[0] = OP_RELEASE_ALL;
  frame[1] = 0x01;
  return frame;
}

/**
 * @param {unknown} body
 * @returns {{ error: string } | { text: string, mode: 'dump' | 'paced', wpm?: number, jitterPct?: number }}
 */
function validatePaste(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Invalid paste' };
  const input = /** @type {Record<string, unknown>} */ (body);
  const allowed = new Set(['text', 'mode', 'wpm', 'jitterPct']);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) return { error: 'Unknown field' };
  }
  const text = input.text;
  if (typeof text !== 'string' || text.length === 0) return { error: 'Empty text' };
  if (text.length > PASTE_MAX_CHARS) return { error: 'Text too long' };
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return { error: 'Text contains control characters' };
  if (input.mode !== 'dump' && input.mode !== 'paced') return { error: 'Invalid mode' };
  if (input.mode === 'dump') return { text, mode: 'dump' };
  if (!integerIn(input.wpm, WPM_MIN, WPM_MAX) || !integerIn(input.jitterPct, JITTER_MIN, JITTER_MAX)) {
    return { error: 'Invalid speed' };
  }
  return { text, mode: 'paced', wpm: input.wpm, jitterPct: input.jitterPct };
}

/**
 * @param {unknown} payload
 */
function publicPasteResult(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { error: 'Paste failed' };
  const input = /** @type {Record<string, unknown>} */ (payload);
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const key of ['ok', 'error', 'mode', 'chars', 'wpm', 'jitterPct', 'sent', 'total']) {
    if (Object.prototype.hasOwnProperty.call(input, key)) out[key] = input[key];
  }
  if (typeof out.error === 'string') out.error = out.error.slice(0, 200);
  return out;
}

/**
 * @param {{
 *   hidUrl?: string,
 *   hidPassword?: string,
 *   fetchImpl?: typeof fetch,
 * }} options
 */
function createHidClient(options = {}) {
  const hidUrl = typeof options.hidUrl === 'string' ? options.hidUrl.replace(/\/$/, '') : '';
  const hidPassword = typeof options.hidPassword === 'string' ? options.hidPassword : '';
  const fetchImpl = options.fetchImpl || fetch;
  let cookie = '';

  function configured() {
    return Boolean(hidUrl && hidPassword);
  }

  async function login() {
    const response = await fetchImpl(`${hidUrl}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ password: hidPassword }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      cookie = '';
      throw new Error('login failed');
    }
    const header = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    const raw = header[0] || response.headers.get('set-cookie') || '';
    const pair = raw.split(';')[0];
    if (!pair.startsWith('op_session=')) {
      cookie = '';
      await response.arrayBuffer().catch(() => undefined);
      throw new Error('login failed');
    }
    cookie = pair;
    await response.arrayBuffer().catch(() => undefined);
  }

  /**
   * @param {string} path
   * @param {{ method?: string, body?: string, headers?: Record<string, string> }} [init]
   */
  async function authed(path, init = {}) {
    if (!configured()) {
      const error = new Error('not configured');
      error.code = 'UNCONFIGURED';
      throw error;
    }
    const send = async () =>
      fetchImpl(`${hidUrl}${path}`, {
        method: init.method || 'GET',
        headers: {
          accept: 'application/json',
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          ...(init.headers || {}),
          cookie,
        },
        body: init.body,
        signal: AbortSignal.timeout(20000),
      });
    if (!cookie) await login();
    let response = await send();
    if (response.status === 401) {
      await login();
      response = await send();
    }
    return response;
  }

  async function status() {
    const response = await authed('/api/status');
    const payload = await response.json().catch(() => ({}));
    return {
      status: response.status,
      body: {
        deviceConnected: Boolean(payload && payload.deviceConnected),
      },
    };
  }

  /**
   * @param {ReturnType<typeof validatePaste>} paste
   */
  async function paste(pasteBody) {
    const response = await authed('/api/paste', {
      method: 'POST',
      body: JSON.stringify(pasteBody),
    });
    const payload = await response.json().catch(() => ({}));
    return { status: response.status, body: publicPasteResult(payload) };
  }

  async function cancel() {
    const response = await authed('/api/paste/cancel', { method: 'POST' });
    return response.ok;
  }

  async function openProgress() {
    return authed('/api/paste/progress', { headers: { accept: 'text/event-stream' } });
  }

  async function liveHeaders() {
    if (!cookie) await login();
    const origin = new URL(hidUrl).origin;
    const wsUrl = `${origin.replace(/^http/, 'ws')}/ws/hid`;
    return { wsUrl, cookie, origin };
  }

  return { configured, status, paste, cancel, openProgress, liveHeaders };
}

module.exports = {
  PASTE_MAX_CHARS,
  WPM_MIN,
  WPM_MAX,
  JITTER_MIN,
  JITTER_MAX,
  validatePaste,
  validLiveFrame,
  createLiveGate,
  releaseAllFrame,
  publicPasteResult,
  createHidClient,
};
