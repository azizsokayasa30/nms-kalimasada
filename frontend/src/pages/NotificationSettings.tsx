import { FormEvent, useEffect, useState } from 'react';
import { POPUP_SETTINGS_EVENT, type PopupConfig } from '../components/AlarmPopup';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { can } from '../lib/format';

type EventId = 'down' | 'warning' | 'recovered';
type Provider = 'fonnte' | 'wablas' | 'custom';
type Templates = Record<EventId, string>;

type Config = {
  popup: PopupConfig;
  telegram: { enabled: boolean; events: EventId[]; chatIds: string[]; botTokenSet: boolean };
  whatsapp: { enabled: boolean; events: EventId[]; provider: Provider; apiUrl: string; targets: string[]; tokenSet: boolean };
  templates: Templates;
  defaults: { templates: Templates; whatsappUrl: Record<Provider, string> };
};

type LogRow = {
  id: string;
  channel: string;
  target: string | null;
  event: string;
  status: string;
  error: string | null;
  sentAt: string;
  alarmTitle: string | null;
};

type TestResult = { ok: boolean; results: Array<{ target: string; ok: boolean; error: string | null }> };
type Chat = { id: string; name: string; type: string };

const eventLabels: Record<EventId, string> = {
  down: 'Perangkat DOWN',
  warning: 'Latency / packet loss tinggi',
  recovered: 'Perangkat pulih (UP)',
};

const logEventLabels: Record<string, string> = { ...eventLabels, test: 'Tes' };

const providerLabels: Record<Provider, string> = {
  fonnte: 'Fonnte',
  wablas: 'Wablas',
  custom: 'Gateway lain (HTTP)',
};

const placeholders = '{device} {ip} {location} {group} {title} {status} {severity} {time} {duration} {downstream}';

const emptyTemplates: Templates = { down: '', warning: '', recovered: '' };

