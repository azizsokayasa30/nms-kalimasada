import { FormEvent, useState } from 'react';
import { guessPeer, type AddressRow, type NetSnapshot, type TestRequest } from './model';

type Props = {
  data: NetSnapshot;
  editor: boolean;
  busy: boolean;
  run: (path: string, method: string, body?: unknown) => Promise<boolean>;
  onTest: (request: TestRequest) => void;
};

type Draft = { id: string; iface: string; cidr: string; comment: string };

const sourceLabels: Record<AddressRow['source'], string> = { nms: 'NMS', system: 'Sistem', vpn: 'VPN' };

export function AddressesView({ data, editor, busy, run, onTest }: Props) {
  const ifaces = [...data.parents.map((p) => p.name), ...data.vlans.map((v) => v.ifname)];
  const [draft, setDraft] = useState<Draft | null>(null);
  const rows = [...data.addresses].sort((a, b) => a.iface.localeCompare(b.iface) || a.cidr.localeCompare(b.cidr));

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    const body = { iface: draft.iface, cidr: draft.cidr.trim(), comment: draft.comment };
    const ok = draft.id
      ? await run(`/api/network/addresses/${draft.id}`, 'PUT', body)
      : await run('/api/network/addresses', 'POST', body);
    if (ok) setDraft(null);
  }

  async function remove(row: AddressRow) {
    if (!row.id || !window.confirm(`Hapus IP ${row.cidr} dari ${row.iface}?`)) return;
    await run(`/api/network/addresses/${row.id}`, 'DELETE');
  }

  return (
    <>
      {editor ? (
        <div className="net-bar">
          {draft ? null : <button className="btn" type="button" onClick={() => setDraft({ id: '', iface: ifaces[0] ?? '', cidr: '', comment: '' })}>+ Tambah IP</button>}
        </div>
      ) : null}
      {draft ? (
        <form className="form-grid net-form" onSubmit={(event) => void save(event)}>
          <label className="field">
            <span>Interface</span>
            <select value={draft.iface} onChange={(event) => setDraft({ ...draft, iface: event.target.value })} required>
              {ifaces.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </label>
          <label className="field">
            <span>IP / prefix</span>
            <input value={draft.cidr} placeholder="192.168.10.1/24" onChange={(event) => setDraft({ ...draft, cidr: event.target.value })} required autoFocus />
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
          <thead><tr><th>Interface</th><th>IP</th><th>Jaringan</th><th>Keterangan</th><th>Sumber</th><th></th></tr></thead>
          <tbody>
            {rows.length === 0 ? <tr><td colSpan={6} className="net-muted">Belum ada IP</td></tr> : rows.map((row) => (
              <tr key={`${row.iface}|${row.cidr}`}>
                <td><b>{row.iface}</b></td>
                <td><code>{row.cidr}</code>{row.active ? null : <span className="badge warning net-inline">Menunggu interface</span>}</td>
                <td className="net-muted">{row.network}</td>
                <td>{row.comment || <span className="net-muted">—</span>}</td>
                <td><span className={`badge ${row.source === 'nms' ? 'method' : 'unknown'}`}>{sourceLabels[row.source]}</span></td>
                <td>
                  <div className="row-actions">
                    <button className="btn-ghost btn-sm" type="button" onClick={() => onTest({ target: guessPeer(row.cidr), iface: row.iface })}>Tes</button>
                    {editor && row.id ? (
                      <>
                        <button className="btn-ghost btn-sm" type="button" onClick={() => setDraft({ id: row.id!, iface: row.iface, cidr: row.cidr, comment: row.comment })}>Ubah</button>
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
    </>
  );
}
