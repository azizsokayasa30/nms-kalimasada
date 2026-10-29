import { FormEvent, useEffect, useRef, useState, type ReactNode } from 'react';
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
import { PrefActions, PrefFlash, PrefRow, PrefSection, PrefSwitch } from '../components/Pref';
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
  { id: 'tampilan', label: 'Tampilan', icon: <DisplayIcon /> },
  { id: 'mrtg', label: 'MRTG', icon: <GraphIcon /> },
  { id: 'pengguna', label: 'Pengguna', icon: <UsersIcon /> },
  { id: 'akses', label: 'Akses API', icon: <KeyIcon /> },
  { id: 'suara', label: 'Suara', icon: <VolumeIcon /> },
  { id: 'notifikasi', label: 'Notifikasi', icon: <SendIcon /> },
  { id: 'jaringan', label: 'Jaringan', icon: <GlobeIcon />, role: 'admin' },
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
            {item.icon}
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

const themeOptions = [
  { value: 'light', label: 'Terang', icon: <SunIcon /> },
  { value: 'dark', label: 'Gelap', icon: <MoonIcon /> },
  { value: 'system', label: 'Sistem', icon: <DisplayIcon /> },
] as const;

function DisplayTab() {
  const [theme, setTheme] = useState<ThemeMode>(readTheme);
  const [refreshSeconds, setRefreshSeconds] = useState(() => String(readRefreshSeconds()));
  const [animations, setAnimations] = useState(readAnimations);
  const [compact, setCompact] = useState(readCompact);

  useEffect(() => {
    const sync = () => {
      setTheme(readTheme());
      setRefreshSeconds(String(readRefreshSeconds()));
      setAnimations(readAnimations());
      setCompact(readCompact());
    };
    window.addEventListener(DISPLAY_EVENT, sync);
    return () => window.removeEventListener(DISPLAY_EVENT, sync);
  }, []);

  function commitRefresh() {
    const seconds = Math.min(120, Math.max(5, Math.round(Number(refreshSeconds) || 15)));
    setRefreshSeconds(String(seconds));
    saveDisplay({ refreshSeconds: seconds });
  }

  return (
    <div className="pref">
      <div className="pref-list">
        <PrefRow title="Tema" description="Warna tampilan dashboard">
          <div className="pref-segment" role="radiogroup" aria-label="Tema">
            {themeOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={theme === option.value}
                className={theme === option.value ? 'on' : ''}
                onClick={() => { setTheme(option.value); saveDisplay({ theme: option.value }); }}
              >
                {option.icon}
                {option.label}
              </button>
            ))}
          </div>
        </PrefRow>
        <PrefRow title="Penyegaran data" description="Interval muat ulang otomatis, 5–120 detik" htmlFor="pref-refresh">
          <div className="pref-number">
            <input
              id="pref-refresh"
              type="number"
              min={5}
              max={120}
              value={refreshSeconds}
              onChange={(event) => setRefreshSeconds(event.target.value)}
              onBlur={commitRefresh}
              onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
            />
            <span>detik</span>
          </div>
        </PrefRow>
        <PrefSwitch
          title="Animasi alarm"
          description="Kedipan pada status dan alarm yang DOWN"
          checked={animations}
          onChange={(next) => { setAnimations(next); saveDisplay({ animations: next }); }}
        />
        <PrefSwitch
          title="Tampilan rapat"
          description="Baris tabel dan kartu lebih padat"
          checked={compact}
          onChange={(next) => { setCompact(next); saveDisplay({ compact: next }); }}
        />
      </div>
      <p className="pref-note">Tersimpan otomatis di browser ini.</p>
    </div>
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
  const formRef = useRef<HTMLFormElement>(null);

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

  function edit(row: UserRow) {
    setDraft({ id: row.id, name: row.name, email: row.email, password: '', role: row.role });
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  return (
    <div className="pref">
      {!superAdmin ? (
        <form onSubmit={(event) => void saveMe(event)}>
          <PrefSection title="Akun saya" description="Ubah nama, email, atau password Anda">
            <div className="pref-fields">
              <label className="field"><span>Nama</span><input value={me.name} onChange={(event) => setMe({ ...me, name: event.target.value })} required /></label>
              <label className="field"><span>Email</span><input type="email" value={me.email} onChange={(event) => setMe({ ...me, email: event.target.value })} required /></label>
              <label className="field"><span>Password saat ini</span><input type="password" autoComplete="current-password" value={me.currentPassword} onChange={(event) => setMe({ ...me, currentPassword: event.target.value })} /></label>
              <label className="field"><span>Password baru</span><input type="password" autoComplete="new-password" placeholder="Minimal 8 karakter" value={me.newPassword} onChange={(event) => setMe({ ...me, newPassword: event.target.value })} /></label>
            </div>
            <PrefActions><button className="btn" type="submit">Simpan akun</button></PrefActions>
          </PrefSection>
          <p className="pref-note">Daftar pengguna hanya dapat dikelola Super Admin.</p>
        </form>
      ) : (
        <>
          <PrefSection title="Daftar pengguna" description={`${rows.length} pengguna terdaftar`}>
            <div className="pref-list">
              {rows.map((row) => (
                <div className="pref-item" key={row.id}>
                  <span className="pref-avatar" aria-hidden="true">{initials(row.name)}</span>
                  <div className="pref-item-main">
                    <strong>{row.name}{row.id === user?.id ? <em> · Anda</em> : null}</strong>
                    <span>{row.email}</span>
                  </div>
                  <span className="badge role">{roleLabels[row.role] ?? row.role}</span>
                  <div className="pref-item-actions">
                    <button className="btn-ghost btn-sm" type="button" onClick={() => edit(row)}>Ubah</button>
                    {row.id !== user?.id ? <button className="btn-danger btn-sm" type="button" onClick={() => void removeUser(row)}>Hapus</button> : null}
                  </div>
                </div>
              ))}
            </div>
          </PrefSection>
          <form ref={formRef} onSubmit={(event) => void saveUser(event)}>
            <PrefSection
              title={draft.id ? 'Ubah pengguna' : 'Tambah pengguna'}
              description={draft.id ? 'Kosongkan password jika tidak diganti' : 'Buat akun baru untuk tim'}
            >
              <div className="pref-fields">
                <label className="field"><span>Nama</span><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} required /></label>
                <label className="field"><span>Email</span><input type="email" value={draft.email} onChange={(event) => setDraft({ ...draft, email: event.target.value })} required /></label>
                <label className="field">
                  <span>{draft.id ? 'Password baru' : 'Password'}</span>
                  <input type="password" autoComplete="new-password" placeholder="Minimal 8 karakter" value={draft.password} onChange={(event) => setDraft({ ...draft, password: event.target.value })} required={!draft.id} />
                </label>
                <label className="field"><span>Role</span>
                  <select value={draft.role} onChange={(event) => setDraft({ ...draft, role: event.target.value })}>
                    <option value="super_admin">Super Admin</option>
                    <option value="admin">Admin</option>
                    <option value="noc">NOC</option>
                    <option value="viewer">Viewer</option>
                  </select>
                </label>
              </div>
              <PrefActions>
                {draft.id ? <button className="btn-ghost" type="button" onClick={() => setDraft({ id: '', name: '', email: '', password: '', role: 'noc' })}>Batal</button> : null}
                <button className="btn" type="submit">{draft.id ? 'Simpan perubahan' : 'Tambah pengguna'}</button>
              </PrefActions>
            </PrefSection>
          </form>
        </>
      )}
      <PrefFlash message={message} error={error} />
    </div>
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
    <div className="pref">
      <PrefSection title="Status layanan" description="Kondisi koneksi backend saat ini">
        <div className="pref-stats">
          <StatusTile label="API" value={health?.api} />
          <StatusTile label="Database" value={health?.database} />
          <StatusTile label="Zabbix" value={health?.zabbix} extra={health?.zabbixVersion} />
          <StatusTile label="Redis" value={health?.redis} />
        </div>
        {health?.zabbixError ? <p className="pref-hint bad">{health.zabbixError}</p> : null}
      </PrefSection>
      <form onSubmit={(event) => void save(event)}>
        <PrefSection title="Koneksi Zabbix" description="Dipakai NMS untuk membaca status dan mengelola host">
          <div className="pref-fields">
            <label className="field full">
              <span>URL API</span>
              <input value={form.zabbixApiUrl} disabled={!admin} onChange={(event) => setForm({ ...form, zabbixApiUrl: event.target.value })} />
            </label>
            <label className="field">
              <span>Username</span>
              <input value={form.zabbixUser} disabled={!admin} autoComplete="off" onChange={(event) => setForm({ ...form, zabbixUser: event.target.value })} />
            </label>
            <label className="field">
              <span>Password{settings?.zabbixPasswordSet ? ' · tersimpan' : ''}</span>
              <input type="password" autoComplete="new-password" value={form.zabbixPassword} disabled={!admin} placeholder="Kosongkan jika tidak diubah" onChange={(event) => setForm({ ...form, zabbixPassword: event.target.value })} />
            </label>
            <label className="field full">
              <span>API token{settings?.zabbixTokenSet ? ' · tersimpan, dipakai lebih dulu daripada password' : ''}</span>
              <input className="secret" type="password" autoComplete="new-password" value={form.zabbixApiToken} disabled={!admin} placeholder="Kosongkan jika tidak diubah" onChange={(event) => setForm({ ...form, zabbixApiToken: event.target.value })} />
            </label>
            {admin && (settings?.zabbixPasswordSet || settings?.zabbixTokenSet) ? (
              <div className="full chip-checks">
                {settings?.zabbixPasswordSet ? (
                  <label className="chip-check"><input type="checkbox" checked={form.clearZabbixPassword} onChange={(event) => setForm({ ...form, clearZabbixPassword: event.target.checked })} />Hapus password tersimpan</label>
                ) : null}
                {settings?.zabbixTokenSet ? (
                  <label className="chip-check"><input type="checkbox" checked={form.clearZabbixToken} onChange={(event) => setForm({ ...form, clearZabbixToken: event.target.checked })} />Hapus API token tersimpan</label>
                ) : null}
              </div>
            ) : null}
          </div>
        </PrefSection>
        <PrefSection title="Webhook masuk" description="Alamat yang dipanggil Zabbix untuk mengirim alarm ke NMS">
          <div className="pref-fields">
            <label className="field full">
              <span>URL yang dipanggil Zabbix</span>
              <input value={form.webhookUrl} disabled={!admin} placeholder={localWebhook} onChange={(event) => setForm({ ...form, webhookUrl: event.target.value })} />
            </label>
            <div className="field full">
              <span>Endpoint aplikasi</span>
              <div className="pref-inline">
                <input className="secret" readOnly value={localWebhook} />
                <button className="btn-ghost" type="button" onClick={() => void copyText(localWebhook, setMessage)}>Salin</button>
                {admin ? <button className="btn-ghost" type="button" onClick={() => setForm({ ...form, webhookUrl: localWebhook })}>Pakai</button> : null}
              </div>
            </div>
            <div className="field full">
              <span>Token webhook{settings?.webhookTokenSet ? '' : ' · belum ada'} · dikirim di header X-Webhook-Token</span>
              <div className="pref-inline">
                <input className="secret" readOnly value={admin ? webhookToken : (settings?.webhookTokenSet ? '••••' : '')} />
                {admin && webhookToken ? <button className="btn-ghost" type="button" onClick={() => void copyText(webhookToken, setMessage)}>Salin</button> : null}
                {admin ? <button className="btn-ghost" type="button" onClick={() => void regenerate()}>Buat ulang</button> : null}
              </div>
            </div>
          </div>
          {admin ? (
            <PrefActions>
              <button className="btn-ghost" type="button" onClick={() => void testConnection()}>Uji koneksi Zabbix</button>
              <button className="btn" type="submit">Simpan akses API</button>
            </PrefActions>
          ) : <p className="pref-note">Hanya admin yang dapat mengubah koneksi API.</p>}
        </PrefSection>
      </form>
      <PrefSection
        title="Token API aplikasi"
        description={<>Untuk sistem lain. Base URL <code>{window.location.origin}/api</code>, kirim header <code>Authorization: Bearer &lt;token&gt;</code>.</>}
      >
        {admin ? (
          <>
            <form className="pref-inline pref-pad" onSubmit={(event) => void createToken(event)}>
              <input aria-label="Nama token" placeholder="Nama token, misalnya Grafana" value={tokenForm.name} onChange={(event) => setTokenForm({ ...tokenForm, name: event.target.value })} required />
              <select aria-label="Role token" value={tokenForm.role} onChange={(event) => setTokenForm({ ...tokenForm, role: event.target.value })}>
                {can(user?.role, 'super_admin') ? <option value="super_admin">Super Admin</option> : null}
                <option value="admin">Admin</option>
                <option value="noc">NOC</option>
                <option value="viewer">Viewer</option>
              </select>
              <button className="btn" type="submit">Buat token</button>
            </form>
            {freshToken ? (
              <div className="token-once">
                <div>Token baru, salin sekarang karena tidak ditampilkan lagi</div>
                <div className="pref-inline" style={{ marginTop: 8 }}>
                  <input className="secret" readOnly value={freshToken} />
                  <button className="btn-ghost" type="button" onClick={() => void copyText(freshToken, setMessage)}>Salin</button>
                </div>
              </div>
            ) : null}
            <div className="pref-list">
              {tokens.length === 0 ? <p className="pref-empty">Belum ada token</p> : tokens.map((row) => (
                <div className="pref-item" key={row.id}>
                  <span className="pref-avatar" aria-hidden="true"><KeyIcon /></span>
                  <div className="pref-item-main">
                    <strong>{row.name}</strong>
                    <span><code>{row.prefix}…</code> · {row.lastUsedAt ? `Terakhir dipakai ${new Date(row.lastUsedAt).toLocaleString('id-ID')}` : 'Belum pernah dipakai'}</span>
                  </div>
                  <span className="badge role">{roleLabels[row.role] ?? row.role}</span>
                  <div className="pref-item-actions">
                    <button className="btn-danger btn-sm" type="button" onClick={() => void revoke(row)}>Cabut</button>
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : <p className="pref-note">Hanya admin yang dapat membuat token.</p>}
      </PrefSection>
      <PrefFlash message={message} error={error} />
    </div>
  );
}

function StatusTile({ label, value, extra }: { label: string; value?: string; extra?: string | null }) {
  const tone = value === 'up' ? 'up' : value === 'down' ? 'down' : 'unknown';
  return (
    <div className={`pref-stat ${tone}`}>
      <span>{label}</span>
      <strong><i aria-hidden="true" />{labelStatus(value)}</strong>
      {extra ? <small>Versi {extra}</small> : null}
    </div>
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
    <form className="pref" onSubmit={(event) => void submit(event)}>
      <PrefSection title="Suara alarm" description="Diputar di browser yang sedang membuka dashboard">
        <div className="pref-list">
          <PrefSwitch
            title="Aktifkan suara alarm"
            description="Berlaku untuk semua pengguna"
            checked={form.soundEnabled}
            disabled={!admin}
            onChange={(next) => setForm({ ...form, soundEnabled: next })}
          />
          <PrefSwitch
            title="Bisukan di browser ini"
            description="Hanya untuk browser ini selama sesi berjalan"
            checked={muted}
            onChange={(next) => { setMuted(next); saveMuted(next); }}
          />
          <PrefRow title="Volume" htmlFor="sound-volume">
            <div className="pref-range">
              <input id="sound-volume" type="range" min={0} max={100} value={form.soundVolume} disabled={!admin} onChange={(event) => setForm({ ...form, soundVolume: Number(event.target.value) })} />
              <b>{form.soundVolume}%</b>
            </div>
          </PrefRow>
        </div>
      </PrefSection>
      <PrefSection title="Nada" description="MP3, WAV, OGG, atau M4A, maksimal 8 MB">
        <div className="pref-list">
          <SoundRow
            title="Perangkat DOWN"
            fileName={form.soundName}
            admin={admin}
            onPreview={() => void previewSound()}
            onUpload={(file) => void uploadSound(file, 'alarm-sound')}
            onReset={() => void resetSound('alarm-sound')}
          />
          <SoundRow
            title="Perangkat UP"
            fileName={form.recoverySoundName}
            admin={admin}
            onPreview={() => void previewRecovery()}
            onUpload={(file) => void uploadSound(file, 'recovery-sound')}
            onReset={() => void resetSound('recovery-sound')}
          />
        </div>
        <p className="pref-hint">Nada DOWN berulang selama ada perangkat DOWN, sampai perangkat UP atau alarm di-acknowledge. Nada UP diputar sekali.</p>
      </PrefSection>
      <PrefSection title="Ambang peringatan" description="Berlaku untuk semua perangkat">
        <div className="pref-list">
          <PrefRow title="Latency" description="Peringatan jika latency melebihi nilai ini" htmlFor="warn-latency">
            <div className="pref-number">
              <input id="warn-latency" type="number" min={1} max={5000} value={form.latencyWarnMs} disabled={!admin} onChange={(event) => setForm({ ...form, latencyWarnMs: Number(event.target.value) })} />
              <span>ms</span>
            </div>
          </PrefRow>
          <PrefRow title="Packet loss" description="Peringatan jika packet loss melebihi nilai ini" htmlFor="warn-loss">
            <div className="pref-number">
              <input id="warn-loss" type="number" min={1} max={100} value={form.lossWarnPct} disabled={!admin} onChange={(event) => setForm({ ...form, lossWarnPct: Number(event.target.value) })} />
              <span>%</span>
            </div>
          </PrefRow>
        </div>
      </PrefSection>
      {admin ? (
        <PrefActions><button className="btn" type="submit">Simpan suara</button></PrefActions>
      ) : <p className="pref-note">Hanya admin yang dapat mengubah suara dan ambang alarm. Bisukan tetap bisa dipakai di browser ini.</p>}
      <PrefFlash message={message} error={error} />
    </form>
  );
}

function SoundRow({
  title,
  fileName,
  admin,
  onPreview,
  onUpload,
  onReset,
}: {
  title: string;
  fileName: string | null;
  admin: boolean;
  onPreview: () => void;
  onUpload: (file: File) => void;
  onReset: () => void;
}) {
  return (
    <PrefRow title={title} description={fileName ?? 'Nada bawaan'}>
      <button className="btn-ghost btn-sm" type="button" onClick={onPreview}>Dengarkan</button>
      {admin ? (
        <label className="btn-ghost btn-sm file-btn">
          Ganti
          <input
            type="file"
            accept={audioAccept}
            hidden
            onChange={(event) => {
              const selected = event.target.files?.[0];
              event.target.value = '';
              if (selected) onUpload(selected);
            }}
          />
        </label>
      ) : null}
      {admin && fileName ? <button className="btn-ghost btn-sm" type="button" onClick={onReset}>Bawaan</button> : null}
    </PrefRow>
  );
}

const mrtgColorFields = [
  ['mrtgColorIn', 'Trafik masuk (RX)'],
  ['mrtgColorOut', 'Trafik keluar (TX)'],
  ['mrtgColorThreshold', 'Garis ambang'],
  ['mrtgColorProbe', 'Probe'],
  ['mrtgColorLoss', 'Packet loss'],
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
    <form className="pref" onSubmit={(event) => void submit(event)}>
      <PrefSection title="Warna grafik" description="Warna garis pada grafik trafik MRTG">
        <div className="pref-list">
          {mrtgColorFields.map(([key, label]) => (
            <PrefRow key={key} title={label} htmlFor={`mrtg-${key}`}>
              <span className="pref-color">
                <input type="color" aria-label={label} value={form[key]} disabled={!admin} onChange={(event) => setForm({ ...form, [key]: event.target.value })} />
                <input id={`mrtg-${key}`} value={form[key]} disabled={!admin} onChange={(event) => setForm({ ...form, [key]: event.target.value })} />
              </span>
            </PrefRow>
          ))}
        </div>
      </PrefSection>
      <PrefSection title="Penagihan" description="Batas pemakaian yang ditandai pada grafik">
        <div className="pref-list">
          <PrefRow title="Persentase dari pemakaian maksimum" description="Dihitung dari max masuk (RX) dan max keluar (TX) pada rentang grafik" htmlFor="mrtg-threshold">
            <div className="pref-number">
              <input id="mrtg-threshold" type="number" min={1} max={100} value={form.mrtgThresholdPct} disabled={!admin} onChange={(event) => setForm({ ...form, mrtgThresholdPct: Number(event.target.value) })} />
              <span>%</span>
            </div>
          </PrefRow>
        </div>
        <p className="pref-hint">
          Contoh: max keluar 500 Mbps × {form.mrtgThresholdPct}% = {(500 * Number(form.mrtgThresholdPct)) / 100} Mbps. Nilai penagihan memakai arah yang lebih tinggi antara masuk dan keluar.
        </p>
      </PrefSection>
      {admin ? <PrefActions><button className="btn" type="submit">Simpan MRTG</button></PrefActions> : null}
      <PrefFlash message={message} error={error} />
    </form>
  );
}

function labelStatus(value?: string) {
  if (value === 'up') return 'Terhubung';
  if (value === 'down') return 'Putus';
  if (value === 'skipped') return 'Tidak dipakai';
  return '—';
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase();
}

async function copyText(value: string, setMessage: (value: string) => void) {
  await navigator.clipboard.writeText(value);
  setMessage('Disalin');
}

function TabSvg({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

function DisplayIcon() {
  return (
    <TabSvg>
      <rect x="2.5" y="3.5" width="19" height="13" rx="2.5" />
      <path d="M8 20.5h8M12 16.5v4" />
    </TabSvg>
  );
}

function SunIcon() {
  return (
    <TabSvg>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4" />
    </TabSvg>
  );
}

function MoonIcon() {
  return (
    <TabSvg>
      <path d="M20.5 14.1A8.5 8.5 0 1 1 9.9 3.5a6.6 6.6 0 0 0 10.6 10.6z" />
    </TabSvg>
  );
}

function GraphIcon() {
  return (
    <TabSvg>
      <path d="M3 3v16a2 2 0 0 0 2 2h16" />
      <path d="M7 16c.5-2 1.5-7 4-7 2 0 2 3 4 3 2.5 0 4.5-5 5-7" />
    </TabSvg>
  );
}

function UsersIcon() {
  return (
    <TabSvg>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.2a6.5 6.5 0 0 1 3.5 5.8" />
    </TabSvg>
  );
}

function KeyIcon() {
  return (
    <TabSvg>
      <circle cx="7.5" cy="15.5" r="4.5" />
      <path d="M10.7 12.3 20 3M16.5 6.5l3 3M14 9l2.5 2.5" />
    </TabSvg>
  );
}

function VolumeIcon() {
  return (
    <TabSvg>
      <path d="M11 4.7a.7.7 0 0 0-1.2-.5L6.4 7.6a1.4 1.4 0 0 1-1 .4H3.5a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h1.9a1.4 1.4 0 0 1 1 .4l3.4 3.4a.7.7 0 0 0 1.2-.5z" />
      <path d="M15.5 9a4 4 0 0 1 0 6M18.7 5.8a8.5 8.5 0 0 1 0 12.4" />
    </TabSvg>
  );
}

function SendIcon() {
  return (
    <TabSvg>
      <path d="M21.5 2.5 11 13" />
      <path d="m21.5 2.5-6.7 19-3.8-8.5-8.5-3.8z" />
    </TabSvg>
  );
}

function GlobeIcon() {
  return (
    <TabSvg>
      <circle cx="12" cy="12" r="9.5" />
      <path d="M2.5 12h19M12 2.5a14.5 14.5 0 0 1 0 19 14.5 14.5 0 0 1 0-19" />
    </TabSvg>
  );
}
