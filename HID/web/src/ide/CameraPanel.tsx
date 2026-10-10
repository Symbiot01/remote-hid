import { useEffect, useState } from 'react';

type Check = { name: string; ok: boolean; detail: string };

type CameraStatus = {
  bridge: 'online' | 'offline';
  phase: string;
  attempt: number;
  detail: string;
  checks: Check[];
  video: 'wanted' | 'off';
  cameraVideo: 'off' | 'starting' | 'on';
  ingest: boolean;
  stream: 2 | 3;
  last: { name: string; ok: boolean; detail: string } | null;
};

type CommandResult = {
  ok?: boolean;
  detail?: string;
  body?: Record<string, unknown> | null;
  error?: string;
};

type AlarmForm = {
  sensitivity: number;
  goptime: number;
  audio: number;
  putalarm: number;
  osd: number;
  flag: number;
  starttime: string;
  endtime: string;
  twotime: string;
  twoend: string;
};

type LedForm = {
  control: number;
  flag: number;
  starttime: string;
  endtime: string;
  twotime: string;
  twoend: string;
};

const EMPTY_ALARM: AlarmForm = {
  sensitivity: 0,
  goptime: 30,
  audio: 0,
  putalarm: 0,
  osd: 1,
  flag: 1,
  starttime: '00:00',
  endtime: '15:00',
  twotime: '00:00',
  twoend: '00:00',
};

const EMPTY_LED: LedForm = {
  control: 0,
  flag: 1,
  starttime: '01:00',
  endtime: '11:00',
  twotime: '00:00',
  twoend: '00:00',
};

type Props = {
  active: boolean;
  stream: 2 | 3;
  onStream: (stream: 2 | 3) => void;
};

