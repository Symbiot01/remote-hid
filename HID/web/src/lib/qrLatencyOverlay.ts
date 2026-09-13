import QRCode from 'qrcode';
import jsQR from 'jsqr';

export const LATENCY_PREFIX = 'hidlat:';
export const TARGET_WIDTH = 1920;
export const TARGET_HEIGHT = 1080;
export const TARGET_FPS = 30;

const QR_SIZE = 220;
const QR_MARGIN = 24;

export type OverlayPipeline = {
  canvas: HTMLCanvasElement;
  /** Local preview: same canvas stream source before WHIP. */
  stream: MediaStream;
  /** Actual camera track settings after open. */
  cameraSettings: MediaTrackSettings;
  stop: () => void;
};

/**
 * Camera → canvas (1080p preferred) with a corner QR of `hidlat:{Date.now()}`.
 * Returns captureStream for WHIP publish.
 */
export async function startQrOverlayPipeline(opts?: {
  preferWidth?: number;
  preferHeight?: number;
  fps?: number;
  onError?: (err: Error) => void;
}): Promise<OverlayPipeline> {
  const preferWidth = opts?.preferWidth ?? TARGET_WIDTH;
  const preferHeight = opts?.preferHeight ?? TARGET_HEIGHT;
  const fps = opts?.fps ?? TARGET_FPS;

  let camera: MediaStream;
  try {
    camera = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        width: { ideal: preferWidth },
        height: { ideal: preferHeight },
        frameRate: { ideal: fps },
        facingMode: 'user',
      },
    });
  } catch {
    camera = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: fps },
      },
    });
  }

  const vTrack = camera.getVideoTracks()[0];
  const cameraSettings = vTrack?.getSettings() ?? {};

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = camera;
  await video.play();

  const canvas = document.createElement('canvas');
  canvas.width = preferWidth;
  canvas.height = preferHeight;
  const ctxRaw = canvas.getContext('2d', { willReadFrequently: false });
  if (!ctxRaw) {
    camera.getTracks().forEach((t) => t.stop());
    throw new Error('Canvas 2D unavailable');
  }
  const ctx = ctxRaw;

  let qrCanvas: HTMLCanvasElement | null = null;
  let lastQrMs = 0;
  let running = true;
  let raf = 0;

  async function refreshQr(now: number) {
    // Refresh QR ~10 Hz so codes stay scannable after encode latency.
    if (now - lastQrMs < 100 && qrCanvas) return;
    lastQrMs = now;
    const payload = `${LATENCY_PREFIX}${Date.now()}`;
    const dataUrl = await QRCode.toDataURL(payload, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: QR_SIZE,
      color: { dark: '#000000', light: '#ffffff' },
    });
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('QR image load failed'));
      img.src = dataUrl;
    });
    const c = document.createElement('canvas');
    c.width = QR_SIZE;
    c.height = QR_SIZE;
    const qctx = c.getContext('2d');
    if (!qctx) return;
    qctx.drawImage(img, 0, 0);
    qrCanvas = c;
  }

  function drawFrame() {
    if (!running) return;
    void refreshQr(Date.now()).catch((err) => {
      opts?.onError?.(err instanceof Error ? err : new Error(String(err)));
    });

    const vw = video.videoWidth || preferWidth;
    const vh = video.videoHeight || preferHeight;
    // Cover-fit into 1920x1080 canvas
    const scale = Math.max(canvas.width / vw, canvas.height / vh);
    const dw = vw * scale;
    const dh = vh * scale;
    const dx = (canvas.width - dw) / 2;
    const dy = (canvas.height - dh) / 2;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(video, dx, dy, dw, dh);

    if (qrCanvas) {
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.fillRect(
        QR_MARGIN - 8,
        QR_MARGIN - 8,
        QR_SIZE + 16,
        QR_SIZE + 16
      );
      ctx.drawImage(qrCanvas, QR_MARGIN, QR_MARGIN);
    }

    raf = requestAnimationFrame(drawFrame);
  }

  raf = requestAnimationFrame(drawFrame);

  const stream = canvas.captureStream(fps);
  const outVideo = stream.getVideoTracks()[0];
  if (outVideo) {
    try {
      outVideo.contentHint = 'detail';
    } catch {
      // ignore
    }
  }

  return {
    canvas,
    stream,
    cameraSettings,
    stop: () => {
      running = false;
      cancelAnimationFrame(raf);
      camera.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
      for (const t of stream.getTracks()) {
        t.stop();
      }
    },
  };
}

export type LatencySample = {
  latencyMs: number;
  stampedAt: number;
  decodedAt: number;
};

/**
 * Sample remote video frames; decode QR timestamps; return glass-to-glass deltas.
 */
