'use strict';

const crypto = require('node:crypto');

const WATCH_MS = 10_000;
const STOP_GRACE_MS = 12_000;
const BRIDGE_TTL_MS = 20_000;
const COMMAND_MS = 15_000;
const MAX_QUEUE = 8;
const MAX_WATCHERS = 20;

const SECRET_KEY = /pwd|password/i;

/**
 * @param {unknown} value
 * @param {number} max
 */
function clip(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max);
}

/**
 * Drop device and network passwords before anything reaches the browser or a log.
 * @param {unknown} value
 */
function redact(value) {
  if (Array.isArray(value)) return value.slice(0, 40).map(redact);
  if (!value || typeof value !== 'object') return value;
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) continue;
    out[key] = redact(item);
  }
  return out;
}

/**
 * @param {unknown} value
 * @returns {{ ok: true, value: number } | { ok: false, error: string }}
 */
function bit(value) {
  if (value !== 0 && value !== 1) return { ok: false, error: 'Expected 0 or 1' };
  return { ok: true, value };
}

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 */
function integer(value, min, max) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    return { ok: false, error: `Expected an integer from ${min} to ${max}` };
  }
  return { ok: true, value };
}

/**
 * @param {unknown} value
 */
function clock(value) {
  if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) {
    return { ok: false, error: 'Expected HH:MM' };
  }
  const hour = Number(value.slice(0, 2));
  const minute = Number(value.slice(3, 5));
  if (hour > 23 || minute > 59) return { ok: false, error: 'Expected HH:MM' };
  return { ok: true, value };
}

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 */
function text(value, min, max) {
  if (typeof value !== 'string') return { ok: false, error: 'Expected text' };
  if (/[\u0000-\u001f\u007f]/.test(value) || value.length < min || value.length > max) {
    return { ok: false, error: `Expected ${min} to ${max} characters` };
  }
  return { ok: true, value };
}

/** @typedef {(value: unknown) => { ok: true, value: unknown } | { ok: false, error: string }} Rule */

/** @type {Record<string, { required?: Record<string, Rule>, optional?: Record<string, Rule>, atLeastOne?: boolean }>} */
const COMMANDS = {
  reconnect: {},
  GetDevInfo: {},
  GetDevStream: {},
  GetDevVideoInfo: {},
  GetAlarmInfo: {},
  GetLedInfo: {},
  searchWiFiList: {},
  LevelFlip: {},
  VerticalFlip: {},
  SetLed: { required: { ledstatus: (value) => bit(value) } },
  SetDevVideoInfo: {
    optional: {
      saturation: (value) => integer(value, 0, 100),
      brightness: (value) => integer(value, 0, 100),
    },
    atLeastOne: true,
  },
  SetAlarmInfo: {
    required: {
      sensitivity: (value) => integer(value, 0, 10),
      goptime: (value) => integer(value, 1, 120),
      audio: (value) => bit(value),
      putalarm: (value) => bit(value),
      osd: (value) => bit(value),
      flag: (value) => bit(value),
      starttime: (value) => clock(value),
      endtime: (value) => clock(value),
      twotime: (value) => clock(value),
      twoend: (value) => clock(value),
    },
  },
  SetLedInfo: {
    required: {
      control: (value) => bit(value),
      flag: (value) => bit(value),
      starttime: (value) => clock(value),
      endtime: (value) => clock(value),
      twotime: (value) => clock(value),
      twoend: (value) => clock(value),
    },
  },
  OpenWifi: {
    required: {
      sid: (value) => text(value, 1, 32),
      wifiPwd: (value) => text(value, 0, 64),
    },
  },
  ModifyPwd: { required: { newpwd: (value) => text(value, 1, 64) } },
};

/**
 * Allow only commands observed on this camera. AppointDev stays inside the bridge.
 * @param {unknown} name
 * @param {unknown} args
 * @returns {{ error: string } | { name: string, args: Record<string, unknown> }}
 */
function validateCommand(name, args) {
  if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(COMMANDS, name)) {
    return { error: 'Unknown command' };
  }
  const input = args == null ? {} : args;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'Invalid arguments' };
  const spec = COMMANDS[name];
  const required = spec.required || {};
  const optional = spec.optional || {};
  const allowed = new Set([...Object.keys(required), ...Object.keys(optional)]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) return { error: 'Unknown field' };
  }
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, rule] of Object.entries(required)) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) return { error: `Missing ${key}` };
    const parsed = rule(/** @type {Record<string, unknown>} */ (input)[key]);
    if (!parsed.ok) return { error: parsed.error };
    out[key] = parsed.value;
  }
  for (const [key, rule] of Object.entries(optional)) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    const parsed = rule(/** @type {Record<string, unknown>} */ (input)[key]);
    if (!parsed.ok) return { error: parsed.error };
    out[key] = parsed.value;
  }
  if (spec.atLeastOne && Object.keys(out).length === 0) return { error: 'Missing a value' };
  return { name, args: out };
}

