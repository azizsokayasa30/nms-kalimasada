import { memo, useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import {
  Background,
  BackgroundVariant,
  ControlButton,
  Controls,
  Handle,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
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

type DeviceData = { name: string; ip: string; kind: string; status: string; latency: string };
type FlowNode = Node<DeviceData, 'device'>;

const GRID = 40;
const SNAP: [number, number] = [GRID, GRID];

const DeviceNode = memo(function DeviceNode({ data }: NodeProps<FlowNode>) {
  const status = data.status || 'unknown';
  const offline = status === 'down' || status === 'unreachable';
  const mark = status === 'up' ? 'up' : offline ? 'down' : '';
  return (
    <div className={`node ${status}`}>
      <Handle type="target" position={Position.Top} />
      <strong>{data.name}</strong>
      <small>{data.ip}</small>
      <small>{data.kind} · {data.latency}</small>
      {mark ? <span className={`node-state ${mark}`}>{mark === 'up' ? 'UP' : 'DOWN'}</span> : null}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
});

const nodeTypes = { device: DeviceNode };

type Filters = { location: string; groupId: string; type: string };

function filterQuery(filters: Filters, keys: { location: string; groupId: string; type: string }) {
  const query = new URLSearchParams();
  if (filters.location) query.set(keys.location, filters.location);
  if (filters.groupId) query.set(keys.groupId, filters.groupId);
  if (filters.type) query.set(keys.type, filters.type);
  const text = query.toString();
  return text ? `?${text}` : '';
}

let topologyScreen: Window | null = null;

function openTopologyScreen(filters: Filters) {
  const url = `/topology/layar${filterQuery(filters, { location: 'lokasi', groupId: 'grup', type: 'jenis' })}`;
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

function FitOnChange({ token, paused }: { token: string; paused: boolean }) {
  const { fitView, getNodes } = useReactFlow();
  const seen = useRef('');
  useEffect(() => {
    if (paused || !token || seen.current === token) return;
    let frames = 0;
    let frame = 0;
    const tick = () => {
      frames += 1;
      const ready = getNodes().some((node) => (node.measured?.width ?? 0) > 0);
      if (!ready && frames < 30) {
        frame = requestAnimationFrame(tick);
        return;
      }
      seen.current = token;
      void fitView({ duration: 180, padding: 0.12 });
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [token, paused, fitView, getNodes]);
  return null;
}

function MapTools({ present, filters, stage }: { present: boolean; filters: Filters; stage: RefObject<HTMLDivElement | null> }) {
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
    if (!present && openTopologyScreen(filters)) return;
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
        showInteractive={false}
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
  const [groups, setGroups] = useState<Array<{ id: string; name: string }>>([]);
  const [types, setTypes] = useState<string[]>([]);
  const [filters, setFilters] = useState<Filters>(() => ({
    location: params.get('lokasi') ?? '',
    groupId: params.get('grup') ?? '',
    type: params.get('jenis') ?? '',
  }));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [ports, setPorts] = useState<{ source: PortSide; target: PortSide } | null>(null);
  const [portChoice, setPortChoice] = useState('');
  const [portError, setPortError] = useState('');
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [savingLayout, setSavingLayout] = useState(false);
  const [layoutError, setLayoutError] = useState('');
  const [baseline, setBaseline] = useState<Map<string, { x: number; y: number }> | null>(null);
  const [nodes, setNodes, applyNodeChanges] = useNodesState<FlowNode>([]);
  const [edges, setEdges, applyEdgeChanges] = useEdgesState<Edge>([]);
  const editingRef = useRef(false);
  const draggingRef = useRef(false);
  const selected = links.find((link) => link.id === selectedId) ?? null;
  const canManage = can(user?.role, 'noc') && !present;
  editingRef.current = editing;

  const load = useCallback(() => {
    const query = filterQuery(filters, { location: 'location', groupId: 'groupId', type: 'type' });
    void api<{
      devices: Device[];
      links: Link[];
      locations: string[];
      groups: Array<{ id: string; name: string }>;
      types: string[];
    }>(`/api/topology${query}`).then((result) => {
      setDevices(result.devices);
      setLinks(result.links);
      setLocations(result.locations);
      setGroups(result.groups);
      setTypes(result.types);
    });
  }, [filters]);

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

  useEffect(() => {
    if (draggingRef.current) return;
    setNodes((current) => mergeNodes(current, devices, editingRef.current));
    setEdges((current) => mergeEdges(current, devices, links));
  }, [devices, links, setNodes, setEdges]);

  useEffect(() => {
    if (!editing) return;
    const onLeave = (event: BeforeUnloadEvent) => {
      if (!layoutDirty(nodes, baseline)) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onLeave);
    return () => window.removeEventListener('beforeunload', onLeave);
  }, [editing, nodes, baseline]);

  const onNodesChange = useCallback((changes: NodeChange<FlowNode>[]) => {
    const editable = editingRef.current;
    applyNodeChanges(changes.filter((change) => change.type !== 'remove' && (change.type !== 'position' || editable)));
  }, [applyNodeChanges]);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    applyEdgeChanges(changes.filter((change) => change.type !== 'remove'));
  }, [applyEdgeChanges]);

  const dirty = editing && layoutDirty(nodes, baseline);
  const fitToken = `${filters.location}|${filters.groupId}|${filters.type}:${devices.map((device) => device.id).join(',')}`;

  function finishEdit() {
    editingRef.current = false;
    setEditing(false);
    setBaseline(null);
    setLayoutError('');
    setDragging(false);
    draggingRef.current = false;
  }

  function startEdit() {
    editingRef.current = true;
    setBaseline(new Map(nodes.map((node) => [node.id, { x: node.position.x, y: node.position.y }])));
    setLayoutError('');
    setEditing(true);
    if (selectedId) void selectLink(selectedId);
  }

  function discardEdit() {
    if (baseline) {
      setNodes((current) => current.map((node) => {
        const origin = baseline.get(node.id);
        return origin ? { ...node, position: { x: origin.x, y: origin.y } } : node;
      }));
    }
    finishEdit();
  }

  function cancelEdit() {
    if (dirty && !window.confirm('Buang perubahan tata letak?')) return;
    discardEdit();
  }

  function changeFilter(key: keyof Filters, value: string) {
    if (value === filters[key]) return;
    if (dirty && !window.confirm('Perubahan tata letak belum disimpan. Buang dan ganti filter?')) return;
    if (editing) discardEdit();
    setFilters((current) => ({ ...current, [key]: value }));
  }

  async function saveLayout() {
    const changed = movedNodes(nodes, baseline);
    if (!changed.length) {
      finishEdit();
      return;
    }
    setSavingLayout(true);
    setLayoutError('');
    try {
      await api('/api/topology/layout', {
        method: 'PATCH',
        body: JSON.stringify({ nodes: changed }),
      });
      const placed = new Map(changed.map((node) => [node.id, node]));
      setDevices((list) => list.map((device) => {
        const next = placed.get(device.id);
        return next ? { ...device, posX: next.x, posY: next.y } : device;
      }));
      setNodes((current) => current.map((node) => {
        const next = placed.get(node.id);
        return next ? { ...node, position: { x: next.x, y: next.y } } : node;
      }));
      finishEdit();
    } catch (err) {
      setLayoutError(err instanceof Error ? err.message : 'Tata letak gagal disimpan');
    } finally {
      setSavingLayout(false);
    }
  }

  async function selectLink(id: string) {
    setSelectedId(id);
    setPorts(null);
    setPortError('');
    const link = links.find((item) => item.id === id);
    setPortChoice(link?.interfaceDeviceId && link.interfaceKey ? `${link.interfaceDeviceId}|${link.interfaceKey}` : '');
    if (!editingRef.current) return;
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
    if (!editingRef.current || !connection.source || !connection.target) return;
    await api('/api/topology/links', {
      method: 'POST',
      body: JSON.stringify({ sourceId: connection.source, targetId: connection.target }),
    });
    load();
  }

  return (
    <div className={present ? 'topology-present' : undefined} style={{ position: 'relative', height: present ? '100%' : undefined }}>
      {present ? null : (
        <div className="toolbar topology-toolbar">
          <select value={filters.location} onChange={(event) => changeFilter('location', event.target.value)} aria-label="Filter lokasi">
            <option value="">Semua lokasi</option>
            {locations.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
          <select value={filters.groupId} onChange={(event) => changeFilter('groupId', event.target.value)} aria-label="Filter grup">
            <option value="">Semua grup</option>
            {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
            <option value="none">Tanpa grup</option>
          </select>
          <select value={filters.type} onChange={(event) => changeFilter('type', event.target.value)} aria-label="Filter jenis device">
            <option value="">Semua jenis device</option>
            {types.map((item) => <option key={item} value={item}>{deviceTypeLabels[item] ?? item}</option>)}
          </select>
          {canManage ? (
            <div className="topology-actions">
              {editing ? (
                <>
                  <button className="btn-ghost" type="button" disabled={savingLayout} onClick={cancelEdit}>Batal</button>
                  <button className="btn" type="button" disabled={savingLayout} onClick={() => void saveLayout()}>
                    {savingLayout ? 'Menyimpan...' : 'Simpan'}
                  </button>
                </>
              ) : (
                <button className="btn" type="button" onClick={startEdit}>EDIT</button>
              )}
            </div>
          ) : null}
        </div>
      )}
      {present ? null : (
        <div className="topology-hint">
          <span className="sub">
            {editing
              ? `Geser perangkat, posisi menempel ke grid ${GRID}px. Simpan jika sudah selesai.`
              : canManage
                ? 'Peta terkunci. Tekan EDIT untuk menggeser perangkat.'
                : 'Klik garis untuk trafik. Klik dua kali perangkat untuk detail.'}
          </span>
          {layoutError ? <span className="error">{layoutError}</span> : null}
        </div>
      )}
      <div className={`flow${editing ? ' editing' : ''}${dragging ? ' dragging' : ''}`} ref={stageRef}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodeTypes={nodeTypes}
          nodesDraggable={editing}
          nodesConnectable={editing}
          minZoom={0.2}
          maxZoom={1.5}
          edgesReconnectable={false}
          elementsSelectable={!present}
          snapToGrid={editing}
          snapGrid={SNAP}
          nodeDragThreshold={1}
          onlyRenderVisibleElements
          zoomOnDoubleClick={!editing}
          deleteKeyCode={null}
          onNodeDoubleClick={(_, node) => {
            if (present || editing) return;
            navigate(`/devices/${node.id}`);
          }}
          onNodeDragStart={() => {
            draggingRef.current = true;
            setDragging(true);
          }}
          onNodeDragStop={() => {
            draggingRef.current = false;
            setDragging(false);
            setNodes((current) => mergeNodes(current, devices, true));
            setEdges((current) => mergeEdges(current, devices, links));
          }}
          onConnect={(connection) => void onConnect(connection)}
          onEdgeClick={(_, edge) => {
            if (!present) void selectLink(edge.id);
          }}
          onPaneClick={() => setSelectedId(null)}
        >
          <Background
            variant={editing ? BackgroundVariant.Lines : BackgroundVariant.Dots}
            gap={GRID}
            size={1}
          />
          <FitOnChange token={fitToken} paused={editing} />
          <MapTools present={present} filters={filters} stage={stageRef} />
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
            <p className="sub">{editing ? 'Pilih interface agar trafik tampil di garis.' : 'Interface belum dipilih.'}</p>
          )}
          {editing ? (
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
                  {saving ? 'Menyimpan...' : 'Simpan interface'}
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

function deviceNodeData(device: Device): DeviceData {
  return {
    name: device.name,
    ip: device.ipAddress,
    kind: deviceTypeLabels[device.deviceType] ?? device.deviceType,
    status: device.status,
    latency: formatLatency(device.latencyMs),
  };
}

function sameData(a: DeviceData, b: DeviceData) {
  return a.name === b.name && a.ip === b.ip && a.kind === b.kind && a.status === b.status && a.latency === b.latency;
}

function mergeNodes(current: FlowNode[], devices: Device[], keepPositions: boolean) {
  const placed = layoutMissing(devices);
  const prev = new Map(current.map((node) => [node.id, node]));
  const next = devices.map((device) => {
    const old = prev.get(device.id);
    const server = {
      x: device.posX ?? placed.get(device.id)?.x ?? 40,
      y: device.posY ?? placed.get(device.id)?.y ?? 40,
    };
    const position = keepPositions && old ? old.position : server;
    const data = deviceNodeData(device);
    if (old && old.position.x === position.x && old.position.y === position.y && sameData(old.data, data)) return old;
    return { id: device.id, type: 'device' as const, position, data, selected: old?.selected };
  });
  if (next.length === current.length && next.every((node, index) => node === current[index])) return current;
  return next;
}

function mergeEdges(current: Edge[], devices: Device[], links: Link[]) {
  const statusOf = new Map(devices.map((device) => [device.id, device.status]));
  const prev = new Map(current.map((edge) => [edge.id, edge]));
  const next = links.map((link) => {
    const status = statusOf.get(link.targetId);
    const down = status === 'down' || status === 'unreachable';
    const label = down ? 'down' : trafficLabel(link);
    const stroke = down ? '#c42318' : '#1d4e89';
    const strokeWidth = down ? 2 : trafficWidth(link.traffic);
    const old = prev.get(link.id);
    if (
      old
      && old.source === link.sourceId
      && old.target === link.targetId
      && old.label === label
      && old.animated === !down
      && old.style?.stroke === stroke
      && old.style?.strokeWidth === strokeWidth
    ) return old;
    return {
      id: link.id,
      source: link.sourceId,
      target: link.targetId,
      animated: !down,
      style: { stroke, strokeWidth },
      label,
      labelStyle: { fill: down ? '#c42318' : 'var(--ink)', fontSize: 11, fontWeight: 600 },
      labelBgStyle: { fill: 'var(--card)', fillOpacity: 0.9 },
      labelBgPadding: [6, 3] as [number, number],
      labelBgBorderRadius: 4,
    };
  });
  if (next.length === current.length && next.every((edge, index) => edge === current[index])) return current;
  return next;
}

function layoutDirty(nodes: FlowNode[], baseline: Map<string, { x: number; y: number }> | null) {
  if (!baseline) return false;
  return nodes.some((node) => {
    const origin = baseline.get(node.id);
    if (!origin) return false;
    return Math.round(origin.x) !== Math.round(node.position.x) || Math.round(origin.y) !== Math.round(node.position.y);
  });
}

function movedNodes(nodes: FlowNode[], baseline: Map<string, { x: number; y: number }> | null) {
  const changed: Array<{ id: string; x: number; y: number }> = [];
  for (const node of nodes) {
    const x = Math.round(node.position.x);
    const y = Math.round(node.position.y);
    const origin = baseline?.get(node.id);
    if (!origin || Math.round(origin.x) !== x || Math.round(origin.y) !== y) changed.push({ id: node.id, x, y });
  }
  return changed;
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
