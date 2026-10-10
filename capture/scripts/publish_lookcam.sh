#!/usr/bin/env bash
# LookCam (or any RTSP camera) → MediaMTX path "cam" via SRT.
# Replaces the Pi CSI source in publish_whip.sh. Slice E stills do not apply.
#
# LOOKCAM_RTSP may contain a password. Keep it in capture/.env (chmod 600).
# Never commit that file. This script redacts userinfo before logging.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ -f "${ROOT}/.env" ]]; then
  # shellcheck disable=SC1091
  set -a
  # shellcheck source=/dev/null
  source "${ROOT}/.env"
  set +a
fi

if [[ -z "${LOOKCAM_RTSP:-}" ]]; then
  echo "ERROR: LOOKCAM_RTSP is unset. Confirm a URL in VLC, then put it in capture/.env (chmod 600)." >&2
  exit 1
fi

# Local laptop MediaMTX by default. Set LOOKCAM_SRT_URL (or SRT_URL) to the VPS for the operator site.
SRT_URL="${LOOKCAM_SRT_URL:-${SRT_URL:-srt://127.0.0.1:8890?streamid=publish:cam&pkt_size=1316}}"

redact_rtsp() {
  # shellcheck disable=SC2001
  printf '%s\n' "$1" | sed -E 's#(rtsp://)[^/@]+@#\1***@#'
}

echo "Publishing $(redact_rtsp "${LOOKCAM_RTSP}") via SRT → ${SRT_URL}"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ERROR: ffmpeg not found" >&2
  exit 1
fi

video_args=(-c:v copy)
if [[ "${LOOKCAM_TRANSCODE:-0}" == "1" ]]; then
  # HEVC / odd SPS: browsers playing WHEP need H.264.
  video_args=(-c:v libx264 -preset veryfast -tune zerolatency -pix_fmt yuv420p)
fi

exec ffmpeg -hide_banner -loglevel warning \
  -rtsp_transport tcp \
  -i "${LOOKCAM_RTSP}" \
  "${video_args[@]}" \
  -an \
  -f mpegts \
  "${SRT_URL}"
