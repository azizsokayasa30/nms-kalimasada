import { FormEvent, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { deviceTypeLabels, methodLabels } from '../lib/format';

type Device = {
  id: string;
  name: string;
  ipAddress: string;
  deviceType: string;
  location: string | null;
  groupId: string | null;
  parentId: string | null;
  monitorMethod: string;
  snmpVersion: string;
  snmpPort: number;
  rosUsername: string | null;
  rosPort: number;
  pingIntervalSec: number;
  failedThreshold: number;
  recoveryThreshold: number;
  alertDelaySec: number;
  criticality: string;
  notificationEnabled: boolean;
  maintenance: boolean;
  snmpCommunitySet?: boolean;
};

const empty = {
  name: '',
  ipAddress: '',
  deviceType: 'mikrotik_router',
  location: '',
  groupId: '',
  parentId: '',
  monitorMethod: 'icmp',
  snmpCommunity: '',
  snmpVersion: '2c',
  snmpPort: 161,
  rosUsername: '',
  rosPassword: '',
  rosPort: 8728,
  pingIntervalSec: 10,
  failedThreshold: 3,
  recoveryThreshold: 2,
  alertDelaySec: 30,
  criticality: 'major',
  notificationEnabled: true,
  maintenance: false,
};

export function DeviceFormPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [form, setForm] = useState(empty);
  const [parents, setParents] = useState<Array<{ id: string; name: string }>>([]);
  const [groups, setGroups] = useState<Array<{ id: string; name: string }>>([]);
  const [newGroup, setNewGroup] = useState('');
  const [error, setError] = useState('');
  const [communitySet, setCommunitySet] = useState(false);

  useEffect(() => {
    void api<{ devices: Device[] }>('/api/devices?limit=100').then((result) => {
      setParents(result.devices.filter((device) => device.id !== id));
    });
    void api<{ groups: Array<{ id: string; name: string }> }>('/api/devices/groups')
      .then((result) => setGroups(result.groups))
      .catch(() => setGroups([]));
    if (!id) return;
    void api<Device>(`/api/devices/${id}`).then((device) => {
      setForm({
        ...empty,
        ...device,
        location: device.location ?? '',
        groupId: device.groupId ?? '',
        parentId: device.parentId ?? '',
        rosUsername: device.rosUsername ?? '',
        snmpCommunity: '',
        rosPassword: '',
      });
      setCommunitySet(Boolean(device.snmpCommunitySet));
    });
  }, [id]);

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    try {
      let groupId: string | null = form.groupId || null;
      if (form.groupId === '__new') {
        const name = newGroup.trim();
        if (name.length < 2) {
          setError('Nama grup minimal 2 karakter');
          return;
        }
        const created = await api<{ id: string }>('/api/devices/groups', {
          method: 'POST',
          body: JSON.stringify({ name }),
        });
        groupId = created.id;
      }
      const needsCommunity = form.monitorMethod === 'snmp' || form.monitorMethod === 'combination';
      if (needsCommunity && !form.snmpCommunity.trim() && !communitySet) {
        setError('SNMP community wajib diisi agar Zabbix bisa menemukan interface');
        return;
      }
      const payload = {
        ...form,
        groupId,
        parentId: form.parentId || null,
        snmpPort: Number(form.snmpPort),
        rosPort: Number(form.rosPort),
        pingIntervalSec: Number(form.pingIntervalSec),
        failedThreshold: Number(form.failedThreshold),
        recoveryThreshold: Number(form.recoveryThreshold),
        alertDelaySec: Number(form.alertDelaySec),
      };
      const saved = await api<Device>(id ? `/api/devices/${id}` : '/api/devices', {
        method: id ? 'PUT' : 'POST',
        body: JSON.stringify(payload),
      });
      navigate(`/devices/${saved.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal menyimpan');
    }
  }

  return (
    <section className="panel">
      <header><h2>{id ? 'Ubah perangkat' : 'Perangkat baru'}</h2></header>
      <form className="form-grid" onSubmit={(event) => void submit(event)}>
        <label className="field"><span>Nama</span><input value={form.name} onChange={(event) => set('name', event.target.value)} required /></label>
        <label className="field"><span>IP address</span><input value={form.ipAddress} onChange={(event) => set('ipAddress', event.target.value)} required /></label>
        <label className="field"><span>Tipe</span>
          <select value={form.deviceType} onChange={(event) => set('deviceType', event.target.value)}>
            {Object.entries(deviceTypeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label className="field"><span>Lokasi</span><input value={form.location} onChange={(event) => set('location', event.target.value)} /></label>
        <label className="field"><span>Grup</span>
          <select value={form.groupId} onChange={(event) => set('groupId', event.target.value)}>
            <option value="">Tanpa grup</option>
            {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
            <option value="__new">Grup baru</option>
          </select>
        </label>
        {form.groupId === '__new' ? (
          <label className="field"><span>Nama grup baru</span><input value={newGroup} onChange={(event) => setNewGroup(event.target.value)} required /></label>
        ) : null}
        <label className="field"><span>Parent device</span>
          <select value={form.parentId} onChange={(event) => set('parentId', event.target.value)}>
            <option value="">Tidak ada</option>
            {parents.map((parent) => <option key={parent.id} value={parent.id}>{parent.name}</option>)}
          </select>
        </label>
        <label className="field"><span>Metode</span>
          <select value={form.monitorMethod} onChange={(event) => set('monitorMethod', event.target.value)}>
            {Object.entries(methodLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label className="field">
          <span>SNMP community</span>
          <input value={form.snmpCommunity} onChange={(event) => set('snmpCommunity', event.target.value)} placeholder={id ? 'Kosongkan jika tidak diubah' : ''} />
          <span className="sub">
            {communitySet
              ? 'Community sudah tersimpan. Isi kolom ini hanya jika ingin mengganti. Zabbix memakai community ini untuk menemukan interface.'
              : 'Wajib untuk metode SNMP. Zabbix memakai community ini untuk menemukan interface. Interface yang disadap dipilih manual di halaman MRTG.'}
          </span>
        </label>
        <label className="field"><span>SNMP version</span>
          <select value={form.snmpVersion} onChange={(event) => set('snmpVersion', event.target.value)}>
            <option value="2c">v2c</option>
            <option value="3">v3</option>
          </select>
        </label>
        <label className="field"><span>RouterOS username</span><input value={form.rosUsername} onChange={(event) => set('rosUsername', event.target.value)} /></label>
        <label className="field"><span>RouterOS password</span><input type="password" value={form.rosPassword} onChange={(event) => set('rosPassword', event.target.value)} placeholder={id ? 'Kosongkan jika tidak diubah' : ''} /></label>
        <label className="field"><span>Ping interval (detik)</span><input type="number" value={form.pingIntervalSec} onChange={(event) => set('pingIntervalSec', Number(event.target.value))} /></label>
        <label className="field"><span>Failed threshold</span><input type="number" value={form.failedThreshold} onChange={(event) => set('failedThreshold', Number(event.target.value))} /></label>
        <label className="field"><span>Recovery threshold</span><input type="number" value={form.recoveryThreshold} onChange={(event) => set('recoveryThreshold', Number(event.target.value))} /></label>
        <label className="field"><span>Alert delay (detik)</span><input type="number" value={form.alertDelaySec} onChange={(event) => set('alertDelaySec', Number(event.target.value))} /></label>
        <label className="field"><span>Criticality</span>
          <select value={form.criticality} onChange={(event) => set('criticality', event.target.value)}>
            <option value="info">Info</option>
            <option value="warning">Warning</option>
            <option value="major">Major</option>
            <option value="critical">Critical</option>
          </select>
        </label>
        <label className="field check"><input type="checkbox" checked={form.notificationEnabled} onChange={(event) => set('notificationEnabled', event.target.checked)} /> Notifikasi aktif</label>
        <label className="field check"><input type="checkbox" checked={form.maintenance} onChange={(event) => set('maintenance', event.target.checked)} /> Maintenance</label>
        <div className="full toolbar">
          <button className="btn" type="submit">Simpan</button>
          <button className="btn-ghost" type="button" onClick={() => navigate(-1)}>Batal</button>
        </div>
      </form>
      {error ? <div className="error">{error}</div> : null}
    </section>
  );
}
