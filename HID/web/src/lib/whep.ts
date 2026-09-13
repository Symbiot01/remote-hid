import { DEFAULT_ICE_SERVERS } from './mediaConfig';

export type WhepSession = {
  pc: RTCPeerConnection;
  resourceUrl: string | null;
  stop: () => Promise<void>;
};

function waitIceComplete(pc: RTCPeerConnection, timeoutMs = 8000): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = window.setTimeout(() => {
      pc.removeEventListener('icegatheringstatechange', onChange);
      reject(new Error('ICE gathering timed out'));
    }, timeoutMs);
    function onChange() {
      if (pc.iceGatheringState === 'complete') {
        window.clearTimeout(t);
        pc.removeEventListener('icegatheringstatechange', onChange);
        resolve();
      }
    }
    pc.addEventListener('icegatheringstatechange', onChange);
  });
}

/**
 * Subscribe to a MediaMTX WHEP endpoint. Remote tracks arrive on the PC.
 */
export async function startWhep(
  whepEndpoint: string,
  opts?: {
    iceServers?: RTCIceServer[];
    onTrack?: (ev: RTCTrackEvent) => void;
    onLog?: (msg: string) => void;
  }
): Promise<WhepSession> {
  const log = opts?.onLog ?? (() => {});
  const pc = new RTCPeerConnection({
    iceServers: opts?.iceServers ?? DEFAULT_ICE_SERVERS,
  });

  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.addTransceiver('audio', { direction: 'recvonly' });

  if (opts?.onTrack) {
    pc.addEventListener('track', opts.onTrack);
  }

  pc.addEventListener('iceconnectionstatechange', () => {
    log(`WHEP ICE: ${pc.iceConnectionState}`);
  });
  pc.addEventListener('connectionstatechange', () => {
    log(`WHEP PC: ${pc.connectionState}`);
  });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  try {
    await waitIceComplete(pc);
  } catch (err) {
    log(`WHEP: ${(err as Error).message} — posting offer anyway`);
  }

  const localSdp = pc.localDescription?.sdp;
  if (!localSdp) {
    pc.close();
    throw new Error('WHEP: missing local SDP');
  }

  log(`WHEP POST ${whepEndpoint}`);
  const res = await fetch(whepEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/sdp',
      Accept: 'application/sdp',
    },
    body: localSdp,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    pc.close();
    throw new Error(`WHEP HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const answerSdp = await res.text();
  const location = res.headers.get('Location');
  let resourceUrl: string | null = null;
  if (location) {
    resourceUrl = new URL(location, whepEndpoint).toString();
  }
  log(`WHEP: answer OK${resourceUrl ? `; resource ${resourceUrl}` : ''}`);

  await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

  return {
    pc,
    resourceUrl,
    stop: async () => {
      pc.close();
      if (resourceUrl) {
        try {
          log(`WHEP DELETE ${resourceUrl}`);
          await fetch(resourceUrl, { method: 'DELETE' });
        } catch (err) {
          log(`WHEP DELETE failed: ${(err as Error).message}`);
        }
      }
    },
  };
}
