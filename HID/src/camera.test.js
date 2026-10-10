'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCameraControl, validateCommand, redact, WATCH_MS, STOP_GRACE_MS } = require('./camera');

test('rejects commands that were not captured', () => {
  assert.equal(validateCommand('reboot', {}).error, 'Unknown command');
  assert.equal(validateCommand('AppointDev', { state: 1 }).error, 'Unknown command');
  assert.equal(validateCommand('DownloadFile', {}).error, 'Unknown command');
  assert.equal(validateCommand('SetLed', { ledstatus: 2 }).error, 'Expected 0 or 1');
  assert.equal(validateCommand('SetLed', { ledstatus: 1, extra: 1 }).error, 'Unknown field');
  assert.equal(validateCommand('OpenWifi', { sid: 'dev', wifiPwd: 'secret', state: 0 }).error, 'Unknown field');
  assert.equal(validateCommand('SetDevVideoInfo', {}).error, 'Missing a value');
  assert.equal(validateCommand('SetDevVideoInfo', { saturation: 101 }).error, 'Expected an integer from 0 to 100');
  assert.equal(
    validateCommand('SetAlarmInfo', {
      sensitivity: 0,
      goptime: 30,
      audio: 0,
      putalarm: 0,
      osd: 1,
      flag: 1,
      starttime: '25:00',
      endtime: '15:00',
      twotime: '00:00',
      twoend: '00:00',
    }).error,
    'Expected HH:MM',
  );
  const ok = validateCommand('SetLed', { ledstatus: 0 });
  assert.equal('error' in ok, false);
});

test('redacts passwords from camera JSON', () => {
  const clean = redact({
    cmd: 'GetDevInfo',
    ip: '10.42.0.143',
    wifipwd: 'do-not-keep',
    nested: { password: 'nope', ssid: 'dev' },
    value: [{ ssid: 'dev', sig: 80, wifiPwd: 'hidden' }],
  });
  const text = JSON.stringify(clean);
  assert.equal(text.includes('do-not-keep'), false);
  assert.equal(text.includes('nope'), false);
  assert.equal(text.includes('hidden'), false);
  assert.equal(clean.ip, '10.42.0.143');
  assert.equal(clean.nested.ssid, 'dev');
});

test('viewer lease starts video and stops it after the grace period', () => {
  let clock = 1_000;
  /** @type {{ fn: () => void, at: number, dead: boolean }[]} */
  const timers = [];
  const camera = createCameraControl({
    password: 'device-secret',
    manual: true,
    now: () => clock,
    schedule: (fn, ms) => {
      const timer = { fn, at: clock + ms, dead: false };
      timers.push(timer);
      return timer;
    },
    cancel: (timer) => {
      timer.dead = true;
    },
  });

  assert.equal(camera.watch({ id: 'viewer-01', stream: 2 }), null);
  assert.equal(camera.snapshot().video, 'wanted');
  assert.equal(JSON.stringify(camera.snapshot()).includes('device-secret'), false);

  clock += WATCH_MS + 1;
  camera.sweep();
  assert.equal(camera.snapshot().video, 'wanted');
  clock += STOP_GRACE_MS;
  for (const timer of timers) {
    if (!timer.dead && timer.at <= clock) timer.fn();
  }
  assert.equal(camera.snapshot().video, 'off');
});

test('a watching viewer cancels a pending stop', () => {
  let clock = 5_000;
  /** @type {{ fn: () => void, dead: boolean }[]} */
  const timers = [];
  const camera = createCameraControl({
    manual: true,
    now: () => clock,
    schedule: (fn) => {
      const timer = { fn, dead: false };
      timers.push(timer);
      return timer;
    },
    cancel: (timer) => {
      timer.dead = true;
    },
  });
  camera.watch({ id: 'viewer-02' });
  clock += WATCH_MS + 1;
  camera.sweep();
  camera.watch({ id: 'viewer-02' });
  assert.equal(timers.some((timer) => timer.dead), true);
  assert.equal(camera.snapshot().video, 'wanted');
});

