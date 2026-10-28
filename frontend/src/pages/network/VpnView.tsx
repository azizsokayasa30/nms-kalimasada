import { FormEvent, useState } from 'react';
import { vpnLabels, vpnPeerCommand, type NetSnapshot, type TestRequest, type VpnRow, type VpnType } from './model';
import { Rates, StateBadge, Toggle } from './parts';

type Props = {
  data: NetSnapshot;
  editor: boolean;
  busy: boolean;
  run: (path: string, method: string, body?: unknown) => Promise<boolean>;
  onTest: (request: TestRequest) => void;
  onMessage: (text: string) => void;
};

type Draft = {
  id: string;
  type: VpnType;
  name: string;
  networks: string;
  address: string;
  endpoint: string;
  peerPublicKey: string;
  presharedKey: string;
  keepalive: string;
  listenPort: string;
  mtu: string;
  regenerateKey: boolean;
  config: string;
  username: string;
  password: string;
  server: string;
  useIpsec: boolean;
  psk: string;
  l2tpMtu: string;
};

const blank: Draft = {
  id: '',
  type: 'wireguard',
  name: '',
  networks: '',
  address: '',
  endpoint: '',
  peerPublicKey: '',
  presharedKey: '',
  keepalive: '25',
  listenPort: '',
  mtu: '',
  regenerateKey: false,
  config: '',
  username: '',
  password: '',
  server: '',
  useIpsec: true,
  psk: '',
  l2tpMtu: '1400',
};

function fromRow(row: VpnRow): Draft {
  return {
    ...blank,
    id: row.id,
    type: row.type,
    name: row.name,
    networks: row.networks.join(', '),
    address: row.address ?? '',
    endpoint: row.endpoint ?? '',
    peerPublicKey: row.peerPublicKey ?? '',
    keepalive: String(row.keepalive ?? 25),
    listenPort: row.listenPort ? String(row.listenPort) : '',
    mtu: row.type === 'wireguard' && row.mtu ? String(row.mtu) : '',
    username: row.username ?? '',
    server: row.server ?? '',
    useIpsec: Boolean(row.pskSet),
    l2tpMtu: row.type === 'l2tp' && row.mtu ? String(row.mtu) : '1400',
  };
}

function payload(draft: Draft) {
  const common = { type: draft.type, name: draft.name, networks: draft.networks };
  if (draft.type === 'wireguard') {
    return {
      ...common,
      address: draft.address.trim(),
      endpoint: draft.endpoint.trim(),
      peerPublicKey: draft.peerPublicKey.trim(),
      presharedKey: draft.presharedKey.trim(),
      keepalive: draft.keepalive,
      listenPort: draft.listenPort,
      mtu: draft.mtu,
      regenerateKey: draft.regenerateKey,
    };
  }
  if (draft.type === 'openvpn') {
    return { ...common, config: draft.config, username: draft.username, password: draft.password };
  }
  return {
    ...common,
    server: draft.server.trim(),
    username: draft.username,
    password: draft.password,
    useIpsec: draft.useIpsec,
    psk: draft.useIpsec ? draft.psk : '',
    mtu: draft.l2tpMtu,
  };
}

async function copy(text: string, onMessage: (text: string) => void) {
  try {
    await navigator.clipboard.writeText(text);
    onMessage('Disalin');
  } catch {
    window.prompt('Salin teks ini:', text);
  }
}

