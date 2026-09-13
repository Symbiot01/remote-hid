'use strict';

const PHOTO_MIN_INTERVAL_MS = 2000;

/**
 * Request a still JPEG via the Pi outbound /ws/capture hub.
 * Never returns CAPTURE_TOKEN to the client.
 *
 * @param {import('./captureHub').CaptureHub} captureHub
 * @param {{ captureToken: string }} config
 * @returns {Promise<
 *   | { ok: true, body: Buffer, filename: string }
 *   | { ok: false, status: number, error: string }
 * >}
 */
async function fetchStillJpeg(captureHub, config) {
  if (!config.captureToken) {
    return {
      ok: false,
      status: 503,
      error: 'Photo capture not configured',
    };
  }
  return captureHub.requestPhoto();
}

module.exports = {
  fetchStillJpeg,
  PHOTO_MIN_INTERVAL_MS,
};
