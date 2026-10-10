/**
 * KeyboardEvent.code → USB HID usage. Continuous typing sends this set only.
 * Ctrl, Alt, and Meta stay in the editor.
 */
const CODE_TO_HID: Record<string, number> = {
  KeyA: 0x04,
  KeyB: 0x05,
  KeyC: 0x06,
  KeyD: 0x07,
  KeyE: 0x08,
  KeyF: 0x09,
  KeyG: 0x0a,
  KeyH: 0x0b,
  KeyI: 0x0c,
  KeyJ: 0x0d,
  KeyK: 0x0e,
  KeyL: 0x0f,
  KeyM: 0x10,
  KeyN: 0x11,
  KeyO: 0x12,
  KeyP: 0x13,
  KeyQ: 0x14,
  KeyR: 0x15,
  KeyS: 0x16,
  KeyT: 0x17,
  KeyU: 0x18,
  KeyV: 0x19,
  KeyW: 0x1a,
  KeyX: 0x1b,
  KeyY: 0x1c,
  KeyZ: 0x1d,
  Digit1: 0x1e,
  Digit2: 0x1f,
  Digit3: 0x20,
  Digit4: 0x21,
  Digit5: 0x22,
  Digit6: 0x23,
  Digit7: 0x24,
  Digit8: 0x25,
  Digit9: 0x26,
  Digit0: 0x27,
  Enter: 0x28,
  Escape: 0x29,
  Backspace: 0x2a,
  Tab: 0x2b,
  Space: 0x2c,
  Minus: 0x2d,
  Equal: 0x2e,
  BracketLeft: 0x2f,
  BracketRight: 0x30,
  Backslash: 0x31,
  Semicolon: 0x33,
  Quote: 0x34,
  Backquote: 0x35,
  Comma: 0x36,
  Period: 0x37,
  Slash: 0x38,
  ShiftLeft: 0xe1,
  ShiftRight: 0xe5,
  ArrowRight: 0x4f,
  ArrowLeft: 0x50,
  ArrowDown: 0x51,
  ArrowUp: 0x52,
  Insert: 0x49,
  Home: 0x4a,
  PageUp: 0x4b,
  Delete: 0x4c,
  End: 0x4d,
  PageDown: 0x4e,
  F1: 0x3a,
  F2: 0x3b,
  F3: 0x3c,
  F4: 0x3d,
  F5: 0x3e,
  F6: 0x3f,
  F7: 0x40,
  F8: 0x41,
  F9: 0x42,
  F10: 0x43,
  F11: 0x44,
  F12: 0x45,
  ControlLeft: 0xe0,
  ControlRight: 0xe4,
  AltLeft: 0xe2,
  AltRight: 0xe6,
  MetaLeft: 0xe3,
  MetaRight: 0xe7,
};

const OP_KEY_DOWN = 1;
const OP_KEY_UP = 2;
const OP_RELEASE_ALL = 3;
const OP_MOUSE = 4;
const FLAG_SEQ = 0x01;

const TYPING_CODES = new Set([
  'Enter',
  'Backspace',
  'Tab',
  'Space',
  'Minus',
  'Equal',
  'BracketLeft',
  'BracketRight',
  'Backslash',
  'Semicolon',
  'Quote',
  'Backquote',
  'Comma',
  'Period',
  'Slash',
  'ShiftLeft',
  'ShiftRight',
]);

let seq = 0;

function nextSeq(): number {
  seq = (seq + 1) & 0xffff;
  return seq;
}

export function hidUsageFromCode(code: string): number | null {
  if (!Object.prototype.hasOwnProperty.call(CODE_TO_HID, code)) return null;
  return CODE_TO_HID[code];
}

export function isTypingCode(code: string): boolean {
  return /^Key[A-Z]$/.test(code) || /^Digit[0-9]$/.test(code) || TYPING_CODES.has(code);
}

export function keyFrame(phase: 'down' | 'up', code: string): ArrayBuffer | null {
  const usage = hidUsageFromCode(code);
  if (usage == null) return null;
  const buf = new ArrayBuffer(5);
  const view = new DataView(buf);
  view.setUint8(0, phase === 'down' ? OP_KEY_DOWN : OP_KEY_UP);
  view.setUint8(1, FLAG_SEQ);
  view.setUint16(2, nextSeq(), true);
  view.setUint8(4, usage);
  return buf;
}

export function mouseFrame(buttons: number, dx: number, dy: number, wheel = 0): ArrayBuffer {
  const buf = new ArrayBuffer(10);
  const view = new DataView(buf);
  view.setUint8(0, OP_MOUSE);
  view.setUint8(1, FLAG_SEQ);
  view.setUint16(2, nextSeq(), true);
  view.setUint8(4, buttons & 0x07);
  view.setInt16(5, clamp(dx, -32768, 32767), true);
  view.setInt16(7, clamp(dy, -32768, 32767), true);
  view.setInt8(9, clamp(wheel, -127, 127));
  return buf;
}

function clamp(value: number, min: number, max: number): number {
  const number = Number(value) || 0;
  if (number > max) return max;
  if (number < min) return min;
  return number | 0;
}

export function releaseFrame(): ArrayBuffer {
  const buf = new ArrayBuffer(4);
  const view = new DataView(buf);
  view.setUint8(0, OP_RELEASE_ALL);
  view.setUint8(1, FLAG_SEQ);
  view.setUint16(2, nextSeq(), true);
  return buf;
}
