'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { validatePaste, validLiveFrame, createLiveGate, createHidClient } = require('./hid');

test('paste validation rejects secrets fields and bad speed', () => {
  assert.equal(validatePaste({ text: 'main', mode: 'paced', wpm: 10, jitterPct: 25 }).error, 'Invalid speed');
  assert.equal(validatePaste({ text: 'main', mode: 'paced', wpm: 80, jitterPct: 25, password: 'nope' }).error, 'Unknown field');
  assert.equal(validatePaste({ text: 'a\u0000b', mode: 'dump' }).error, 'Text contains control characters');
  const ok = validatePaste({ text: 'int main() {\n}\n', mode: 'paced', wpm: 80, jitterPct: 25 });
  assert.equal('error' in ok, false);
  assert.equal(ok.text.includes('main'), true);
});

test('live frames follow the socket mode', () => {
  const keyA = Buffer.from([1, 1, 0, 1, 0x04]);
  const ctrl = Buffer.from([1, 1, 0, 1, 0xe0]);
  const esc = Buffer.from([1, 1, 0, 1, 0x29]);
  const shift = Buffer.from([1, 1, 0, 1, 0xe1]);
  const mouse = Buffer.from([4, 1, 0, 1, 0, 0, 0, 0, 0, 0]);
  const badMouse = Buffer.from([4, 1, 0, 1, 8, 0, 0, 0, 0, 0]);
  assert.equal(validLiveFrame(Buffer.from([3, 1, 0, 1])), true);
  assert.equal(validLiveFrame(keyA), true);
  assert.equal(validLiveFrame(shift, 'typing'), true);
  assert.equal(validLiveFrame(ctrl), false);
  assert.equal(validLiveFrame(ctrl, 'typing'), false);
  assert.equal(validLiveFrame(esc, 'typing'), false);
  assert.equal(validLiveFrame(mouse, 'typing'), true);
  assert.equal(validLiveFrame(mouse), false);
  assert.equal(validLiveFrame(badMouse, 'all'), false);
  assert.equal(validLiveFrame(ctrl, 'all'), true);
  assert.equal(validLiveFrame(esc, 'all'), true);
  assert.equal(validLiveFrame(Buffer.from([1, 1, 0, 1, 0])), false);

  const gate = createLiveGate();
  assert.equal(gate.claim('a', 'typing').ok, true);
  assert.equal(gate.claim('b', 'all').ok, false);
  assert.equal(validLiveFrame(ctrl, gate.modeFor('b')), false);
  assert.equal(validLiveFrame(mouse, gate.modeFor('a')), true);
  assert.equal(gate.claim('a', 'all').release, true);
  assert.equal(validLiveFrame(ctrl, gate.modeFor('a')), true);
  assert.equal(gate.leave('a'), true);
  assert.equal(gate.modeFor('a'), null);
  assert.equal(validLiveFrame(mouse, gate.modeFor('a')), false);
});

test('HID status does not return the relay password or extra fields', async () => {
  let seenPassword = '';
  const relay = http.createServer((req, res) => {
    if (req.url === '/api/login') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        seenPassword = JSON.parse(Buffer.concat(chunks).toString()).password;
        res.setHeader('Set-Cookie', 'op_session=relay-session; HttpOnly; Path=/');
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    if (req.headers.cookie !== 'op_session=relay-session') {
      res.writeHead(401).end('{}');
      return;
    }
    res.end(JSON.stringify({ deviceConnected: true, deviceToken: 'do-not-keep', captureConnected: true }));
  });
  await new Promise((resolve) => relay.listen(0, '127.0.0.1', resolve));
  const { port } = relay.address();
  try {
    const hid = createHidClient({
      hidUrl: `http://127.0.0.1:${port}`,
      hidPassword: 'gate-password-value',
    });
    const result = await hid.status();
    assert.equal(seenPassword, 'gate-password-value');
    assert.equal(result.body.deviceConnected, true);
    assert.equal(JSON.stringify(result.body).includes('do-not-keep'), false);
    assert.equal(JSON.stringify(result.body).includes('gate-password-value'), false);
  } finally {
    await new Promise((resolve) => relay.close(resolve));
  }
});
