/**
 * Capture a still from canvas or video at native pixel size (not CSS-scaled).
 */

export type FrameSnapshot = {
  id: string;
  source: 'local' | 'received';
  width: number;
  height: number;
  mime: string;
  blob: Blob;
  objectUrl: string;
  when: string;
};

function stampId(source: string): string {
  return `${source}-${Date.now()}`;
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function canvasToJpegBlob(canvas: HTMLCanvasElement, quality = 0.92): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('toBlob failed'))),
      'image/jpeg',
      quality
    );
  });
}

/** Full-resolution still from the publish canvas (true 1080p desk capture). */
export async function snapshotFromCanvas(
  canvas: HTMLCanvasElement,
  source: 'local' | 'received' = 'local'
): Promise<FrameSnapshot> {
  if (!canvas.width || !canvas.height) {
    throw new Error('Canvas has no pixels yet');
  }
  const blob = await canvasToJpegBlob(canvas, 0.95);
  const id = stampId(source);
  const objectUrl = URL.createObjectURL(blob);
  return {
    id,
    source,
    width: canvas.width,
    height: canvas.height,
    mime: 'image/jpeg',
    blob,
    objectUrl,
    when: new Date().toISOString(),
  };
}

/** Still from a playing &lt;video&gt; at its decoded frame size (may be &lt; 1080 if WHEP ABR). */
export async function snapshotFromVideo(
  video: HTMLVideoElement,
  source: 'local' | 'received' = 'received'
): Promise<FrameSnapshot> {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h || video.readyState < 2) {
    throw new Error('Video has no frame yet');
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D unavailable');
  ctx.drawImage(video, 0, 0, w, h);
  const blob = await canvasToJpegBlob(canvas, 0.92);
  const id = stampId(source);
  const objectUrl = URL.createObjectURL(blob);
  return {
    id,
    source,
    width: w,
    height: h,
    mime: 'image/jpeg',
    blob,
    objectUrl,
    when: new Date().toISOString(),
  };
}

export function downloadSnapshot(snap: FrameSnapshot) {
  const name = `streamtest-${snap.source}-${snap.width}x${snap.height}-${snap.id}.jpg`;
  downloadBlob(snap.blob, name);
}

export function revokeSnapshot(snap: FrameSnapshot) {
  URL.revokeObjectURL(snap.objectUrl);
}
