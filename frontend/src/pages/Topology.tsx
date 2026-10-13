import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {
  Background,
  ControlButton,
  Controls,
  Handle,
  Position,
  ReactFlow,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { io } from 'socket.io-client';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { readRefreshSeconds } from '../lib/display';
import { can, deviceTypeLabels, formatBps, formatLatency } from '../lib/format';

type Device = {
  id: string;
  name: string;
  ipAddress: string;
  deviceType: string;
  status: string;
  latencyMs: number | null;
  parentId: string | null;
  posX: number | null;
  posY: number | null;
  location: string | null;
};

type Traffic = { down: number | null; up: number | null; at: number | null };

type Link = {
  id: string;
  sourceId: string;
  targetId: string;
  interfaceDeviceId: string | null;
  interfaceKey: string | null;
  interfaceName: string | null;
  traffic: Traffic | null;
};

type PortSide = { id: string; name: string; snmp: 'off' | 'waiting' | 'ready'; interfaces: Array<{ key: string; name: string }> };

function DeviceNode({ data }: NodeProps) {
  const status = String(data.status ?? 'unknown');
  return (
    <div className={`node ${status}`}>
      <Handle type="target" position={Position.Top} />
      <strong>{String(data.name)}</strong>
      <small>{String(data.ip)}</small>
      <small>{String(data.kind)} · {String(data.latency)}</small>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

const nodeTypes = { device: DeviceNode };

let topologyScreen: Window | null = null;

function openTopologyScreen(location: string) {
  const query = location ? `?lokasi=${encodeURIComponent(location)}` : '';
  const url = `/topology/layar${query}`;
  if (topologyScreen && !topologyScreen.closed) {
    const next = new URL(url, window.location.origin).href;
    if (topologyScreen.location.href !== next) topologyScreen.location.replace(next);
    topologyScreen.focus();
    return true;
  }
  const display = window.screen as Screen & { availLeft?: number; availTop?: number };
  const popup = window.open(
    url,
    'kalimasada-topology',
    `popup=yes,width=${display.availWidth},height=${display.availHeight},left=${display.availLeft ?? 0},top=${display.availTop ?? 0}`,
  );
  if (!popup) return false;
  topologyScreen = popup;
  popup.focus();
  return true;
}

function FullscreenIcon({ exit = false }: { exit?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {exit ? (
        <path d="M9 4H4v5h2V6h3V4zm11 0h-5v2h3v3h2V4zM6 15H4v5h5v-2H6v-3zm14 0h-2v3h-3v2h5v-5z" />
      ) : (
        <path d="M4 9V4h5v2H6v3H4zm16 0V4h-5v2h3v3h2zM4 15v5h5v-2H6v-3H4zm16 0v5h-5v-2h3v-3h2z" />
      )}
    </svg>
  );
}

function MapTools({ present, location, stage }: { present: boolean; location: string; stage: RefObject<HTMLDivElement | null> }) {
  const { fitView } = useReactFlow();
  const [full, setFull] = useState(false);

  useEffect(() => {
    const sync = () => {
      const active = document.fullscreenElement != null;
      setFull(active);
      if (active) void fitView({ duration: 200 });
    };
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, [fitView]);

  useEffect(() => {
    if (!present) return;
    const onResize = () => { void fitView({ duration: 150 }); };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [present, fitView]);

  function enterFullscreen() {
    const node = stage.current;
    if (!node) return;
    void node.requestFullscreen().catch(() => {});
  }

  function onFullscreen() {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
      return;
    }
    if (!present && openTopologyScreen(location)) return;
    enterFullscreen();
  }

  return (
    <>
      <Controls
        showFitView={false}
        showInteractive={false}
        className="flow-controls-zoom"
        aria-label="Zoom"
      />
      <Controls
        showZoom={false}
        showFitView={false}
        className="flow-controls-tools"
        aria-label="Layar penuh dan kunci"
      >
        <ControlButton
          className="flow-fullscreen"
          onClick={onFullscreen}
          title={full ? 'Keluar dari layar penuh' : 'Layar penuh'}
          aria-label={full ? 'Keluar dari layar penuh' : 'Layar penuh'}
        >
          <FullscreenIcon exit={full} />
        </ControlButton>
      </Controls>
    </>
  );
}

export function TopologyPage({ present = false }: { present?: boolean }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { user } = useAuth();
  const stageRef = useRef<HTMLDivElement>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [links, setLinks] = useState<Link[]>([]);
  const [locations, setLocations] = useState<string[]>([]);
  const [location, setLocation] = useState(() => params.get('lokasi') ?? '');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [ports, setPorts] = useState<{ source: PortSide; target: PortSide } | null>(null);
  const [portChoice, setPortChoice] = useState('');
  const [portError, setPortError] = useState('');
  const [saving, setSaving] = useState(false);
  const selected = links.find((link) => link.id === selectedId) ?? null;
  const isAdmin = can(user?.role, 'admin');

  const load = useCallback(() => {
    const query = location ? `?location=${encodeURIComponent(location)}` : '';
    void api<{ devices: Device[]; links: Link[]; locations: string[] }>(`/api/topology${query}`).then((result) => {
      setDevices(result.devices);
      setLinks(result.links);
      setLocations(result.locations);
    });
  }, [location]);

  useEffect(() => {
    load();
    window.addEventListener('noc-refresh', load);
    return () => window.removeEventListener('noc-refresh', load);
  }, [load]);

  useEffect(() => {
    if (!present) return;
    const timer = window.setInterval(() => window.dispatchEvent(new Event('noc-refresh')), readRefreshSeconds() * 1000);
    const token = localStorage.getItem('token');
    const socket = token ? io({ path: '/socket.io', auth: { token } }) : null;
    const refresh = () => window.dispatchEvent(new Event('noc-refresh'));
    socket?.on('device_status_changed', refresh);
    socket?.on('alarm_created', refresh);
    socket?.on('alarm_recovered', refresh);
    return () => {
      window.clearInterval(timer);
      socket?.close();
    };
  }, [present]);

  const nodes = useMemo<Node[]>(() => {
    const placed = layoutMissing(devices);
    return devices.map((device) => ({
      id: device.id,
      type: 'device',
      position: { x: device.posX ?? placed.get(device.id)?.x ?? 40, y: device.posY ?? placed.get(device.id)?.y ?? 40 },
      data: {
        name: device.name,
        ip: device.ipAddress,
        kind: deviceTypeLabels[device.deviceType] ?? device.deviceType,
        status: device.status,
        latency: formatLatency(device.latencyMs),
      },
    }));
  }, [devices]);

  const edges = useMemo<Edge[]>(() => links.map((link) => {
    const target = devices.find((device) => device.id === link.targetId);
    const down = target?.status === 'down' || target?.status === 'unreachable';
    const label = down ? 'down' : trafficLabel(link);
    return {
      id: link.id,
      source: link.sourceId,
      target: link.targetId,
      animated: !down,
      style: { stroke: down ? '#c42318' : '#1d4e89', strokeWidth: down ? 2 : trafficWidth(link.traffic) },
      label,
      labelStyle: { fill: down ? '#c42318' : 'var(--ink)', fontSize: 11, fontWeight: 600 },
      labelBgStyle: { fill: 'var(--card)', fillOpacity: 0.9 },
      labelBgPadding: [6, 3] as [number, number],
      labelBgBorderRadius: 4,
    };
  }), [devices, links]);

  async function selectLink(id: string) {
    setSelectedId(id);
    setPorts(null);
    setPortError('');
    const link = links.find((item) => item.id === id);
    setPortChoice(link?.interfaceDeviceId && link.interfaceKey ? `${link.interfaceDeviceId}|${link.interfaceKey}` : '');
    if (!isAdmin) return;
    try {
      setPorts(await api<{ source: PortSide; target: PortSide }>(`/api/topology/links/${id}/interfaces`));
    } catch (err) {
      setPortError(err instanceof Error ? err.message : 'Daftar interface gagal dimuat');
    }
  }

  async function saveInterface() {
    if (!selected) return;
    const [deviceId, key] = portChoice ? portChoice.split('|') : [null, null];
    setSaving(true);
    setPortError('');
    try {
      await api(`/api/topology/links/${selected.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ deviceId, key }),
      });
      load();
    } catch (err) {
      setPortError(err instanceof Error ? err.message : 'Interface gagal disimpan');
    } finally {
      setSaving(false);
    }
  }

  async function removeLink() {
    if (!selected) return;
    if (!window.confirm(`Hapus link ${nameOf(devices, selected.sourceId)} → ${nameOf(devices, selected.targetId)}?`)) return;
    setSaving(true);
    setPortError('');
    try {
      await api(`/api/topology/links/${selected.id}`, { method: 'DELETE' });
      setSelectedId(null);
      load();
    } catch (err) {
      setPortError(err instanceof Error ? err.message : 'Link gagal dihapus');
    } finally {
      setSaving(false);
    }
  }

  async function onConnect(connection: Connection) {
    if (!can(user?.role, 'admin') || !connection.source || !connection.target) return;
    await api('/api/topology/links', {
      method: 'POST',
      body: JSON.stringify({ sourceId: connection.source, targetId: connection.target }),
    });
    load();
  }

  return (
    <div className={present ? 'topology-present' : undefined} style={{ position: 'relative', height: present ? '100%' : undefined }}>
      {present ? null : (
        <div className="toolbar" style={{ marginBottom: 10 }}>
          <select value={location} onChange={(event) => setLocation(event.target.value)}>
            <option value="">Semua lokasi</option>
            {locations.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
          <span className="sub">Geser node untuk menyimpan posisi. Klik dua kali untuk membuka detail.</span>
        </div>
      )}
      <div className="flow" ref={stageRef}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          nodesDraggable={can(user?.role, 'noc')}
          nodesConnectable={can(user?.role, 'admin')}
          deleteKeyCode={null}
          onNodeDoubleClick={(_, node) => {
            if (present) return;
            navigate(`/devices/${node.id}`);
          }}
          onNodeDragStop={(_, node) => {
            void api(`/api/topology/nodes/${node.id}`, {
              method: 'PATCH',
              body: JSON.stringify({ x: node.position.x, y: node.position.y }),
            });
          }}
          onConnect={(connection) => void onConnect(connection)}
          onEdgeClick={(_, edge) => {
            if (!present) void selectLink(edge.id);
          }}
          onPaneClick={() => setSelectedId(null)}
        >
          <Background />
          <MapTools present={present} location={location} stage={stageRef} />
        </ReactFlow>
      </div>
      {selected && !present ? (
        <aside className="link-panel">
          <div className="link-panel-head">
            <strong>{nameOf(devices, selected.sourceId)} → {nameOf(devices, selected.targetId)}</strong>
            <button className="btn-ghost btn-sm" type="button" onClick={() => setSelectedId(null)} aria-label="Tutup">×</button>
          </div>
          {selected.interfaceKey ? (
            <div className="link-traffic">
              <span className="sub">{nameOf(devices, selected.interfaceDeviceId)} · {selected.interfaceName ?? selected.interfaceKey}</span>
              {selected.traffic && (selected.traffic.down != null || selected.traffic.up != null) ? (
                <span>↓ <b>{formatBps(selected.traffic.down)}</b> · ↑ <b>{formatBps(selected.traffic.up)}</b></span>
              ) : (
                <span className="sub">Menunggu data trafik dari Zabbix (±1–2 menit).</span>
              )}
            </div>
          ) : (
            <p className="sub">Pilih interface agar trafik tampil di garis.</p>
          )}
          {isAdmin ? (
            <>
              <label className="field">
                <span>Interface</span>
                <select value={portChoice} onChange={(event) => setPortChoice(event.target.value)} disabled={!ports}>
                  <option value="">{ports ? 'Tanpa interface' : 'Memuat interface...'}</option>
                  {ports ? [ports.source, ports.target].map((side) => (
                    <optgroup key={side.id} label={side.interfaces.length ? side.name : `${side.name} (${side.snmp === 'off' ? 'SNMP belum diisi' : 'SNMP belum menjawab'})`}>
                      {physicalFirst(side.interfaces).map((port) => (
                        <option key={port.key} value={`${side.id}|${port.key}`}>{port.name}</option>
                      ))}
                    </optgroup>
                  )) : null}
                </select>
              </label>
              {portError ? <div className="error">{portError}</div> : null}
              <div className="toolbar">
                <button className="btn" type="button" disabled={!ports || saving} onClick={() => void saveInterface()}>
                  {saving ? 'Menyimpan...' : 'Simpan'}
                </button>
                <button className="btn-danger" type="button" disabled={saving} onClick={() => void removeLink()}>Hapus link</button>
              </div>
            </>
          ) : null}
        </aside>
      ) : null}
    </div>
  );
}

function trafficLabel(link: Link) {
  if (!link.interfaceKey) return '';
  const traffic = link.traffic;
  if (!traffic || (traffic.down == null && traffic.up == null)) return '…';
  return `↓ ${formatBps(traffic.down)}  ↑ ${formatBps(traffic.up)}`;
}

function trafficWidth(traffic: Traffic | null) {
  const peak = Math.max(traffic?.down ?? 0, traffic?.up ?? 0);
  if (!peak) return 2;
  return Math.min(6, 2 + Math.log10(peak / 1_000_000 + 1) * 1.5);
}

function physicalFirst(ports: PortSide['interfaces']) {
  const dynamic = (name: string) => name.startsWith('<');
  return [...ports.filter((port) => !dynamic(port.name)), ...ports.filter((port) => dynamic(port.name))];
}

function nameOf(devices: Device[], id: string | null) {
  return devices.find((device) => device.id === id)?.name ?? '—';
}

function layoutMissing(devices: Device[]) {
  const positions = new Map<string, { x: number; y: number }>();
  const byId = new Map(devices.map((device) => [device.id, device]));
  const depthOf = (device: Device, guard = 0): number => {
    if (!device.parentId || guard > 30) return 0;
    const parent = byId.get(device.parentId);
    return parent ? 1 + depthOf(parent, guard + 1) : 0;
  };
  const groups = new Map<number, Device[]>();
  for (const device of devices) {
    const depth = depthOf(device);
    const list = groups.get(depth) ?? [];
    list.push(device);
    groups.set(depth, list);
  }
  for (const [depth, list] of groups) {
    list.forEach((device, index) => {
      if (device.posX == null || device.posY == null) {
        positions.set(device.id, { x: index * 250, y: depth * 160 });
      }
    });
  }
  return positions;
}