export function NotificationTab() {
  const { user } = useAuth();
  const admin = can(user?.role, 'admin');
  const [popup, setPopup] = useState<PopupConfig>({ enabled: true, events: ['down', 'warning', 'recovered'], durationSec: 15, position: 'top-right' });
  const [telegram, setTelegram] = useState({ enabled: false, events: ['down', 'recovered'] as EventId[], botToken: '', clearBotToken: false, chatIds: '', botTokenSet: false });
  const [whatsapp, setWhatsapp] = useState({ enabled: false, events: ['down', 'recovered'] as EventId[], provider: 'fonnte' as Provider, apiUrl: '', token: '', clearToken: false, targets: '', tokenSet: false });
  const [templates, setTemplates] = useState<Templates>(emptyTemplates);
  const [defaults, setDefaults] = useState<Config['defaults']>({ templates: emptyTemplates, whatsappUrl: { fonnte: '', wablas: '', custom: '' } });
  const [bot, setBot] = useState('');
  const [chats, setChats] = useState<Chat[] | null>(null);
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  function apply(config: Config) {
    setPopup(config.popup);
    setTelegram({
      enabled: config.telegram.enabled,
      events: config.telegram.events,
      botToken: '',
      clearBotToken: false,
      chatIds: config.telegram.chatIds.join('\n'),
      botTokenSet: config.telegram.botTokenSet,
    });
    setWhatsapp({
      enabled: config.whatsapp.enabled,
      events: config.whatsapp.events,
      provider: config.whatsapp.provider,
      apiUrl: config.whatsapp.apiUrl,
      token: '',
      clearToken: false,
      targets: config.whatsapp.targets.join('\n'),
      tokenSet: config.whatsapp.tokenSet,
    });
    setTemplates(config.templates);
    setDefaults(config.defaults);
  }

  function loadLogs() {
    void api<LogRow[]>('/api/notifications/logs').then(setLogs).catch(() => undefined);
  }

  useEffect(() => {
    if (!admin) {
      void api<PopupConfig>('/api/notifications/popup').then(setPopup).catch((err: Error) => setError(err.message));
      return;
    }
    void api<Config>('/api/notifications').then(apply).catch((err: Error) => setError(err.message));
    loadLogs();
  }, [admin]);

  function payload() {
    return {
      popup,
      telegram: {
        enabled: telegram.enabled,
        events: telegram.events,
        botToken: telegram.botToken || undefined,
        clearBotToken: telegram.clearBotToken,
        chatIds: lines(telegram.chatIds),
      },
      whatsapp: {
        enabled: whatsapp.enabled,
        events: whatsapp.events,
        provider: whatsapp.provider,
        apiUrl: whatsapp.apiUrl,
        token: whatsapp.token || undefined,
        clearToken: whatsapp.clearToken,
        targets: lines(whatsapp.targets),
      },
      templates,
    };
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setError('');
    setMessage('');
    if (telegram.enabled && !telegram.botTokenSet && !telegram.botToken) {
      setError('Isi token bot Telegram sebelum mengaktifkannya');
      return;
    }
    if (whatsapp.enabled && !whatsapp.apiUrl.trim()) {
      setError('Isi URL API WhatsApp sebelum mengaktifkannya');
      return;
    }
    try {
      const saved = await api<Config>('/api/notifications', { method: 'PUT', body: JSON.stringify(payload()) });
      apply(saved);
      setMessage('Pengaturan notifikasi disimpan');
      window.dispatchEvent(new Event(POPUP_SETTINGS_EVENT));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Pengaturan notifikasi gagal disimpan');
    }
  }

  async function run(label: string, task: () => Promise<void>) {
    setBusy(label);
    setError('');
    setMessage('');
    try {
      await task();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Permintaan gagal');
    } finally {
      setBusy('');
    }
  }

  function checkBot() {
    void run('bot', async () => {
      const info = await api<{ username: string; name: string }>('/api/notifications/telegram/bot', {
        method: 'POST',
        body: JSON.stringify({ botToken: telegram.botToken || undefined }),
      });
      setBot(`${info.name}${info.username ? ` (@${info.username})` : ''}`);
    });
  }

  function findChats() {
    void run('chats', async () => {
      const result = await api<{ chats: Chat[] }>('/api/notifications/telegram/chats', {
        method: 'POST',
        body: JSON.stringify({ botToken: telegram.botToken || undefined }),
      });
      setChats(result.chats);
    });
  }

  function addChat(id: string) {
    const current = lines(telegram.chatIds);
    if (current.includes(id)) return;
    setTelegram({ ...telegram, chatIds: [...current, id].join('\n') });
  }

  function sendTest(channel: 'telegram' | 'whatsapp') {
    void run(channel, async () => {
      const result = await api<TestResult>(`/api/notifications/test/${channel}`, { method: 'POST', body: JSON.stringify(payload()) });
      const summary = result.results
        .map((row) => (row.ok ? `${row.target}: terkirim` : `${row.target || 'Tes'}: ${row.error}`))
        .join(' · ');
      if (result.ok) setMessage(`Tes terkirim. ${summary}`);
      else setError(summary);
      loadLogs();
    });
  }

  function changeProvider(provider: Provider) {
    const usingDefault = !whatsapp.apiUrl.trim() || whatsapp.apiUrl === defaults.whatsappUrl[whatsapp.provider];
    setWhatsapp({ ...whatsapp, provider, apiUrl: usingDefault ? defaults.whatsappUrl[provider] : whatsapp.apiUrl });
  }

  if (!admin) {
    return (
      <div className="form-grid">
        <h3>Popup di dashboard</h3>
        <div className="full sub">
          Popup {popup.enabled ? 'aktif' : 'mati'} untuk: {popup.events.map((item) => eventLabels[item as EventId]).join(', ') || 'tidak ada kejadian'}.
        </div>
        <div className="full sub">Hanya admin yang dapat mengubah popup, Telegram, dan WhatsApp.</div>
        {error ? <div className="error">{error}</div> : null}
      </div>
    );
  }

  return (
    <>
      <form className="form-grid" onSubmit={(event) => void save(event)}>
        <h3>Popup di dashboard</h3>
        <label className="field check full">
          <input type="checkbox" checked={popup.enabled} onChange={(event) => setPopup({ ...popup, enabled: event.target.checked })} />
          Tampilkan popup saat ada alarm
        </label>
        <EventChecks value={popup.events as EventId[]} onChange={(events) => setPopup({ ...popup, events })} />
        <label className="field">
          <span>Lama tampil (detik, 0 = sampai ditutup)</span>
          <input type="number" min={0} max={600} value={popup.durationSec} onChange={(event) => setPopup({ ...popup, durationSec: Number(event.target.value) })} />
        </label>
        <label className="field">
          <span>Posisi</span>
          <select value={popup.position} onChange={(event) => setPopup({ ...popup, position: event.target.value as PopupConfig['position'] })}>
            <option value="top-right">Kanan atas</option>
            <option value="bottom-right">Kanan bawah</option>
          </select>
        </label>

        <h3>Telegram</h3>
        <label className="field check full">
          <input type="checkbox" checked={telegram.enabled} onChange={(event) => setTelegram({ ...telegram, enabled: event.target.checked })} />
          Kirim pemberitahuan ke Telegram
        </label>
        <label className="field full">
          <span>Token bot {telegram.botTokenSet ? '(tersimpan)' : ''}</span>
          <input
            className="secret"
            type="password"
            autoComplete="new-password"
            value={telegram.botToken}
            placeholder={telegram.botTokenSet ? 'Kosongkan jika tidak diubah' : '123456789:AA...'}
            onChange={(event) => setTelegram({ ...telegram, botToken: event.target.value })}
          />
        </label>
        <div className="toolbar">
          <button className="btn-ghost" type="button" disabled={busy === 'bot'} onClick={checkBot}>{busy === 'bot' ? 'Memeriksa...' : 'Cek bot'}</button>
          <button className="btn-ghost" type="button" disabled={busy === 'chats'} onClick={findChats}>{busy === 'chats' ? 'Mencari...' : 'Cari chat ID'}</button>
          {telegram.botTokenSet ? (
            <label className="check"><input type="checkbox" checked={telegram.clearBotToken} onChange={(event) => setTelegram({ ...telegram, clearBotToken: event.target.checked })} /> Hapus token tersimpan</label>
          ) : null}
          {bot ? <span className="status-ok">Bot: {bot}</span> : null}
        </div>
        <div className="full sub">
          Buat bot lewat @BotFather di Telegram, lalu tempel tokennya di sini. Kirim /start ke bot, atau tambahkan bot ke grup NOC dan kirim satu pesan, lalu klik Cari chat ID.
        </div>
        {chats ? (
          <div className="field full chat-pick">
            <span>Chat yang pernah menghubungi bot</span>
            {chats.length === 0 ? <div className="sub">Belum ada. Kirim pesan ke bot dulu, lalu cari lagi.</div> : chats.map((chat) => (
              <div key={chat.id}>
                <span className="sub">{chat.name} · {chat.type} · <span className="secret">{chat.id}</span></span>
                <button className="btn-ghost btn-sm" type="button" disabled={lines(telegram.chatIds).includes(chat.id)} onClick={() => addChat(chat.id)}>
                  {lines(telegram.chatIds).includes(chat.id) ? 'Sudah dipakai' : 'Tambah'}
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <label className="field full">
          <span>Chat ID tujuan (satu per baris)</span>
          <textarea rows={3} className="secret" value={telegram.chatIds} placeholder="-1001234567890" onChange={(event) => setTelegram({ ...telegram, chatIds: event.target.value })} />
        </label>
        <EventChecks value={telegram.events} onChange={(events) => setTelegram({ ...telegram, events })} />
        <div className="toolbar">
          <button className="btn-ghost" type="button" disabled={busy === 'telegram'} onClick={() => sendTest('telegram')}>{busy === 'telegram' ? 'Mengirim...' : 'Kirim tes Telegram'}</button>
        </div>

        <h3>WhatsApp</h3>
        <label className="field check full">
          <input type="checkbox" checked={whatsapp.enabled} onChange={(event) => setWhatsapp({ ...whatsapp, enabled: event.target.checked })} />
          Kirim pemberitahuan ke WhatsApp
        </label>
        <label className="field">
          <span>Gateway / bot WhatsApp</span>
          <select value={whatsapp.provider} onChange={(event) => changeProvider(event.target.value as Provider)}>
            {(Object.keys(providerLabels) as Provider[]).map((item) => <option key={item} value={item}>{providerLabels[item]}</option>)}
          </select>
        </label>
        <label className="field">
          <span>URL API</span>
          <input
            value={whatsapp.apiUrl}
            placeholder={whatsapp.provider === 'wablas' ? 'https://jkt.wablas.com' : whatsapp.provider === 'custom' ? 'https://gateway.anda/send' : ''}
            onChange={(event) => setWhatsapp({ ...whatsapp, apiUrl: event.target.value })}
          />
        </label>
        <label className="field full">
          <span>Token {whatsapp.tokenSet ? '(tersimpan)' : ''}</span>
          <input
            className="secret"
            type="password"
            autoComplete="new-password"
            value={whatsapp.token}
            placeholder={whatsapp.tokenSet ? 'Kosongkan jika tidak diubah' : 'Token dari gateway WhatsApp'}
            onChange={(event) => setWhatsapp({ ...whatsapp, token: event.target.value })}
          />
        </label>
        {whatsapp.tokenSet ? (
          <label className="check full"><input type="checkbox" checked={whatsapp.clearToken} onChange={(event) => setWhatsapp({ ...whatsapp, clearToken: event.target.checked })} /> Hapus token tersimpan</label>
        ) : null}
        <div className="full sub">
          {whatsapp.provider === 'fonnte' ? 'Hubungkan nomor bot di dashboard fonnte.com dengan scan QR, lalu salin token device ke sini.' : null}
          {whatsapp.provider === 'wablas' ? 'Isi domain server Wablas Anda (misalnya https://jkt.wablas.com) dan token device.' : null}
          {whatsapp.provider === 'custom' ? 'Aplikasi mengirim POST JSON {"target": "...", "message": "..."} ke URL ini, dengan header Authorization berisi token jika diisi.' : null}
        </div>
        <label className="field full">
          <span>Nomor atau ID grup tujuan (satu per baris)</span>
          <textarea rows={3} className="secret" value={whatsapp.targets} placeholder={'081234567890\n120363012345678901@g.us'} onChange={(event) => setWhatsapp({ ...whatsapp, targets: event.target.value })} />
        </label>
        <EventChecks value={whatsapp.events} onChange={(events) => setWhatsapp({ ...whatsapp, events })} />
        <div className="toolbar">
          <button className="btn-ghost" type="button" disabled={busy === 'whatsapp'} onClick={() => sendTest('whatsapp')}>{busy === 'whatsapp' ? 'Mengirim...' : 'Kirim tes WhatsApp'}</button>
        </div>

        <h3>Template pesan Telegram dan WhatsApp</h3>
        <div className="full sub">Kata dalam kurung kurawal diganti otomatis: {placeholders}</div>
        {(Object.keys(eventLabels) as EventId[]).map((key) => (
          <label className="field full" key={key}>
            <span>
              {eventLabels[key]}{' '}
              <button className="btn-ghost btn-sm" type="button" onClick={() => setTemplates({ ...templates, [key]: defaults.templates[key] })}>Bawaan</button>
            </span>
            <textarea rows={6} value={templates[key]} onChange={(event) => setTemplates({ ...templates, [key]: event.target.value })} />
          </label>
        ))}
        <div className="full sub">
          Pesan dikirim setelah alarm bertahan selama Alert delay perangkat. Perangkat dengan Notifikasi aktif dimatikan atau dalam maintenance tidak dikirimi pesan.
          Pesan pulih hanya dikirim bila pesan DOWN atau WARNING-nya sudah terkirim.
        </div>
        <div className="toolbar">
          <button className="btn" type="submit">Simpan notifikasi</button>
        </div>
        {error ? <div className="error">{error}</div> : null}
        {message ? <div className="sub">{message}</div> : null}
      </form>
      <div className="form-grid">
        <h3>Riwayat pengiriman</h3>
        <div className="toolbar"><button className="btn-ghost btn-sm" type="button" onClick={loadLogs}>Muat ulang</button></div>
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Waktu</th><th>Kanal</th><th>Tujuan</th><th>Kejadian</th><th>Status</th><th>Keterangan</th></tr></thead>
          <tbody>
            {logs.length === 0 ? <tr><td colSpan={6}>Belum ada pengiriman</td></tr> : logs.map((row) => (
              <tr key={row.id}>
                <td>{new Date(row.sentAt).toLocaleString('id-ID')}</td>
                <td>{row.channel === 'telegram' ? 'Telegram' : 'WhatsApp'}</td>
                <td className="secret">{row.target ?? '—'}</td>
                <td>{logEventLabels[row.event] ?? row.event}</td>
                <td className={row.status === 'sent' ? 'status-ok' : 'status-bad'}>{row.status === 'sent' ? 'Terkirim' : 'Gagal'}</td>
                <td>{row.error ?? row.alarmTitle ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function EventChecks({ value, onChange }: { value: EventId[]; onChange: (next: EventId[]) => void }) {
  return (
    <div className="field full">
      <span>Kirim untuk kejadian</span>
      <div className="notify-events">
        {(Object.keys(eventLabels) as EventId[]).map((key) => (
          <label className="check" key={key}>
            <input
              type="checkbox"
              checked={value.includes(key)}
              onChange={(event) => onChange(event.target.checked ? [...value, key] : value.filter((item) => item !== key))}
            />
            {eventLabels[key]}
          </label>
        ))}
      </div>
    </div>
  );
}

function lines(value: string) {
  return [...new Set(value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean))];
}
