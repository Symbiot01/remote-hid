import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import {
  buildFrame,
  buildMouseFrame,
  hidUsageFromCode,
  OP_KEY_DOWN,
  OP_KEY_UP,
  OP_RELEASE_ALL,
} from '../lib/keymap';

export type ConsoleViewName = 'focus' | 'split' | 'paste' | 'selftest' | 'streamtest';
export type InputTarget = 'none' | 'hid' | 'measure';

type UseLiveHidOpts = {
  view: ConsoleViewName;
  deviceConnected: boolean;
  wsConnected: boolean;
  sendBinary: (buf: ArrayBuffer) => boolean;
  isOpen: () => boolean;
  stageRef: RefObject<HTMLDivElement | null>;
  scratchRef?: RefObject<HTMLTextAreaElement | null>;
};

const SQUARE_SIDE = 240;
const SQUARE_STEP = 3;
const SQUARE_MS = 8;

type NavigatorWithKeyboard = Navigator & {
  keyboard?: {
    lock: (keyCodes?: string[]) => Promise<void>;
    unlock: () => void;
  };
};

export function useLiveHid(opts: UseLiveHidOpts) {
  const { view, deviceConnected, wsConnected, sendBinary, isOpen, stageRef, scratchRef } =
    opts;

  const [liveActive, setLiveActive] = useState(false);
  const [inputTarget, setInputTarget] = useState<InputTarget>('none');
  const [lastKey, setLastKey] = useState('Last key: —');
  const [hint, setHint] = useState('');
  const [squareRunning, setSquareRunning] = useState(false);

  const heldCodes = useRef(new Set<string>());
  const mouseButtons = useRef(0);
  const squareTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveRef = useRef(false);
  const targetRef = useRef<InputTarget>('none');
  const viewRef = useRef(view);

  liveRef.current = liveActive;
  targetRef.current = inputTarget;
  viewRef.current = view;

  const isOperatorView = view === 'focus' || view === 'split';

  const sendReleaseAll = useCallback(() => {
    heldCodes.current.clear();
    mouseButtons.current = 0;
    sendBinary(buildFrame(OP_RELEASE_ALL));
  }, [sendBinary]);

  const cancelSquare = useCallback(() => {
    if (squareTimer.current != null) {
      clearTimeout(squareTimer.current);
      squareTimer.current = null;
    }
    setSquareRunning(false);
  }, []);

  const unlockKeyboard = useCallback(() => {
    const nav = navigator as NavigatorWithKeyboard;
    if (nav.keyboard && typeof nav.keyboard.unlock === 'function') {
      try {
        nav.keyboard.unlock();
      } catch {
        // ignore
      }
    }
  }, []);

  const exitPointerLock = useCallback(() => {
    if (document.pointerLockElement && typeof document.exitPointerLock === 'function') {
      try {
        document.exitPointerLock();
      } catch {
        // ignore
      }
    }
  }, []);

  const requestPointerLock = useCallback(() => {
    const stage = stageRef.current;
    if (!stage || document.pointerLockElement === stage) return;
    if (typeof stage.requestPointerLock !== 'function') {
      setHint('Pointer Lock unavailable. Mouse needs a Chromium browser.');
      return;
    }
    try {
      const ret = stage.requestPointerLock({ unadjustedMovement: true } as PointerLockOptions);
      if (ret && typeof (ret as Promise<void>).then === 'function') {
        (ret as Promise<void>).catch(() => {
          try {
            stage.requestPointerLock();
          } catch {
            // ignore
          }
        });
      }
    } catch {
      try {
        stage.requestPointerLock();
      } catch {
        // ignore
      }
    }
  }, [stageRef]);

  const stopLive = useCallback(
    (reason?: string) => {
      cancelSquare();
      unlockKeyboard();
      exitPointerLock();
      if (!liveRef.current) {
        setLiveActive(false);
        setInputTarget('none');
        return;
      }
      setLiveActive(false);
      setInputTarget('none');
      sendReleaseAll();
      setHint('');
      setLastKey(reason ? `Last key: (${reason})` : 'Last key: —');
    },
    [cancelSquare, unlockKeyboard, exitPointerLock, sendReleaseAll]
  );

  const startLive = useCallback(async () => {
    if (!deviceConnected || !isOpen() || liveRef.current || !isOperatorView) return;
    setLiveActive(true);
    setInputTarget('hid');
    setLastKey('Last key: (live on)');
    sendReleaseAll();
    stageRef.current?.focus();
    requestPointerLock();
    setHint('Pointer locked — Esc exits lock. Move/click/scroll for target mouse.');

    if (!window.isSecureContext) {
      setHint('Keyboard Lock needs HTTPS or localhost. Some browser shortcuts stay local.');
      return;
    }
    const nav = navigator as NavigatorWithKeyboard;
    if (!nav.keyboard || typeof nav.keyboard.lock !== 'function') {
      setHint('No Keyboard Lock in this browser. Use Chromium when possible.');
      return;
    }
    try {
      await nav.keyboard.lock();
    } catch {
      setHint('Keyboard Lock denied. Some shortcuts may not forward.');
    }
  }, [
    deviceConnected,
    isOpen,
    isOperatorView,
    sendReleaseAll,
    stageRef,
    requestPointerLock,
  ]);

  // Stop live when leaving operator views
  useEffect(() => {
    if (view === 'paste' || view === 'selftest' || view === 'streamtest') {
      if (liveRef.current) stopLive('view switch');
      if (view === 'selftest') setInputTarget('measure');
      else setInputTarget('none');
    }
  }, [view, stopLive]);

  // Keys
  useEffect(() => {
    function onKey(event: KeyboardEvent, action: 'down' | 'up') {
      if (viewRef.current === 'selftest' || targetRef.current === 'measure') return;
      if (!liveRef.current || targetRef.current !== 'hid') return;
      if (viewRef.current === 'paste') return;

      event.preventDefault();
      event.stopPropagation();
      if (action === 'down' && event.repeat) return;
      const code = event.code;
      if (!code) return;
      const usage = hidUsageFromCode(code);
      if (usage === null) return;

      if (action === 'down') {
        if (heldCodes.current.has(code)) return;
        heldCodes.current.add(code);
        sendBinary(buildFrame(OP_KEY_DOWN, usage));
      } else {
        if (!heldCodes.current.has(code)) return;
        heldCodes.current.delete(code);
        sendBinary(buildFrame(OP_KEY_UP, usage));
      }
      setLastKey(`Last key: ${code} ${action}`);
    }

    const down = (e: KeyboardEvent) => onKey(e, 'down');
    const up = (e: KeyboardEvent) => onKey(e, 'up');
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    return () => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
    };
  }, [sendBinary]);

  // Blur / visibility
  useEffect(() => {
    function onBlur() {
      if (liveRef.current) {
        exitPointerLock();
        sendReleaseAll();
        setLastKey('Last key: (window blur — keys released)');
      }
    }
    function onVis() {
      if (document.hidden && liveRef.current) {
        exitPointerLock();
        sendReleaseAll();
      }
    }
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [exitPointerLock, sendReleaseAll]);

  // Pointer lock change
  useEffect(() => {
    function onLockChange() {
      if (!liveRef.current) return;
      const stage = stageRef.current;
      if (document.pointerLockElement === stage) {
        setInputTarget('hid');
        setHint('Pointer locked — Esc exits lock. Move/click/scroll for target mouse.');
      } else if (targetRef.current === 'hid') {
        setHint('Click the video stage to re-lock the pointer.');
        sendReleaseAll();
      }
    }
    document.addEventListener('pointerlockchange', onLockChange);
    return () => document.removeEventListener('pointerlockchange', onLockChange);
  }, [stageRef, sendReleaseAll]);

  const canSendPointerMouse = useCallback(() => {
    return (
      liveRef.current &&
      targetRef.current === 'hid' &&
      (viewRef.current === 'focus' || viewRef.current === 'split') &&
      document.pointerLockElement === stageRef.current
    );
  }, [stageRef]);

  const canSendScriptedMouse = useCallback(() => {
    return (
      liveRef.current &&
      targetRef.current === 'hid' &&
      (viewRef.current === 'focus' || viewRef.current === 'split') &&
      deviceConnected &&
      isOpen()
    );
  }, [deviceConnected, isOpen]);

  const sendScriptedMouse = useCallback(
    (dx: number, dy: number, wheel = 0, buttons = 0) => {
      if (!canSendScriptedMouse()) return false;
      mouseButtons.current = buttons & 0x07;
      return sendBinary(buildMouseFrame(mouseButtons.current, dx, dy, wheel));
    },
    [canSendScriptedMouse, sendBinary]
  );

  // Stage mouse listeners
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    function onMove(event: MouseEvent) {
      if (!canSendPointerMouse()) return;
      const dx = event.movementX || 0;
      const dy = event.movementY || 0;
      if (dx === 0 && dy === 0) return;
      mouseButtons.current = event.buttons & 0x07;
      sendBinary(buildMouseFrame(mouseButtons.current, dx, dy, 0));
    }
    function onButton(event: MouseEvent) {
      if (!canSendPointerMouse()) return;
      event.preventDefault();
      mouseButtons.current = event.buttons & 0x07;
      sendBinary(buildMouseFrame(mouseButtons.current, 0, 0, 0));
      setLastKey(`Last key: mouse buttons ${event.buttons}`);
    }
    function onWheel(event: WheelEvent) {
      if (!canSendPointerMouse()) return;
      event.preventDefault();
      let steps = 0;
      if (event.deltaMode === 1) steps = -event.deltaY;
      else if (event.deltaMode === 2) steps = -event.deltaY * 3;
      else steps = -event.deltaY / 40;
      let n = Math.round(steps);
      if (n > 127) n = 127;
      if (n < -127) n = -127;
      if (n === 0) return;
      mouseButtons.current = event.buttons & 0x07;
      sendBinary(buildMouseFrame(mouseButtons.current, 0, 0, n));
    }
    function onContext(event: Event) {
      if (canSendPointerMouse()) event.preventDefault();
    }

    stage.addEventListener('mousemove', onMove);
    stage.addEventListener('mousedown', onButton);
    stage.addEventListener('mouseup', onButton);
    stage.addEventListener('wheel', onWheel, { passive: false });
    stage.addEventListener('contextmenu', onContext);
    return () => {
      stage.removeEventListener('mousemove', onMove);
      stage.removeEventListener('mousedown', onButton);
      stage.removeEventListener('mouseup', onButton);
      stage.removeEventListener('wheel', onWheel);
      stage.removeEventListener('contextmenu', onContext);
    };
  }, [stageRef, canSendPointerMouse, sendBinary, view]);

  const runMicroMoves = useCallback(
    (totalDx: number, totalDy: number, onDone?: () => void) => {
      const absX = Math.abs(totalDx);
      const absY = Math.abs(totalDy);
      if (absX === 0 && absY === 0) {
        onDone?.();
        return;
      }
      const signX = totalDx === 0 ? 0 : totalDx > 0 ? 1 : -1;
      const signY = totalDy === 0 ? 0 : totalDy > 0 ? 1 : -1;
      let remain = Math.max(absX, absY);
      setSquareRunning(true);

      function step() {
        squareTimer.current = null;
        if (!canSendScriptedMouse()) {
          cancelSquare();
          setLastKey('Last key: (mouse move cancelled)');
          return;
        }
        if (remain <= 0) {
          setSquareRunning(false);
          onDone?.();
          return;
        }
        const mag = Math.min(SQUARE_STEP, remain);
        const dx = signX * (absX > 0 ? mag : 0);
        const dy = signY * (absY > 0 ? mag : 0);
        remain -= mag;
        if (!sendScriptedMouse(dx, dy, 0, 0)) {
          cancelSquare();
          return;
        }
        squareTimer.current = setTimeout(step, SQUARE_MS);
      }
      step();
    },
    [canSendScriptedMouse, cancelSquare, sendScriptedMouse]
  );

  const nudgeMouse = useCallback(
    (dx: number, dy: number) => {
      if (!canSendScriptedMouse() || squareRunning) return;
      runMicroMoves(dx, dy, () => setLastKey(`Last key: mouse nudge ${dx},${dy} done`));
      setLastKey(`Last key: mouse nudge ${dx},${dy}`);
    },
    [canSendScriptedMouse, squareRunning, runMicroMoves]
  );

  const runMouseSquare = useCallback(() => {
    if (!canSendScriptedMouse() || squareRunning) return;
    const sides = [
      { dx: SQUARE_SIDE, dy: 0 },
      { dx: 0, dy: SQUARE_SIDE },
      { dx: -SQUARE_SIDE, dy: 0 },
      { dx: 0, dy: -SQUARE_SIDE },
    ];
    let sideIdx = 0;
    setSquareRunning(true);
    setLastKey('Last key: mouse square test…');

    function runSide() {
      if (!canSendScriptedMouse()) {
        cancelSquare();
        setLastKey('Last key: (square cancelled)');
        return;
      }
      if (sideIdx >= sides.length) {
        setSquareRunning(false);
        setLastKey('Last key: mouse square done');
        return;
      }
      const side = sides[sideIdx];
      sideIdx += 1;
      runMicroMoves(side.dx, side.dy, runSide);
    }
    runSide();
  }, [canSendScriptedMouse, squareRunning, cancelSquare, runMicroMoves]);

  const onStageClick = useCallback(() => {
    if (!liveRef.current) return;
    setInputTarget('hid');
    stageRef.current?.focus();
    requestPointerLock();
  }, [stageRef, requestPointerLock]);

  const onScratchFocus = useCallback(() => {
    if (!liveRef.current) return;
    setInputTarget('hid');
    exitPointerLock();
    setHint('Live on — keys still go to HID. Click video to re-lock mouse.');
  }, [exitPointerLock]);

  // Device drop
  useEffect(() => {
    if (!deviceConnected && liveActive) {
      stopLive('Device disconnected');
    }
  }, [deviceConnected, liveActive, stopLive]);

  useEffect(() => {
    if (!wsConnected && liveActive) {
      stopLive('WebSocket disconnected');
    }
  }, [wsConnected, liveActive, stopLive]);

  void scratchRef;

  return {
    liveActive,
    inputTarget,
    lastKey,
    hint,
    squareRunning,
    startLive,
    stopLive,
    sendReleaseAll,
    onStageClick,
    onScratchFocus,
    nudgeMouse,
    runMouseSquare,
    canLive: deviceConnected && wsConnected && !liveActive && isOperatorView,
    canMouseTest: deviceConnected && wsConnected && liveActive && isOperatorView && !squareRunning,
  };
}
