import { useEffect, useRef, useState } from 'react';

export type LiveMode = 'typing' | 'all';

type HidStatus = {
  configured?: boolean;
  deviceConnected?: boolean;
  error?: string;
};

type LogLine = { id: number; text: string };

type Options = {
  connect: boolean;
  watch: boolean;
  liveMode: LiveMode | null;
};

export function useHidLink({ connect, watch, liveMode }: Options) {
  const [status, setStatus] = useState<HidStatus>({ configured: false, deviceConnected: false });
  const [socketOpen, setSocketOpen] = useState(false);
  const [log, setLog] = useState<LogLine[]>([]);
  const socketRef = useRef<WebSocket | null>(null);
  const liveRef = useRef(liveMode);
  const prevLive = useRef<LiveMode | null>(null);
  const logId = useRef(0);
  liveRef.current = liveMode;

  function pushLog(text: string) {
    logId.current += 1;
    const id = logId.current;
    setLog((prev) => [...prev.slice(-39), { id, text }]);
  }

  function sendFrame(buf: ArrayBuffer | null) {
    const socket = socketRef.current;
    if (!buf || !socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(buf);
    return true;
  }

  function sendControl(mode: LiveMode | null) {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(mode ? { type: 'live', mode } : { type: 'leave' }));
  }

  useEffect(() => {
    if (!watch) return;
    let stop = false;
    const pull = async () => {
      try {
        const res = await fetch('/api/hid/status', { credentials: 'same-origin' });
        const body = (await res.json()) as HidStatus;
        if (!stop) setStatus(body);
      } catch {
        if (!stop) setStatus({ configured: false, error: 'Status unavailable' });
      }
    };
    void pull();
    const timer = window.setInterval(() => void pull(), 2000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [watch]);

  useEffect(() => {
    if (!connect || !status.configured) return;
    let stop = false;
    let socket: WebSocket | null = null;
    let timer = 0;

    const open = () => {
      if (stop) return;
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const next = new WebSocket(`${proto}//${window.location.host}/ws/hid`);
      next.binaryType = 'arraybuffer';
      socket = next;
      socketRef.current = next;
      next.addEventListener('open', () => {
        if (stop || socket !== next) return;
        setSocketOpen(true);
        pushLog('live socket open');
        if (liveRef.current) sendControl(liveRef.current);
      });
      next.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') return;
        try {
          const msg = JSON.parse(event.data) as { type?: string; deviceConnected?: boolean; message?: string };
          if (msg.type === 'status') {
            setStatus((prev) => ({ ...prev, configured: true, deviceConnected: Boolean(msg.deviceConnected) }));
            pushLog(msg.deviceConnected ? 'device connected' : 'device disconnected');
          } else if (msg.type === 'error' && msg.message) {
            pushLog(msg.message.slice(0, 120));
          }
        } catch {
          // ignore malformed relay messages
        }
      });
      next.addEventListener('close', () => {
        if (socket === next) {
          setSocketOpen(false);
          socketRef.current = null;
        }
        if (!stop) timer = window.setTimeout(open, 2000);
      });
    };

    open();
    return () => {
      stop = true;
      window.clearTimeout(timer);
      if (liveRef.current && socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'leave' }));
      }
      socket?.close();
      if (socketRef.current === socket) socketRef.current = null;
      setSocketOpen(false);
    };
  }, [connect, status.configured]);

  useEffect(() => {
    if (!socketOpen) return;
    if (liveMode) sendControl(liveMode);
    else if (prevLive.current) sendControl(null);
    prevLive.current = liveMode;
  }, [liveMode, socketOpen]);

  return { status, socketOpen, log, pushLog, sendFrame };
}
