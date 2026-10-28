import { FormEvent, useState } from 'react';
import { guessPeer, type NetSnapshot, type TestRequest, type VlanRow } from './model';
import { Rates, StateBadge, Toggle } from './parts';

type Props = {
  data: NetSnapshot;
  editor: boolean;
  busy: boolean;
  run: (path: string, method: string, body?: unknown) => Promise<boolean>;
  onTest: (request: TestRequest) => void;
};

type Draft = { id: string; vid: string; parent: string; name: string; address: string; mtu: string };

export function VlansView({ data, editor, busy, run, onTest }: Props) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const byName = new Map(data.interfaces.map((item) => [item.name, item]));
  const rows = [...data.vlans].sort((a, b) => a.parent.localeCompare(b.parent) || a.vid - b.vid);

  function blank(): Draft {
    const parent = data.parents[0];
    return { id: '', vid: '', parent: parent?.name ?? '', name: '', address: '', mtu: String(Math.min(1500, parent?.mtu ?? 1500)) };
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    const ok = draft.id
      ? await run(`/api/network/vlans/${draft.id}`, 'PUT', { name: draft.name, mtu: Number(draft.mtu) })
      : await run('/api/network/vlans', 'POST', {
        vid: Number(draft.vid),
        parent: draft.parent,
        name: draft.name,
        mtu: Number(draft.mtu),
        address: draft.address.trim() || undefined,
      });
    if (ok) setDraft(null);
  }

  async function remove(row: VlanRow) {
    if (!window.confirm(`Hapus VLAN ${row.vid} (${row.ifname})? IP dan rute di VLAN ini ikut terhapus.`)) return;
    await run(`/api/network/vlans/${row.id}`, 'DELETE');
  }

  return (
    <>
      {editor ? (
        <div className="net-bar">
          {draft ? null : <button className="btn" type="button" disabled={!data.parents.length} onClick={() => setDraft(blank())}>+ Tambah VLAN</button>}
        </div>
      ) : null}
      {draft ? (
        <form className="form-grid net-form" onSubmit={(event) => void save(event)}>
          <label className="field">
            <span>VLAN ID</span>
            <input type="number" min={1} max={4094} value={draft.vid} disabled={Boolean(draft.id)} placeholder="100" onChange={(event) => setDraft({ ...draft, vid: event.target.value })} required autoFocus />
          </label>
          <label className="field">
            <span>Interface induk</span>
            <select value={draft.parent} disabled={Boolean(draft.id)} onChange={(event) => setDraft({ ...draft, parent: event.target.value })}>
              {data.parents.map((parent) => <option key={parent.name} value={parent.name}>{parent.name}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Nama</span>
            <input value={draft.name} maxLength={40} placeholder="POP Selomerto" onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          </label>
          {draft.id ? null : (
            <label className="field">
              <span>IP / prefix</span>
              <input value={draft.address} placeholder="10.10.100.1/24 (opsional)" onChange={(event) => setDraft({ ...draft, address: event.target.value })} />
            </label>
          )}
          <label className="field">
            <span>MTU</span>
            <input type="number" min={576} max={9000} value={draft.mtu} onChange={(event) => setDraft({ ...draft, mtu: event.target.value })} />
          </label>
          <div className="toolbar">
            <button className="btn" type="submit" disabled={busy}>{draft.id ? 'Simpan' : 'Tambah'}</button>
            <button className="btn-ghost" type="button" onClick={() => setDraft(null)}>Batal</button>
          </div>
        </form>
      ) : null}
      <div className="table-wrap">
        <table>
          <thead><tr><th>Status</th><th>Interface</th><th>VLAN</th><th>Nama</th><th>IP</th><th>Trafik</th><th>MTU</th><th></th></tr></thead>
          <tbody>
            {rows.length === 0 ? <tr><td colSpan={8} className="net-muted">Belum ada VLAN</td></tr> : rows.map((row) => {
              const live = byName.get(row.ifname);
              return (
                <tr key={row.id}>
                  <td><StateBadge state={live?.state ?? row.state} text={live?.stateText} /></td>
                  <td><b>{row.ifname}</b></td>
                  <td>{row.vid}</td>
                  <td>{row.name || <span className="net-muted">—</span>}</td>
                  <td>{live?.addresses.length ? live.addresses.map((cidr) => <code key={cidr} className="net-chip">{cidr}</code>) : <span className="net-muted">—</span>}</td>
                  <td>{live ? <Rates rx={live.rx} tx={live.tx} /> : <span className="net-muted">—</span>}</td>
                  <td>{row.mtu}</td>
                  <td>
                    <div className="row-actions">
                      <button className="btn-ghost btn-sm" type="button" onClick={() => onTest({ target: live?.addresses[0] ? guessPeer(live.addresses[0]) : '', iface: row.ifname })}>Tes</button>
                      {editor ? (
                        <>
                          <Toggle on={row.enabled} disabled={busy} label={row.enabled ? 'Nonaktifkan' : 'Aktifkan'} onChange={(next) => void run(`/api/network/vlans/${row.id}`, 'PUT', { enabled: next })} />
                          <button className="btn-ghost btn-sm" type="button" onClick={() => setDraft({ id: row.id, vid: String(row.vid), parent: row.parent, name: row.name, address: '', mtu: String(row.mtu) })}>Ubah</button>
                          <button className="btn-danger btn-sm" type="button" disabled={busy} onClick={() => void remove(row)}>Hapus</button>
                        </>
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