export function startLatencySampler(
  remoteVideo: HTMLVideoElement,
  opts: {
    intervalMs?: number;
    onSample?: (sample: LatencySample) => void;
    onMiss?: () => void;
    onLog?: (msg: string) => void;
  }
): { stop: () => void } {
  const intervalMs = opts.intervalMs ?? 200;
  const sampleCanvas = document.createElement('canvas');
  const ctx = sampleCanvas.getContext('2d', { willReadFrequently: true });
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastStamp = -1;

  function tick() {
    if (!ctx) return;
    const w = remoteVideo.videoWidth;
    const h = remoteVideo.videoHeight;
    if (!w || !h || remoteVideo.readyState < 2) {
      opts.onMiss?.();
      return;
    }
    // Decode only the top-left region where we draw the QR (faster + sharper).
    const region = Math.min(w, h, Math.round(Math.max(w, h) * 0.35));
    sampleCanvas.width = region;
    sampleCanvas.height = region;
    ctx.drawImage(remoteVideo, 0, 0, region, region, 0, 0, region, region);
    const image = ctx.getImageData(0, 0, region, region);
    const code = jsQR(image.data, region, region, {
      inversionAttempts: 'dontInvert',
    });
    if (!code?.data?.startsWith(LATENCY_PREFIX)) {
      opts.onMiss?.();
      return;
    }
    const stampedAt = Number(code.data.slice(LATENCY_PREFIX.length));
    if (!Number.isFinite(stampedAt) || stampedAt === lastStamp) {
      opts.onMiss?.();
      return;
    }
    lastStamp = stampedAt;
    const decodedAt = Date.now();
    const latencyMs = decodedAt - stampedAt;
    if (latencyMs < 0 || latencyMs > 60_000) {
      opts.onMiss?.();
      return;
    }
    opts.onSample?.({ latencyMs, stampedAt, decodedAt });
  }

  timer = setInterval(tick, intervalMs);
  opts.onLog?.(`Latency sampler started (${intervalMs} ms)`);

  return {
    stop: () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

export type PeerStatsSnapshot = {
  when: string;
  role: 'whip' | 'whep';
  rttMs: number | null;
  jitterMs: number | null;
  bitrateKbps: number | null;
  framesPerSecond: number | null;
  framesDropped: number | null;
  framesReceived: number | null;
  framesSent: number | null;
  resolution: string | null;
};

export async function collectPeerStats(
  pc: RTCPeerConnection,
  role: 'whip' | 'whep'
): Promise<PeerStatsSnapshot> {
  const report = await pc.getStats();
  let rttMs: number | null = null;
  let jitterMs: number | null = null;
  let framesPerSecond: number | null = null;
  let framesDropped: number | null = null;
  let framesReceived: number | null = null;
  let framesSent: number | null = null;
  let resolution: string | null = null;
  let bytes = 0;
  let timestamp = 0;

  report.forEach((stat) => {
    if (stat.type === 'candidate-pair' && 'state' in stat && stat.state === 'succeeded') {
      const pair = stat as RTCIceCandidatePairStats;
      if (typeof pair.currentRoundTripTime === 'number') {
        rttMs = pair.currentRoundTripTime * 1000;
      }
    }
    if (stat.type === 'inbound-rtp' && 'kind' in stat && stat.kind === 'video') {
      const inbound = stat as RTCInboundRtpStreamStats;
      if (typeof inbound.jitter === 'number') jitterMs = inbound.jitter * 1000;
      if (typeof inbound.framesPerSecond === 'number') framesPerSecond = inbound.framesPerSecond;
      if (typeof inbound.framesDropped === 'number') framesDropped = inbound.framesDropped;
      if (typeof inbound.framesReceived === 'number') framesReceived = inbound.framesReceived;
      if (typeof inbound.bytesReceived === 'number') {
        bytes = inbound.bytesReceived;
        timestamp = inbound.timestamp;
      }
      if (typeof inbound.frameWidth === 'number' && typeof inbound.frameHeight === 'number') {
        resolution = `${inbound.frameWidth}x${inbound.frameHeight}`;
      }
    }
    if (stat.type === 'outbound-rtp' && 'kind' in stat && stat.kind === 'video') {
      const outbound = stat as RTCOutboundRtpStreamStats;
      if (typeof outbound.framesPerSecond === 'number') framesPerSecond = outbound.framesPerSecond;
      if (typeof outbound.framesSent === 'number') framesSent = outbound.framesSent;
      if (typeof outbound.bytesSent === 'number') {
        bytes = outbound.bytesSent;
        timestamp = outbound.timestamp;
      }
      if (typeof outbound.frameWidth === 'number' && typeof outbound.frameHeight === 'number') {
        resolution = `${outbound.frameWidth}x${outbound.frameHeight}`;
      }
    }
  });

  // Single snapshot: bitrate filled by estimateBitrateKbps when needed.
  void bytes;
  void timestamp;

  return {
    when: new Date().toISOString(),
    role,
    rttMs,
    jitterMs,
    bitrateKbps: null,
    framesPerSecond,
    framesDropped,
    framesReceived,
    framesSent,
    resolution,
  };
}

/** Two-sample bitrate estimate for outbound or inbound video. */
export async function estimateBitrateKbps(
  pc: RTCPeerConnection,
  role: 'whip' | 'whep',
  waitMs = 1000
): Promise<number | null> {
  const key = role === 'whip' ? 'outbound-rtp' : 'inbound-rtp';
  const bytesField = role === 'whip' ? 'bytesSent' : 'bytesReceived';

  const a = await pc.getStats();
  let bytesA = 0;
  let tsA = 0;
  a.forEach((stat) => {
    if (stat.type === key && 'kind' in stat && stat.kind === 'video') {
      const b = (stat as Record<string, unknown>)[bytesField];
      if (typeof b === 'number') {
        bytesA = b;
        tsA = stat.timestamp;
      }
    }
  });
  await new Promise((r) => setTimeout(r, waitMs));
  const b = await pc.getStats();
  let bytesB = 0;
  let tsB = 0;
  b.forEach((stat) => {
    if (stat.type === key && 'kind' in stat && stat.kind === 'video') {
      const v = (stat as Record<string, unknown>)[bytesField];
      if (typeof v === 'number') {
        bytesB = v;
        tsB = stat.timestamp;
      }
    }
  });
  const dt = (tsB - tsA) / 1000;
  if (dt <= 0) return null;
  return ((bytesB - bytesA) * 8) / 1000 / dt;
}
