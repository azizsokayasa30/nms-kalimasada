import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { can, connectionLabels, deviceTypeLabels, formatLatency, methodLabels } from '../lib/format';
import { StatusBadge } from '../components/StatusBadge';

type Device = {
  id: string;
  name: string;
  ipAddress: string;
  deviceType: string;
  location: string | null;
  groupId: string | null;
  groupName: string | null;
  monitorMethod: string;
  status: string;
  latencyMs: number | null;
  zabbixLinked: boolean;
};

type Group = { id: string; name: string; deviceCount: number };

type Section = { id: string; name: string; devices: Device[] };

type Probe = { pending: boolean; ok: boolean; text: string };

const columns = 9;

export function DevicesPage() {
  const { user } = useAuth();
  const [params] = useSearchParams();
  const search = params.get('q') ?? '';
  const [q, setQ] = useState(search);
  const [groupFilter, setGroupFilter] = useState('all');
  const [rows, setRows] = useState<Device[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [groupName, setGroupName] = useState('');
  const [managing, setManaging] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [probes, setProbes] = useState<Record<string, Probe>>({});
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');
  const canEdit = can(user?.role, 'admin');
  const canTest = can(user?.role, 'noc');

  useEffect(() => {
    setQ(search);
  }, [search]);

  useEffect(() => {
    const load = () => {
      const query = new URLSearchParams({ q, limit: '500' });
      if (groupFilter !== 'all') query.set('groupId', groupFilter);
      void Promise.all([
        api<{ devices: Device[]; total: number }>(`/api/devices?${query}`),
        api<{ groups: Group[] }>('/api/devices/groups').catch(() => ({ groups: [] as Group[] })),
      ])
        .then(([list, groupResult]) => {
          setRows(list.devices);
          setTotal(list.total);
          setGroups(groupResult.groups);
          setDrafts((current) => {
            const next = { ...current };
            for (const group of groupResult.groups) {
              if (!(group.id in next)) next[group.id] = group.name;
            }
            return next;
          });
        })
        .catch((err: Error) => setError(err.message));
    };
    load();
    window.addEventListener('noc-refresh', load);
    return () => window.removeEventListener('noc-refresh', load);
  }, [q, groupFilter]);

  const sections = useMemo(
    () => buildSections(rows, groups, groupFilter, q),
    [rows, groups, groupFilter, q],
  );

  async function test(device: Device) {
    setProbes((current) => ({ ...current, [device.id]: { pending: true, ok: false, text: 'Menguji...' } }));
    try {
      const result = await api<{ ok: boolean; results: Array<{ message: string; latencyMs: number | null }> }>(
        `/api/devices/${device.id}/test`,
        { method: 'POST' },
      );
      const text = result.results
        .map((row) => (row.latencyMs == null ? row.message : `${row.message} (${row.latencyMs} ms)`))
        .join(' · ');
      setProbes((current) => ({ ...current, [device.id]: { pending: false, ok: result.ok, text } }));
    } catch (err) {
      setProbes((current) => ({
        ...current,
        [device.id]: { pending: false, ok: false, text: err instanceof Error ? err.message : 'Uji gagal' },
      }));
    }
  }

  async function remove(device: Device) {
    if (!window.confirm(`Hapus perangkat ${device.name}?`)) return;
    setError('');
    try {
      await api(`/api/devices/${device.id}`, { method: 'DELETE' });
      window.dispatchEvent(new Event('noc-refresh'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal menghapus');
    }
  }

  async function addGroup() {
    const name = groupName.trim();
    if (name.length < 2) {
      setError('Nama grup minimal 2 karakter');
      return;
    }
    setError('');
    try {
      await api('/api/devices/groups', { method: 'POST', body: JSON.stringify({ name }) });
      setGroupName('');
      window.dispatchEvent(new Event('noc-refresh'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal menambah grup');
    }
  }

  async function renameGroup(group: Group) {
    const name = (drafts[group.id] ?? group.name).trim();
    if (name === group.name) return;
    setError('');
    try {
      const saved = await api<Group>(`/api/devices/groups/${group.id}`, {
        method: 'PUT',
        body: JSON.stringify({ name }),
      });
      setDrafts((current) => ({ ...current, [saved.id]: saved.name }));
      window.dispatchEvent(new Event('noc-refresh'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal mengubah grup');
    }
  }

  async function removeGroup(group: Group) {
    if (!window.confirm(`Hapus grup ${group.name}? Perangkat di dalamnya tidak ikut terhapus.`)) return;
    setError('');
    try {
      await api(`/api/devices/groups/${group.id}`, { method: 'DELETE' });
      if (groupFilter === group.id) setGroupFilter('all');
      window.dispatchEvent(new Event('noc-refresh'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal menghapus grup');
    }
  }

  return (
    <section className="panel">
      <header>
        <h2>Devices ({total})</h2>
        <div className="toolbar">
          <input value={q} onChange={(event) => setQ(event.target.value)} placeholder="Nama, IP, lokasi, grup" />
          <select value={groupFilter} onChange={(event) => setGroupFilter(event.target.value)} aria-label="Filter grup">
            <option value="all">Semua grup</option>
            <option value="none">Tanpa grup</option>
            {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
          </select>
          {canEdit ? (
            <button className="btn-ghost" type="button" onClick={() => setManaging((current) => !current)}>
              {managing ? 'Tutup grup' : 'Kelola grup'}
            </button>
          ) : null}
          {canEdit ? <Link className="btn" to="/devices/new">Tambah</Link> : null}
        </div>
      </header>
      {error ? <div className="error">{error}</div> : null}
      {canEdit && managing ? (
        <div className="group-manager">
          <div className="group-manager-row">
            <input value={groupName} onChange={(event) => setGroupName(event.target.value)} placeholder="Nama grup baru" />
            <button className="btn" type="button" onClick={() => void addGroup()}>Tambah grup</button>
          </div>
          {!groups.length ? <div className="sub">Belum ada grup. Perangkat tanpa grup tetap tampil di bagian Tanpa grup.</div> : groups.map((group) => (
            <div className="group-manager-row" key={group.id}>
              <input
                value={drafts[group.id] ?? group.name}
                onChange={(event) => setDrafts((current) => ({ ...current, [group.id]: event.target.value }))}
                aria-label={`Nama grup ${group.name}`}
              />
              <span className="sub">{group.deviceCount} perangkat</span>
              <button className="btn-ghost btn-sm" type="button" onClick={() => void renameGroup(group)}>Simpan</button>
              <button className="btn-danger btn-sm" type="button" onClick={() => void removeGroup(group)}>Hapus</button>
            </div>
          ))}
        </div>
      ) : null}
      {rows.length < total ? (
        <div className="note">Menampilkan {rows.length} dari {total} perangkat. Persempit dengan pencarian atau grup.</div>
      ) : null}
      {!sections.length ? (
        <div className="empty">{q || groupFilter !== 'all' ? 'Tidak ada perangkat yang cocok.' : 'Belum ada perangkat.'}</div>
      ) : (
        <div className="table-wrap">
          <table className="device-table">
            <thead>
              <tr>
                <th>Nama</th><th>IP</th><th>Tipe</th><th>Lokasi</th><th>Mode</th><th>Status</th><th>Latency</th><th>Zabbix</th><th className="actions">Aksi</th>
              </tr>
            </thead>
            {sections.map((section) => {
              const key = section.id || 'none';
              const open = !collapsed[key];
              return (
                <tbody key={key}>
                  <tr className="group-row">
                    <td colSpan={columns}>
                      <button
                        className="group-toggle"
                        type="button"
                        aria-expanded={open}
                        onClick={() => setCollapsed((current) => ({ ...current, [key]: open }))}
                      >
                        <span>{open ? '▾' : '▸'}</span>
                        {section.name}
                        <span className="group-count">{section.devices.length}</span>
                      </button>
                    </td>
                  </tr>
                  {open && !section.devices.length ? (
                    <tr><td colSpan={columns} className="empty">Belum ada perangkat di grup ini.</td></tr>
                  ) : null}
                  {open ? section.devices.map((device) => {
                    const probe = probes[device.id];
                    return (
                      <tr key={device.id} className="device-row">
                        <td className="cell-name"><Link to={`/devices/${device.id}`}>{device.name}</Link></td>
                        <td data-label="IP">{device.ipAddress}</td>
                        <td data-label="Tipe">{deviceTypeLabels[device.deviceType] ?? device.deviceType}</td>
                        <td data-label="Lokasi">{device.location ?? '—'}</td>
                        <td data-label="Mode">
                          <span className="badge method" title={methodLabels[device.monitorMethod] ?? device.monitorMethod}>
                            {connectionLabels[device.monitorMethod] ?? device.monitorMethod}
                          </span>
                        </td>
                        <td className="cell-status"><StatusBadge status={device.status} /></td>
                        <td data-label="Latency">{formatLatency(device.latencyMs)}</td>
                        <td data-label="Zabbix">{device.zabbixLinked ? 'Terhubung' : 'Menunggu'}</td>
                        <td className="actions">
                          <div className="row-actions">
                            <Link className="btn btn-sm" to={`/devices/${device.id}`}>Lihat</Link>
                            <button className="btn-ghost btn-sm" type="button" disabled={!canTest || probe?.pending} onClick={() => void test(device)}>Test</button>
                            {canEdit ? (
                              <Link className="btn-ghost btn-sm" to={`/devices/${device.id}/edit`}>Edit</Link>
                            ) : (
                              <button className="btn-ghost btn-sm" type="button" disabled>Edit</button>
                            )}
                            <button className="btn-danger btn-sm" type="button" disabled={!canEdit} onClick={() => void remove(device)}>Hapus</button>
                          </div>
                          {probe ? <div className={probe.pending ? 'probe' : probe.ok ? 'probe ok' : 'probe bad'}>{probe.text}</div> : null}
                        </td>
                      </tr>
                    );
                  }) : null}
                </tbody>
              );
            })}
          </table>
        </div>
      )}
    </section>
  );
}

function buildSections(rows: Device[], groups: Group[], groupFilter: string, q: string) {
  const buckets = new Map<string, Device[]>();
  const ungrouped: Device[] = [];
  for (const device of rows) {
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
    if (groupFilter !== 'all' && groupFilter !== group.id) continue;
    const devices = buckets.get(group.id) ?? [];
    seen.add(group.id);
    if (!devices.length && q) continue;
    sections.push({ id: group.id, name: group.name, devices });
  }
  for (const [id, devices] of buckets) {
    if (seen.has(id)) continue;
    if (groupFilter !== 'all' && groupFilter !== id) continue;
    sections.push({ id, name: devices[0]?.groupName ?? 'Grup', devices });
  }
  const showNone = groupFilter === 'all' || groupFilter === 'none';
  const hideEmptySearch = q && !ungrouped.length && groupFilter === 'all';
  if (showNone && (ungrouped.length || groupFilter === 'none') && !hideEmptySearch) {
    sections.push({ id: '', name: 'Tanpa grup', devices: ungrouped });
  }
  return sections;
}
