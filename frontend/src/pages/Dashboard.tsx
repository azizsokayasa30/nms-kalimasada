import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { can, deviceTypeLabels, formatBps, formatClock, formatLatency, formatPercent } from '../lib/format';
import { StatusBadge } from '../components/StatusBadge';

type Summary = {
  total: number;
  up: number;
  down: number;
  warning: number;
  unknown: number;
  flapping: number;
  unreachable: number;
  rxBps: number | null;
  txBps: number | null;
  activeAlarms: number;
  downstream: number;
  latencyMs: number | null;
  packetLoss: number | null;
  uptimePct: number | null;
  problems: Array<{
    id: string;
    deviceId: string;
    name: string;
    ipAddress: string;
    status: string;
    severity?: string;
    downSince: string;
    lastResponse: string | null;
    latencyMs: number | null;
  }>;
};

type Health = { zabbix: string; zabbixError: string | null };

type Internet = {
  checkedAt: string | null;
  intervalSec: number;
  maxTargets?: number;
  targets: Array<{
    id: string;
    name: string;
    host: string;
    latencyMs: number | null;
    loss: number | null;
    history: Array<number | null>;
  }>;
};

const siteColors: Array<[string, string]> = [
  ['youtube', '#ff0000'],
  ['google', '#4285f4'],
  ['facebook', '#1877f2'],
  ['instagram', '#e1306c'],
  ['whatsapp', '#25d366'],
  ['tiktok', '#111827'],
  ['netflix', '#e50914'],
  ['1.1.1.1', '#f38020'],
  ['cloudflare', '#f38020'],
  ['twitter', '#111827'],
  ['x.com', '#111827'],
  ['shopee', '#ee4d2d'],
  ['tokopedia', '#03ac0e'],
  ['8.8.', '#4285f4'],
];

const fallbackColors = ['#1d5fe0', '#7c4dff', '#14b8a6', '#f97316', '#db2777', '#0891b2'];

function siteColor(host: string) {
  const known = siteColors.find(([keyword]) => host.includes(keyword));
  if (known) return known[1];
  const hash = [...host].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return fallbackColors[hash % fallbackColors.length];
}

type Device = {
  id: string;
  name: string;
  ipAddress: string;
  deviceType: string;
  location: string | null;
  status: string;
  latencyMs: number | null;
  lastSeenAt: string | null;
};

const typeColors: Record<string, string> = {
  mikrotik_router: '#1d5fe0',
  mikrotik_switch: '#22c55e',
  huawei_olt: '#8b5cf6',
  switch: '#14b8a6',
  access_point: '#f5b400',
  server: '#475569',
  customer_router: '#f97316',
  other: '#94a3b8',
};

const statusRank: Record<string, number> = { down: 0, unreachable: 1, flapping: 2, warning: 3, unknown: 4, up: 5 };

const STATUS_ROWS = 8;

