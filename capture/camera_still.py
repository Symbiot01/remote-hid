"""
Shared still capture for Slice D/E.

Libcamera allows one client. While whip.service (rpicam-vid / SRT) runs,
rpicam-still fails with exit 255. Optionally stop/start that unit around
the still (CAPTURE_RELEASE_WHIP=1, default).

Env:
  CAPTURE_RELEASE_WHIP  1 (default) | 0
  WHIP_SERVICE          systemd unit name (default whip.service)
  STILL_WIDTH / STILL_HEIGHT  still size (default 1280x720, fast)
"""

from __future__ import annotations

import os
import subprocess
import tempfile
import time
from shutil import which

MAX_JPEG_BYTES = 8 * 1024 * 1024


def _truthy(raw: str | None, default: bool = True) -> bool:
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() not in ("0", "false", "no", "off")


def _systemctl(action: str, unit: str) -> None:
    """stop/start unit; prefer passwordless sudo -n, then plain systemctl."""
    if action not in ("stop", "start", "is-active"):
        raise ValueError("invalid systemctl action")
    # Reject path/injection — unit must look like a service name.
    if not unit or "/" in unit or ".." in unit or not unit.endswith(".service"):
        raise ValueError("invalid WHIP_SERVICE name")

    attempts = (
        ["sudo", "-n", "systemctl", action, unit],
        ["systemctl", action, unit],
    )
    last_err = ""
    for cmd in attempts:
        try:
            proc = subprocess.run(
                cmd,
                check=False,
                capture_output=True,
                text=True,
                timeout=20,
            )
            if proc.returncode == 0:
                return
            last_err = (proc.stderr or proc.stdout or "").strip()[:200]
        except FileNotFoundError:
            last_err = "systemctl not found"
        except subprocess.TimeoutExpired:
            last_err = "systemctl timed out"
    raise RuntimeError(f"systemctl {action} {unit} failed: {last_err or 'denied'}")


def _whip_active(unit: str) -> bool:
    try:
        proc = subprocess.run(
            ["systemctl", "is-active", "--quiet", unit],
            check=False,
            timeout=5,
        )
        if proc.returncode == 0:
            return True
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
    try:
        proc = subprocess.run(
            ["sudo", "-n", "systemctl", "is-active", "--quiet", unit],
            check=False,
            timeout=5,
        )
        return proc.returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False


def capture_jpeg() -> bytes:
    """
    Capture one JPEG. If CAPTURE_RELEASE_WHIP and whip is active, stop it,
    capture, then start it again in finally.
    """
    release = _truthy(os.environ.get("CAPTURE_RELEASE_WHIP"), True)
    unit = (os.environ.get("WHIP_SERVICE") or "whip.service").strip()
    width = int(os.environ.get("STILL_WIDTH") or os.environ.get("WIDTH") or "1280")
    height = int(os.environ.get("STILL_HEIGHT") or os.environ.get("HEIGHT") or "720")

    binary = None
    for name in ("rpicam-still", "libcamera-still"):
        if which(name):
            binary = name
            break
    if not binary:
        raise RuntimeError("rpicam-still / libcamera-still not found")

    stopped = False
    if release and unit:
        if _whip_active(unit):
            print(f"still: stopping {unit} to free camera", flush=True)
            _systemctl("stop", unit)
            stopped = True
            # Brief settle so Unicam releases before still opens.
            time.sleep(0.4)

    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tmp:
        path = tmp.name

    try:
        cmd = [
            binary,
            "-n",
            "--immediate",
            "--timeout",
            "1000",
            "--width",
            str(width),
            "--height",
            str(height),
            "-o",
            path,
        ]
        print(
            f"still: running {binary} --immediate {width}x{height} "
            f"XDG_RUNTIME_DIR={os.environ.get('XDG_RUNTIME_DIR', '')!r}",
            flush=True,
        )
        proc = subprocess.run(
            cmd,
            check=False,
            capture_output=True,
            timeout=20,
            env=os.environ.copy(),
        )
        if proc.returncode != 0:
            err = (proc.stderr or proc.stdout or b"").decode("utf-8", "replace").strip()
            err = err[-300:] if err else f"exit {proc.returncode}"
            raise RuntimeError(f"{binary} failed: {err}")
        with open(path, "rb") as f:
            data = f.read()
        if not data:
            raise RuntimeError("empty JPEG")
        if len(data) > MAX_JPEG_BYTES:
            raise RuntimeError("JPEG too large")
        if len(data) < 2 or data[0] != 0xFF or data[1] != 0xD8:
            raise RuntimeError("not a JPEG")
        print(f"still: ok bytes={len(data)}", flush=True)
        return data
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass
        if stopped:
            try:
                print(f"still: starting {unit}", flush=True)
                _systemctl("start", unit)
            except Exception as exc:  # noqa: BLE001
                print(f"still: failed to restart {unit}: {exc}", flush=True)