/**
 * @param {{
 *   password?: string,
 *   streamStatus?: () => { ingest: boolean },
 *   now?: () => number,
 *   schedule?: (fn: () => void, ms: number) => unknown,
 *   cancel?: (timer: unknown) => void,
 *   manual?: boolean,
 * }} [options]
 */
function createCameraControl(options = {}) {
  const password = typeof options.password === 'string' ? options.password : '';
  const streamStatus = options.streamStatus || (() => ({ ingest: false }));
  const now = options.now || (() => Date.now());
  const schedule = options.schedule || ((fn, ms) => setTimeout(fn, ms));
  const cancel = options.cancel || ((timer) => clearTimeout(/** @type {ReturnType<typeof setTimeout>} */ (timer)));

  /** @type {Map<string, number>} */
  const watchers = new Map();
  /** @type {{ id: string, op: string, name: string, args: Record<string, unknown> }[]} */
  const queue = [];
  /** @type {Map<string, { name: string, resolve: (result: { status: number, payload: Record<string, unknown> }) => void, timer: unknown }>} */
  const pending = new Map();
  /** @type {{ res: import('express').Response, timer: unknown } | null} */
  let poller = null;
  let stopTimer = /** @type {unknown} */ (null);
  let videoDesired = false;
  let stream = 2;
  let configured = false;
  let lastSeen = 0;
  let phase = '';
  let detail = '';
  let attempt = 0;
  let cameraVideo = 'off';
  /** @type {{ name: string, ok: boolean, detail: string }[]} */
  let checks = [];
  /** @type {{ name: string, ok: boolean, detail: string, at: number } | null} */
  let last = null;

  function touch() {
    lastSeen = now();
  }

  function online() {
    return lastSeen > 0 && now() - lastSeen < BRIDGE_TTL_MS;
  }

  function wake() {
    if (!poller) return;
    const current = poller;
    poller = null;
    cancel(current.timer);
    if (!current.res.writableEnded && !current.res.destroyed) current.res.json(drain());
  }

  function setVideo(next) {
    if (videoDesired === next) return;
    videoDesired = next;
    wake();
  }

  function liveWatchers() {
    const time = now();
    for (const [id, exp] of watchers) {
      if (exp <= time) watchers.delete(id);
    }
    return watchers.size;
  }

  function sweep() {
    if (liveWatchers() > 0) {
      if (stopTimer) {
        cancel(stopTimer);
        stopTimer = null;
      }
      setVideo(true);
      return;
    }
    if (videoDesired && !stopTimer) {
      stopTimer = schedule(() => {
        stopTimer = null;
        if (liveWatchers() === 0) setVideo(false);
      }, STOP_GRACE_MS);
    }
  }

  if (!options.manual) {
    const timer = setInterval(sweep, 2000);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function drain() {
    touch();
    /** @type {Record<string, unknown>[]} */
    const commands = [];
    if (!configured) {
      commands.push({ id: crypto.randomBytes(8).toString('hex'), op: 'configure', password });
      configured = true;
    }
    while (commands.length < 4 && queue.length > 0) {
      const next = queue.shift();
      if (next) commands.push(next);
    }
    return { video: videoDesired, stream, commands };
  }

  /**
   * @param {import('express').Response} res
   * @param {number} waitMs
   */
  function hold(res, waitMs) {
    if (poller) {
      res.status(409).json({ error: 'A bridge is already connected' });
      return;
    }
    touch();
    if (!configured || queue.length > 0) {
      res.json(drain());
      return;
    }
    const timer = schedule(() => {
      if (poller && poller.res === res) poller = null;
      if (!res.writableEnded && !res.destroyed) res.json(drain());
    }, waitMs);
    poller = { res, timer };
    res.on('close', () => {
      if (poller && poller.res === res) {
        cancel(timer);
        poller = null;
      }
    });
  }

  function snapshot() {
    const media = streamStatus();
    return {
      bridge: online() ? 'online' : 'offline',
      phase,
      attempt,
      detail,
      checks,
      video: videoDesired ? 'wanted' : 'off',
      cameraVideo,
      ingest: Boolean(media && media.ingest),
      watching: liveWatchers() > 0,
      stream,
      last,
    };
  }

  /**
   * @param {unknown} body
   * @returns {string | null}
   */
  function watch(body) {
    const input = body && typeof body === 'object' ? /** @type {Record<string, unknown>} */ (body) : {};
    const id = input.id;
    if (typeof id !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(id)) return 'Invalid watch id';
    if (input.stream != null && input.stream !== 2 && input.stream !== 3) return 'Invalid stream';
    if (watchers.size >= MAX_WATCHERS && !watchers.has(id)) return 'Too many viewers';
    watchers.set(id, now() + WATCH_MS);
    if ((input.stream === 2 || input.stream === 3) && stream !== input.stream) {
      stream = input.stream;
      wake();
    }
    if (stopTimer) {
      cancel(stopTimer);
      stopTimer = null;
    }
    setVideo(true);
    return null;
  }

  /**
   * @param {unknown} name
   * @param {unknown} args
   * @returns {Promise<{ status: number, payload: Record<string, unknown> }>}
   */
  function command(name, args) {
    const parsed = validateCommand(name, args);
    if ('error' in parsed) return Promise.resolve({ status: 400, payload: { error: parsed.error } });
    if (!online()) return Promise.resolve({ status: 409, payload: { error: 'Bridge is offline' } });
    if (queue.length >= MAX_QUEUE) {
      return Promise.resolve({ status: 429, payload: { error: 'Too many camera commands' } });
    }
    const id = crypto.randomBytes(8).toString('hex');
    const op = parsed.name === 'reconnect' ? 'reconnect' : 'call';
    return new Promise((resolve) => {
      const timer = schedule(() => {
        pending.delete(id);
        resolve({ status: 504, payload: { error: 'Camera did not answer' } });
      }, COMMAND_MS);
      pending.set(id, { name: parsed.name, resolve, timer });
      queue.push({ id, op, name: parsed.name, args: parsed.args });
      wake();
    });
  }

  /**
   * @param {unknown} body
   * @returns {string | null}
   */
  function applyStatus(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Invalid status';
    const input = /** @type {Record<string, unknown>} */ (body);
    phase = clip(input.phase, 40);
    detail = clip(input.detail, 160);
    attempt = Number.isInteger(input.attempt)
      ? Math.max(0, Math.min(/** @type {number} */ (input.attempt), 1_000_000))
      : 0;
    cameraVideo = input.video === 'on' || input.video === 'starting' ? input.video : 'off';
    /** @type {{ name: string, ok: boolean, detail: string }[]} */
    const nextChecks = [];
    if (Array.isArray(input.checks)) {
      for (const item of input.checks.slice(0, 8)) {
        if (!item || typeof item !== 'object') continue;
        const row = /** @type {Record<string, unknown>} */ (item);
        nextChecks.push({
          name: clip(row.name, 24),
          ok: row.ok === true,
          detail: clip(row.detail, 80),
        });
      }
    }
    checks = nextChecks;
    touch();
    if (input.needsPassword === true && password && configured) {
      configured = false;
      wake();
    }
    return null;
  }

  /**
   * @param {unknown} body
   * @returns {string | null}
   */
  function submitResult(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Invalid result';
    const input = /** @type {Record<string, unknown>} */ (body);
    if (typeof input.id !== 'string' || !/^[a-f0-9]{16}$/.test(input.id)) return 'Invalid result';
    const safeBody = redact(input.body);
    const detailText = clip(input.detail, 200);
    const waiter = pending.get(input.id);
    if (waiter) {
      last = { name: waiter.name, ok: input.ok === true, detail: detailText, at: now() };
      cancel(waiter.timer);
      pending.delete(input.id);
      waiter.resolve({
        status: 200,
        payload: {
          ok: input.ok === true,
          detail:
            waiter.name === 'ModifyPwd' && input.ok === true
              ? 'Password changed. Update LOOKCAM_PASSWORD on the server, then restart the bridge.'
              : detailText,
          body: safeBody && typeof safeBody === 'object' ? /** @type {Record<string, unknown>} */ (safeBody) : null,
        },
      });
    }
    return null;
  }

  return { snapshot, watch, command, applyStatus, submitResult, drain, hold, sweep };
}

module.exports = {
  createCameraControl,
  validateCommand,
  redact,
  WATCH_MS,
  STOP_GRACE_MS,
};
