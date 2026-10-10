export type WhepSession = {
  stop: () => Promise<void>;
  pc: RTCPeerConnection;
};

function waitIceComplete(pc: RTCPeerConnection, timeoutMs = 4000): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      pc.removeEventListener('icegatheringstatechange', onChange);
      resolve();
    }, timeoutMs);
    function onChange() {
      if (pc.iceGatheringState !== 'complete') return;
      window.clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', onChange);
      resolve();
    }
    pc.addEventListener('icegatheringstatechange', onChange);
  });
}

export async function startWhep(onTrack: (event: RTCTrackEvent) => void): Promise<WhepSession> {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.addEventListener('track', onTrack);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitIceComplete(pc);
  const localSdp = pc.localDescription?.sdp;
  if (!localSdp) {
    pc.close();
    throw new Error('Could not build the stream offer');
  }

  const response = await fetch('/api/stream/whep', {
    method: 'POST',
    headers: { 'Content-Type': 'application/sdp', Accept: 'application/sdp' },
    body: localSdp,
  });
  if (!response.ok) {
    pc.close();
    let message = 'Stream is unavailable';
    try {
      const payload = (await response.json()) as { error?: string };
      if (payload.error) message = payload.error;
    } catch {
      // The player only needs a short status.
    }
    throw new Error(message);
  }

  const answer = await response.text();
  const location = response.headers.get('Location');
  const resourceUrl = location ? new URL(location, window.location.href).toString() : null;
  await pc.setRemoteDescription({ type: 'answer', sdp: answer });

  return {
    pc,
    stop: async () => {
      for (const receiver of pc.getReceivers()) receiver.track?.stop();
      pc.close();
      if (!resourceUrl) return;
      try {
        await fetch(resourceUrl, { method: 'DELETE' });
      } catch {
        // Closing the page is enough if the relay is already gone.
      }
    },
  };
}
