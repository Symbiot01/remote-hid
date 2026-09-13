import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { camWhepUrl } from '../lib/mediaConfig';
import { startWhep, type WhepSession } from '../lib/whep';

export type CamWhepStatus = 'idle' | 'connecting' | 'live' | 'error';

const BACKOFF_MS = [3000, 8000, 15000, 15000];

/**
 * Subscribe to MediaMTX /cam/whep while Focus/Split is active.
 * Auto-retries when the Pi SRT publisher bounces (e.g. Snapshot).
 */
export function useCamWhep(
  active: boolean,
  videoRef: RefObject<HTMLVideoElement | null>
) {
  const [status, setStatus] = useState<CamWhepStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  const sessionRef = useRef<WhepSession | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const retryRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const genRef = useRef(0);
  const videoRefStable = videoRef;

  const clearTimer = () => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const detachVideo = () => {
    const v = videoRefStable.current;
    if (v) v.srcObject = null;
    streamRef.current = null;
  };

  const stopSession = async () => {
    clearTimer();
    const s = sessionRef.current;
    sessionRef.current = null;
    detachVideo();
    if (s) {
      try {
        await s.stop();
      } catch {
        // ignore
      }
    }
  };

  const attachTrack = (ev: RTCTrackEvent) => {
    let stream = streamRef.current;
    if (!stream) {
      stream = new MediaStream();
      streamRef.current = stream;
    }
    if (ev.track && !stream.getTracks().some((t) => t.id === ev.track.id)) {
      stream.addTrack(ev.track);
    }
    const v = videoRefStable.current;
    if (v && v.srcObject !== stream) {
      v.srcObject = stream;
      void v.play().catch(() => undefined);
    }
  };

  const connectGen = useCallback(async (generation: number) => {
    if (generation !== genRef.current) return;
    setStatus('connecting');
    setError(null);
    await stopSession();
    if (generation !== genRef.current) return;

    const scheduleRetry = () => {
      if (generation !== genRef.current) return;
      clearTimer();
      const idx = Math.min(retryRef.current, BACKOFF_MS.length - 1);
      const delay = BACKOFF_MS[idx];
      retryRef.current += 1;
      timerRef.current = window.setTimeout(() => {
        void connectGen(generation);
      }, delay);
    };

    try {
      const session = await startWhep(camWhepUrl(), {
        onTrack: attachTrack,
      });
      if (generation !== genRef.current) {
        await session.stop();
        return;
      }
      sessionRef.current = session;

      const onConn = () => {
        if (generation !== genRef.current) return;
        const st = session.pc.connectionState;
        if (st === 'connected') {
          setStatus('live');
          setError(null);
          retryRef.current = 0;
        } else if (st === 'failed' || st === 'disconnected' || st === 'closed') {
          setStatus('error');
          setError(
            st === 'failed'
              ? 'Video ICE failed (UDP 8189 / network?). Try Reconnect or WARP.'
              : `Video ${st}`
          );
          session.pc.removeEventListener('connectionstatechange', onConn);
          scheduleRetry();
        }
      };
      session.pc.addEventListener('connectionstatechange', onConn);
      if (session.pc.connectionState === 'connected') {
        setStatus('live');
        retryRef.current = 0;
      }
    } catch (err) {
      if (generation !== genRef.current) return;
      const msg = (err as Error).message || 'WHEP failed';
      setStatus('error');
      setError(msg.slice(0, 160));
      scheduleRetry();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional stable helpers via refs
  }, []);

  const syncVideo = useCallback(() => {
    const v = videoRefStable.current;
    const stream = streamRef.current;
    if (v && stream && v.srcObject !== stream) {
      v.srcObject = stream;
      void v.play().catch(() => undefined);
    }
  }, []);

  const reconnect = useCallback(() => {
    retryRef.current = 0;
    genRef.current += 1;
    void connectGen(genRef.current);
  }, [connectGen]);

  useEffect(() => {
    if (!active) {
      genRef.current += 1;
      clearTimer();
      void stopSession().then(() => {
        setStatus('idle');
        setError(null);
      });
      return;
    }
    genRef.current += 1;
    const g = genRef.current;
    retryRef.current = 0;
    void connectGen(g);
    return () => {
      genRef.current += 1;
      clearTimer();
      void stopSession();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, connectGen]);

  const videoLabel =
    status === 'live'
      ? 'Video: live'
      : status === 'connecting'
        ? 'Video: connecting…'
        : status === 'error'
          ? `Video: offline${error ? ` — ${error}` : ''}`
          : 'Video: idle';

  return {
    status,
    error,
    videoLabel,
    reconnect,
    syncVideo,
  };
}