test('command results returned to the web do not include secrets', async () => {
  const camera = createCameraControl({ password: 'device-secret', manual: true });
  assert.equal(
    camera.applyStatus({ phase: 'ready', attempt: 2, detail: 'logged in', video: 'off', checks: [] }),
    null,
  );
  const job = camera.command('GetDevInfo', {});
  const polled = camera.drain();
  const call = polled.commands.find((item) => item.op === 'call');
  assert.ok(call);
  assert.equal(polled.commands[0].op, 'configure');
  assert.equal(polled.commands[0].password, 'device-secret');
  camera.submitResult({
    id: call.id,
    ok: true,
    detail: 'ok',
    body: { cmd: 'GetDevInfo', ip: '192.168.100.1', wifipwd: 'do-not-keep', pwd: 'do-not-keep' },
  });
  const result = await job;
  assert.equal(result.status, 200);
  assert.equal(JSON.stringify(result.payload).includes('do-not-keep'), false);
  assert.equal(result.payload.body.ip, '192.168.100.1');
});

test('offline bridge and bad arguments never queue a camera call', async () => {
  const camera = createCameraControl({ manual: true });
  const offline = await camera.command('GetDevInfo', {});
  assert.equal(offline.status, 409);
  camera.applyStatus({ phase: 'ready', attempt: 1, detail: '', video: 'off', checks: [] });
  const rejected = await camera.command('SetLed', { ledstatus: 9 });
  assert.equal(rejected.status, 400);
  const polled = camera.drain();
  assert.equal(polled.commands.some((item) => item.op === 'call'), false);
});

test('browser camera routes never receive the device password', async () => {
  const { createApp } = require('./http');
  const { createSessionToken, COOKIE_NAME } = require('./auth');
  const bridgeToken = 'b'.repeat(32);
  const sessionSecret = 's'.repeat(32);
  const app = createApp({
    config: {
      gatePassword: 'g'.repeat(16),
      sessionSecret,
      nodeEnv: 'development',
      trustProxy: false,
      streamWhepUrl: 'http://127.0.0.1:9/cam/whep',
      streamSrtUrl: 'srt://127.0.0.1:9?streamid=publish:cam',
      bridgeToken,
      lookcamPassword: 'device-secret',
    },
  });
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const cookie = `${COOKIE_NAME}=${encodeURIComponent(createSessionToken(sessionSecret))}`;
  const bridge = { Authorization: `Bearer ${bridgeToken}` };
  try {
    assert.equal((await fetch(`${base}/api/camera`)).status, 401);
    assert.equal((await fetch(`${base}/api/bridge/poll`)).status, 401);
    assert.equal((await fetch(`${base}/api/camera/command`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{"name":"reboot"}' })).status, 400);

    const first = await fetch(`${base}/api/bridge/poll?wait=1`, { headers: bridge });
    const opened = await first.json();
    assert.equal(opened.commands[0].password, 'device-secret');

    const page = await fetch(`${base}/api/camera`, { headers: { cookie } });
    const snap = await page.json();
    assert.equal(page.status, 200);
    assert.equal(JSON.stringify(snap).includes('device-secret'), false);
    assert.equal(snap.bridge, 'online');

    const pending = fetch(`${base}/api/camera/command`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'GetDevInfo', args: {} }),
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = await fetch(`${base}/api/bridge/poll?wait=1`, { headers: bridge });
    const queued = await second.json();
    const call = queued.commands.find((item) => item.op === 'call');
    assert.ok(call);
    assert.equal(JSON.stringify(call).includes('device-secret'), false);
    const posted = await fetch(`${base}/api/bridge/result`, {
      method: 'POST',
      headers: { ...bridge, 'content-type': 'application/json' },
      body: JSON.stringify({
        id: call.id,
        ok: true,
        detail: 'ok',
        body: { cmd: 'GetDevInfo', ip: '10.42.0.143', wifipwd: 'do-not-keep' },
      }),
    });
    assert.equal(posted.status, 200);
    const answered = await (await pending).json();
    assert.equal(JSON.stringify(answered).includes('do-not-keep'), false);
    assert.equal(answered.body.ip, '10.42.0.143');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
