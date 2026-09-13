const DEFAULT_MEDIA_BASE = 'https://mediarelay.sahilpatel.online:8889';
/** Stream-test loopback path (browser WHIP + WHEP). */
const DESK_PATH = 'desk';
/** Pi live camera path (SRT in → WHEP out). */
const CAM_PATH = 'cam';

function trimSlash(s: string): string {
  return s.replace(/\/+$/, '');
}

/** Public MediaMTX HTTPS origin (Coolify domain). No credentials. */
export function mediaBaseUrl(): string {
  const raw = import.meta.env.VITE_MEDIA_BASE_URL as string | undefined;
  const base = (raw && raw.trim()) || DEFAULT_MEDIA_BASE;
  return trimSlash(base);
}

/** @deprecated Prefer mediaDeskPath — kept for Stream-test call sites. */
export function mediaPath(): string {
  return DESK_PATH;
}

export function mediaDeskPath(): string {
  return DESK_PATH;
}

export function camPath(): string {
  return CAM_PATH;
}

export function whipUrl(): string {
  return `${mediaBaseUrl()}/${DESK_PATH}/whip`;
}

export function whepUrl(): string {
  return `${mediaBaseUrl()}/${DESK_PATH}/whep`;
}

export function camWhepUrl(): string {
  return `${mediaBaseUrl()}/${CAM_PATH}/whep`;
}

export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
];
