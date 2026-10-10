'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCaptureControl } = require('./capture');
const { createApp } = require('./http');
const { createSessionToken, COOKIE_NAME } = require('./auth');

test('capture session does not reveal the token and rejects a bad bearer', async () => {
  const captureToken = 'c'.repeat(32);
  const sessionSecret = 's'.repeat(32);
  const app = createApp({
    config: {
      gatePassword: 'g'.repeat(16),
      sessionSecret,
      nodeEnv: 'development',
      trustProxy: false,
      streamWhepUrl: 'http://127.0.0.1:9/cam/whep',
      streamSrtUrl: 'srt://127.0.0.1:9?streamid=publish:cam',
      streamDeskSrtUrl: 'srt://127.0.0.1:9?streamid=publish:desk',
      captureRtspCam: 'rtsp://127.0.0.1:9/cam',
      bridgeToken: '',
      lookcamPassword: '',
      captureToken,
    },
  });
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const cookie = `${COOKIE_NAME}=${encodeURIComponent(createSessionToken(sessionSecret))}`;
  try {
    assert.equal((await fetch(`${base}/api/capture/poll`)).status, 401);
    assert.equal(
      (await fetch(`${base}/api/capture/poll`, { headers: { authorization: 'Bearer not-the-token' } })).status,
      401,
    );
    const page = await fetch(`${base}/api/capture`, { headers: { cookie } });
    const body = await page.json();
    assert.equal(page.status, 200);
    assert.equal(body.agent, 'offline');
    assert.equal(JSON.stringify(body).includes(captureToken), false);
    const snap = await fetch(`${base}/api/capture/snap`, { method: 'POST', headers: { cookie } });
    assert.equal(snap.status, 409);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('missing capture token refuses the agent', async () => {
  const sessionSecret = 's'.repeat(32);
  const app = createApp({
    config: {
      gatePassword: 'g'.repeat(16),
      sessionSecret,
      nodeEnv: 'development',
      trustProxy: false,
      streamWhepUrl: 'http://127.0.0.1:9/cam/whep',
      streamSrtUrl: 'srt://127.0.0.1:9?streamid=publish:cam',
      bridgeToken: '',
      lookcamPassword: '',
      captureToken: '',
    },
  });
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const { port } = server.address();
  try {
    const denied = await fetch(`http://127.0.0.1:${port}/api/capture/poll`, {
      headers: { authorization: `Bearer ${'c'.repeat(32)}` },
    });
    assert.equal(denied.status, 503);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a second jpeg is rejected while a snapshot is in flight', async () => {
  const capture = createCaptureControl({ token: 'c'.repeat(16) });
  /** @type {{ snap?: boolean }} */
  let polled = {};
  const res = {
    writableEnded: false,
    destroyed: false,
    headersSent: false,
    status(code) {
      this.code = code;
      return this;
    },
    json(payload) {
      polled = payload;
    },
    on() {},
  };
  capture.poll(res, 5000);
  const pending = capture.requestSnap();
  assert.equal(polled.snap, true);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  assert.equal(capture.acceptJpeg(jpeg).status, 200);
  assert.equal(capture.acceptJpeg(jpeg).status, 409);
  const shot = await pending;
  assert.equal(shot.status, 200);
  assert.equal(shot.body[0], 0xff);
  assert.equal(JSON.stringify(shot).includes('c'.repeat(16)), false);
});
