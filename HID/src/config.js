'use strict';

require('dotenv').config();

const DEFAULT_MEDIA_BASE_URL = 'https://mediarelay.sahilpatel.online:8889';
const DEFAULT_STUN_URL = 'stun:stun.l.google.com:19302';

/**
 * @param {string} raw
 * @returns {string | null} origin like https://host — null if invalid
 */
function parseHttpsOrigin(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * Load and validate required environment. Exits process on failure.
 * @returns {{
 *   gatePassword: string,
 *   sessionSecret: string,
 *   deviceToken: string,
 *   port: number,
 *   host: string,
 *   nodeEnv: string,
 *   trustProxy: boolean,
 *   mediaBaseUrl: string,
 *   mediaOrigin: string,
 *   mediaOrigins: string[],
 *   stunUrl: string,
 *   captureToken: string,
 * }}
 */
function loadConfig() {
  const nodeEnv = process.env.NODE_ENV || 'development';
  const gatePassword = process.env.GATE_PASSWORD || '';
  const sessionSecret = process.env.SESSION_SECRET || '';
  const deviceToken = process.env.DEVICE_TOKEN || '';

  if (!gatePassword || Buffer.byteLength(gatePassword, 'utf8') < 16) {
    console.error('[fatal] GATE_PASSWORD must be set and at least 16 characters');
    process.exit(1);
  }
  if (!sessionSecret || Buffer.byteLength(sessionSecret, 'utf8') < 32) {
    console.error('[fatal] SESSION_SECRET must be set and at least 32 characters');
    process.exit(1);
  }
  if (!deviceToken || Buffer.byteLength(deviceToken, 'utf8') < 16) {
    console.error('[fatal] DEVICE_TOKEN must be set and at least 16 characters');
    process.exit(1);
  }

  const port = Number.parseInt(process.env.PORT || '8080', 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    console.error('[fatal] PORT must be a valid TCP port');
    process.exit(1);
  }

  const mediaRaw = (process.env.MEDIA_BASE_URL || DEFAULT_MEDIA_BASE_URL).trim();
  const mediaOrigin = parseHttpsOrigin(mediaRaw);
  if (!mediaOrigin) {
    console.error('[fatal] MEDIA_BASE_URL must be a valid http(s) URL');
    process.exit(1);
  }
  const mediaBaseUrl = mediaRaw.replace(/\/+$/, '');
  // Coolify UI is often :443 while WHIP/WHEP hit container :8889 — allow both.
  const mediaOrigins = new Set([mediaOrigin]);
  try {
    const u = new URL(mediaOrigin);
    if (u.port === '8889') {
      mediaOrigins.add(`${u.protocol}//${u.hostname}`);
    } else {
      mediaOrigins.add(`${u.protocol}//${u.hostname}:8889`);
    }
  } catch {
    /* keep mediaOrigin only */
  }
  const stunUrl = (process.env.MEDIA_STUN_URL || DEFAULT_STUN_URL).trim();

  const captureToken = (process.env.CAPTURE_TOKEN || '').trim();
  if (captureToken && Buffer.byteLength(captureToken, 'utf8') < 16) {
    console.error('[fatal] CAPTURE_TOKEN must be at least 16 characters when set');
    process.exit(1);
  }
  if (!captureToken) {
    console.warn(
      '[warn] CAPTURE_TOKEN unset — /ws/capture and POST /api/photo unavailable'
    );
  }

  return {
    gatePassword,
    sessionSecret,
    deviceToken,
    port,
    host: process.env.HOST || '0.0.0.0',
    nodeEnv,
    trustProxy: process.env.TRUST_PROXY === '1',
    mediaBaseUrl,
    mediaOrigin,
    mediaOrigins: [...mediaOrigins],
    stunUrl,
    captureToken,
  };
}

module.exports = { loadConfig };
