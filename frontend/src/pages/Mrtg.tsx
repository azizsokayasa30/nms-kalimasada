import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { toPng } from 'html-to-image';
import { jsPDF } from 'jspdf';
import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { StatusBadge } from '../components/StatusBadge';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { can, formatBps, formatClock } from '../lib/format';

type Device = {
  id: string;
  name: string;
  ipAddress: string;
  status: string;
  location: string | null;
  groupId?: string | null;
  groupName?: string | null;
};
type Group = { id: string; name: string };
type Section = { id: string; name: string; devices: Device[] };
type MrtgStyle = {
  colorIn: string;
  colorOut: string;
  colorThreshold: string;
  colorProbe: string;
  colorLoss: string;
  thresholdPct: number;
};
type Point = { t: number; v: number };
type Stats = { min: number | null; max: number | null; avg: number | null; current: number | null; points: Point[]; billed?: number | null; threshold?: number | null };
type TrafficPoint = { t: number; in: number | null; out: number | null };
type Numbers = { min: number | null; max: number | null; avg: number | null; current: number | null };
type SavedGraph = {
  id: string;
  kind: 'probe' | 'interface';
  key: string;
  name: string;
  unit: string;
  threshold: number | null;
  points: Array<Point | TrafficPoint>;
  min?: number | null;
  max?: number | null;
  avg?: number | null;
  current?: number | null;
  inbound?: Stats;
  outbound?: Stats;
};
type Choice = { key: string; name: string; unit?: string; added: boolean };
type Graph = {
  period: string;
  from: string;
  to: string;
  device: Device;
  style: MrtgStyle;
  note: string | null;
  summary: {
    latency: Numbers & { unit: string; threshold: number | null };
    bandwidth: { unit: string; threshold: number | null; inbound: Numbers; outbound: Numbers };
  };
  graphs: SavedGraph[];
};

const presets = [
  { id: 'daily', label: 'Harian', hours: 24 },
  { id: 'weekly', label: 'Mingguan', hours: 24 * 7 },
  { id: 'monthly', label: 'Bulanan', hours: 24 * 30 },
];

