import { useEffect, useState } from 'react';
import { PrefFlash, PrefSection, PrefSwitch } from '../components/Pref';
import { api } from '../lib/api';

type Inventory = {
  users: number;
  groups: number;
  devices: number;
  links: number;
  graphs: number;
  alarms: number;
  events: number;
  clients: number;
  rules: number;
  tokens: number;
  settings: number;
  logs: number;
  sounds: number;
  network: boolean;
};

type Preview = { createdAt: string; inventory: Inventory };
type RestoreNote = { message: string; notes: string[]; warnings: string[] };

const cards = [
  ['devices', 'Perangkat'],
  ['links', 'Topologi'],
  ['graphs', 'Grafik MRTG'],
  ['alarms', 'Alarm'],
  ['users', 'Pengguna'],
  ['groups', 'Grup'],
  ['clients', 'Klien'],
  ['events', 'Kejadian'],
] as const;

const noteKey = 'kalimasada-backup-note';

export function BackupTab() {
  const [current, setCurrent] = useState<Inventory | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState<'download' | 'restore' | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [notes, setNotes] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);

  useEffect(() => {
    const saved = sessionStorage.getItem(noteKey);
    if (saved) {
      sessionStorage.removeItem(noteKey);
      try {
        const note = JSON.parse(saved) as RestoreNote;
        setMessage(note.message);
        setNotes(note.notes ?? []);
        setWarnings(note.warnings ?? []);
      } catch {
        setMessage(saved);
      }
    }
    void api<Inventory>('/api/settings/backup/summary').then(setCurrent).catch((err: Error) => setError(err.message));
  }, []);

  async function download() {
    setBusy('download');
    setError('');
    setMessage('');
    try {
      const token = localStorage.getItem('token');
      const headers = new Headers();
      if (token) headers.set('Authorization', `Bearer ${token}`);
      const response = await fetch('/api/settings/backup', { headers });
      const type = response.headers.get('Content-Type') ?? '';
      if (!response.ok || type.includes('json')) {
        const data = await response.json().catch(() => null) as { message?: string | string[] } | null;
        const detail = Array.isArray(data?.message) ? data.message.join(', ') : data?.message;
        throw new Error(detail || 'Cadangan gagal diunduh');
      }
      const blob = await response.blob();
      const match = /filename="([^"]+)"/i.exec(response.headers.get('Content-Disposition') ?? '');
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = match?.[1] || `kalimasada-${stamp(new Date())}.kmsbackup`;
      link.click();
      URL.revokeObjectURL(url);
      setMessage('Cadangan diunduh');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Cadangan gagal diunduh');
    } finally {
      setBusy(null);
    }
  }

  async function choose(next: File | undefined) {
    setFile(next ?? null);
    setPreview(null);
    setAgreed(false);
    setError('');
    if (!next) return;
    if (next.size > 256 * 1024 * 1024) {
      setFile(null);
      setError('File cadangan lebih dari 256 MB');
      return;
    }
    try {
      setPreview(await readPreview(next));
    } catch (err) {
      setFile(null);
      setError(err instanceof Error ? err.message : 'File cadangan tidak bisa dibaca');
    }
  }

  async function restore() {
    if (!file || !preview || !agreed || busy) return;
    const when = preview.createdAt ? formatWhen(preview.createdAt) : file.name;
    if (!window.confirm(`Pulihkan cadangan ${when}? Seluruh data yang sedang berjalan akan diganti.`)) return;
    setBusy('restore');
    setError('');
    setMessage('');
    try {
      const token = localStorage.getItem('token');
      const body = new FormData();
      body.append('file', file);
      body.append('confirm', 'PULIHKAN');
      const headers = new Headers();
      if (token) headers.set('Authorization', `Bearer ${token}`);
      const response = await fetch('/api/settings/backup/restore', { method: 'POST', body, headers });
      const data = await response.json().catch(() => null) as { message?: string | string[]; inventory?: Inventory; warnings?: string[]; notes?: string[] } | null;
      if (!response.ok || !data?.inventory) {
        const detail = Array.isArray(data?.message) ? data.message.join(', ') : data?.message;
        throw new Error(detail || 'Pemulihan gagal');
      }
      const count = data.inventory;
      const note: RestoreNote = {
        message: `Data dipulihkan: ${count.devices} perangkat, ${count.links} tautan topologi, ${count.graphs} grafik MRTG.`,
        notes: data.notes ?? [],
        warnings: data.warnings ?? [],
      };
      sessionStorage.setItem(noteKey, JSON.stringify(note));
      window.location.assign('/settings?tab=cadangan');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Pemulihan gagal');
      setBusy(null);
    }
  }

  return (
    <div className="pref">
      <PrefSection title="Unduh cadangan" description="Satu file untuk seluruh data yang tersimpan di NMS ini" action={
        <button className="btn" type="button" disabled={busy !== null || !current} onClick={() => void download()}>
          {busy === 'download' ? 'Mengunduh…' : 'Unduh cadangan'}
        </button>
      }>
        <InventoryGrid inventory={current} />
        <p className="pref-hint">
          Cadangan mencakup database lengkap: pengguna, grup, perangkat, topologi, definisi grafik MRTG, alarm, kejadian, klien, notifikasi, token API, dan pengaturan. Nada alarm serta konfigurasi jaringan ikut masuk bila ada di server ini. Angka riwayat MRTG tetap berada di Zabbix. Sandi di dalam file terenkripsi dengan kunci server ini.
        </p>
      </PrefSection>
      <PrefSection title="Pulihkan cadangan" description="Mengganti seluruh data yang sedang berjalan">
        <div className="pref-list">
          <div className="pref-row stack">
            <div className="pref-text">
              <strong>File cadangan</strong>
              <span>{file ? file.name : 'Pilih file .kmsbackup hasil unduhan'}</span>
            </div>
            <div className="pref-control">
              <label className="btn-ghost file-btn">
                Pilih file
                <input
                  type="file"
                  accept=".kmsbackup,.json,.gz,application/gzip,application/json"
                  hidden
                  disabled={busy !== null}
                  onChange={(event) => {
                    const selected = event.target.files?.[0];
                    event.target.value = '';
                    void choose(selected);
                  }}
                />
              </label>
            </div>
          </div>
        </div>
        {preview ? (
          <>
            <p className="pref-hint">Isi file{preview.createdAt ? `, dibuat ${formatWhen(preview.createdAt)}` : ''}.</p>
            <InventoryGrid inventory={preview.inventory} />
            <PrefSwitch
              title="Ganti seluruh data yang sedang berjalan"
              description="Perangkat, topologi, grafik MRTG, alarm, pengguna, dan pengaturan ikut terganti"
              checked={agreed}
              disabled={busy !== null}
              onChange={setAgreed}
            />
            <div className="pref-actions">
              <button className="btn-danger" type="button" disabled={!agreed || busy !== null} onClick={() => void restore()}>
                {busy === 'restore' ? 'Memulihkan…' : 'Pulihkan data'}
              </button>
            </div>
          </>
        ) : null}
        {notes.map((item) => <p key={item} className="pref-hint">{item}</p>)}
        {warnings.map((item) => <p key={item} className="pref-hint bad">{item}</p>)}
      </PrefSection>
      <PrefFlash message={message} error={error} />
    </div>
  );
}

