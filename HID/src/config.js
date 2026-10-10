'use strict';

require('dotenv').config();

/**
 * Load and validate required environment. Exits the process on failure.
 * @returns {{
 *   gatePassword: string,
 *   sessionSecret: string,
 *   port: number,
 *   host: string,
 *   nodeEnv: string,
 *   trustProxy: boolean,
 *   streamWhepUrl: string,
 *   streamSrtUrl: string,
 *   bridgeToken: string,
 *   lookcamPassword: string,
 *   hidUrl: string,
 *   hidPassword: string,
 *   captureToken: string,
 *   streamDeskSrtUrl: string,
 *   streamDeskWhepUrl: string,
 *   captureRtspCam: string,
 * }}
 */
function loadConfig() {
  const nodeEnv = process.env.NODE_ENV || 'development';
  const gatePassword = process.env.GATE_PASSWORD || '';
  const sessionSecret = process.env.SESSION_SECRET || '';

  if (!gatePassword || Buffer.byteLength(gatePassword, 'utf8') < 16) {
    console.error('[fatal] GATE_PASSWORD must be set and at least 16 characters');
    process.exit(1);
  }
  if (!sessionSecret || Buffer.byteLength(sessionSecret, 'utf8') < 32) {
    console.error('[fatal] SESSION_SECRET must be set and at least 32 characters');
    process.exit(1);
  }

  const port = Number.parseInt(process.env.PORT || '8080', 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    console.error('[fatal] PORT must be a valid TCP port');
    process.exit(1);
  }

  const host = (process.env.HOST || '127.0.0.1').trim() || '127.0.0.1';
  const trustProxy = process.env.TRUST_PROXY === '1';
  const streamWhepUrl = httpUrl(
    'STREAM_WHEP_URL',
    process.env.STREAM_WHEP_URL || 'http://127.0.0.1:8889/cam/whep',
  );
  const streamSrtUrl = srtUrl(
    process.env.STREAM_SRT_URL ||
      'srt://127.0.0.1:8890?streamid=publish:cam&pkt_size=1316',
  );
  const bridgeToken = process.env.BRIDGE_TOKEN || '';
  if (bridgeToken && Buffer.byteLength(bridgeToken, 'utf8') < 16) {
    console.error('[fatal] BRIDGE_TOKEN must be at least 16 characters when set');
    process.exit(1);
  }
  const lookcamPassword = process.env.LOOKCAM_PASSWORD || '';
  if (lookcamPassword.length > 64 || /[\u0000-\u001f\u007f]/.test(lookcamPassword)) {
    console.error('[fatal] LOOKCAM_PASSWORD is invalid');
    process.exit(1);
  }
  const hidUrlRaw = (process.env.HID_URL || '').trim();
  const hidUrl = hidUrlRaw ? httpUrl('HID_URL', hidUrlRaw).replace(/\/$/, '') : '';
  const hidPassword = process.env.HID_GATE_PASSWORD || '';
  if (hidUrl && Buffer.byteLength(hidPassword, 'utf8') < 16) {
    console.error('[fatal] HID_GATE_PASSWORD must be at least 16 characters when HID_URL is set');
    process.exit(1);
  }
  if (/[\u0000-\u001f\u007f]/.test(hidPassword)) {
    console.error('[fatal] HID_GATE_PASSWORD is invalid');
    process.exit(1);
  }
  const captureToken = process.env.CAPTURE_TOKEN || '';
  if (captureToken && Buffer.byteLength(captureToken, 'utf8') < 16) {
    console.error('[fatal] CAPTURE_TOKEN must be at least 16 characters when set');
    process.exit(1);
  }
  const streamDeskSrtUrl = srtUrl(
    process.env.STREAM_DESK_SRT_URL ||
      'srt://127.0.0.1:8890?streamid=publish:desk&pkt_size=1316',
    'STREAM_DESK_SRT_URL',
  );
  const streamDeskWhepUrl = httpUrl(
    'STREAM_DESK_WHEP_URL',
    process.env.STREAM_DESK_WHEP_URL || 'http://127.0.0.1:8889/desk/whep',
  );
  const captureRtspCam = rtspUrl(
    process.env.CAPTURE_RTSP_CAM || 'rtsp://127.0.0.1:8554/cam',
  );

  return {
    gatePassword,
    sessionSecret,
    port,
    host,
    nodeEnv,
    trustProxy,
    streamWhepUrl,
    streamSrtUrl,
    bridgeToken,
    lookcamPassword,
    hidUrl,
    hidPassword,
    captureToken,
    streamDeskSrtUrl,
    streamDeskWhepUrl,
    captureRtspCam,
  };
}

function httpUrl(name, raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    console.error(`[fatal] ${name} must be an http(s) URL`);
    process.exit(1);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    console.error(`[fatal] ${name} must be an http(s) URL`);
    process.exit(1);
  }
  if (url.username || url.password) {
    console.error(`[fatal] ${name} must not contain credentials`);
    process.exit(1);
  }
  return url.toString();
}

function srtUrl(raw, name = 'STREAM_SRT_URL') {
  const value = raw.trim();
  if (value.length === 0 || value.length > 300 || /\s/.test(value) || value.includes('@')) {
    console.error(`[fatal] ${name} must be an srt URL without credentials`);
    process.exit(1);
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    console.error(`[fatal] ${name} must be an srt URL without credentials`);
    process.exit(1);
  }
  if (url.protocol !== 'srt:' || url.username || url.password) {
    console.error(`[fatal] ${name} must be an srt URL without credentials`);
    process.exit(1);
  }
  return value;
}

function rtspUrl(raw) {
  const value = raw.trim();
  if (value.length === 0 || value.length > 300 || /\s/.test(value) || value.includes('@')) {
    console.error('[fatal] CAPTURE_RTSP_CAM must be an rtsp URL without credentials');
    process.exit(1);
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    console.error('[fatal] CAPTURE_RTSP_CAM must be an rtsp URL without credentials');
    process.exit(1);
  }
  if (url.protocol !== 'rtsp:' || url.username || url.password) {
    console.error('[fatal] CAPTURE_RTSP_CAM must be an rtsp URL without credentials');
    process.exit(1);
  }
  return value;
}

module.exports = { loadConfig };
