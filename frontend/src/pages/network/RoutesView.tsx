import { FormEvent, useState } from 'react';
import { guessPeer, type NetSnapshot, type RouteRow, type TestRequest } from './model';
import { Toggle } from './parts';

type Props = {
  data: NetSnapshot;
  editor: boolean;
  busy: boolean;
  run: (path: string, method: string, body?: unknown) => Promise<boolean>;
  onTest: (request: TestRequest) => void;
};

type Draft = { id: string; dst: string; gateway: string; iface: string; metric: string; comment: string };

const blank: Draft = { id: '', dst: '', gateway: '', iface: '', metric: '10', comment: '' };

export function RoutesView({ data, editor, busy, run, onTest }: Props) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [showSystem, setShowSystem] = useState(false);
  const ifaces = data.interfaces.map((item) => item.name);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    const body = {
      dst: draft.dst.trim(),
      gateway: draft.gateway.trim(),
      iface: draft.iface,
      metric: Number(draft.metric || 10),
      comment: draft.comment,
    };
    const ok = draft.id
      ? await run(`/api/network/routes/${draft.id}`, 'PUT', body)
      : await run('/api/network/routes', 'POST', body);
    if (ok) setDraft(null);
  }

  async function remove(row: RouteRow) {
    if (!window.confirm(`Hapus rute ${row.dst}?`)) return;
    await run(`/api/network/routes/${row.id}`, 'DELETE');
  }

  function status(row: RouteRow) {
    if (!row.enabled) return <span className="badge unknown"><i />Nonaktif</span>;
    if (row.active) return <span className="badge up"><i />Aktif</span>;
    return <span className="badge warning" title={row.error ?? undefined}><i />{row.error ?? 'Menunggu'}</span>;
  }

  return (
    <>
      {editor ? (
        <div className="net-bar">
          {draft ? null : <button className="btn" type="button" onClick={() => setDraft(blank)}>+ Tambah rute</button>}
        </div>
      ) : null}
      {draft ? (
        <form className="form-grid net-form" onSubmit={(event) => void save(event)}>
          <label className="field">
            <span>Tujuan</span>
            <input value={draft.dst} placeholder="10.20.0.0/16" onChange={(event) => setDraft({ ...draft, dst: event.target.value })} required autoFocus />
          </label>
          <label className="field">
            <span>Gateway</span>
            <input value={draft.gateway} placeholder="10.10.100.254" onChange={(event) => setDraft({ ...draft, gateway: event.target.value })} />
          </label>
          <label className="field">
            <span>Interface</span>
            <select value={draft.iface} onChange={(event) => setDraft({ ...draft, iface: event.target.value })}>
              <option value="">Otomatis (ikut gateway)</option>
              {ifaces.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Metric</span>
            <input type="number" min={0} max={9999} value={draft.metric} onChange={(event) => setDraft({ ...draft, metric: event.target.value })} />
          </label>
          <label className="field full">
            <span>Keterangan</span>
            <input value={draft.comment} maxLength={60} placeholder="opsional" onChange={(event) => setDraft({ ...draft, comment: event.target.value })} />
          </label>
          <div className="toolbar">
            <button className="btn" type="submit" disabled={busy}>{draft.id ? 'Simpan' : 'Tambah'}</button>
            <button className="btn-ghost" type="button" onClick={() => setDraft(null)}>Batal</button>
          </div>
        </form>
      ) : null}
      <div className="table-wrap">
        <table>
          <thead><tr><th>Status</th><th>Tujuan</th><th>Gateway</th><th>Interface</th><th>Metric</th><th>Keterangan</th><th></th></tr></thead>
          <tbody>
            {data.routes.length === 0 ? <tr><td colSpan={7} className="net-muted">Belum ada rute statis</td></tr> : data.routes.map((row) => (
              <tr key={row.id}>
                <td>{status(row)}</td>
                <td><code>{row.dst}</code></td>
                <td>{row.gateway ?? <span className="net-muted">—</span>}</td>
                <td>{row.dev ?? <span className="net-muted">otomatis</span>}</td>
                <td>{row.metric}</td>
                <td>{row.comment || <span className="net-muted">—</span>}</td>
                <td>
                  <div className="row-actions">
                    <button className="btn-ghost btn-sm" type="button" onClick={() => onTest({ target: row.gateway ?? guessPeer(row.dst), iface: '' })}>Tes</button>
                    {editor ? (
                      <>
                        <Toggle on={row.enabled} disabled={busy} label={row.enabled ? 'Nonaktifkan' : 'Aktifkan'} onChange={(next) => void run(`/api/network/routes/${row.id}`, 'PUT', { enabled: next })} />
                        <button className="btn-ghost btn-sm" type="button" onClick={() => setDraft({ id: row.id, dst: row.dst, gateway: row.gateway ?? '', iface: row.iface ?? '', metric: String(row.metric), comment: row.comment })}>Ubah</button>
                        <button className="btn-danger btn-sm" type="button" disabled={busy} onClick={() => void remove(row)}>Hapus</button>
                      </>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button className="net-fold" type="button" onClick={() => setShowSystem(!showSystem)}>
        {showSystem ? '▾' : '▸'} Rute sistem & VPN ({data.systemRoutes.length})
      </button>
      {showSystem ? (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Tujuan</th><th>Gateway</th><th>Interface</th><th>Metric</th><th>Sumber</th></tr></thead>
            <tbody>
              {data.systemRoutes.map((row) => (
                <tr key={`${row.dst}|${row.metric}|${row.dev}`}>
                  <td><code>{row.dst === '0.0.0.0/0' ? 'default' : row.dst}</code></td>
                  <td>{row.gateway ?? <span className="net-muted">langsung</span>}</td>
                  <td>{row.dev}</td>
                  <td>{row.metric}</td>
                  <td><span className={`badge ${row.source === 'vpn' ? 'method' : 'unknown'}`}>{row.source === 'vpn' ? 'VPN' : 'Sistem'}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}
