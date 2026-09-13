import { useCallback, useEffect, useRef, useState } from 'react';
import { createHidSocket, type HidSocket } from '../lib/hidSocket';

type StatusPayload = {
  deviceConnected?: boolean;
  captureConnected?: boolean;
};

export function useHidSocket() {
  const socketRef = useRef<HidSocket | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [deviceConnected, setDeviceConnected] = useState(false);
  const [captureConnected, setCaptureConnected] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  useEffect(() => {
    const socket = createHidSocket({
      onOpen() {
        setWsConnected(true);
      },
      onClose() {
        setWsConnected(false);
      },
      onStatus(connected) {
        setDeviceConnected(connected);
      },
      onError(message) {
        setLastError(message);
      },
    });
    socketRef.current = socket;
    socket.open();

    let cancelled = false;

    async function pullStatus() {
      try {
        const res = await fetch('/api/status', {
          credentials: 'same-origin',
          headers: { Accept: 'application/json' },
        });
        if (cancelled) return;
        if (res.status === 401) {
          window.location.assign('/');
          return;
        }
        if (!res.ok) return;
        const data = (await res.json()) as StatusPayload;
        if (cancelled) return;
        setDeviceConnected(Boolean(data.deviceConnected));
        setCaptureConnected(Boolean(data.captureConnected));
      } catch {
        // ignore transient poll errors
      }
    }

    void pullStatus();
    const pollId = window.setInterval(() => {
      void pullStatus();
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(pollId);
      socket.close();
      socketRef.current = null;
    };
  }, []);

  const sendBinary = useCallback((buf: ArrayBuffer) => {
    return socketRef.current?.sendBinary(buf) ?? false;
  }, []);

  const isOpen = useCallback(() => {
    return socketRef.current?.isOpen() ?? false;
  }, []);

  const clearError = useCallback(() => setLastError(null), []);

  return {
    wsConnected,
    deviceConnected,
    captureConnected,
    lastError,
    clearError,
    sendBinary,
    isOpen,
    socketRef,
  };
}
