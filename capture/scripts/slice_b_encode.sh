#!/usr/bin/env bash
# Slice B — local H.264 encode 1280x720@30 for 10 seconds.
set -euo pipefail

WIDTH="${WIDTH:-1280}"
HEIGHT="${HEIGHT:-720}"
FPS="${FPS:-30}"
MS="${DURATION_MS:-10000}"
OUT="${1:-/tmp/test.h264}"

echo "==> Encode ${WIDTH}x${HEIGHT}@${FPS} for ${MS} ms → ${OUT}"
if command -v rpicam-vid >/dev/null 2>&1; then
  rpicam-vid -t "${MS}" --width "${WIDTH}" --height "${HEIGHT}" --framerate "${FPS}" -o "${OUT}"
elif command -v libcamera-vid >/dev/null 2>&1; then
  libcamera-vid -t "${MS}" --width "${WIDTH}" --height "${HEIGHT}" --framerate "${FPS}" -o "${OUT}"
else
  echo "ERROR: rpicam-vid / libcamera-vid not found. Install: sudo apt install -y libcamera-apps" >&2
  exit 1
fi

ls -la "${OUT}"
echo
echo "PASS checklist:"
echo "  [ ] Ran ~10s with no libcamera buffer errors"
echo "  [ ] ${OUT} is non-empty"
echo "Play: copy to PC and open in VLC, or serve via python3 -m http.server"
echo "Next: Slice C (WHIP to MediaMTX /cam/whip)"
