import { FormEvent, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { roleLabels } from '../lib/format';

type UserRow = { id: string; name: string; email: string; role: string };

export function UsersPage() {
  const [rows, setRows] = useState<UserRow[]>([]);
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'noc' });
  const [error, setError] = useState('');

  function load() {
    void api<UserRow[]>('/api/users').then(setRows).catch((err: Error) => setError(err.message));
  }

  useEffect(load, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    try {
      await api('/api/users', { method: 'POST', body: JSON.stringify(form) });
      setForm({ name: '', email: '', password: '', role: 'noc' });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal menambah user');
    }
  }

  return (
    <section className="panel">
      <header><h2>Users</h2></header>
      <form className="form-grid" onSubmit={(event) => void submit(event)}>
        <label className="field"><span>Nama</span><input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required /></label>
        <label className="field"><span>Email</span><input value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} required /></label>
        <label className="field"><span>Password</span><input type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} required /></label>
        <label className="field"><span>Role</span>
          <select value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value })}>
            <option value="super_admin">Super Admin</option>
            <option value="admin">Admin</option>
            <option value="noc">NOC</option>
            <option value="viewer">Viewer</option>
          </select>
        </label>
        <button className="btn" type="submit">Tambah</button>
      </form>
      {error ? <div className="error">{error}</div> : null}
      <div className="table-wrap">
        <table>
          <thead><tr><th>Nama</th><th>Email</th><th>Role</th></tr></thead>
          <tbody>
            {rows.map((user) => (
              <tr key={user.id}><td>{user.name}</td><td>{user.email}</td><td>{roleLabels[user.role] ?? user.role}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
