#!/usr/bin/env bash
# Slice A — detect Camera Module 3 (IMX708) and capture a still.
set -euo pipefail

echo "==> Listing cameras (expect imx708 / Module 3)"
if command -v rpicam-hello >/dev/null 2>&1; then
  rpicam-hello --list-cameras
elif command -v libcamera-hello >/dev/null 2>&1; then
  libcamera-hello --list-cameras
else
  echo "ERROR: rpicam-hello / libcamera-hello not found. Install: sudo apt install -y libcamera-apps" >&2
  exit 1
fi

OUT="${1:-/tmp/test.jpg}"
echo "==> Still capture → ${OUT}"
if command -v rpicam-still >/dev/null 2>&1; then
  rpicam-still -n -o "${OUT}"
elif command -v libcamera-still >/dev/null 2>&1; then
  libcamera-still -n -o "${OUT}"
else
  echo "ERROR: rpicam-still / libcamera-still not found" >&2
  exit 1
fi

ls -la "${OUT}"
echo
echo "PASS checklist:"
echo "  [ ] One camera listed with imx708"
echo "  [ ] ${OUT} is non-empty"
echo "View headless:  cd /tmp && python3 -m http.server 8080"
echo "               then open http://<PI_IP>:8080/$(basename "${OUT}")"
