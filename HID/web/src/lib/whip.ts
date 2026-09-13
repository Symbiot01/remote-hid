import { DEFAULT_ICE_SERVERS } from './mediaConfig';

export type WhipSession = {
  pc: RTCPeerConnection;
  resourceUrl: string | null;
  stop: () => Promise<void>;
};

/** Desk / operator publish: aim for sharp 1080p30, not ABR 360p. */
export const WHIP_VIDEO_MAX_BITRATE_BPS = 6_000_000;
export const WHIP_VIDEO_MAX_FRAMERATE = 30;

function waitIceComplete(pc: RTCPeerConnection, timeoutMs = 2500): Promise<void> {
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

function preferSharpVideoCodecs(transceiver: RTCRtpTransceiver, log: (m: string) => void) {
  const caps = RTCRtpSender.getCapabilities?.('video');
  if (!caps?.codecs?.length || !transceiver.setCodecPreferences) return;
  const preferred = [...caps.codecs].sort((a, b) => {
    const rank = (c: RTCRtpCodec) => {
      const mime = c.mimeType.toLowerCase();
      if (mime === 'video/h264') return 0;
      if (mime === 'video/vp8') return 1;
      if (mime === 'video/vp9') return 2;
      if (mime === 'video/av1') return 3;
      return 9;
    };
    return rank(a) - rank(b);
  });
  try {
    transceiver.setCodecPreferences(preferred);
    log(`WHIP: codec preference ${preferred.map((c) => c.mimeType).slice(0, 3).join(', ')}`);
  } catch (err) {
    log(`WHIP: setCodecPreferences failed: ${(err as Error).message}`);
  }
}

/**
 * Keep resolution; push bitrate so Chrome does not settle at 320/640.
 */
export async function applyHighQualityVideoSender(
  sender: RTCRtpSender,
  log: (m: string) => void = () => {}
): Promise<void> {
  if (sender.track?.kind !== 'video') return;
  try {
    if ('contentHint' in sender.track) {
      sender.track.contentHint = 'detail';
    }
  } catch {
    // ignore
  }

  try {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{}];
    }
    for (const enc of params.encodings) {
      enc.scaleResolutionDownBy = 1;
      enc.maxFramerate = WHIP_VIDEO_MAX_FRAMERATE;
      enc.maxBitrate = WHIP_VIDEO_MAX_BITRATE_BPS;
      // Single stream — disable simulcast layers if present
      if ('active' in enc) enc.active = true;
    }
    params.degradationPreference = 'maintain-resolution';
    await sender.setParameters(params);
    log(
      `WHIP: sender maxBitrate=${WHIP_VIDEO_MAX_BITRATE_BPS / 1e6}Mbps scale=1 fps≤${WHIP_VIDEO_MAX_FRAMERATE} maintain-resolution`
    );
  } catch (err) {
    log(`WHIP: setParameters failed: ${(err as Error).message}`);
  }
}

/**
 * Publish a MediaStream to a MediaMTX WHIP endpoint (no credentials).
 */
export async function startWhip(
  whipEndpoint: string,
  stream: MediaStream,
  opts?: {
    iceServers?: RTCIceServer[];
    onLog?: (msg: string) => void;
    highQuality?: boolean;
  }
): Promise<WhipSession> {
  const log = opts?.onLog ?? (() => {});
  const highQuality = opts?.highQuality !== false;
  const pc = new RTCPeerConnection({
    iceServers: opts?.iceServers ?? DEFAULT_ICE_SERVERS,
  });

  for (const track of stream.getTracks()) {
    if (track.kind === 'video' && highQuality) {
      try {
        track.contentHint = 'detail';
      } catch {
        // ignore
      }
      const transceiver = pc.addTransceiver(track, {
        direction: 'sendonly',
        streams: [stream],
        sendEncodings: [
          {
            active: true,
            scaleResolutionDownBy: 1,
            maxFramerate: WHIP_VIDEO_MAX_FRAMERATE,
            maxBitrate: WHIP_VIDEO_MAX_BITRATE_BPS,
          },
        ],
      });
      preferSharpVideoCodecs(transceiver, log);
      log(`WHIP: added video track (HQ encodings)`);
    } else {
      pc.addTrack(track, stream);
      log(`WHIP: added ${track.kind} track (${track.label || track.id})`);
    }
  }

  if (highQuality) {
    for (const sender of pc.getSenders()) {
      await applyHighQualityVideoSender(sender, log);
    }
  }

  pc.addEventListener('iceconnectionstatechange', () => {
    log(`WHIP ICE: ${pc.iceConnectionState}`);
  });
  pc.addEventListener('connectionstatechange', () => {
    log(`WHIP PC: ${pc.connectionState}`);
    if (highQuality && pc.connectionState === 'connected') {
      void (async () => {
        for (const sender of pc.getSenders()) {
          await applyHighQualityVideoSender(sender, log);
        }
      })();
    }
  });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  try {
    await waitIceComplete(pc);
  } catch (err) {
    log(`WHIP: ${(err as Error).message} — posting offer anyway`);
  }

  const localSdp = pc.localDescription?.sdp;
  if (!localSdp) {
    pc.close();
    throw new Error('WHIP: missing local SDP');
  }

  log(`WHIP POST ${whipEndpoint}`);
  const res = await fetch(whipEndpoint, {
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
    throw new Error(`WHIP HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const answerSdp = await res.text();
  const location = res.headers.get('Location');
  let resourceUrl: string | null = null;
  if (location) {
    resourceUrl = new URL(location, whipEndpoint).toString();
  }
  log(`WHIP: answer OK${resourceUrl ? `; resource ${resourceUrl}` : ''}`);

  await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

  if (highQuality) {
    for (const sender of pc.getSenders()) {
      await applyHighQualityVideoSender(sender, log);
    }
  }

  return {
    pc,
    resourceUrl,
    stop: async () => {
      for (const sender of pc.getSenders()) {
        try {
          sender.track?.stop();
        } catch {
          // ignore
        }
      }
      pc.close();
      if (resourceUrl) {
        try {
          log(`WHIP DELETE ${resourceUrl}`);
          await fetch(resourceUrl, { method: 'DELETE' });
        } catch (err) {
          log(`WHIP DELETE failed: ${(err as Error).message}`);
        }
      }
    },
  };
}
