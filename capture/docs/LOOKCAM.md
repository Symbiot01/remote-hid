# LookCam module

The operator Focus view plays MediaMTX path `cam`. This module is not a Pi camera and it does not serve RTSP on its own access point. The phone app and the laptop both use PPPP (CS2) over UDP: a short handshake, then JSON commands, then H.264.

Device id: `GHBB-522328-BWDTT`. Access-point SSID: `G522328BWDTT`. Firmware seen in `GetDevInfo`: `Mar 11 2026 16:40:37`.

Do not commit packet captures. They contain the device password and Wi-Fi passwords. Do not put those values in this file, in git, or in logs.

## How the laptop connected

The working path was the laptop on the camera access point, not the cloud.

1. Join SSID `G522328BWDTT`. The camera is `192.168.100.1`. The laptop was `192.168.100.22` on `wlo1`. Bind every UDP socket to that address so packets do not leave through Ethernet.
2. Send a LAN search, `F1 30 00 00`, to `192.168.100.1:32108` and to `255.255.255.255:32108`.
3. The camera answers with a punch, `F1 41`, from a temporary UDP port. The 20-byte body is the device id:

   `GHBB` + 4 zero bytes + serial `522328` as a big-endian integer + `BWDTT` + 3 zero bytes.

   A punch that puts `0x40` in front of those zeros is ignored. The null-padded id is the one the camera accepts.
4. From the same socket, send that punch back to the camera’s source port. The camera then sends ready, `F1 42`, many times.
5. Send alive (`F1 E0 00 00`), then JSON on data channel 1. The camera answers alive with `F1 E1`.
6. Command order that produced video: `LoginDev`, then `AppointDev`, then `OpenVideo`.
7. Acknowledge every data packet. Video is channel 0. If a channel-0 body starts with `01 AF AF AF`, drop the first 83 bytes. The rest is H.264 in Annex B. Reassemble packets in index order.
8. Publish into local MediaMTX and open the player:

```bash
cd HID/deploy/mediamtx
docker compose -f docker-compose.local.yml up -d
```

Play `http://127.0.0.1:8889/cam/`. The picture we got was 640×360 at 15 fps. Copying the elementary stream into SRT froze the player after a few seconds because timestamps were missing and the camera stopped when acknowledgements stalled. A low-latency H.264 transcode into `srt://127.0.0.1:8890?streamid=publish:cam&pkt_size=1316` kept the player moving. Re-send `OpenVideo` if channel 0 goes quiet.

TCP 554 is closed on the access point. There is no RTSP URL in that mode. Ports 21, 23, 6789, and 8000 are open and were not used for the picture.

`publish_lookcam.sh` still expects an RTSP URL. It does not speak PPPP. Use it only if the camera later exposes RTSP on a normal LAN.

## Two networks

| Network | Camera address | How you get there |
|---|---|---|
| Camera access point `G522328BWDTT` | `192.168.100.1` | Join that SSID. No internet on the camera. |
| Shared Wi-Fi | `10.42.0.143` in the capture | App sends `OpenWifi` (below). A later `GetDevInfo` shows `wifissid` `dev` and the new IP. |

After `OpenWifi`, live view is still PPPP. The protocol does not switch to RTSP. One capture (10:51) never reached the camera: the phone only broadcast searches and talked to the cloud directory on UDP 32100.

## Packet types

Every datagram starts with `F1`, a type byte, and a big-endian length.

| Type | Name | Role |
|---|---|---|
| `0x30` | LAN search | Empty body, sent to UDP 32108. |
| `0x41` | Punch | 20-byte device id. Opens the direct port. |
| `0x42` | Ready | Same 20-byte id. Session can carry commands. |
| `0x43` | Extended punch | Seen from the camera in the phone capture. Not required for the laptop login that worked. |
| `0xD0` | Data | Channel, index, then payload. |
| `0xD1` | Data ack | Channel plus the indexes received. Required or the camera stops sending. |
| `0xE0` / `0xE1` | Alive / alive ack | Keep the session up. |
| `0xF0` | Close | Either side ends the session. |

JSON is only on channel 1. Video is channel 0. A command is wrapped like this, then the data header is put in front:

- 4 bytes `A0 AF AF AF`
- `00`, then the timezone in whole hours (`05` for this camera)
- 8-byte little-endian unix time
- 8 zero bytes
- 4-byte little-endian JSON length
- UTF-8 JSON, no spaces
- trailer `F4 F3 F2 F1`

The app retries a command until it sees a data ack. `result` 0 or `state` 0 means success. Some edits never send a JSON body back; only the data ack arrives.

## Commands

Passwords below are field names. Store the real values outside git.

### Session

These three run before anything else.

