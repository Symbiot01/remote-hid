#!/usr/bin/env bash
# Slice C — live H.264 → MediaMTX path "cam" via SRT (stock ffmpeg cannot WHIP).
# Filename is historical; ingest is SRT, not WHIP.
#
# Note: Snapshot (Slice E) briefly stops this service to free the camera, then
# restarts it (CAPTURE_RELEASE_WHIP). See camera_still.py + sudoers/.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ -f "${ROOT}/.env" ]]; then
  # shellcheck disable=SC1091
  set -a
  # shellcheck source=/dev/null
  source "${ROOT}/.env"
  set +a
fi

WIDTH="${WIDTH:-1280}"
HEIGHT="${HEIGHT:-720}"
FPS="${FPS:-30}"
SRT_URL="${SRT_URL:-srt://mediarelay.sahilpatel.online:8890?streamid=publish:cam&pkt_size=1316}"

if command -v rpicam-vid >/dev/null 2>&1; then
  VID=(rpicam-vid)
elif command -v libcamera-vid >/dev/null 2>&1; then
  VID=(libcamera-vid)
else
  echo "ERROR: rpicam-vid / libcamera-vid not found" >&2
  exit 1
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ERROR: ffmpeg not found" >&2
  exit 1
fi

# Log URL without leaking unrelated secrets from the environment.
echo "Publishing ${WIDTH}x${HEIGHT}@${FPS} via SRT → ${SRT_URL}"

exec "${VID[@]}" -t 0 -n --inline \
  --width "${WIDTH}" --height "${HEIGHT}" --framerate "${FPS}" \
  -o - |
  ffmpeg -hide_banner -loglevel warning \
    -fflags +genpts \
    -f h264 -i - \
    -c:v copy \
    -f mpegts \
    "${SRT_URL}"
