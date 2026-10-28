import { FormEvent, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import {
  DISPLAY_EVENT,
  readAnimations,
  readCompact,
  readMuted,
  readRefreshSeconds,
  readTheme,
  saveDisplay,
  saveMuted,
  type ThemeMode,
} from '../lib/display';
import { can, roleLabels } from '../lib/format';
import { playRecovery } from '../components/AlarmSound';
import { NotificationTab } from './NotificationSettings';
import { NetworkTab } from './network/NetworkTab';

type AppSettings = {
  soundEnabled: boolean;
  soundVolume: number;
  soundName: string | null;
  recoverySoundName: string | null;
  latencyWarnMs: number;
  lossWarnPct: number;
  zabbixApiUrl: string;
  zabbixUser: string;
  zabbixPasswordSet: boolean;
  zabbixTokenSet: boolean;
  webhookUrl: string;
  webhookTokenSet: boolean;
  mrtgColorIn: string;
  mrtgColorOut: string;
  mrtgColorThreshold: string;
  mrtgColorProbe: string;
  mrtgColorLoss: string;
  mrtgThresholdPct: number;
};

type Health = { api: string; database: string; zabbix: string; zabbixVersion: string | null; zabbixError: string | null; redis: string };
type UserRow = { id: string; name: string; email: string; role: string };
type ApiToken = { id: string; name: string; role: string; prefix: string; createdAt: string; lastUsedAt: string | null };

const tabs = [
  { id: 'tampilan', label: 'Tampilan' },
  { id: 'mrtg', label: 'MRTG' },
  { id: 'pengguna', label: 'Pengguna' },
  { id: 'akses', label: 'Akses API' },
  { id: 'suara', label: 'Suara' },
  { id: 'notifikasi', label: 'Notifikasi' },
  { id: 'jaringan', label: 'Jaringan', role: 'admin' },
] as const;

type TabId = (typeof tabs)[number]['id'];

export function SettingsPage() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const visible = tabs.filter((item) => !('role' in item) || can(user?.role, item.role));
  const requested = params.get('tab');
  const tab: TabId = visible.some((item) => item.id === requested) ? requested as TabId : 'tampilan';

  return (
    <section className="panel">
      <header><h2>Pengaturan</h2></header>
      <div className="settings-tabs">
        {visible.map((item) => (
          <button
            key={item.id}
            type="button"
            className={item.id === tab ? 'active' : ''}
            onClick={() => setParams({ tab: item.id })}
          >
            {item.label}
          </button>
        ))}
      </div>
      {tab === 'tampilan' ? <DisplayTab /> : null}
      {tab === 'mrtg' ? <MrtgTab /> : null}
      {tab === 'pengguna' ? <UsersTab /> : null}
      {tab === 'akses' ? <ApiTab /> : null}
      {tab === 'suara' ? <SoundTab /> : null}
      {tab === 'notifikasi' ? <NotificationTab /> : null}
      {tab === 'jaringan' ? <NetworkTab /> : null}
    </section>
  );
}

function DisplayTab() {
  const [theme, setTheme] = useState<ThemeMode>(readTheme);
  const [refreshSeconds, setRefreshSeconds] = useState(readRefreshSeconds);
  const [animations, setAnimations] = useState(readAnimations);
  const [compact, setCompact] = useState(readCompact);
  const [message, setMessage] = useState('');

  useEffect(() => {
    const sync = () => {
      setTheme(readTheme());
      setRefreshSeconds(readRefreshSeconds());
      setAnimations(readAnimations());
      setCompact(readCompact());
    };
    window.addEventListener(DISPLAY_EVENT, sync);
    return () => window.removeEventListener(DISPLAY_EVENT, sync);
  }, []);

  function save(event: FormEvent) {
    event.preventDefault();
    saveDisplay({ theme, refreshSeconds: Number(refreshSeconds), animations, compact });
    setMessage('Tampilan disimpan di browser ini');
  }

  return (
    <form className="form-grid" onSubmit={save}>
      <div className="field full">
        <span>Tema</span>
        <div className="segment">
          {([['light', 'Terang'], ['dark', 'Gelap'], ['system', 'Ikuti sistem']] as const).map(([value, label]) => (
            <button key={value} className={theme === value ? 'on' : ''} type="button" onClick={() => { setTheme(value); saveDisplay({ theme: value, refreshSeconds, animations, compact }); }}>{label}</button>
          ))}
        </div>
      </div>
      <label className="field">
        <span>Penyegaran data (detik)</span>
        <input type="number" min={5} max={120} value={refreshSeconds} onChange={(event) => setRefreshSeconds(Number(event.target.value))} />
      </label>
      <label className="field check">
        <input type="checkbox" checked={animations} onChange={(event) => { const next = event.target.checked; setAnimations(next); saveDisplay({ theme, refreshSeconds, animations: next, compact }); }} />
        Animasi alarm
      </label>
      <label className="field check">
        <input type="checkbox" checked={compact} onChange={(event) => { const next = event.target.checked; setCompact(next); saveDisplay({ theme, refreshSeconds, animations, compact: next }); }} />
        Tabel dan kartu lebih rapat
      </label>
      <div className="full sub">Pengaturan ini berlaku di browser ini. Tombol tema di atas tetap bisa mengganti terang atau gelap dengan cepat.</div>
      <button className="btn" type="submit">Simpan tampilan</button>
      {message ? <div className="full sub">{message}</div> : null}
    </form>
  );
}

