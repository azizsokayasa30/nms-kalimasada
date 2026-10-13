import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { can, formatClock, formatDuration, formatLatency } from '../lib/format';
import { StatusBadge } from '../components/StatusBadge';

type Alarm = {
  id: string;
  title: string;
  severity: string;
  state: string;
  deviceId: string;
  deviceName: string;
  ipAddress: string;
  status: string;
  openedAt: string;
  recoveredAt: string | null;
  downtimeSec: number;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  downstreamCount: number;
  rootCauseName: string | null;
  lastResponse: string | null;
  latencyMs: number | null;
};

export function AlarmsPage() {
  const { user } = useAuth();
  const [active, setActive] = useState<Alarm[]>([]);
  const [history, setHistory] = useState<Alarm[]>([]);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const load = () => {
      void api<Alarm[]>('/api/alarms?state=active').then(setActive);
      void api<Alarm[]>('/api/alarms?state=history').then(setHistory);
    };
    load();
    window.addEventListener('noc-refresh', load);
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      window.removeEventListener('noc-refresh', load);
      window.clearInterval(timer);
    };
  }, []);

  async function acknowledge(id: string) {
    await api(`/api/alarms/${id}/acknowledge`, { method: 'POST' });
    window.dispatchEvent(new Event('noc-refresh'));
  }

  return (
    <>
      <AlarmTable
        title={`Alarm aktif (${active.length})`}
        empty="Tidak ada alarm aktif."
        rows={active}
        now={now}
        onAcknowledge={can(user?.role, 'noc') ? acknowledge : undefined}
      />
      <AlarmTable
        title={`Riwayat (${history.length})`}
        empty="Belum ada riwayat alarm."
        rows={history}
        now={now}
      />
    </>
  );
}

function AlarmTable({ title, empty, rows, now, onAcknowledge }: {
  title: string;
  empty: string;
  rows: Alarm[];
  now: number;
  onAcknowledge?: (id: string) => Promise<void>;
}) {
  return (
    <section className="panel">
      <header>
        <h2>{title}</h2>
      </header>
      {!rows.length ? <div className="empty">{empty}</div> : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Severity</th><th>Perangkat</th><th>IP</th><th>Status</th><th>Sejak</th><th>Durasi</th><th>Last response</th><th>Dampak</th><th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((alarm) => {
                const duration = alarm.recoveredAt
                  ? alarm.downtimeSec
                  : Math.max(0, Math.floor((now - new Date(alarm.openedAt).getTime()) / 1000));
                return (
                  <tr key={alarm.id}>
                    <td><StatusBadge status={alarm.severity} /></td>
                    <td><Link to={`/devices/${alarm.deviceId}`}>{alarm.deviceName}</Link></td>
                    <td>{alarm.ipAddress}</td>
                    <td><StatusBadge status={alarm.status} /></td>
                    <td>{formatClock(alarm.openedAt)}</td>
                    <td>{formatDuration(duration)}</td>
                    <td>{alarm.lastResponse ?? '—'}</td>
                    <td>{alarm.downstreamCount ? `${alarm.downstreamCount} downstream` : formatLatency(alarm.latencyMs)}</td>
                    <td>
                      {onAcknowledge && !alarm.recoveredAt && !alarm.acknowledgedAt ? (
                        <button className="btn" type="button" onClick={() => void onAcknowledge(alarm.id)}>Disarm</button>
                      ) : alarm.acknowledgedBy ? `Disarm ${alarm.acknowledgedBy}` : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