export function VpnView({ data, editor, busy, run, onTest, onMessage }: Props) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const byName = new Map(data.interfaces.map((item) => [item.name, item]));
  const editing = data.vpns.find((row) => row.id === draft?.id);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    const ok = draft.id
      ? await run(`/api/network/vpns/${draft.id}`, 'PUT', payload(draft))
      : await run('/api/network/vpns', 'POST', payload(draft));
    if (ok) setDraft(null);
  }

  async function remove(row: VpnRow) {
    if (!window.confirm(`Hapus VPN ${row.name} (${row.iface})? Rute lewat VPN ini ikut terhapus.`)) return;
    await run(`/api/network/vpns/${row.id}`, 'DELETE');
  }

  function readFile(file: File) {
    if (!draft) return;
    void file.text().then((config) => setDraft({ ...draft, config, name: draft.name || file.name.replace(/\.(ovpn|conf)$/i, '') }));
  }

  const set = (patch: Partial<Draft>) => setDraft((current) => (current ? { ...current, ...patch } : current));
  const secretHint = (saved?: boolean) => (saved ? 'Tersimpan — kosongkan bila tetap' : '');

  return (
    <>
      {editor ? (
        <div className="net-bar">
          {draft ? null : <button className="btn" type="button" onClick={() => { setAdvanced(false); setDraft(blank); }}>+ Tambah VPN</button>}
        </div>
      ) : null}
      {draft ? (
        <form className="form-grid net-form" onSubmit={(event) => void save(event)}>
          <div className="field full">
            <span>Jenis</span>
            <div className="segment">
              {(Object.keys(vpnLabels) as VpnType[]).map((type) => (
                <button key={type} type="button" className={`btn-ghost ${draft.type === type ? 'on' : ''}`} disabled={Boolean(draft.id)} onClick={() => set({ type })}>{vpnLabels[type]}</button>
              ))}
            </div>
          </div>
          <label className="field">
            <span>Nama</span>
            <input value={draft.name} maxLength={40} placeholder="POP Selomerto" onChange={(event) => set({ name: event.target.value })} required autoFocus />
          </label>
          <label className="field">
            <span>Jaringan di seberang</span>
            <input value={draft.networks} placeholder="192.168.88.0/24, 10.10.0.0/16" onChange={(event) => set({ networks: event.target.value })} />
          </label>

          {draft.type === 'wireguard' ? (
            <>
              <label className="field">
                <span>IP tunnel NMS</span>
                <input value={draft.address} placeholder="10.99.0.2/30" onChange={(event) => set({ address: event.target.value })} required />
              </label>
              <label className="field">
                <span>Endpoint server</span>
                <input value={draft.endpoint} placeholder="vpn.kantor.id:13231" onChange={(event) => set({ endpoint: event.target.value })} />
              </label>
              <label className="field full">
                <span>Public key server</span>
                <input className="secret" value={draft.peerPublicKey} placeholder="44 karakter, dari MikroTik" onChange={(event) => set({ peerPublicKey: event.target.value })} required />
              </label>
            </>
          ) : null}

          {draft.type === 'openvpn' ? (
            <>
              <div className="field full">
                <span>File .ovpn {editing?.remote ? `(tersimpan: ${editing.remote})` : ''}</span>
                <input type="file" accept=".ovpn,.conf,text/plain" onChange={(event) => { const file = event.target.files?.[0]; if (file) readFile(file); }} />
                <textarea className="secret" rows={draft.config ? 6 : 2} value={draft.config} placeholder={draft.id ? 'Kosongkan bila tetap' : 'atau tempel isi file .ovpn di sini'} onChange={(event) => set({ config: event.target.value })} />
              </div>
              <label className="field">
                <span>Username</span>
                <input value={draft.username} autoComplete="off" placeholder="opsional" onChange={(event) => set({ username: event.target.value })} />
              </label>
              <label className="field">
                <span>Password</span>
                <input type="password" autoComplete="new-password" value={draft.password} placeholder={secretHint(editing?.passwordSet)} onChange={(event) => set({ password: event.target.value })} />
              </label>
            </>
          ) : null}

          {draft.type === 'l2tp' ? (
            <>
              <label className="field">
                <span>Server</span>
                <input value={draft.server} placeholder="IP / host MikroTik" onChange={(event) => set({ server: event.target.value })} required />
              </label>
              <label className="field">
                <span>Username</span>
                <input value={draft.username} autoComplete="off" onChange={(event) => set({ username: event.target.value })} required />
              </label>
              <label className="field">
                <span>Password</span>
                <input type="password" autoComplete="new-password" value={draft.password} placeholder={secretHint(editing?.passwordSet)} onChange={(event) => set({ password: event.target.value })} required={!editing?.passwordSet} />
              </label>
              <label className="field">
                <span className="check"><input type="checkbox" checked={draft.useIpsec} onChange={(event) => set({ useIpsec: event.target.checked })} /> IPsec secret</span>
                <input type="password" autoComplete="new-password" value={draft.psk} disabled={!draft.useIpsec} placeholder={secretHint(editing?.pskSet)} onChange={(event) => set({ psk: event.target.value })} />
              </label>
            </>
          ) : null}

          {draft.type !== 'openvpn' ? (
            <button className="net-fold full" type="button" onClick={() => setAdvanced(!advanced)}>{advanced ? '▾' : '▸'} Lanjutan</button>
          ) : null}
          {advanced && draft.type === 'wireguard' ? (
            <>
              <label className="field">
                <span>Preshared key</span>
                <input className="secret" type="password" autoComplete="new-password" value={draft.presharedKey} placeholder={secretHint(editing?.presharedKeySet) || 'opsional'} onChange={(event) => set({ presharedKey: event.target.value })} />
              </label>
              <label className="field">
                <span>Keepalive (detik)</span>
                <input type="number" min={0} max={600} value={draft.keepalive} onChange={(event) => set({ keepalive: event.target.value })} />
              </label>
              <label className="field">
                <span>Port listen</span>
                <input type="number" min={1} max={65535} value={draft.listenPort} placeholder="opsional" onChange={(event) => set({ listenPort: event.target.value })} />
              </label>
              <label className="field">
                <span>MTU</span>
                <input type="number" min={1280} max={1500} value={draft.mtu} placeholder="1420" onChange={(event) => set({ mtu: event.target.value })} />
              </label>
              {draft.id ? (
                <label className="field check full">
                  <input type="checkbox" checked={draft.regenerateKey} onChange={(event) => set({ regenerateKey: event.target.checked })} /> Buat kunci baru
                </label>
              ) : null}
            </>
          ) : null}
          {advanced && draft.type === 'l2tp' ? (
            <label className="field">
              <span>MTU</span>
              <input type="number" min={576} max={1500} value={draft.l2tpMtu} onChange={(event) => set({ l2tpMtu: event.target.value })} />
            </label>
          ) : null}

          <div className="toolbar">
            <button className="btn" type="submit" disabled={busy}>{busy ? 'Menerapkan…' : draft.id ? 'Simpan' : 'Tambah'}</button>
            <button className="btn-ghost" type="button" onClick={() => setDraft(null)}>Batal</button>
          </div>
        </form>
      ) : null}

      {data.vpns.length === 0 && !draft ? <div className="empty">Belum ada VPN</div> : null}
      <div className="net-cards">
        {data.vpns.map((row) => {
          const live = byName.get(row.iface);
          const detail = row.type === 'wireguard' ? row.endpoint || (row.listenPort ? `listen :${row.listenPort}` : '') : row.type === 'openvpn' ? row.remote : row.server;
          return (
            <article key={row.id} className={`net-card tone-${row.status.state === 'up' ? 'up' : row.status.state === 'down' ? 'down' : row.status.state === 'wait' ? 'warning' : 'unknown'}`}>
              <div className="net-card-head">
                <strong>{row.name}</strong>
                <span className="net-kind">{vpnLabels[row.type]} · {row.iface}</span>
                <StateBadge state={row.status.state} text={row.status.text} />
              </div>
              <div className="net-note">{row.status.text}</div>
              <div className="net-ips">
                {(row.addresses.length ? row.addresses : row.address ? [row.address] : []).map((cidr) => <code key={cidr}>{cidr}</code>)}
                {detail ? <span className="net-muted">→ {detail}</span> : null}
              </div>
              {row.networks.length ? <div className="net-meta">Jaringan: {row.networks.join(', ')}</div> : null}
              {live ? <Rates rx={live.rx} tx={live.tx} /> : null}
              {row.type === 'wireguard' && row.publicKey ? (
                <div className="net-key">
                  <span>Public key NMS</span>
                  <code title={row.publicKey}>{row.publicKey}</code>
                  <button className="btn-ghost btn-sm" type="button" onClick={() => void copy(row.publicKey!, onMessage)}>Salin</button>
                  <button className="btn-ghost btn-sm" type="button" title="Perintah untuk menambahkan NMS sebagai peer di MikroTik" onClick={() => void copy(vpnPeerCommand(row), onMessage)}>Perintah MikroTik</button>
                </div>
              ) : null}
              <div className="net-card-actions">
                <button className="btn-ghost btn-sm" type="button" onClick={() => onTest({ target: row.testTarget ?? '', iface: row.iface })}>Tes</button>
                {editor ? (
                  <>
                    <button className="btn-ghost btn-sm" type="button" disabled={busy || !row.enabled} onClick={() => void run(`/api/network/vpns/${row.id}/restart`, 'POST')}>Restart</button>
                    <button className="btn-ghost btn-sm" type="button" onClick={() => { setAdvanced(false); setDraft(fromRow(row)); }}>Ubah</button>
                    <button className="btn-danger btn-sm" type="button" disabled={busy} onClick={() => void remove(row)}>Hapus</button>
                    <Toggle on={row.enabled} disabled={busy} label={row.enabled ? 'Nonaktifkan' : 'Aktifkan'} onChange={(next) => void run(`/api/network/vpns/${row.id}`, 'PUT', { enabled: next })} />
                  </>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>
    </>
  );
}
