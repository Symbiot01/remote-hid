export type PhotoResult =
  | { ok: true; blob: Blob; filename: string }
  | { ok: false; error: string };

/**
 * Session-authenticated Pi still via POST /api/photo (Slice E).
 */
export async function fetchPhoto(): Promise<PhotoResult> {
  try {
    const res = await fetch('/api/photo', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'image/jpeg' },
    });

    if (res.status === 401) {
      window.location.assign('/');
      return { ok: false, error: 'Unauthorized' };
    }

    if (!res.ok) {
      let error = 'Photo failed';
      try {
        const data = (await res.json()) as { error?: string };
        if (typeof data.error === 'string' && data.error) {
          error = data.error;
        }
      } catch {
        if (res.status === 429) error = 'Wait a moment';
        else if (res.status === 503) error = 'Capture node offline';
        else if (res.status === 504) error = 'Capture timed out';
      }
      if (res.status === 429 && error === 'Photo failed') {
        error = 'Wait a moment';
      }
      return { ok: false, error };
    }

    const blob = await res.blob();
    if (!blob.size) {
      return { ok: false, error: 'Empty photo' };
    }

    const filename =
      filenameFromDisposition(res.headers.get('Content-Disposition')) ||
      defaultFilename();

    return { ok: true, blob, filename };
  } catch {
    return { ok: false, error: 'Photo unreachable' };
  }
}

function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      // fall through
    }
  }
  const plain = /filename="([^"]+)"/i.exec(header) || /filename=([^;]+)/i.exec(header);
  if (plain?.[1]) {
    return plain[1].trim().replace(/^["']|["']$/g, '');
  }
  return null;
}

function defaultFilename(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `capture-${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}.jpg`
  );
}