export function CameraPanel({ active, stream, onStream }: Props) {
  const [status, setStatus] = useState<CameraStatus | null>(null);
  const [output, setOutput] = useState('Video stops about 20 seconds after you leave this tab.');
  const [busy, setBusy] = useState(false);
  const [alarm, setAlarm] = useState<AlarmForm>(EMPTY_ALARM);
  const [led, setLed] = useState<LedForm>(EMPTY_LED);
  const [saturation, setSaturation] = useState(30);
  const [brightness, setBrightness] = useState(30);
  const [ssid, setSsid] = useState('');
  const [wifiPwd, setWifiPwd] = useState('');
  const [nextPwd, setNextPwd] = useState('');
  const [networks, setNetworks] = useState<{ ssid: string; sig?: number }[]>([]);

  useEffect(() => {
    if (!active) return;
    let stop = false;
    const pull = async () => {
      try {
        const res = await fetch('/api/camera', { credentials: 'same-origin' });
        if (!res.ok || stop) return;
        const body = (await res.json()) as CameraStatus;
        if (!stop) setStatus(body);
      } catch {
        if (!stop) setStatus(null);
      }
    };
    void pull();
    const timer = window.setInterval(() => void pull(), 2000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [active]);

  const run = async (name: string, args?: Record<string, unknown>) => {
    setBusy(true);
    try {
      const res = await fetch('/api/camera/command', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, args: args ?? {} }),
      });
      const body = (await res.json()) as CommandResult;
      if (!res.ok) {
        setOutput(body.error || `Command failed (${res.status})`);
        return null;
      }
      const text = body.body ? JSON.stringify(body.body, null, 2) : body.detail || (body.ok ? 'Done' : 'Failed');
      setOutput(text);
      return body;
    } catch {
      setOutput('Command failed');
      return null;
    } finally {
      setBusy(false);
    }
  };

  const readAlarm = async () => {
    const result = await run('GetAlarmInfo');
    if (!result?.body) return;
    setAlarm((prev) => fill(prev, result.body));
  };

  const readLed = async () => {
    const result = await run('GetLedInfo');
    if (!result?.body) return;
    setLed((prev) => fill(prev, result.body));
  };

  const readPicture = async () => {
    const result = await run('GetDevVideoInfo');
    if (!result?.body) return;
    if (typeof result.body.saturation === 'number') setSaturation(result.body.saturation);
    if (typeof result.body.brightness === 'number') setBrightness(result.body.brightness);
  };

  const scan = async () => {
    const result = await run('searchWiFiList');
    const value = result?.body?.value;
    if (!Array.isArray(value)) return;
    setNetworks(
      value
        .filter((item): item is { ssid?: string; sig?: number } => Boolean(item) && typeof item === 'object')
        .map((item) => ({ ssid: typeof item.ssid === 'string' ? item.ssid : '', sig: item.sig }))
        .filter((item) => item.ssid),
    );
  };

  const bridgeLine = !status
    ? 'Waiting for the console'
    : status.bridge === 'offline'
      ? 'Bridge offline'
      : `${status.phase || 'connecting'} · attempt ${status.attempt}`;

  return (
    <aside className="ide-cam">
      <p className="ide-cam-status">{bridgeLine}</p>
      <p className="ide-cam-sub">
        {status?.cameraVideo === 'on' ? 'Camera streaming' : status?.video === 'wanted' ? 'Opening camera' : 'Camera idle'}
        {status?.ingest ? ' · server publishing' : ''}
      </p>
      <ul className="ide-cam-checks">
        {(status?.checks ?? []).map((check) => (
          <li key={check.name} className={check.ok ? 'ok' : ''}>
            {check.name}: {check.detail || (check.ok ? 'ok' : 'waiting')}
          </li>
        ))}
      </ul>
      <label className="ide-cam-field">
        Stream
        <select
          value={stream}
          onChange={(event) => onStream(event.target.value === '3' ? 3 : 2)}
        >
          <option value={2}>2</option>
          <option value={3}>3</option>
        </select>
      </label>
      <div className="ide-cam-actions">
        <button type="button" className="btn ghost ide-mini" disabled={busy} onClick={() => void run('GetDevInfo')}>
          Info
        </button>
        <button type="button" className="btn ghost ide-mini" disabled={busy} onClick={() => void run('GetDevStream')}>
          Streams
        </button>
        <button type="button" className="btn ghost ide-mini" disabled={busy} onClick={() => void readPicture()}>
          Picture
        </button>
        <button type="button" className="btn ghost ide-mini" disabled={busy} onClick={() => void run('reconnect')}>
          Recover
        </button>
        <button type="button" className="btn ghost ide-mini" disabled={busy} onClick={() => void run('SetLed', { ledstatus: 1 })}>
          LED on
        </button>
        <button type="button" className="btn ghost ide-mini" disabled={busy} onClick={() => void run('SetLed', { ledstatus: 0 })}>
          LED off
        </button>
        <button type="button" className="btn ghost ide-mini" disabled={busy} onClick={() => void run('LevelFlip')}>
          Flip horizontal
        </button>
        <button type="button" className="btn ghost ide-mini" disabled={busy} onClick={() => void run('VerticalFlip')}>
          Flip vertical
        </button>
      </div>
      <details>
        <summary>Picture values</summary>
        <label className="ide-cam-field">
          Saturation
          <input
            type="number"
            min={0}
            max={100}
            value={saturation}
            onChange={(event) => setSaturation(Number(event.target.value))}
          />
        </label>
        <label className="ide-cam-field">
          Brightness
          <input
            type="number"
            min={0}
            max={100}
            value={brightness}
            onChange={(event) => setBrightness(Number(event.target.value))}
          />
        </label>
        <button
          type="button"
          className="btn ghost ide-mini"
          disabled={busy}
          onClick={() => void run('SetDevVideoInfo', { saturation, brightness })}
        >
          Save picture
        </button>
      </details>
      <details>
        <summary>Alarm</summary>
        <button type="button" className="btn ghost ide-mini" disabled={busy} onClick={() => void readAlarm()}>
          Read alarm
        </button>
        <ClockFields value={alarm} onChange={setAlarm} />
        <label className="ide-cam-field">
          Sensitivity
          <input
            type="number"
            min={0}
            max={10}
            value={alarm.sensitivity}
            onChange={(event) => setAlarm({ ...alarm, sensitivity: Number(event.target.value) })}
          />
        </label>
        <label className="ide-cam-field">
          GOP
          <input
            type="number"
            min={1}
            max={120}
            value={alarm.goptime}
            onChange={(event) => setAlarm({ ...alarm, goptime: Number(event.target.value) })}
          />
        </label>
        <Bit label="Audio" value={alarm.audio} onChange={(audio) => setAlarm({ ...alarm, audio })} />
        <Bit label="Push" value={alarm.putalarm} onChange={(putalarm) => setAlarm({ ...alarm, putalarm })} />
        <Bit label="OSD" value={alarm.osd} onChange={(osd) => setAlarm({ ...alarm, osd })} />
        <button type="button" className="btn ghost ide-mini" disabled={busy} onClick={() => void run('SetAlarmInfo', alarm)}>
          Save alarm
        </button>
      </details>
      <details>
        <summary>LED schedule</summary>
        <button type="button" className="btn ghost ide-mini" disabled={busy} onClick={() => void readLed()}>
          Read schedule
        </button>
        <Bit label="Control" value={led.control} onChange={(control) => setLed({ ...led, control })} />
        <ClockFields value={led} onChange={setLed} />
        <button type="button" className="btn ghost ide-mini" disabled={busy} onClick={() => void run('SetLedInfo', led)}>
          Save schedule
        </button>
      </details>
      <details>
        <summary>Wi-Fi</summary>
        <p className="ide-cam-sub">Joining a network takes the camera off its access point.</p>
        <button type="button" className="btn ghost ide-mini" disabled={busy} onClick={() => void scan()}>
          Scan
        </button>
        <ul className="ide-cam-nets">
          {networks.map((network) => (
            <li key={network.ssid}>
              <button type="button" className="btn ghost ide-mini" onClick={() => setSsid(network.ssid)}>
                {network.ssid}
                {typeof network.sig === 'number' ? ` (${network.sig})` : ''}
              </button>
            </li>
          ))}
        </ul>
        <label className="ide-cam-field">
          Name
          <input value={ssid} maxLength={32} autoComplete="off" onChange={(event) => setSsid(event.target.value)} />
        </label>
        <label className="ide-cam-field">
          Password
          <input
            type="password"
            value={wifiPwd}
            maxLength={64}
            autoComplete="off"
            onChange={(event) => setWifiPwd(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="btn ghost ide-mini"
          disabled={busy || !ssid}
          onClick={() => void run('OpenWifi', { sid: ssid, wifiPwd })}
        >
          Join network
        </button>
      </details>
      <details>
        <summary>Device password</summary>
        <label className="ide-cam-field">
          New password
          <input
            type="password"
            value={nextPwd}
            maxLength={64}
            autoComplete="new-password"
            onChange={(event) => setNextPwd(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="btn ghost ide-mini"
          disabled={busy || !nextPwd}
          onClick={() => void run('ModifyPwd', { newpwd: nextPwd })}
        >
          Change password
        </button>
      </details>
      <pre className="ide-cam-out">{output}</pre>
    </aside>
  );
}

function Bit({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <label className="ide-cam-field">
      {label}
      <select value={value} onChange={(event) => onChange(Number(event.target.value))}>
        <option value={0}>0</option>
        <option value={1}>1</option>
      </select>
    </label>
  );
}

function ClockFields<T extends { starttime: string; endtime: string; twotime: string; twoend: string; flag: number }>({
  value,
  onChange,
}: {
  value: T;
  onChange: (value: T) => void;
}) {
  const set = (key: 'starttime' | 'endtime' | 'twotime' | 'twoend', next: string) => onChange({ ...value, [key]: next });
  return (
    <>
      <label className="ide-cam-field">
        From
        <input value={value.starttime} onChange={(event) => set('starttime', event.target.value)} />
      </label>
      <label className="ide-cam-field">
        Until
        <input value={value.endtime} onChange={(event) => set('endtime', event.target.value)} />
      </label>
      <label className="ide-cam-field">
        Second from
        <input value={value.twotime} onChange={(event) => set('twotime', event.target.value)} />
      </label>
      <label className="ide-cam-field">
        Second until
        <input value={value.twoend} onChange={(event) => set('twoend', event.target.value)} />
      </label>
      <Bit label="Flag" value={value.flag} onChange={(flag) => onChange({ ...value, flag })} />
    </>
  );
}

function fill<T extends Record<string, string | number>>(prev: T, body: Record<string, unknown> | null | undefined): T {
  if (!body) return prev;
  const next: Record<string, string | number> = { ...prev };
  for (const key of Object.keys(prev)) {
    const value = body[key];
    if (typeof prev[key] === 'number' && typeof value === 'number') next[key] = value;
    if (typeof prev[key] === 'string' && typeof value === 'string') next[key] = value;
  }
  return next as T;
}