**LoginDev.** App sends `pwd` and `cmd`. Camera returns `result` 0, `connectNum`, `devtype` `ipc`, `audioType` 0, `SampleRate` 8000, `csType` 1.

**AppointDev.** App sends `state` 3, `pwd`, `zone` 5, `zone_s` 19800 (5.5 hours in seconds), and unix `time`. Camera returns `state` 0. This sets the clock. The captures did not use any other `state`.

**GetDevInfo.** App sends `cmd` only. Camera returns id `GHBB-522328-BWDTT`, firmware date, `ip`, `wifissid`, `wifipwd`, `wifisig`, `4G` 2 (no modem in use), empty `iccid`, `ledstatus`, `lightstatus` 1, and `lock` 2.

### Video

**OpenVideo.** `state` 2 starts, `state` 0 stops. Also sends `pwd`, `stream`, and `userid`. The app used stream 2 and stream 3 for the live picture. `userid` changes every open; it is a client counter, not a login. After a start, H.264 follows on channel 0. There is no separate JSON “video started” body.

**GetDevStream.** Camera returns `mainstream` `4K`, `substream` `2K`, `threestream` `1080P`. Those names did not match the 640×360 frames we decoded.

**GetDevVideoInfo.** Camera returns `brightness` 30 and `saturation` 30.

**SetDevVideoInfo.** App sent `saturation` 0, 63, and 32. No JSON reply in the capture.

**LevelFlip** and **VerticalFlip.** App sends `cmd` only, each command twice. No JSON reply. Treat them as toggles.

### Alarm, LED, password

**GetAlarmInfo.** Camera returns `sensitivity`, `audio`, `goptime` (30 before the edit), `putalarm`, `osd` 1, and two windows: `starttime`/`endtime` and `twotime`/`twoend`.

**SetAlarmInfo.** App set `goptime` 35 and `sensitivity` 1 and kept the same windows. Camera returns `state` 0.

**GetLedInfo.** Camera returns `control` plus `starttime`/`endtime` (`01:00`–`11:00` in the capture) and a second window.

**SetLedInfo.** App set `control` 1, then 0, with that same window. Camera returns `state` 0.

**SetLed.** App sent `ledstatus` 1, then 0. No JSON reply. A later `GetDevInfo` is how the app reads `ledstatus` back. This is separate from `SetLedInfo`.

**ModifyPwd.** App sends `pwd` and `newpwd`. Camera returns `result` 0.

### Wi-Fi

**searchWiFiList.** Camera returns `result` 0 and `value`, a list of `ssid` and `sig`.

**OpenWifi.** App sends `sid`, `wifiPwd`, and `state` 1. Camera returns `state` 1. In the 11:02 capture the target name was `dev`. The following `GetDevInfo` showed `wifissid` `dev` and `ip` `10.42.0.143`.

## Operator control

`capture/scripts/lookcam_bridge.py` keeps this session up. It searches, punches, logs in, and sets the clock. If the camera goes quiet, closes the session, or stops sending video, the bridge backs off and discovers it again. It acknowledges channel 0 so the window does not fill. A 3.5 second video stall reopens `OpenVideo`. After several stalls it rebuilds the session.

The bridge uploads Annex-B only while the server says someone is watching:

```bash
# On the camera Wi-Fi. Bind the interface that can see the camera.
export BRIDGE_URL=http://127.0.0.1:8080
export BRIDGE_TOKEN=...          # same value as operator_console/.env
export LOOKCAM_IFACE=wlo1
export LOOKCAM_BIND=192.168.100.22
python3 scripts/lookcam_bridge.py
```

`LOOKCAM_PASSWORD` stays in `operator_console/.env`. The server gives it to the bridge once over the bearer channel. The browser never receives it.

The Stream tab sends a watch every few seconds. That asks the bridge to open video. About 20 seconds after the last watch, the server tells the bridge to send `OpenVideo` with `state` 0 and to end the upload, so the camera can sleep. The tab can run the commands above, plus `reconnect`. `AppointDev` stays inside the bridge and is only the clock set (`state` 3). After a device password change, put the new value in `LOOKCAM_PASSWORD` before the next bridge start.

On a phone hotspot, join the camera to that network with `OpenWifi` first. Run this script there (Termux on Android). Point `BRIDGE_URL` at the console and set the console `HOST` to `0.0.0.0` so the phone can reach it. One bridge at a time.

## What is not in the captures

- No RTSP, and no HTTP picture API, on the access point.
- No change to brightness. It was only read, at 30.
- No reboot and no factory reset. Do not invent other `AppointDev` states for those.
- Cloud directory packets (`F1 20` and `F1 F9` to UDP 32100) are the phone looking up the camera when it is not on the LAN. The laptop did not need them.