function UsersTab() {
  const { user, replaceUser } = useAuth();
  const superAdmin = can(user?.role, 'super_admin');
  const [me, setMe] = useState({ name: user?.name ?? '', email: user?.email ?? '', currentPassword: '', newPassword: '' });
  const [rows, setRows] = useState<UserRow[]>([]);
  const [draft, setDraft] = useState({ id: '', name: '', email: '', password: '', role: 'noc' });
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  function loadUsers() {
    if (!superAdmin) return;
    void api<UserRow[]>('/api/users').then(setRows).catch((err: Error) => setError(err.message));
  }

  useEffect(loadUsers, [superAdmin]);

  async function saveMe(event: FormEvent) {
    event.preventDefault();
    setError('');
    setMessage('');
    if (me.newPassword && me.newPassword.length < 8) {
      setError('Password baru minimal 8 karakter');
      return;
    }
    if (me.newPassword && !me.currentPassword) {
      setError('Isi password saat ini untuk menggantinya');
      return;
    }
    try {
      const updated = await api<UserRow>('/api/users/me', {
        method: 'PATCH',
        body: JSON.stringify({
          name: me.name,
          email: me.email,
          currentPassword: me.currentPassword || undefined,
          newPassword: me.newPassword || undefined,
        }),
      });
      replaceUser({ id: updated.id, name: updated.name, email: updated.email, role: updated.role });
      setMe({ name: updated.name, email: updated.email, currentPassword: '', newPassword: '' });
      setMessage('Akun diperbarui');
      loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Akun gagal disimpan');
    }
  }

  async function saveUser(event: FormEvent) {
    event.preventDefault();
    setError('');
    setMessage('');
    if (!draft.id && draft.password.length < 8) {
      setError('Password minimal 8 karakter');
      return;
    }
    if (draft.id && draft.password && draft.password.length < 8) {
      setError('Password baru minimal 8 karakter');
      return;
    }
    try {
      const body = {
        name: draft.name,
        email: draft.email,
        role: draft.role,
        password: draft.password || undefined,
      };
      const saved = draft.id
        ? await api<UserRow>(`/api/users/${draft.id}`, { method: 'PATCH', body: JSON.stringify(body) })
        : await api<UserRow>('/api/users', { method: 'POST', body: JSON.stringify({ ...body, password: draft.password }) });
      if (saved.id === user?.id) replaceUser({ id: saved.id, name: saved.name, email: saved.email, role: saved.role });
      setDraft({ id: '', name: '', email: '', password: '', role: 'noc' });
      setMessage(draft.id ? 'Pengguna diperbarui' : 'Pengguna ditambahkan');
      loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Pengguna gagal disimpan');
    }
  }

  async function removeUser(row: UserRow) {
    if (!window.confirm(`Hapus ${row.name}?`)) return;
    setError('');
    try {
      await api(`/api/users/${row.id}`, { method: 'DELETE' });
      if (draft.id === row.id) setDraft({ id: '', name: '', email: '', password: '', role: 'noc' });
      setMessage('Pengguna dihapus');
      loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Pengguna gagal dihapus');
    }
  }

  return (
    <>
      {!superAdmin ? (
        <form className="form-grid" onSubmit={(event) => void saveMe(event)}>
          <h3 className="full" style={{ margin: 0 }}>Akun saya</h3>
          <label className="field"><span>Nama</span><input value={me.name} onChange={(event) => setMe({ ...me, name: event.target.value })} required /></label>
          <label className="field"><span>Email</span><input type="email" value={me.email} onChange={(event) => setMe({ ...me, email: event.target.value })} required /></label>
          <label className="field"><span>Password saat ini</span><input type="password" autoComplete="current-password" value={me.currentPassword} onChange={(event) => setMe({ ...me, currentPassword: event.target.value })} /></label>
          <label className="field"><span>Password baru</span><input type="password" autoComplete="new-password" value={me.newPassword} onChange={(event) => setMe({ ...me, newPassword: event.target.value })} /></label>
          <button className="btn" type="submit">Simpan akun</button>
        </form>
      ) : null}
      {superAdmin ? (
        <>
          <form className="form-grid" onSubmit={(event) => void saveUser(event)}>
            <h3 className="full" style={{ margin: 0 }}>{draft.id ? 'Ubah pengguna' : 'Tambah pengguna'}</h3>
            <label className="field"><span>Nama</span><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} required /></label>
            <label className="field"><span>Email</span><input type="email" value={draft.email} onChange={(event) => setDraft({ ...draft, email: event.target.value })} required /></label>
            <label className="field">
              <span>{draft.id ? 'Password baru (kosongkan jika tetap)' : 'Password'}</span>
              <input type="password" autoComplete="new-password" value={draft.password} onChange={(event) => setDraft({ ...draft, password: event.target.value })} required={!draft.id} />
            </label>
            <label className="field"><span>Role</span>
              <select value={draft.role} onChange={(event) => setDraft({ ...draft, role: event.target.value })}>
                <option value="super_admin">Super Admin</option>
                <option value="admin">Admin</option>
                <option value="noc">NOC</option>
                <option value="viewer">Viewer</option>
              </select>
            </label>
            <div className="toolbar">
              <button className="btn" type="submit">{draft.id ? 'Simpan perubahan' : 'Tambah'}</button>
              {draft.id ? <button className="btn-ghost" type="button" onClick={() => setDraft({ id: '', name: '', email: '', password: '', role: 'noc' })}>Batal</button> : null}
            </div>
          </form>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Nama</th><th>Email</th><th>Role</th><th></th></tr></thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>{row.name}</td>
                    <td>{row.email}</td>
                    <td>{roleLabels[row.role] ?? row.role}</td>
                    <td>
                      <div className="toolbar">
                        <button className="btn-ghost" type="button" onClick={() => setDraft({ id: row.id, name: row.name, email: row.email, password: '', role: row.role })}>Ubah</button>
                        {row.id !== user?.id ? <button className="btn-danger" type="button" onClick={() => void removeUser(row)}>Hapus</button> : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : <div className="sub" style={{ padding: '0 16px 16px' }}>Daftar pengguna hanya dapat dikelola Super Admin.</div>}
      {error ? <div className="error">{error}</div> : null}
      {message ? <div className="sub" style={{ padding: '0 16px 16px' }}>{message}</div> : null}
    </>
  );
}

function ApiTab() {
  const { user } = useAuth();
  const admin = can(user?.role, 'admin');
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [webhookToken, setWebhookToken] = useState('');
  const [form, setForm] = useState({
    zabbixApiUrl: '',
    zabbixUser: '',
    zabbixPassword: '',
    clearZabbixPassword: false,
    zabbixApiToken: '',
    clearZabbixToken: false,
    webhookUrl: '',
  });
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [tokenForm, setTokenForm] = useState({ name: '', role: 'viewer' });
  const [freshToken, setFreshToken] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  function load() {
    void api<AppSettings>('/api/settings').then((value) => {
      setSettings(value);
      setForm((current) => ({
        ...current,
        zabbixApiUrl: value.zabbixApiUrl,
        zabbixUser: value.zabbixUser,
        webhookUrl: value.webhookUrl,
        zabbixPassword: '',
        zabbixApiToken: '',
        clearZabbixPassword: false,
        clearZabbixToken: false,
      }));
    }).catch((err: Error) => setError(err.message));
    void api<Health>('/api/health').then(setHealth).catch(() => undefined);
    if (!admin) return;
    void api<{ webhookToken: string }>('/api/settings/integration').then((value) => setWebhookToken(value.webhookToken)).catch(() => undefined);
    void api<ApiToken[]>('/api/settings/api-tokens').then(setTokens).catch((err: Error) => setError(err.message));
  }

  useEffect(load, [admin]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setError('');
    setMessage('');
    try {
      const saved = await api<AppSettings>('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({
          zabbixApiUrl: form.zabbixApiUrl,
          zabbixUser: form.zabbixUser,
          zabbixPassword: form.zabbixPassword || undefined,
          clearZabbixPassword: form.clearZabbixPassword,
          zabbixApiToken: form.zabbixApiToken || undefined,
          clearZabbixToken: form.clearZabbixToken,
          webhookUrl: form.webhookUrl,
        }),
      });
      setSettings(saved);
      setForm((current) => ({ ...current, zabbixPassword: '', zabbixApiToken: '', clearZabbixPassword: false, clearZabbixToken: false }));
      setMessage('Akses API disimpan');
      void api<Health>('/api/health').then(setHealth).catch(() => undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Akses API gagal disimpan');
    }
  }

  async function testConnection() {
    setError('');
    setMessage('');
    try {
      const result = await api<{ ok: boolean; version: string | null; error: string | null }>('/api/settings/test-zabbix', {
        method: 'POST',
        body: JSON.stringify({
          zabbixApiUrl: form.zabbixApiUrl,
          zabbixUser: form.zabbixUser,
          zabbixPassword: form.zabbixPassword || undefined,
          zabbixApiToken: form.zabbixApiToken || undefined,
          clearZabbixToken: form.clearZabbixToken,
        }),
      });
      setMessage(result.ok ? `Zabbix terhubung${result.version ? `, versi ${result.version}` : ''}` : (result.error || 'Zabbix tidak terjangkau'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Uji koneksi gagal');
    }
  }

  async function regenerate() {
    if (!window.confirm('Token webhook lama langsung tidak berlaku. Lanjutkan?')) return;
    setError('');
    try {
      const result = await api<{ webhookToken: string }>('/api/settings/webhook-token', { method: 'POST' });
      setWebhookToken(result.webhookToken);
      setSettings((current) => current ? { ...current, webhookTokenSet: true } : current);
      setMessage('Token webhook baru dibuat');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Token webhook gagal dibuat');
    }
  }

  async function createToken(event: FormEvent) {
    event.preventDefault();
    setError('');
    setFreshToken('');
    try {
      const created = await api<ApiToken & { token: string }>('/api/settings/api-tokens', {
        method: 'POST',
        body: JSON.stringify(tokenForm),
      });
      setFreshToken(created.token);
      setTokenForm({ name: '', role: 'viewer' });
      setMessage('Token dibuat. Salin sekarang, nilai lengkap tidak ditampilkan lagi.');
      setTokens(await api<ApiToken[]>('/api/settings/api-tokens'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Token gagal dibuat');
    }
  }

  async function revoke(row: ApiToken) {
    if (!window.confirm(`Cabut token ${row.name}?`)) return;
    setError('');
    try {
      await api(`/api/settings/api-tokens/${row.id}`, { method: 'DELETE' });
      setMessage('Token dicabut');
      setTokens(await api<ApiToken[]>('/api/settings/api-tokens'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Token gagal dicabut');
    }
  }

  const localWebhook = `${window.location.origin}/api/internal/zabbix/webhook`;

  return (
    <>
      <form className="form-grid" onSubmit={(event) => void save(event)}>
        <h3 className="full" style={{ margin: 0 }}>Zabbix</h3>
        <label className="field full">
          <span>URL API</span>
          <input value={form.zabbixApiUrl} disabled={!admin} onChange={(event) => setForm({ ...form, zabbixApiUrl: event.target.value })} />
        </label>
        <label className="field">
          <span>Username</span>
          <input value={form.zabbixUser} disabled={!admin} autoComplete="off" onChange={(event) => setForm({ ...form, zabbixUser: event.target.value })} />
        </label>
        <label className="field">
          <span>Password {settings?.zabbixPasswordSet ? '(tersimpan)' : ''}</span>
          <input type="password" autoComplete="new-password" value={form.zabbixPassword} disabled={!admin} placeholder="Kosongkan jika tidak diubah" onChange={(event) => setForm({ ...form, zabbixPassword: event.target.value })} />
        </label>
        <label className="field full">
          <span>API token {settings?.zabbixTokenSet ? '(tersimpan, dipakai lebih dulu daripada password)' : ''}</span>
          <input className="secret" type="password" autoComplete="new-password" value={form.zabbixApiToken} disabled={!admin} placeholder="Kosongkan jika tidak diubah" onChange={(event) => setForm({ ...form, zabbixApiToken: event.target.value })} />
        </label>
        {admin ? (
          <div className="toolbar full">
            <label className="check"><input type="checkbox" checked={form.clearZabbixPassword} onChange={(event) => setForm({ ...form, clearZabbixPassword: event.target.checked })} /> Hapus password tersimpan</label>
            <label className="check"><input type="checkbox" checked={form.clearZabbixToken} onChange={(event) => setForm({ ...form, clearZabbixToken: event.target.checked })} /> Hapus API token tersimpan</label>
          </div>
        ) : null}
        <h3 className="full" style={{ margin: 0 }}>Webhook masuk</h3>
        <label className="field full">
          <span>URL yang dipanggil Zabbix</span>
          <input value={form.webhookUrl} disabled={!admin} placeholder={localWebhook} onChange={(event) => setForm({ ...form, webhookUrl: event.target.value })} />
        </label>
        <div className="field full">
          <span>Endpoint aplikasi</span>
          <div className="toolbar">
            <input className="secret" readOnly value={localWebhook} />
            <button className="btn-ghost" type="button" onClick={() => void copyText(localWebhook, setMessage)}>Salin</button>
            {admin ? <button className="btn-ghost" type="button" onClick={() => setForm({ ...form, webhookUrl: localWebhook })}>Pakai alamat ini</button> : null}
          </div>
          <div className="sub">Header: X-Webhook-Token</div>
        </div>
        <div className="field full">
          <span>Token webhook {settings?.webhookTokenSet ? '' : '(belum ada)'}</span>
          <div className="toolbar">
            <input className="secret" readOnly value={admin ? webhookToken : (settings?.webhookTokenSet ? '••••' : '')} />
            {admin && webhookToken ? <button className="btn-ghost" type="button" onClick={() => void copyText(webhookToken, setMessage)}>Salin</button> : null}
            {admin ? <button className="btn-ghost" type="button" onClick={() => void regenerate()}>Buat ulang</button> : null}
          </div>
        </div>
        {admin ? (
          <div className="toolbar">
            <button className="btn" type="submit">Simpan akses API</button>
            <button className="btn-ghost" type="button" onClick={() => void testConnection()}>Uji koneksi Zabbix</button>
          </div>
        ) : <div className="full sub">Hanya admin yang dapat mengubah koneksi API.</div>}
      </form>
      <div className="statrow">
        <div><span>API</span><strong>{labelStatus(health?.api)}</strong></div>
        <div><span>Database</span><strong>{labelStatus(health?.database)}</strong></div>
        <div><span>Zabbix</span><strong>{health ? `${labelStatus(health.zabbix)}${health.zabbixVersion ? ` ${health.zabbixVersion}` : ''}` : '—'}</strong></div>
        <div><span>Redis</span><strong>{labelStatus(health?.redis)}</strong></div>
      </div>
      {health?.zabbixError ? <div className="error">{health.zabbixError}</div> : null}
      <div className="sub" style={{ padding: '0 16px 8px' }}>Base URL aplikasi: {window.location.origin}/api. Kirim header Authorization: Bearer dan token di bawah, atau token login.</div>
      {admin ? (
        <form className="form-grid" onSubmit={(event) => void createToken(event)}>
          <h3 className="full" style={{ margin: 0 }}>Token API aplikasi</h3>
          <label className="field"><span>Nama</span><input value={tokenForm.name} onChange={(event) => setTokenForm({ ...tokenForm, name: event.target.value })} required /></label>
          <label className="field"><span>Role</span>
            <select value={tokenForm.role} onChange={(event) => setTokenForm({ ...tokenForm, role: event.target.value })}>
              {can(user?.role, 'super_admin') ? <option value="super_admin">Super Admin</option> : null}
              <option value="admin">Admin</option>
              <option value="noc">NOC</option>
              <option value="viewer">Viewer</option>
            </select>
          </label>
          <button className="btn" type="submit">Buat token</button>
        </form>
      ) : null}
      {freshToken ? (
        <div className="token-once">
          <div>Token baru</div>
          <div className="toolbar" style={{ marginTop: 8 }}>
            <input className="secret" readOnly value={freshToken} />
            <button className="btn-ghost" type="button" onClick={() => void copyText(freshToken, setMessage)}>Salin</button>
          </div>
        </div>
      ) : null}
      {admin ? (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Nama</th><th>Role</th><th>Prefix</th><th>Terakhir dipakai</th><th></th></tr></thead>
            <tbody>
              {tokens.length === 0 ? <tr><td colSpan={5}>Belum ada token</td></tr> : tokens.map((row) => (
                <tr key={row.id}>
                  <td>{row.name}</td>
                  <td>{roleLabels[row.role] ?? row.role}</td>
                  <td className="secret">{row.prefix}…</td>
                  <td>{row.lastUsedAt ? new Date(row.lastUsedAt).toLocaleString('id-ID') : 'Belum'}</td>
                  <td><button className="btn-danger" type="button" onClick={() => void revoke(row)}>Cabut</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {error ? <div className="error">{error}</div> : null}
      {message ? <div className="sub" style={{ padding: '0 16px 16px' }}>{message}</div> : null}
    </>
  );
}

type SoundSlot = 'alarm-sound' | 'recovery-sound';

const audioAccept = 'audio/mpeg,audio/wav,audio/ogg,audio/webm,audio/mp4,audio/aac,.mp3,.wav,.ogg,.webm,.m4a,.aac';

function SoundTab() {
  const { user } = useAuth();
  const admin = can(user?.role, 'admin');
  const [form, setForm] = useState({
    soundEnabled: true,
    soundVolume: 80,
    soundName: null as string | null,
    recoverySoundName: null as string | null,
    latencyWarnMs: 150,
    lossWarnPct: 20,
  });
  const [muted, setMuted] = useState(readMuted);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    void api<AppSettings>('/api/settings').then((value) => setForm({
      soundEnabled: value.soundEnabled,
      soundVolume: Number(value.soundVolume) || 0,
      soundName: value.soundName,
      recoverySoundName: value.recoverySoundName ?? null,
      latencyWarnMs: value.latencyWarnMs,
      lossWarnPct: value.lossWarnPct,
    })).catch((err: Error) => setError(err.message));
  }, []);

  async function uploadSound(file: File, slot: SoundSlot) {
    setError('');
    setMessage('');
    if (file.size > 8 * 1024 * 1024) {
      setError('File lebih dari 8 MB');
      return;
    }
    const token = localStorage.getItem('token');
    const body = new FormData();
    body.append('file', file);
    const headers = new Headers();
    if (token) headers.set('Authorization', `Bearer ${token}`);
    const response = await fetch(`/api/settings/${slot}`, { method: 'POST', body, headers });
    const text = await response.text();
    const data = text ? JSON.parse(text) as AppSettings & { message?: string | string[] } : null;
    if (!response.ok) {
      const detail = Array.isArray(data?.message) ? data.message.join(', ') : data?.message;
      setError(detail || 'Nada gagal diunggah');
      return;
    }
    setForm((current) => ({
      ...current,
      soundName: data?.soundName ?? current.soundName,
      recoverySoundName: data?.recoverySoundName ?? current.recoverySoundName,
      soundEnabled: data?.soundEnabled ?? current.soundEnabled,
    }));
    setMessage(slot === 'alarm-sound' ? 'Nada alarm diperbarui' : 'Nada UP diperbarui');
    window.dispatchEvent(new Event('alarm-sound-changed'));
  }

  async function resetSound(slot: SoundSlot) {
    setError('');
    const next = await api<AppSettings>(`/api/settings/${slot}`, { method: 'DELETE' });
    setForm((current) => ({ ...current, soundName: next.soundName, recoverySoundName: next.recoverySoundName ?? null }));
    setMessage(slot === 'alarm-sound' ? 'Nada alarm kembali ke bawaan' : 'Nada UP kembali ke bawaan');
    window.dispatchEvent(new Event('alarm-sound-changed'));
  }

  async function playUploaded(slot: SoundSlot, level: number) {
    const token = localStorage.getItem('token');
    const headers = new Headers();
    if (token) headers.set('Authorization', `Bearer ${token}`);
    const response = await fetch(`/api/settings/${slot}`, { headers });
    if (!response.ok) {
      setError('Nada tidak bisa diputar');
      return;
    }
    const url = URL.createObjectURL(await response.blob());
    const player = new Audio(url);
    player.volume = level;
    player.onended = () => URL.revokeObjectURL(url);
    await player.play();
  }

  async function previewSound() {
    setError('');
    const level = Math.min(100, Math.max(0, Number(form.soundVolume))) / 100;
    if (!form.soundName) {
      const context = new AudioContext();
      const now = context.currentTime;
      const gain = context.createGain();
      const peak = Math.max(0.0002, 0.18 * level);
      gain.gain.setValueAtTime(peak, now);
      gain.connect(context.destination);
      [880, 660, 880].forEach((frequency, index) => {
        const oscillator = context.createOscillator();
        oscillator.type = 'sine';
        oscillator.frequency.value = frequency;
        oscillator.connect(gain);
        const start = now + index * 0.24;
        oscillator.start(start);
        oscillator.stop(start + 0.18);
      });
      window.setTimeout(() => void context.close(), 1200);
      return;
    }
    await playUploaded('alarm-sound', level);
  }

  async function previewRecovery() {
    setError('');
    const level = Math.min(100, Math.max(0, Number(form.soundVolume))) / 100;
    if (form.recoverySoundName) {
      await playUploaded('recovery-sound', level);
      return;
    }
    const context = new AudioContext();
    playRecovery(context, level);
    window.setTimeout(() => void context.close(), 1500);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setMessage('');
    setError('');
    try {
      const saved = await api<AppSettings>('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({
          soundEnabled: form.soundEnabled,
          soundVolume: Number(form.soundVolume),
          latencyWarnMs: Number(form.latencyWarnMs),
          lossWarnPct: Number(form.lossWarnPct),
        }),
      });
      setForm((current) => ({ ...current, ...saved, soundVolume: Number(saved.soundVolume) || 0 }));
      setMessage('Suara dan ambang alarm disimpan');
      window.dispatchEvent(new Event('alarm-sound-changed'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Pengaturan suara gagal disimpan');
    }
  }

  return (
    <form className="form-grid" onSubmit={(event) => void submit(event)}>
      <label className="field check">
        <input type="checkbox" checked={form.soundEnabled} disabled={!admin} onChange={(event) => setForm({ ...form, soundEnabled: event.target.checked })} />
        Aktifkan suara alarm
      </label>
      <label className="field check">
        <input type="checkbox" checked={muted} onChange={(event) => { setMuted(event.target.checked); saveMuted(event.target.checked); }} />
        Bisukan di browser ini
      </label>
      <label className="field">
        <span>Volume ({form.soundVolume}%)</span>
        <input type="range" min={0} max={100} value={form.soundVolume} disabled={!admin} onChange={(event) => setForm({ ...form, soundVolume: Number(event.target.value) })} />
      </label>
      <label className="field">
        <span>Ambang latency (ms)</span>
        <input type="number" min={1} max={5000} value={form.latencyWarnMs} disabled={!admin} onChange={(event) => setForm({ ...form, latencyWarnMs: Number(event.target.value) })} />
      </label>
      <label className="field">
        <span>Ambang packet loss (%)</span>
        <input type="number" min={1} max={100} value={form.lossWarnPct} disabled={!admin} onChange={(event) => setForm({ ...form, lossWarnPct: Number(event.target.value) })} />
      </label>
      <div className="field full">
        <span>Nada alarm (perangkat DOWN)</span>
        <div className="sub">{form.soundName ? `Dipakai: ${form.soundName}` : 'Nada bawaan'}</div>
        <div className="toolbar">
          <input
            type="file"
            accept={audioAccept}
            disabled={!admin}
            onChange={(event) => {
              const selected = event.target.files?.[0];
              event.target.value = '';
              if (selected) void uploadSound(selected, 'alarm-sound');
            }}
          />
          <button className="btn-ghost" type="button" onClick={() => void previewSound()}>Dengarkan</button>
          {form.soundName ? <button className="btn-ghost" type="button" disabled={!admin} onClick={() => void resetSound('alarm-sound')}>Nada bawaan</button> : null}
        </div>
      </div>
      <div className="field full">
        <span>Nada perangkat UP</span>
        <div className="sub">{form.recoverySoundName ? `Dipakai: ${form.recoverySoundName}` : 'Nada bawaan'}</div>
        <div className="toolbar">
          <input
            type="file"
            accept={audioAccept}
            disabled={!admin}
            onChange={(event) => {
              const selected = event.target.files?.[0];
              event.target.value = '';
              if (selected) void uploadSound(selected, 'recovery-sound');
            }}
          />
          <button className="btn-ghost" type="button" onClick={() => void previewRecovery()}>Dengarkan</button>
          {form.recoverySoundName ? <button className="btn-ghost" type="button" disabled={!admin} onClick={() => void resetSound('recovery-sound')}>Nada bawaan</button> : null}
        </div>
      </div>
      <div className="full sub">
        Nada berulang terus selama ada perangkat DOWN, sampai perangkat UP atau alarm di-acknowledge. Saat perangkat kembali UP, nada pendek diputar sekali. Ambang latency dan packet loss berlaku untuk semua perangkat.
      </div>
      {admin ? <button className="btn" type="submit">Simpan suara</button> : <div className="full sub">Hanya admin yang dapat mengubah suara dan ambang alarm. Bisukan tetap bisa dipakai di browser ini.</div>}
      {error ? <div className="error full">{error}</div> : null}
      {message ? <div className="full sub">{message}</div> : null}
    </form>
  );
}

const mrtgColorFields = [
  ['mrtgColorIn', 'Warna masuk'],
  ['mrtgColorOut', 'Warna keluar'],
  ['mrtgColorThreshold', 'Warna ambang'],
  ['mrtgColorProbe', 'Warna probe'],
  ['mrtgColorLoss', 'Warna packet loss'],
] as const;

function MrtgTab() {
  const { user } = useAuth();
  const admin = can(user?.role, 'admin');
  const [form, setForm] = useState({
    mrtgColorIn: '#1f8a3b',
    mrtgColorOut: '#1d4e89',
    mrtgColorThreshold: '#c42318',
    mrtgColorProbe: '#1f8a3b',
    mrtgColorLoss: '#b45309',
    mrtgThresholdPct: 95,
  });
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    void api<AppSettings>('/api/settings').then((value) => setForm({
      mrtgColorIn: value.mrtgColorIn,
      mrtgColorOut: value.mrtgColorOut,
      mrtgColorThreshold: value.mrtgColorThreshold,
      mrtgColorProbe: value.mrtgColorProbe,
      mrtgColorLoss: value.mrtgColorLoss,
      mrtgThresholdPct: value.mrtgThresholdPct,
    })).catch((err: Error) => setError(err.message));
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setMessage('');
    setError('');
    const thresholdPct = Number(form.mrtgThresholdPct);
    if (!Number.isInteger(thresholdPct) || thresholdPct < 1 || thresholdPct > 100) {
      setError('Ambang diisi 1 sampai 100 persen');
      return;
    }
    try {
      const saved = await api<AppSettings>('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ ...form, mrtgThresholdPct: thresholdPct }),
      });
      setForm({
        mrtgColorIn: saved.mrtgColorIn,
        mrtgColorOut: saved.mrtgColorOut,
        mrtgColorThreshold: saved.mrtgColorThreshold,
        mrtgColorProbe: saved.mrtgColorProbe,
        mrtgColorLoss: saved.mrtgColorLoss,
        mrtgThresholdPct: saved.mrtgThresholdPct,
      });
      setMessage('Pengaturan MRTG disimpan');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Pengaturan MRTG gagal disimpan');
    }
  }

  return (
    <form className="form-grid" onSubmit={(event) => void submit(event)}>
      <h3>Warna grafik</h3>
      {mrtgColorFields.map(([key, label]) => (
        <label className="field" key={key}>
          <span>{label}</span>
          <span className="color-field">
            <input type="color" value={form[key]} disabled={!admin} onChange={(event) => setForm({ ...form, [key]: event.target.value })} />
            <input value={form[key]} disabled={!admin} onChange={(event) => setForm({ ...form, [key]: event.target.value })} />
          </span>
        </label>
      ))}
      <h3>Persentase penagihan</h3>
      <label className="field">
        <span>Persen dari pemakaian maksimum (%)</span>
        <input type="number" min={1} max={100} value={form.mrtgThresholdPct} disabled={!admin} onChange={(event) => setForm({ ...form, mrtgThresholdPct: Number(event.target.value) })} />
      </label>
      <div className="full sub">
        100% adalah max masuk (RX) dan max keluar (TX) pada rentang grafik. {form.mrtgThresholdPct}% dihitung dari masing-masing max itu.
        Nilai penagihan memakai arah yang lebih tinggi, misalnya max keluar 500 Mbps × {form.mrtgThresholdPct}% = {(500 * Number(form.mrtgThresholdPct)) / 100} Mbps.
      </div>
      {error ? <div className="error">{error}</div> : null}
      {message ? <div className="sub">{message}</div> : null}
      {admin ? <button className="btn" type="submit">Simpan MRTG</button> : null}
    </form>
  );
}

function labelStatus(value?: string) {
  if (value === 'up') return 'Terhubung';
  if (value === 'down') return 'Putus';
  if (value === 'skipped') return 'Tidak dipakai';
  return '—';
}

async function copyText(value: string, setMessage: (value: string) => void) {
  await navigator.clipboard.writeText(value);
  setMessage('Disalin');
}
