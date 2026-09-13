export type HidSocketHandlers = {
  onOpen?: () => void;
  onClose?: () => void;
  onStatus?: (deviceConnected: boolean) => void;
  onError?: (message: string) => void;
};

export type HidSocket = {
  open: () => void;
  isOpen: () => boolean;
  sendJson: (msg: object) => boolean;
  sendBinary: (buf: ArrayBuffer) => boolean;
  close: () => void;
};

/** Drop live frames if the browser WS send buffer grows (device/path stall). */
const SEND_BUFFER_LIMIT = 4096;

export function createHidSocket(handlers: HidSocketHandlers = {}): HidSocket {
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  const onStatus = handlers.onStatus ?? (() => undefined);
  const onError = handlers.onError ?? (() => undefined);
  const onOpen = handlers.onOpen ?? (() => undefined);
  const onClose = handlers.onClose ?? (() => undefined);

  function isOpen(): boolean {
    return Boolean(ws && ws.readyState === WebSocket.OPEN);
  }

  function sendJson(msg: object): boolean {
    if (!isOpen() || !ws) return false;
    if (ws.bufferedAmount > SEND_BUFFER_LIMIT) return false;
    ws.send(JSON.stringify(msg));
    return true;
  }

  function sendBinary(arrayBuffer: ArrayBuffer): boolean {
    if (!isOpen() || !ws) return false;
    // Design: drop, do not queue a mouse storm. Unbounded send() is an OOM.
    if (ws.bufferedAmount > SEND_BUFFER_LIMIT) return false;
    ws.send(arrayBuffer);
    return true;
  }

  function open(): void {
    closed = false;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    const prev = ws;
    ws = null;
    if (prev) {
      try {
        prev.close();
      } catch {
        // ignore
      }
    }
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${window.location.host}/ws/hid`;
    const socket = new WebSocket(wsUrl);
    socket.binaryType = 'arraybuffer';
    ws = socket;

    socket.addEventListener('open', () => {
      if (ws !== socket) return;
      onOpen();
      sendJson({ type: 'ping' });
    });

    socket.addEventListener('message', (event) => {
      if (ws !== socket) return;
      if (typeof event.data !== 'string') return;
      let msg: { type?: string; deviceConnected?: boolean; message?: string };
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'status') {
        onStatus(Boolean(msg.deviceConnected));
      } else if (msg.type === 'error') {
        onError(msg.message || 'Error');
      }
    });

    socket.addEventListener('close', () => {
      if (ws !== socket) return;
      onClose();
      if (closed) return;
      reconnectTimer = setTimeout(open, 2000);
    });

    socket.addEventListener('error', () => {
      if (ws !== socket) return;
      try {
        socket.close();
      } catch {
        // ignore
      }
    });
  }

  function close(): void {
    closed = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    const socket = ws;
    ws = null;
    if (socket) {
      try {
        socket.close();
      } catch {
        // ignore
      }
    }
  }

  return { open, isOpen, sendJson, sendBinary, close };
}