export function MrtgPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [devices, setDevices] = useState<Device[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [preset, setPreset] = useState('daily');
  const [draftFrom, setDraftFrom] = useState(() => inputValue(hoursAgo(24)));
  const [draftTo, setDraftTo] = useState(() => inputValue(new Date()));
  const [applied, setApplied] = useState(() => ({ from: hoursAgo(24).toISOString(), to: new Date().toISOString() }));
  const [graph, setGraph] = useState<Graph | null>(null);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState('');
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<'probe' | 'interface'>('probe');
  const [choices, setChoices] = useState<{ probes: Choice[]; interfaces: Choice[]; snmp: 'off' | 'waiting' | 'ready' }>({ probes: [], interfaces: [], snmp: 'off' });
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    const load = () => {
      void Promise.all([
        api<{ devices: Device[] }>('/api/devices?limit=500'),
        api<{ groups: Group[] }>('/api/devices/groups').catch(() => ({ groups: [] as Group[] })),
      ]).then(([list, groupResult]) => {
        setDevices(list.devices);
        setGroups(groupResult.groups);
      });
    };
    load();
    window.addEventListener('noc-refresh', load);
    return () => window.removeEventListener('noc-refresh', load);
  }, []);

  const sections = useMemo(() => buildSections(devices, groups), [devices, groups]);

  useEffect(() => {
    const first = sections[0]?.devices[0];
    if (!id && first) navigate(`/mrtg/${first.id}`, { replace: true });
  }, [id, sections, navigate]);

  useEffect(() => {
    if (!id) return;
    const load = () => {
      setError('');
      const query = new URLSearchParams({ from: applied.from, to: applied.to });
      void api<Graph>(`/api/devices/${id}/mrtg?${query}`)
        .then((result) => setGraph(result))
        .catch((err: Error) => setError(err.message));
    };
    load();
    window.addEventListener('noc-refresh', load);
    return () => window.removeEventListener('noc-refresh', load);
  }, [id, applied]);

  useEffect(() => {
    setAdding(false);
    setSelectedKeys([]);
  }, [id]);

  function applyPreset(item: (typeof presets)[number]) {
    const to = new Date();
    const from = hoursAgo(item.hours);
    setPreset(item.id);
    setDraftFrom(inputValue(from));
    setDraftTo(inputValue(to));
    setApplied({ from: from.toISOString(), to: to.toISOString() });
  }

  function applyCustom() {
    const from = new Date(draftFrom);
    const to = new Date(draftTo);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) {
      setError('Tanggal akhir harus setelah tanggal awal');
      return;
    }
    setPreset('custom');
    setApplied({ from: from.toISOString(), to: to.toISOString() });
  }

  async function openAdd() {
    if (!id) return;
    setError('');
    const options = await api<{ probes: Choice[]; interfaces: Choice[]; snmp: 'off' | 'waiting' | 'ready' }>(`/api/devices/${id}/mrtg/options`);
    setChoices(options);
    setKind('probe');
    setSelectedKeys(firstOpenKey(options.probes));
    setAdding(true);
  }

  function showKind(next: 'probe' | 'interface') {
    setKind(next);
    setSelectedKeys(next === 'probe' ? firstOpenKey(choices.probes) : []);
  }

  function toggleKey(key: string) {
    setSelectedKeys((current) => (current.includes(key) ? current.filter((item) => item !== key) : [...current, key]));
  }

  async function addGraph() {
    if (!id || !selectedKeys.length) return;
    setError('');
    try {
      for (const key of selectedKeys) {
        await api(`/api/devices/${id}/mrtg/graphs`, {
          method: 'POST',
          body: JSON.stringify({ kind, key }),
        });
      }
      setAdding(false);
      setSelectedKeys([]);
      setApplied((current) => ({ ...current }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Graph gagal ditambahkan');
      setApplied((current) => ({ ...current }));
    }
  }

  function askRemove(item: SavedGraph) {
    setPendingDelete({ id: item.id, name: item.name });
  }

  async function exportReport(kind: 'png' | 'pdf') {
    const node = document.getElementById('mrtg-report');
    if (!node || !graph) return;
    setExporting(kind);
    setError('');
    try {
      const background = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#ffffff';
      const dataUrl = await toPng(node, { cacheBust: true, pixelRatio: 2, backgroundColor: background });
      const stamp = graph.from.slice(0, 10);
      const filename = `mrtg-${graph.device.name}-${stamp}`;
      if (kind === 'png') {
        download(dataUrl, `${filename}.png`);
      } else {
        const width = node.offsetWidth * 2;
        const height = node.offsetHeight * 2;
        const pdf = new jsPDF({
          orientation: width > height ? 'landscape' : 'portrait',
          unit: 'px',
          format: [width, height],
        });
        pdf.addImage(dataUrl, 'PNG', 0, 0, width, height);
        pdf.save(`${filename}.pdf`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export gagal');
    } finally {
      setExporting('');
    }
  }

  return (
    <div className="mrtg">
      <section className="panel mrtg-list">
        <header><h2>Perangkat</h2></header>
        {!devices.length ? <div className="empty">Belum ada perangkat.</div> : sections.map((section) => {
          const key = section.id || 'none';
          const open = !collapsed[key];
          return (
            <div key={key} className="mrtg-group">
              <button
                className="group-toggle mrtg-group-head"
                type="button"
                aria-expanded={open}
                onClick={() => setCollapsed((current) => ({ ...current, [key]: open }))}
              >
                <span>{open ? '▾' : '▸'}</span>
                {section.name}
                <span className="group-count">{section.devices.length}</span>
              </button>
              {open ? section.devices.map((device) => (
                <Link key={device.id} to={`/mrtg/${device.id}`} className={device.id === id ? 'active' : ''}>
                  <span className="mrtg-device-text" title={device.name}>
                    <strong>{device.name}</strong>
                    <small>{device.ipAddress}</small>
                  </span>
                  <StatusBadge status={device.status} />
                </Link>
              )) : null}
            </div>
          );
        })}
      </section>
      <section className="panel">
        <header>
          <div>
            <h2>{graph?.device.name ?? 'MRTG'}</h2>
            <div className="sub">{graph ? `${graph.device.ipAddress}${graph.device.location ? ` · ${graph.device.location}` : ''}` : 'Pilih perangkat'}</div>
          </div>
          <div className="toolbar">
            {can(user?.role, 'noc') ? <button className="btn" type="button" onClick={() => void openAdd()}>Tambah Graph</button> : null}
            <button className="btn-ghost" type="button" disabled={exporting !== '' || !graph} onClick={() => void exportReport('png')}>
              {exporting === 'png' ? 'Menyiapkan gambar...' : 'Export gambar'}
            </button>
            <button className="btn-ghost" type="button" disabled={exporting !== '' || !graph} onClick={() => void exportReport('pdf')}>
              {exporting === 'pdf' ? 'Menyiapkan PDF...' : 'Export PDF'}
            </button>
          </div>
        </header>
        <div className="mrtg-filters">
          {presets.map((item) => (
            <button key={item.id} className={item.id === preset ? 'btn' : 'btn-ghost'} type="button" onClick={() => applyPreset(item)}>
              {item.label}
            </button>
          ))}
          <label>
            Dari
            <input type="datetime-local" value={draftFrom} onChange={(event) => setDraftFrom(event.target.value)} />
          </label>
          <label>
            Sampai
            <input type="datetime-local" value={draftTo} onChange={(event) => setDraftTo(event.target.value)} />
          </label>
          <button className={preset === 'custom' ? 'btn' : 'btn-ghost'} type="button" onClick={applyCustom}>Terapkan</button>
        </div>
        {adding ? (
          <div className="mrtg-add">
            <div className="toolbar">
              <button className={kind === 'probe' ? 'btn' : 'btn-ghost'} type="button" onClick={() => showKind('probe')}>Probe</button>
              <button className={kind === 'interface' ? 'btn' : 'btn-ghost'} type="button" onClick={() => showKind('interface')}>Interface</button>
              <button className="btn" type="button" disabled={!selectedKeys.length} onClick={() => void addGraph()}>
                {selectedKeys.length > 1 ? `Simpan ${selectedKeys.length} graph` : 'Simpan graph'}
              </button>
              <button className="btn-ghost" type="button" onClick={() => setAdding(false)}>Batal</button>
            </div>
            <div className="mrtg-choices">
              {(kind === 'probe' ? choices.probes : choices.interfaces).map((item) => (
                <label key={item.key}>
                  <input
                    type="checkbox"
                    name="mrtg-choice"
                    value={item.key}
                    checked={selectedKeys.includes(item.key)}
                    disabled={item.added}
                    onChange={() => toggleKey(item.key)}
                  />
                  <span>{item.name}{item.unit ? ` (${item.unit})` : ''}{item.added ? ' · sudah ada' : ''}</span>
                </label>
              ))}
              {kind === 'probe' && !choices.probes.length ? <div className="sub">Belum ada probe yang bisa digrafik.</div> : null}
              {kind === 'interface' && !choices.interfaces.length ? (
                <div className="sub">
                  {choices.snmp === 'off'
                    ? 'Isi SNMP community pada perangkat agar daftar interface bisa dipilih.'
                    : 'Zabbix sedang mencari interface. Setelah SNMP menjawab, pilih interface yang ingin disadap.'}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
        {error ? <div className="error">{error}</div> : null}
        {!graph ? <div className="empty">Memuat grafik...</div> : (
          <div id="mrtg-report">
            <div className="mrtg-range">
              <strong>{graph.device.name}</strong>
              <span>· {formatRange(graph.from)} – {formatRange(graph.to)}</span>
            </div>
            {graph.note ? <div className="banner">{graph.note}</div> : null}
            {!graph.graphs.length ? <div className="empty">Belum ada graph pada perangkat ini.</div> : graph.graphs.map((item) => (
              <div className="mrtg-graph" key={item.id}>
                <div className="mrtg-legend">
                  <strong>{item.name}</strong>
                  {item.kind === 'interface' && item.inbound && item.outbound ? (
                    <>
                      <UsageLine label="Masuk" color={graph.style.colorIn} stats={item.inbound} unit={item.unit} percent={graph.style.thresholdPct} />
                      <UsageLine label="Keluar" color={graph.style.colorOut} stats={item.outbound} unit={item.unit} percent={graph.style.thresholdPct} />
                    </>
                  ) : (
                    <StatLine label="" stats={{ min: item.min ?? null, avg: item.avg ?? null, max: item.max ?? null }} unit={item.unit} threshold={item.threshold} />
                  )}
                  {can(user?.role, 'noc') ? <button className="btn-ghost" type="button" onClick={() => askRemove(item)}>Hapus</button> : null}
                </div>
                {item.kind === 'interface' ? (
                  <TrafficChart
                    points={item.points as TrafficPoint[]}
                    from={graph.from}
                    to={graph.to}
                    unit={item.unit}
                    threshold={item.threshold}
                    percent={graph.style.thresholdPct}
                    colorIn={graph.style.colorIn}
                    colorOut={graph.style.colorOut}
                    colorThreshold={graph.style.colorThreshold}
                  />
                ) : (
                  <SingleChart
                    title={item.name}
                    stats={{ min: item.min ?? null, max: item.max ?? null, avg: item.avg ?? null, current: item.current ?? null, points: item.points as Point[] }}
                    from={graph.from}
                    to={graph.to}
                    unit={item.unit}
                    color={item.key === 'loss' ? graph.style.colorLoss : graph.style.colorProbe}
                    threshold={item.threshold}
                    colorThreshold={graph.style.colorThreshold}
                  />
                )}
              </div>
            ))}
          </div>
        )}
      </section>
      {pendingDelete && id ? (
        <DeleteGraphDialog
          deviceId={id}
          graph={pendingDelete}
          onClose={() => setPendingDelete(null)}
          onDeleted={() => {
            setPendingDelete(null);
            setApplied((current) => ({ ...current }));
          }}
        />
      ) : null}
    </div>
  );
}

function DeleteGraphDialog({ deviceId, graph, onClose, onDeleted }: { deviceId: string; graph: { id: string; name: string }; onClose: () => void; onDeleted: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState(false);

  function close() {
    if (!removing) onClose();
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!password || removing) return;
    setRemoving(true);
    setError('');
    try {
      await api(`/api/devices/${deviceId}/mrtg/graphs/${graph.id}`, {
        method: 'DELETE',
        body: JSON.stringify({ password }),
      });
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Graph gagal dihapus');
      setRemoving(false);
    }
  }

  return createPortal(
    <div className="confirm-backdrop" onMouseDown={close}>
      <form
        className="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mrtg-delete-title"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => void submit(event)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') close();
        }}
      >
        <h3 id="mrtg-delete-title">Hapus graph?</h3>
        <p>
          Graph <strong>{graph.name}</strong> akan dihapus dari perangkat ini dan pengumpulan datanya dihentikan.
          Histori yang sudah terkumpul tidak lagi ditampilkan. Masukkan password akun untuk melanjutkan.
        </p>
        <label className="field">
          <span>Password akun</span>
          <input
            type="password"
            autoFocus
            autoComplete="current-password"
            spellCheck={false}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={removing}
            required
          />
        </label>
        {error ? <div className="error" role="alert">{error}</div> : null}
        <div className="confirm-actions">
          <button className="btn-ghost" type="button" onClick={close} disabled={removing}>Batal</button>
          <button className="btn-danger" type="submit" disabled={removing || !password}>
            {removing ? 'Menghapus...' : 'Hapus graph'}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

function buildSections(devices: Device[], groups: Group[]) {
  const buckets = new Map<string, Device[]>();
  const ungrouped: Device[] = [];
  for (const device of devices) {
    if (device.groupId) {
      const list = buckets.get(device.groupId) ?? [];
      list.push(device);
      buckets.set(device.groupId, list);
    } else {
      ungrouped.push(device);
    }
  }
  const sections: Section[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    seen.add(group.id);
    const list = buckets.get(group.id);
    if (list?.length) sections.push({ id: group.id, name: group.name, devices: list });
  }
  for (const [groupId, list] of buckets) {
    if (!seen.has(groupId)) sections.push({ id: groupId, name: list[0]?.groupName ?? 'Grup', devices: list });
  }
  if (ungrouped.length) sections.push({ id: '', name: 'Tanpa grup', devices: ungrouped });
  return sections;
}

function UsageLine({ label, color, stats, unit, percent }: { label: string; color?: string; stats: { min: number | null; avg: number | null; max: number | null; billed?: number | null }; unit: string; percent: number }) {
  const billed = stats.billed ?? (stats.max == null ? null : (stats.max * percent) / 100);
  return (
    <span>
      {color ? <i className="swatch" style={{ background: color }} /> : null}
      {label} Min <b>{formatMeasure(stats.min, unit)}</b>
      {' · '}Avg <b>{formatMeasure(stats.avg, unit)}</b>
      {' · '}Max 100% <b>{formatMeasure(stats.max, unit)}</b>
      {' · '}TH {percent}% <b>{formatMeasure(billed, unit)}</b>
    </span>
  );
}

function StatLine({ label, color, stats, unit, threshold }: { label: string; color?: string; stats: { min: number | null; avg: number | null; max: number | null }; unit: string; threshold: number | null }) {
  return (
    <span>
      {color ? <i className="swatch" style={{ background: color }} /> : null}
      {label ? `${label} ` : ''}
      Min <b>{formatMeasure(stats.min, unit)}</b>
      {' · '}Avg <b>{formatMeasure(stats.avg, unit)}</b>
      {' · '}Max <b>{formatMeasure(stats.max, unit)}</b>
      {' · '}Ambang <b>{formatMeasure(threshold, unit)}</b>
    </span>
  );
}

function TrafficChart({ points, from, to, unit, threshold, percent, colorIn, colorOut, colorThreshold }: { points: TrafficPoint[]; from: string; to: string; unit: string; threshold: number | null; percent: number; colorIn: string; colorOut: string; colorThreshold: string }) {
  if (!points.length) return <div className="empty">Belum ada histori pada rentang ini.</div>;
  return (
    <div style={{ height: 220 }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={points}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
          <XAxis dataKey="t" tickFormatter={(value) => axisLabel(Number(value), from, to)} stroke="var(--muted)" fontSize={11} />
          <YAxis stroke="var(--muted)" fontSize={11} width={84} tickFormatter={(value) => formatMeasure(Number(value), unit)} domain={domain(threshold)} />
          <Tooltip labelFormatter={(value) => formatClock(new Date(Number(value)).toISOString())} formatter={(value, name) => [formatMeasure(Number(value), unit), name]} />
          {threshold != null ? <ReferenceLine y={threshold} stroke={colorThreshold} strokeDasharray="4 4" label={`TH ${percent}%`} /> : null}
          <Area type="linear" dataKey="in" name="Masuk" stroke={colorIn} fill={colorIn} fillOpacity={0.28} strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
          <Line type="linear" dataKey="out" name="Keluar" stroke={colorOut} dot={false} strokeWidth={2} connectNulls isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function SingleChart({ title, stats, from, to, unit, color, threshold, colorThreshold }: { title: string; stats: Stats; from: string; to: string; unit: string; color: string; threshold: number | null; colorThreshold: string }) {
  return (
    <div>
      {!stats.points.length ? <div className="empty">Belum ada histori pada rentang ini.</div> : (
        <div style={{ height: 200 }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={stats.points}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
              <XAxis dataKey="t" tickFormatter={(value) => axisLabel(Number(value), from, to)} stroke="var(--muted)" fontSize={11} />
              <YAxis stroke="var(--muted)" fontSize={11} width={48} domain={domain(threshold)} />
              <Tooltip labelFormatter={(value) => formatClock(new Date(Number(value)).toISOString())} formatter={(value) => [formatMeasure(Number(value), unit), title]} />
              {threshold != null ? <ReferenceLine y={threshold} stroke={colorThreshold} strokeDasharray="4 4" /> : null}
              <Area type="monotone" dataKey="v" stroke={color} fill={color} fillOpacity={0.25} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

function domain(threshold: number | null): [number, (dataMax: number) => number] {
  return [0, (dataMax) => Math.max(dataMax || 0, threshold ?? 0)];
}

function axisLabel(value: number, from: string, to: string) {
  const date = new Date(value);
  const span = new Date(to).getTime() - new Date(from).getTime();
  if (span <= 24 * 60 * 60 * 1000) return date.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  return date.toLocaleDateString('id-ID', { day: '2-digit', month: 'short' });
}

function formatMeasure(value: number | null, unit: string) {
  if (value == null || Number.isNaN(value)) return '—';
  if (unit === 'bps' || unit === 'Bps' || unit === 'bit/s') return formatBps(value);
  if (unit === '%') return `${value.toFixed(1)}%`;
  if (unit === 'ms') return `${Math.round(value)} ms`;
  return `${value.toFixed(1)} ${unit}`;
}

function formatRange(value: string) {
  return new Date(value).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function firstOpenKey(items: Choice[]) {
  const key = items.find((item) => !item.added)?.key;
  return key ? [key] : [];
}

function hoursAgo(hours: number) {
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}

function inputValue(date: Date) {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function download(href: string, name: string) {
  const link = document.createElement('a');
  link.href = href;
  link.download = name;
  link.click();
}
