import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { can } from '../../lib/format';
import { AddressesView } from './AddressesView';
import { InterfacesView } from './InterfacesView';
import { applyChange, type NetSnapshot, type TestRequest } from './model';
import { TestPanel, Toggle } from './parts';
import { RoutesView } from './RoutesView';
import { VlansView } from './VlansView';
import { VpnView } from './VpnView';

const views = [
  { id: 'interface', label: 'Interface' },
  { id: 'ip', label: 'IP Address' },
  { id: 'vlan', label: 'VLAN' },
  { id: 'route', label: 'Route' },
  { id: 'vpn', label: 'VPN' },
] as const;

type ViewId = (typeof views)[number]['id'];

export function NetworkTab() {
  const { user } = useAuth();
  const editor = can(user?.role, 'super_admin');
  const [data, setData] = useState<NetSnapshot | null>(null);
  const [view, setView] = useState<ViewId>('interface');
  const [test, setTest] = useState<TestRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; tone: 'ok' | 'warn' | 'bad' } | null>(null);
  const [loadError, setLoadError] = useState('');

  const load = useCallback(() => {
    void api<NetSnapshot>('/api/network')
      .then((value) => {
        setData(value);
        setLoadError('');
      })
      .catch((err: Error) => setLoadError(err.message));
  }, []);

  useEffect(() => {
    load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [load]);

  async function run(path: string, method: string, body?: unknown) {
    setBusy(true);
    setNotice(null);
    try {
      const result = await applyChange(path, method, body);
      const warnings = result.warnings ?? [];
      setNotice({
        text: [result.summary ? `${result.summary} — diterapkan` : 'Diterapkan', ...warnings].join('. '),
        tone: warnings.length ? 'warn' : 'ok',
      });
      load();
      return true;
    } catch (err) {
      setNotice({ text: err instanceof Error ? err.message : 'Gagal', tone: 'bad' });
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (!data) {
    return <div className="empty">{loadError || 'Memuat…'}</div>;
  }

  const physical = data.interfaces.filter((item) => item.kind === 'ethernet' || item.kind === 'vlan');
  const vpnUp = data.vpns.filter((row) => row.status.state === 'up').length;
  const vpnOn = data.vpns.filter((row) => row.enabled).length;
  const routeWait = data.routes.filter((row) => row.enabled && !row.active).length;
  const counts: Record<ViewId, number> = {
    interface: data.interfaces.length,
    ip: data.addresses.length,
    vlan: data.vlans.length,
    route: data.routes.length,
    vpn: data.vpns.length,
  };
  const props = { data, editor, busy, run, onTest: setTest };

  return (
    <div className="net">
      <div className="net-summary">
        <div className="net-stat">
          <span>Uplink</span>
          <strong>{data.management.iface ?? '—'}</strong>
          <small>{data.management.address ?? ''}{data.management.gateway ? ` → ${data.management.gateway}` : ''}</small>
        </div>
        <div className={`net-stat ${physical.some((item) => item.state === 'down') ? 'bad' : 'ok'}`}>
          <span>Interface aktif</span>
          <strong>{physical.filter((item) => item.state === 'up').length}/{physical.length}</strong>
          <small>{data.vlans.length} VLAN</small>
        </div>
        <div className={`net-stat ${vpnOn && vpnUp < vpnOn ? 'warn' : vpnOn ? 'ok' : ''}`}>
          <span>VPN terhubung</span>
          <strong>{vpnUp}/{vpnOn}</strong>
          <small>{data.vpns.length - vpnOn ? `${data.vpns.length - vpnOn} nonaktif` : ' '}</small>
        </div>
        <div className={`net-stat ${routeWait ? 'warn' : data.routes.length ? 'ok' : ''}`}>
          <span>Rute statis</span>
          <strong>{data.routes.length - routeWait}/{data.routes.length}</strong>
          <small>{routeWait ? `${routeWait} menunggu` : ' '}</small>
        </div>
        <div className="net-stat">
          <span>Routing L3</span>
          <div className="net-stat-row">
            <Toggle on={data.forwarding} disabled={!editor || busy} label="Routing antar interface" onChange={(next) => void run('/api/network/forwarding', 'POST', { enabled: next })} />
            <strong>{data.forwarding ? 'ON' : 'OFF'}</strong>
          </div>
          <small>antar interface</small>
        </div>
      </div>

      <div className="chip-tabs">
        {views.map((item) => (
          <button key={item.id} type="button" className={view === item.id ? 'on' : ''} onClick={() => setView(item.id)}>
            {item.label} <span className="net-count">{counts[item.id]}</span>
          </button>
        ))}
        <button type="button" className="net-test-open" onClick={() => setTest({ target: data.management.gateway ?? '', iface: '' })}>Tes koneksi</button>
      </div>

      {notice ? (
        <div className={`net-notice ${notice.tone}`} role="status">
          <span>{notice.text}</span>
          <button type="button" aria-label="Tutup" onClick={() => setNotice(null)}>✕</button>
        </div>
      ) : null}
      {test ? <TestPanel request={test} interfaces={data.interfaces} onClose={() => setTest(null)} /> : null}
      {!editor ? <div className="note">Mode lihat. Perubahan hanya oleh Super Admin.</div> : null}

      <div className="net-body">
        {view === 'interface' ? <InterfacesView data={data} onTest={setTest} /> : null}
        {view === 'ip' ? <AddressesView {...props} /> : null}
        {view === 'vlan' ? <VlansView {...props} /> : null}
        {view === 'route' ? <RoutesView {...props} /> : null}
        {view === 'vpn' ? <VpnView {...props} onMessage={(text) => setNotice({ text, tone: 'ok' })} /> : null}
      </div>
    </div>
  );
}