export function DashboardPage() {
  const [data, setData] = useState<Summary | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [internet, setInternet] = useState<Internet | null>(null);
  const [deviceTotal, setDeviceTotal] = useState(0);
  const [typeFilter, setTypeFilter] = useState('all');
  const [now, setNow] = useState(() => new Date());
  const [slot, setSlot] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setSlot(document.getElementById('topbar-slot'));
  }, []);

  useEffect(() => {
    const load = () => {
      void api<Summary>('/api/dashboard').then(setData).catch(() => undefined);
      void api<Health>('/api/health').then(setHealth).catch(() => undefined);
      void api<Internet>('/api/internet').then(setInternet).catch(() => undefined);
      void api<{ devices: Device[]; total: number }>('/api/devices?limit=500')
        .then((list) => {
          setDevices(list.devices);
          setDeviceTotal(list.total);
        })
        .catch(() => undefined);
    };
    load();
    window.addEventListener('noc-refresh', load);
    return () => {
      window.removeEventListener('noc-refresh', load);
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const types = useMemo(() => {
    const counts = new Map<string, number>();
    for (const device of devices ?? []) counts.set(device.deviceType, (counts.get(device.deviceType) ?? 0) + 1);
    return [...counts.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count);
  }, [devices]);

  const statusRows = useMemo(() => {
    const rows = (devices ?? []).filter((device) => typeFilter === 'all' || device.deviceType === typeFilter);
    return rows
      .slice()
      .sort((a, b) => (statusRank[a.status] ?? 9) - (statusRank[b.status] ?? 9) || a.name.localeCompare(b.name));
  }, [devices, typeFilter]);

  const total = data?.total ?? 0;
  const share = (value?: number) => (data && total ? (value ?? 0) / total * 100 : null);
  const otherCount = data ? data.unknown + data.flapping + data.unreachable : 0;
  const healthParts = data
    ? [
        { label: 'Online', value: data.up, color: 'var(--up)' },
        { label: 'Warning', value: data.warning, color: 'var(--warn)' },
        { label: 'Offline', value: data.down, color: 'var(--down)' },
        { label: 'Lainnya', value: otherCount, color: 'var(--unknown)' },
      ]
    : [];
  const typeParts = types.map((item) => ({
    label: deviceTypeLabels[item.type] ?? item.type,
    value: item.count,
    color: typeColors[item.type] ?? typeColors.other,
  }));
  const hasBandwidth = data?.rxBps != null || data?.txBps != null;
  const zabbixDown = health?.zabbix === 'down';

  return (
    <>
      {slot ? createPortal(
        <div className="page-meta">
          <span className="clock">
            <CalendarIcon />
            {now.toLocaleDateString('id-ID', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })}
            <b>{now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</b>
          </span>
          <span className={zabbixDown ? 'live-pill off' : 'live-pill'}>
            <i />
            {zabbixDown ? 'Zabbix terputus' : 'Live Monitoring'}
          </span>
        </div>,
        slot,
      ) : null}
      {zabbixDown ? (
        <div className="banner">
          Zabbix belum terhubung. Perangkat tetap tersimpan, ping dimulai setelah engine Zabbix jalan.
          {health?.zabbixError ? ` (${health.zabbixError})` : ''}
        </div>
      ) : null}
      <div className="kpis">
        <Kpi
          tone="info"
          icon={<ServerIcon />}
          label="Total Devices"
          value={data?.total ?? '—'}
          foot={data ? `${data.unknown} unknown` : undefined}
        />
        <Kpi tone="up" icon={<WifiIcon />} label="Online Devices" value={data?.up ?? '—'} percent={share(data?.up)} />
        <Kpi tone="down" icon={<AlertIcon />} label="Offline Devices" value={data?.down ?? '—'} percent={share(data?.down)} />
        <Kpi tone="warn" icon={<WarnIcon />} label="Warning" value={data?.warning ?? '—'} percent={share(data?.warning)} />
        <Kpi
          tone="down"
          icon={<BellIcon />}
          label="Active Alarm"
          value={data?.activeAlarms ?? '—'}
          live={(data?.down ?? 0) > 0}
          foot={data ? (data.downstream ? `${data.downstream} perangkat di bawahnya tidak terjangkau` : 'Tidak ada induk yang memutus anak') : undefined}
        />
        {hasBandwidth ? (
          <Kpi
            tone="info"
            icon={<ChartIcon />}
            label="Total RX / TX"
            value={formatBps(data?.rxBps)}
            foot={`TX ${formatBps(data?.txBps)}`}
          />
        ) : null}
        <Kpi tone="purple" icon={<GaugeIcon />} label="Average Latency" value={formatLatency(data?.latencyMs)} />
        <Kpi tone="warn" icon={<LossIcon />} label="Packet Loss" value={formatPercent(data?.packetLoss)} />
        <Kpi tone="up" icon={<ShieldIcon />} label="Uptime" value={formatPercent(data?.uptimePct)} percent={data?.uptimePct ?? null} />
      </div>

      <div className="dash-row three">
        <section className="panel">
          <header>
            <h2><PulseIcon /> Network Health Overview</h2>
          </header>
          <div className="donut-body">
            <Donut parts={healthParts} total={total} label="Devices" />
            <Legend parts={healthParts} total={total} />
          </div>
        </section>
        <section className="panel">
          <header>
            <h2><PieIcon /> Device Distribution</h2>
            <Link to="/devices">Semua device</Link>
          </header>
          {!types.length ? (
            <div className="empty">{devices ? 'Belum ada perangkat.' : 'Memuat...'}</div>
          ) : (
            <div className="donut-body">
              <Donut parts={typeParts} total={devices?.length ?? 0} label="Devices" />
              <Legend parts={typeParts} total={devices?.length ?? 0} />
            </div>
          )}
        </section>
        <InternetPanel data={internet} onSaved={setInternet} />
      </div>

      <div className="dash-row wide-left">
        <section className="panel">
          <header>
            <h2><ServerIcon /> Device Status</h2>
            <Link to="/devices">Lihat semua</Link>
          </header>
          {types.length ? (
            <div className="chip-tabs" role="tablist">
              <button type="button" role="tab" aria-selected={typeFilter === 'all'} className={typeFilter === 'all' ? 'on' : ''} onClick={() => setTypeFilter('all')}>
                Semua ({devices?.length ?? 0})
              </button>
              {types.map((item) => (
                <button
                  key={item.type}
                  type="button"
                  role="tab"
                  aria-selected={typeFilter === item.type}
                  className={typeFilter === item.type ? 'on' : ''}
                  onClick={() => setTypeFilter(item.type)}
                >
                  {deviceTypeLabels[item.type] ?? item.type} ({item.count})
                </button>
              ))}
            </div>
          ) : null}
          {!statusRows.length ? (
            <div className="empty">{devices ? 'Belum ada perangkat.' : 'Memuat...'}</div>
          ) : (
            <div className="table-wrap">
              <table className="dash-table">
                <thead>
                  <tr>
                    <th>Status</th><th>Device</th><th>IP</th><th>Tipe</th><th>Lokasi</th><th>Latency</th><th>Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {statusRows.slice(0, STATUS_ROWS).map((device) => (
                    <tr key={device.id}>
                      <td><span className={`dot ${device.status}`} title={device.status.toUpperCase()} /></td>
                      <td className="strong"><Link to={`/devices/${device.id}`}>{device.name}</Link></td>
                      <td>{device.ipAddress}</td>
                      <td>
                        <span className="type-tag">
                          <i style={{ background: typeColors[device.deviceType] ?? typeColors.other }} />
                          {deviceTypeLabels[device.deviceType] ?? device.deviceType}
                        </span>
                      </td>
                      <td>{device.location ?? '—'}</td>
                      <td>{formatLatency(device.latencyMs)}</td>
                      <td className="muted">{timeAgo(device.lastSeenAt, now)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {statusRows.length > STATUS_ROWS || deviceTotal > (devices?.length ?? 0) ? (
            <div className="panel-foot">
              Menampilkan {Math.min(STATUS_ROWS, statusRows.length)} dari {typeFilter === 'all' ? deviceTotal : statusRows.length} perangkat ·{' '}
              <Link to="/devices">buka halaman Devices</Link>
            </div>
          ) : null}
        </section>

        <section className="panel">
          <header>
            <h2 className="alert-title"><BellIcon /> Recent Problems</h2>
            <Link className="btn-ghost btn-sm" to="/alarms">Semua alarm</Link>
          </header>
          {!data?.problems.length ? (
            <div className="empty">Tidak ada masalah aktif.</div>
          ) : (
            <div className="table-wrap">
              <table className="dash-table">
                <thead>
                  <tr>
                    <th>Down since</th><th>Status</th><th>Device</th><th>Last ping</th><th>Latency</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {data.problems.map((row) => (
                    <tr key={row.id} className={`problem ${row.severity ?? row.status}`}>
                      <td>{formatClock(row.downSince)}</td>
                      <td><StatusBadge status={row.status} /></td>
                      <td className="strong">
                        {row.name}
                        <small>{row.ipAddress}</small>
                      </td>
                      <td>{row.lastResponse ?? '—'}</td>
                      <td>{formatLatency(row.latencyMs)}</td>
                      <td><Link className="row-link" to={`/devices/${row.deviceId}`}>Detail</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </>
  );
}

function Kpi({ tone, icon, label, value, foot, percent, live }: {
  tone: string;
  icon: ReactNode;
  label: string;
  value: string | number;
  foot?: string;
  percent?: number | null;
  live?: boolean;
}) {
  return (
    <article className={`kpi tone-${tone}${live ? ' live' : ''}`}>
      <span className="kpi-icon">{icon}</span>
      <div className="kpi-text">
        <div className="kpi-label">{label}</div>
        <div className="kpi-value">{value}</div>
      </div>
      {percent != null ? (
        <div className="kpi-foot">
          <div className="kpi-bar"><i style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} /></div>
          <span>{formatPercent(percent)}</span>
        </div>
      ) : foot ? (
        <div className="kpi-foot"><span>{foot}</span></div>
      ) : null}
    </article>
  );
}

function InternetPanel({ data, onSaved }: { data: Internet | null; onSaved: (value: Internet) => void }) {
  const { user } = useAuth();
  const canEdit = can(user?.role, 'admin');
  const [draft, setDraft] = useState<Array<{ name: string; host: string }> | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const targets = data?.targets ?? [];
  const reachable = targets.filter((target) => target.latencyMs != null && (target.loss ?? 100) < 100).length;
  const checked = Boolean(data?.checkedAt);
  const maxTargets = data?.maxTargets ?? 12;

  async function save() {
    if (!draft) return;
    setSaving(true);
    setError('');
    try {
      const rows = draft.filter((row) => row.host.trim());
      const next = await api<Internet>('/api/internet/targets', { method: 'PUT', body: JSON.stringify({ targets: rows }) });
      onSaved(next);
      setDraft(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal menyimpan');
    } finally {
      setSaving(false);
    }
  }

  const update = (index: number, field: 'name' | 'host', value: string) =>
    setDraft((current) => current?.map((row, at) => (at === index ? { ...row, [field]: value } : row)) ?? null);

  return (
    <section className="panel">
      <header>
        <h2><GlobeIcon /> Internet Monitoring</h2>
        <div className="toolbar">
          {checked && !draft && targets.length ? (
            <span className={`inet-summary ${reachable === targets.length ? 'up' : reachable ? 'warn' : 'down'}`}>
              {reachable}/{targets.length} terjangkau
            </span>
          ) : null}
          {canEdit && !draft ? (
            <button
              className="btn-ghost btn-sm"
              type="button"
              onClick={() => {
                setError('');
                setDraft(targets.map((target) => ({ name: target.name, host: target.host })));
              }}
            >
              Kelola
            </button>
          ) : null}
        </div>
      </header>
      {draft ? (
        <div className="inet-edit">
          {draft.map((row, index) => (
            <div className="inet-edit-row" key={index}>
              <input value={row.name} placeholder="Nama" aria-label={`Nama situs ${index + 1}`} onChange={(event) => update(index, 'name', event.target.value)} />
              <input value={row.host} placeholder="domain.com / IP" aria-label={`Host situs ${index + 1}`} onChange={(event) => update(index, 'host', event.target.value)} />
              <button
                className="btn-danger btn-sm"
                type="button"
                aria-label={`Hapus situs ${index + 1}`}
                onClick={() => setDraft((current) => current?.filter((_, at) => at !== index) ?? null)}
              >
                ×
              </button>
            </div>
          ))}
          {!draft.length ? <div className="sub">Belum ada situs. Tambahkan minimal satu.</div> : null}
          <div className="toolbar">
            <button
              className="btn-ghost btn-sm"
              type="button"
              disabled={draft.length >= maxTargets}
              onClick={() => setDraft((current) => [...(current ?? []), { name: '', host: '' }])}
            >
              + Tambah situs
            </button>
            <span className="sub">{draft.length}/{maxTargets}</span>
            <span style={{ flex: 1 }} />
            <button className="btn-ghost btn-sm" type="button" disabled={saving} onClick={() => setDraft(null)}>Batal</button>
            <button className="btn btn-sm" type="button" disabled={saving} onClick={() => void save()}>
              {saving ? 'Menyimpan...' : 'Simpan'}
            </button>
          </div>
          {error ? <div className="error" style={{ padding: 0 }}>{error}</div> : null}
        </div>
      ) : !targets.length ? (
        <div className="empty">Belum ada situs yang dipantau.{canEdit ? ' Klik Kelola untuk menambahkan.' : ''}</div>
      ) : !checked ? (
        <div className="empty">{data ? 'Menunggu ping pertama...' : 'Memuat...'}</div>
      ) : (
        <ul className="inet-list">
          {targets.map((target) => {
            const down = target.latencyMs == null || (target.loss ?? 100) >= 100;
            const tone = down ? 'down' : (target.latencyMs ?? 0) >= 150 || (target.loss ?? 0) > 0 ? 'warn' : 'up';
            return (
              <li key={target.id} className={`inet ${tone}`}>
                <span className="inet-logo" style={{ background: siteColor(target.host) }}>{(target.name[0] ?? '?').toUpperCase()}</span>
                <div className="inet-name">
                  <strong>{target.name}</strong>
                  <small>{target.host}</small>
                </div>
                <Sparkline values={target.history} />
                <div className="inet-ms">
                  <b>{down ? 'Timeout' : formatLatency(target.latencyMs)}</b>
                  <small>loss {target.loss ?? 100}%</small>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {checked && !draft && targets.length ? (
        <div className="panel-foot">
          Ping dari server tiap {data?.intervalSec ?? 30} detik · terakhir {formatClock(data?.checkedAt)}
        </div>
      ) : null}
    </section>
  );
}

function Sparkline({ values }: { values: Array<number | null> }) {
  const width = 72;
  const height = 24;
  const numbers = values.filter((value): value is number => value != null);
  if (numbers.length < 2) return <span className="sparkline" />;
  const min = Math.min(...numbers);
  const max = Math.max(...numbers);
  const span = max - min || 1;
  const step = width / Math.max(1, values.length - 1);
  const points = values
    .map((value, index) => (value == null ? null : `${(index * step).toFixed(1)},${(height - 2 - ((value - min) / span) * (height - 4)).toFixed(1)}`))
    .filter(Boolean)
    .join(' ');
  return (
    <svg className="sparkline" viewBox={`0 0 ${width} ${height}`} width={width} height={height} aria-hidden="true">
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

type Part = { label: string; value: number; color: string };

function Donut({ parts, total, label }: { parts: Part[]; total: number; label: string }) {
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  const visible = parts.filter((part) => part.value > 0);
  const segments = visible.map((part, index) => {
    const before = visible.slice(0, index).reduce((sum, item) => sum + item.value, 0);
    return {
      ...part,
      length: total ? (part.value / total) * circumference : 0,
      offset: total ? (before / total) * circumference : 0,
    };
  });
  return (
    <div className="donut">
      <svg viewBox="0 0 140 140" aria-hidden="true">
        <circle className="donut-track" cx="70" cy="70" r={radius} />
        {segments.map((segment) => (
          <circle
            key={segment.label}
            cx="70"
            cy="70"
            r={radius}
            style={{ stroke: segment.color }}
            strokeDasharray={`${segment.length} ${circumference - segment.length}`}
            strokeDashoffset={-segment.offset}
          />
        ))}
      </svg>
      <div className="donut-center">
        <strong>{total}</strong>
        <span>{label}</span>
      </div>
    </div>
  );
}

function Legend({ parts, total }: { parts: Part[]; total: number }) {
  return (
    <ul className="legend">
      {parts.map((part) => (
        <li key={part.label}>
          <i style={{ background: part.color }} />
          <span>{part.label}</span>
          <b>{part.value}</b>
          <em>{total ? formatPercent((part.value / total) * 100) : '—'}</em>
        </li>
      ))}
    </ul>
  );
}

function timeAgo(value: string | null, now: Date) {
  if (!value) return '—';
  const seconds = Math.max(0, Math.floor((now.getTime() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return `${seconds} dtk lalu`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} mnt lalu`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} jam lalu`;
  return `${Math.floor(seconds / 86400)} hari lalu`;
}

function Svg({ children, size = 22 }: { children: ReactNode; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

function ServerIcon() {
  return <Svg><rect x="3" y="4" width="18" height="6" rx="1.5" /><rect x="3" y="14" width="18" height="6" rx="1.5" /><path d="M7 7h.01M7 17h.01" /></Svg>;
}

function WifiIcon() {
  return <Svg><path d="M2 8.8a15 15 0 0 1 20 0M5 12.5a10 10 0 0 1 14 0M8.5 16.1a5 5 0 0 1 7 0" /><path d="M12 20h.01" /></Svg>;
}

function AlertIcon() {
  return <Svg><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5.5M12 16.5h.01" /></Svg>;
}

function WarnIcon() {
  return <Svg><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 9v4M12 17h.01" /></Svg>;
}

function BellIcon() {
  return <Svg size={20}><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></Svg>;
}

function ChartIcon() {
  return <Svg><path d="M3 3v18h18" /><path d="m7 15 4-5 3 3 5-6" /></Svg>;
}

function GaugeIcon() {
  return <Svg><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Svg>;
}

function LossIcon() {
  return <Svg><path d="M4 12h4l2-5 4 10 2-5h4" /></Svg>;
}

function ShieldIcon() {
  return <Svg><path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3z" /><path d="m9 12 2 2 4-4" /></Svg>;
}

function PulseIcon() {
  return <Svg size={20}><path d="M3 12h4l3-8 4 16 3-8h4" /></Svg>;
}

function PieIcon() {
  return <Svg size={20}><path d="M21 12A9 9 0 1 1 12 3v9z" /><path d="M15 3.5A9 9 0 0 1 20.5 9H15z" /></Svg>;
}

function GlobeIcon() {
  return <Svg size={20}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></Svg>;
}

function CalendarIcon() {
  return <Svg size={16}><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 10h18" /></Svg>;
}
