import { useEffect, useRef, useState } from 'react';
import { isTypingCode, keyFrame, mouseFrame } from './hidKeys.ts';
import type { LiveMode } from './useHidLink.ts';
import { startWhep, type WhepSession } from './whep.ts';

type Status = 'connecting' | 'live' | 'offline';

const RETRY_MS = [3000, 8000, 15000];

type Props = {
  active: boolean;
  stream: 2 | 3;
  liveMode: LiveMode | null;
  onLeave: () => void;
  sendFrame: (buf: ArrayBuffer | null) => boolean;
};

export function StreamPane({ active, stream, liveMode, onLeave, sendFrame }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<Status>('offline');
  const [detail, setDetail] = useState('No signal');
  const [nonce, setNonce] = useState(0);
  const stageRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef(stream);
  const liveRef = useRef(liveMode);
  const sendRef = useRef(sendFrame);
  streamRef.current = stream;
  liveRef.current = liveMode;
  sendRef.current = sendFrame;

  useEffect(() => {
    if (!active) return;
    const id = crypto.randomUUID();
    let stop = false;
    const beat = () => {
      if (stop) return;
      void fetch('/api/camera/watch', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, stream: streamRef.current }),
      }).catch(() => undefined);
    };
    beat();
    const timer = window.setInterval(beat, 4000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [active]);

  useEffect(() => {
    if (!active) {
      setStatus('offline');
      setDetail('No signal');
      return;
    }

    const video = videoRef.current;
    const stream = new MediaStream();
    let session: WhepSession | null = null;
    let timer = 0;
    let stopped = false;
    let retry = 0;

    const schedule = () => {
      if (stopped) return;
      const delay = RETRY_MS[Math.min(retry, RETRY_MS.length - 1)];
      retry += 1;
      timer = window.setTimeout(() => {
        void connect();
      }, delay);
    };

    const connect = async () => {
      if (stopped) return;
      setStatus('connecting');
      setDetail('Connecting');
      try {
        const next = await startWhep((event) => {
          if (stopped || stream.getTracks().some((track) => track.id === event.track.id)) return;
          stream.addTrack(event.track);
          if (video && video.srcObject !== stream) {
            video.srcObject = stream;
            void video.play().catch(() => undefined);
          }
        });
        if (stopped) {
          await next.stop();
          return;
        }
        session = next;
        const onState = () => {
          if (stopped || session !== next) return;
          const state = next.pc.connectionState;
          if (state === 'connected') {
            retry = 0;
            setStatus('live');
            setDetail('Live');
            return;
          }
          if (state === 'disconnected') {
            window.setTimeout(() => {
              if (stopped || session !== next) return;
              if (next.pc.connectionState === 'connected' || next.pc.connectionState === 'connecting') return;
              next.pc.removeEventListener('connectionstatechange', onState);
              setStatus('offline');
              setDetail('No signal');
              void next.stop();
              session = null;
              schedule();
            }, 2000);
            return;
          }
          if (state !== 'failed') return;
          setStatus('offline');
          setDetail('No signal');
          next.pc.removeEventListener('connectionstatechange', onState);
          void next.stop();
          if (session === next) session = null;
          schedule();
        };
        next.pc.addEventListener('connectionstatechange', onState);
        if (next.pc.connectionState === 'connected') onState();
      } catch (error) {
        if (stopped) return;
        setStatus('offline');
        setDetail(error instanceof Error ? error.message : 'No signal');
        schedule();
      }
    };

    void connect();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      if (video) video.srcObject = null;
      for (const track of stream.getTracks()) track.stop();
      void session?.stop();
    };
  }, [active, nonce]);

  useEffect(() => {
    if (!active || !liveMode) return;
    const stage = stageRef.current;
    if (!stage) return;

    const sendKey = (event: KeyboardEvent, phase: 'down' | 'up') => {
      const mode = liveRef.current;
      if (!mode || event.repeat) return;
      if (mode === 'typing' && !isTypingCode(event.code)) return;
      const frame = keyFrame(phase, event.code);
      if (!frame) return;
      event.preventDefault();
      sendRef.current(frame);
    };
    const onDown = (event: KeyboardEvent) => sendKey(event, 'down');
    const onUp = (event: KeyboardEvent) => sendKey(event, 'up');
    const onMove = (event: MouseEvent) => {
      if (document.pointerLockElement !== stage) return;
      sendRef.current(mouseFrame(event.buttons & 7, event.movementX, event.movementY, 0));
    };
    const onButton = (event: MouseEvent) => {
      if (document.pointerLockElement !== stage) return;
      event.preventDefault();
      sendRef.current(mouseFrame(event.buttons & 7, 0, 0, 0));
    };
    const onWheel = (event: WheelEvent) => {
      if (document.pointerLockElement !== stage) return;
      event.preventDefault();
      const wheel = event.deltaY > 0 ? -1 : event.deltaY < 0 ? 1 : 0;
      if (wheel) sendRef.current(mouseFrame(event.buttons & 7, 0, 0, wheel));
    };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    stage.addEventListener('mousemove', onMove);
    stage.addEventListener('mousedown', onButton);
    stage.addEventListener('mouseup', onButton);
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      stage.removeEventListener('mousemove', onMove);
      stage.removeEventListener('mousedown', onButton);
      stage.removeEventListener('mouseup', onButton);
      stage.removeEventListener('wheel', onWheel);
      if (document.pointerLockElement === stage) document.exitPointerLock();
    };
  }, [active, liveMode]);

  function lockPointer() {
    const stage = stageRef.current;
    if (!liveMode || !stage || document.pointerLockElement === stage) return;
    void stage.requestPointerLock();
  }

  return (
    <div
      ref={stageRef}
      className={`ide-stream${liveMode ? ' ide-stream-live-mode' : ''}`}
      onClick={lockPointer}
    >
      <video ref={videoRef} autoPlay playsInline muted />
      <p className={`ide-stream-status ide-stream-${status}`}>{detail}</p>
      {liveMode ? (
        <div className="ide-live-bar">
          <span>{liveMode === 'all' ? 'Live, all keys' : 'Live, typing keys'}</span>
          <span>Fn stays on this keyboard. Click the picture to lock the pointer.</span>
          <button
            type="button"
            className="btn ghost ide-mini"
            onClick={(event) => {
              event.stopPropagation();
              onLeave();
            }}
          >
            Leave live
          </button>
        </div>
      ) : null}
      <button
        type="button"
        className="btn ghost ide-mini ide-stream-retry"
        onClick={(event) => {
          event.stopPropagation();
          setNonce((value) => value + 1);
        }}
      >
        Reconnect
      </button>
    </div>
  );
}