function InventoryGrid({ inventory }: { inventory: Inventory | null }) {
  return (
    <>
      <div className="pref-stats">
        {cards.map(([key, label]) => (
          <div key={key} className="pref-stat">
            <span>{label}</span>
            <strong>{inventory ? inventory[key].toLocaleString('id-ID') : '—'}</strong>
          </div>
        ))}
      </div>
      <p className="pref-hint">
        {inventory
          ? `Pengaturan ${inventory.settings} · token API ${inventory.tokens} · notifikasi ${inventory.rules} · log ${inventory.logs} · nada ${inventory.sounds} · jaringan ${inventory.network ? 'ikut' : 'tidak ada'}`
          : 'Menghitung isi data…'}
      </p>
    </>
  );
}

async function readPreview(file: File): Promise<Preview> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const gzip = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  let text: string;
  if (gzip) {
    if (typeof DecompressionStream === 'undefined') throw new Error('Browser ini tidak bisa membaca file cadangan');
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    text = await new Response(stream).text();
  } else {
    text = new TextDecoder().decode(bytes);
  }
  const data = JSON.parse(text) as { format?: string; version?: number; createdAt?: string; inventory?: Inventory };
  if (data.format !== 'kalimasada-backup' || data.version !== 1 || !data.inventory) {
    throw new Error('File ini bukan cadangan Kalimasada');
  }
  return { createdAt: typeof data.createdAt === 'string' ? data.createdAt : '', inventory: data.inventory };
}

function formatWhen(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
}

function stamp(date: Date) {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
