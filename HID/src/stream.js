'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const FFMPEG = '/usr/bin/ffmpeg';
const SDP_MAX = 64 * 1024;
const SESSION_TTL_MS = 60 * 60 * 1000;
const IDLE_MS = 20_000;
const MAX_WHEP_SESSIONS = 8;

/** @type {Map<string, { url: string, exp: number }>} */
const whepSessions = new Map();
const FRAME_MAX = 4 * 1024 * 1024;
/** @type {Record<'cam' | 'desk', { child: import('node:child_process').ChildProcess, input: import('node:stream').Readable, idle: NodeJS.Timeout } | null>} */
const slots = { cam: null, desk: null };

function tokensMatch(provided, expected) {
  const a = Buffer.from(typeof provided === 'string' ? provided : '', 'utf8');
  const b = Buffer.from(typeof expected === 'string' ? expected : '', 'utf8');
  if (a.length !== b.length) {
    crypto.timingSafeEqual(a, Buffer.alloc(a.length));
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function bearer(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return '';
  const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(header);
  return match ? match[1] : '';
}

function pruneSessions() {
  const now = Date.now();
  for (const [id, session] of whepSessions) {
    if (session.exp <= now) whepSessions.delete(id);
  }
}

function sameOrigin(resource, base) {
  try {
    return new URL(resource, base).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

/**
 * @param {string} whepUrl
 * @param {Buffer} sdp
 */
async function openWhep(whepUrl, sdp) {
  pruneSessions();
  if (whepSessions.size >= MAX_WHEP_SESSIONS) {
    const error = new Error('busy');
    error.status = 429;
    throw error;
  }
  let upstream;
  try {
    upstream = await fetch(whepUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp', Accept: 'application/sdp' },
      body: sdp,
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    const error = new Error('unreachable');
    error.status = 502;
    throw error;
  }
  const answer = Buffer.from(await upstream.arrayBuffer());
  if (!upstream.ok) {
    const error = new Error('upstream');
    error.status = upstream.status === 404 ? 404 : 502;
    throw error;
  }
  if (answer.length === 0 || answer.length > SDP_MAX) {
    const error = new Error('answer');
    error.status = 502;
    throw error;
  }
  const location = upstream.headers.get('location');
  let id = null;
  if (location) {
    if (!sameOrigin(location, whepUrl)) {
      const error = new Error('location');
      error.status = 502;
      throw error;
    }
    id = crypto.randomBytes(16).toString('hex');
    whepSessions.set(id, {
      url: new URL(location, whepUrl).toString(),
      exp: Date.now() + SESSION_TTL_MS,
    });
  }
  return { answer, id };
}

/**
 * @param {string} id
 */
async function closeWhep(id) {
  pruneSessions();
  const session = whepSessions.get(id);
  if (!session) return false;
  whepSessions.delete(id);
  try {
    await fetch(session.url, { method: 'DELETE', signal: AbortSignal.timeout(4000) });
  } catch {
    // The browser session is already going away.
  }
  return true;
}

function streamStatus() {
  return { ingest: Boolean(slots.cam), desk: Boolean(slots.desk) };
}

/**
 * @param {'cam' | 'desk'} [slot]
 */
function stopIngest(slot = 'cam') {
  const current = slots[slot];
  if (!current) return;
  slots[slot] = null;
  clearTimeout(current.idle);
  current.input.destroy();
  current.child.kill('SIGKILL');
}

/**
 * Pipe one Annex-B H.264 feed into ffmpeg. The bridge does not transcode.
 * @param {import('node:stream').Readable} input
 * @param {string} srtUrl
 * @param {(result: { ok: true } | { ok: false, status: number }) => void} ready
 * @param {'cam' | 'desk'} [slot]
 */
function startIngest(input, srtUrl, ready, slot = 'cam') {
  if (slot !== 'cam' && slot !== 'desk') {
    ready({ ok: false, status: 400 });
    return;
  }
  if (slots[slot]) {
    ready({ ok: false, status: 409 });
    return;
  }
  if (!fs.existsSync(FFMPEG)) {
    ready({ ok: false, status: 503 });
    return;
  }

  const child = spawn(
    FFMPEG,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-fflags',
      'nobuffer',
      '-flags',
      'low_delay',
      '-f',
      'h264',
      '-i',
      'pipe:0',
      '-an',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-tune',
      'zerolatency',
      '-pix_fmt',
      'yuv420p',
      '-g',
      '30',
      '-f',
      'mpegts',
      srtUrl,
    ],
    { stdio: ['pipe', 'ignore', 'pipe'] },
  );

  let settled = false;
  let cleanEnd = false;
  const finish = (result) => {
    if (settled) return;
    settled = true;
    ready(result);
  };

  const state = {
    child,
    input,
    idle: setTimeout(() => stopIngest(slot), IDLE_MS),
  };
  slots[slot] = state;

  const bump = () => {
    if (slots[slot] !== state) return;
    clearTimeout(state.idle);
    state.idle = setTimeout(() => stopIngest(slot), IDLE_MS);
  };

  child.on('error', () => {
    if (slots[slot] === state) slots[slot] = null;
    finish({ ok: false, status: 503 });
  });
  child.stderr.on('data', () => {});
  child.stdin.on('error', () => {});
  input.on('data', bump);
  input.pipe(child.stdin);
  input.on('end', () => {
    cleanEnd = true;
    if (slots[slot] === state) child.stdin.end();
  });
  input.on('close', () => {
    if (!cleanEnd && slots[slot] === state) stopIngest(slot);
  });
  child.on('exit', () => {
    if (slots[slot] === state) {
      clearTimeout(state.idle);
      slots[slot] = null;
    }
    input.destroy();
  });

  // Give ffmpeg a moment to reject a bad binary or a closed publish port.
  setTimeout(() => {
    if (settled) return;
    if (child.exitCode === null && child.signalCode === null) finish({ ok: true });
    else finish({ ok: false, status: 502 });
  }, 200);
}

/**
 * One JPEG from an already-published RTSP path. Does not stop an ingest slot.
 * @param {string} rtspUrl
 */
function grabFrame(rtspUrl) {
  return new Promise((resolve) => {
    if (!fs.existsSync(FFMPEG)) {
      resolve({ ok: false, status: 503 });
      return;
    }
    const child = spawn(
      FFMPEG,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-rtsp_transport',
        'tcp',
        '-i',
        rtspUrl,
        '-frames:v',
        '1',
        '-f',
        'image2pipe',
        '-vcodec',
        'mjpeg',
        'pipe:1',
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, status: 504 });
    }, 8000);
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > FRAME_MAX) {
        child.kill('SIGKILL');
        finish({ ok: false, status: 502 });
        return;
      }
      chunks.push(chunk);
    });
    child.on('error', () => finish({ ok: false, status: 503 }));
    child.on('close', (code) => {
      const body = Buffer.concat(chunks);
      if (code !== 0 || body.length < 4 || body[0] !== 0xff || body[1] !== 0xd8) {
        finish({ ok: false, status: 502 });
        return;
      }
      finish({ ok: true, status: 200, body });
    });
  });
}

module.exports = {
  tokensMatch,
  bearer,
  openWhep,
  closeWhep,
  streamStatus,
  startIngest,
  stopIngest,
  grabFrame,
  SDP_MAX,
  FRAME_MAX,
};
