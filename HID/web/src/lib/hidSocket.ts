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

export function createHidSocket(handlers: HidSocketHandlers = {}): HidSocket {
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const onStatus = handlers.onStatus ?? (() => undefined);
  const onError = handlers.onError ?? (() => undefined);
  const onOpen = handlers.onOpen ?? (() => undefined);
  const onClose = handlers.onClose ?? (() => undefined);

  function isOpen(): boolean {
    return Boolean(ws && ws.readyState === WebSocket.OPEN);
  }

  function sendJson(msg: object): boolean {
    if (!isOpen() || !ws) return false;
    ws.send(JSON.stringify(msg));
    return true;
  }

  function sendBinary(arrayBuffer: ArrayBuffer): boolean {
    if (!isOpen() || !ws) return false;
    ws.send(arrayBuffer);
    return true;
  }

  function open(): void {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${window.location.host}/ws/hid`;
    ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';

    ws.addEventListener('open', () => {
      onOpen();
      sendJson({ type: 'ping' });
    });

    ws.addEventListener('message', (event) => {
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

    ws.addEventListener('close', () => {
      onClose();
      reconnectTimer = setTimeout(open, 2000);
    });

    ws.addEventListener('error', () => {
      try {
        ws?.close();
      } catch {
        // ignore
      }
    });
  }

  function close(): void {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
  }

  return { open, isOpen, sendJson, sendBinary, close };
}
