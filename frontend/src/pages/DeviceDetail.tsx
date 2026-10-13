import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { can, connectionLabels, deviceTypeLabels, formatClock, formatDuration, formatLatency, formatPercent, methodLabels } from '../lib/format';
import { StatusBadge } from '../components/StatusBadge';

type Device = {
  id: string;
  name: string;
  ipAddress: string;
  deviceType: string;
  location: string | null;
  groupName: string | null;
  monitorMethod: string;
  status: string;
  latencyMs: number | null;
  packetLoss: number | null;
  lastSeenAt: string | null;
  downSince: string | null;
  downtimeSec: number;
  lastResponse: string | null;
  maintenance: boolean;
  zabbixLinked: boolean;
  events: Array<{ id: string; type: string; message: string; createdAt: string }>;
};

type Metrics = { latency: Array<{ t: number; v: number }>; loss: Array<{ t: number; v: number }>; note?: string };

const ranges = ['5m', '1h', '24h', '7d', '30d'];

export function DeviceDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [device, setDevice] = useState<Device | null>(null);
  const [metrics, setMetrics] = useState<Metrics>({ latency: [], loss: [] });
  const [range, setRange] = useState('1h');

  useEffect(() => {
    if (!id) return;
    const load = () => {
      void api<Device>(`/api/devices/${id}`).then(setDevice);
      void api<Metrics>(`/api/devices/${id}/metrics?range=${range}`).then(setMetrics);
    };
    load();
    window.addEventListener('noc-refresh', load);
    return () => window.removeEventListener('noc-refresh', load);
  }, [id, range]);

  async function remove() {
    if (!id || !window.confirm('Hapus perangkat ini?')) return;
    await api(`/api/devices/${id}`, { method: 'DELETE' });
    navigate('/devices');
  }

  if (!device) return <div className="empty">Memuat perangkat...</div>;

  return (
    <>
      <section className="panel">
        <header>
          <div>
            <h2>{device.name}</h2>
            <div className="sub">{device.ipAddress} · {deviceTypeLabels[device.deviceType]} · {methodLabels[device.monitorMethod] ?? connectionLabels[device.monitorMethod] ?? device.monitorMethod} · {device.groupName ?? 'Tanpa grup'} · {device.location ?? 'Tanpa lokasi'}</div>
          </div>
          <div className="toolbar">
            <StatusBadge status={device.status} />
            {can(user?.role, 'admin') ? <Link className="btn-ghost" to={`/devices/${device.id}/edit`}>Ubah</Link> : null}
            {can(user?.role, 'admin') ? <button className="btn-danger" type="button" onClick={() => void remove()}>Hapus</button> : null}
          </div>
        </header>
        <div className="statrow">
          <div><span>Latency</span><strong>{formatLatency(device.latencyMs)}</strong></div>
          <div><span>Packet loss</span><strong>{formatPercent(device.packetLoss)}</strong></div>
          <div><span>Last ping</span><strong>{device.lastResponse ?? '—'}</strong></div>
          <div><span>Last seen</span><strong>{formatClock(device.lastSeenAt)}</strong></div>
          <div><span>Down since</span><strong>{formatClock(device.downSince)}</strong></div>
          <div><span>Downtime</span><strong>{device.downSince || device.downtimeSec ? formatDuration(device.downtimeSec) : '—'}</strong></div>
          <div><span>Maintenance</span><strong>{device.maintenance ? 'Ya' : 'Tidak'}</strong></div>
          <div><span>Zabbix</span><strong>{device.zabbixLinked ? 'Terhubung' : 'Menunggu'}</strong></div>
        </div>
      </section>
      <section className="panel">
        <header>
          <h2>Grafik</h2>
          <div className="toolbar">
            {ranges.map((item) => (
              <button key={item} className={item === range ? 'btn' : 'btn-ghost'} type="button" onClick={() => setRange(item)}>{item}</button>
            ))}
          </div>
        </header>
        {metrics.note && !metrics.latency.length ? <div className="empty">{metrics.note}</div> : null}
        <div className="charts">
          <Chart title="Latency (ms)" data={metrics.latency} color="#1d4e89" />
          <Chart title="Packet loss (%)" data={metrics.loss} color="#b45309" />
        </div>
      </section>
      <section className="panel">
        <header><h2>Timeline</h2></header>
        {!device.events.length ? <div className="empty">Belum ada kejadian.</div> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Waktu</th><th>Kejadian</th></tr></thead>
              <tbody>
                {device.events.map((event) => (
                  <tr key={event.id}><td>{formatClock(event.createdAt)}</td><td>{event.message}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function Chart({ title, data, color }: { title: string; data: Array<{ t: number; v: number }>; color: string }) {
  return (
    <div style={{ height: 220 }}>
      <div className="sub" style={{ padding: '0 8px' }}>{title}</div>
      <ResponsiveContainer width="100%" height="90%">
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
          <XAxis dataKey="t" tickFormatter={(value) => formatClock(new Date(value).toISOString())} stroke="var(--muted)" fontSize={11} />
          <YAxis stroke="var(--muted)" fontSize={11} width={40} />
          <Tooltip labelFormatter={(value) => formatClock(new Date(Number(value)).toISOString())} />
          <Line type="monotone" dataKey="v" stroke={color} dot={false} strokeWidth={2} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
