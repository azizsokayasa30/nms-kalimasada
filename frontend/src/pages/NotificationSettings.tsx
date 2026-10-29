import { FormEvent, useEffect, useState } from 'react';
import { POPUP_SETTINGS_EVENT, type PopupConfig } from '../components/AlarmPopup';
import { PrefActions, PrefFlash, PrefRow, PrefSection, PrefSwitch } from '../components/Pref';
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
      <div className="pref">
        <PrefSection title="Popup di dashboard" description="Kotak pemberitahuan di layar saat ada alarm">
          <div className="pref-list">
            <PrefRow title="Status">
              <span className={popup.enabled ? 'badge up' : 'badge unknown'}>{popup.enabled ? 'Aktif' : 'Mati'}</span>
            </PrefRow>
            <PrefRow title="Kejadian">
              <span className="pref-value">{popup.events.map((item) => eventLabels[item as EventId]).join(', ') || 'Tidak ada'}</span>
            </PrefRow>
          </div>
        </PrefSection>
        <p className="pref-note">Hanya admin yang dapat mengubah popup, Telegram, dan WhatsApp.</p>
        <PrefFlash message="" error={error} />
      </div>
    );
  }

  const usedChats = lines(telegram.chatIds);

  return (
    <>
      <form className="pref" onSubmit={(event) => void save(event)}>
        <PrefSection title="Popup di dashboard" description="Kotak pemberitahuan di layar saat ada alarm">
          <div className="pref-list">
            <PrefSwitch title="Tampilkan popup" description="Muncul saat ada alarm baru" checked={popup.enabled} onChange={(next) => setPopup({ ...popup, enabled: next })} />
            {popup.enabled ? <>
            <PrefRow title="Kejadian" description="Jenis alarm yang dimunculkan">
              <EventChecks value={popup.events as EventId[]} onChange={(events) => setPopup({ ...popup, events })} />
            </PrefRow>
            <PrefRow title="Lama tampil" description="0 = tampil sampai ditutup" htmlFor="popup-duration">
              <div className="pref-number">
                <input id="popup-duration" type="number" min={0} max={600} value={popup.durationSec} onChange={(event) => setPopup({ ...popup, durationSec: Number(event.target.value) })} />
                <span>detik</span>
              </div>
            </PrefRow>
            <PrefRow title="Posisi" htmlFor="popup-position">
              <select id="popup-position" value={popup.position} onChange={(event) => setPopup({ ...popup, position: event.target.value as PopupConfig['position'] })}>
                <option value="top-right">Kanan atas</option>
                <option value="bottom-right">Kanan bawah</option>
              </select>
            </PrefRow>
            </> : null}
          </div>
        </PrefSection>

        <PrefSection title="Telegram" description="Kirim pemberitahuan lewat bot Telegram">
          <div className="pref-list">
            <PrefSwitch
              title="Aktifkan Telegram"
              description={telegram.enabled ? undefined : 'Nyalakan untuk mengatur bot dan chat tujuan'}
              checked={telegram.enabled}
              onChange={(next) => setTelegram({ ...telegram, enabled: next })}
            />
            {telegram.enabled ? <>
            <PrefRow
              stack
              title={`Token bot${telegram.botTokenSet ? ' · tersimpan' : ''}`}
              description="Buat bot lewat @BotFather, lalu tempel tokennya di sini"
              htmlFor="tg-token"
            >
              <div className="pref-inline">
                <input
                  id="tg-token"
                  className="secret"
                  type="password"
                  autoComplete="new-password"
                  value={telegram.botToken}
                  placeholder={telegram.botTokenSet ? 'Kosongkan jika tidak diubah' : '123456789:AA...'}
                  onChange={(event) => setTelegram({ ...telegram, botToken: event.target.value })}
                />
                <button className="btn-ghost" type="button" disabled={busy === 'bot'} onClick={checkBot}>{busy === 'bot' ? 'Memeriksa...' : 'Cek bot'}</button>
                <button className="btn-ghost" type="button" disabled={busy === 'chats'} onClick={findChats}>{busy === 'chats' ? 'Mencari...' : 'Cari chat ID'}</button>
              </div>
              {telegram.botTokenSet || bot ? (
                <div className="pref-meta">
                  {telegram.botTokenSet ? (
                    <label className="chip-check"><input type="checkbox" checked={telegram.clearBotToken} onChange={(event) => setTelegram({ ...telegram, clearBotToken: event.target.checked })} />Hapus token tersimpan</label>
                  ) : null}
                  {bot ? <span className="status-ok">Bot: {bot}</span> : null}
                </div>
              ) : null}
            </PrefRow>
            {chats ? (
              <PrefRow stack title="Chat yang pernah menghubungi bot">
                {chats.length === 0 ? <span className="pref-value">Belum ada. Kirim pesan ke bot dulu, lalu cari lagi.</span> : chats.map((chat) => (
                  <div className="pref-pick" key={chat.id}>
                    <span>{chat.name} · {chat.type} · <code>{chat.id}</code></span>
                    <button className="btn-ghost btn-sm" type="button" disabled={usedChats.includes(chat.id)} onClick={() => addChat(chat.id)}>
                      {usedChats.includes(chat.id) ? 'Sudah dipakai' : 'Tambah'}
                    </button>
                  </div>
                ))}
              </PrefRow>
            ) : null}
            <PrefRow
              stack
              title="Chat ID tujuan"
              description="Satu per baris. Kirim /start ke bot, atau tambahkan bot ke grup dan kirim satu pesan, lalu klik Cari chat ID."
              htmlFor="tg-chats"
            >
              <textarea id="tg-chats" rows={3} className="secret" value={telegram.chatIds} placeholder="-1001234567890" onChange={(event) => setTelegram({ ...telegram, chatIds: event.target.value })} />
            </PrefRow>
            <PrefRow title="Kejadian" description="Jenis alarm yang dikirim">
              <EventChecks value={telegram.events} onChange={(events) => setTelegram({ ...telegram, events })} />
            </PrefRow>
            </> : null}
          </div>
          {telegram.enabled ? (
            <PrefActions>
              <button className="btn-ghost" type="button" disabled={busy === 'telegram'} onClick={() => sendTest('telegram')}>{busy === 'telegram' ? 'Mengirim...' : 'Kirim tes Telegram'}</button>
            </PrefActions>
          ) : null}
        </PrefSection>

        <PrefSection title="WhatsApp" description="Kirim pemberitahuan lewat gateway WhatsApp">
          <div className="pref-list">
            <PrefSwitch
              title="Aktifkan WhatsApp"
              description={whatsapp.enabled ? undefined : 'Nyalakan untuk mengatur gateway dan nomor tujuan'}
              checked={whatsapp.enabled}
              onChange={(next) => setWhatsapp({ ...whatsapp, enabled: next })}
            />
            {whatsapp.enabled ? <>
            <PrefRow title="Gateway" htmlFor="wa-provider">
              <select id="wa-provider" value={whatsapp.provider} onChange={(event) => changeProvider(event.target.value as Provider)}>
                {(Object.keys(providerLabels) as Provider[]).map((item) => <option key={item} value={item}>{providerLabels[item]}</option>)}
              </select>
            </PrefRow>
            <PrefRow
              stack
              title="URL API"
              description={
                whatsapp.provider === 'fonnte' ? 'Hubungkan nomor bot di dashboard fonnte.com dengan scan QR, lalu salin token device.'
                  : whatsapp.provider === 'wablas' ? 'Isi domain server Wablas Anda dan token device.'
                    : 'Aplikasi mengirim POST JSON {"target", "message"} ke URL ini, dengan header Authorization berisi token jika diisi.'
              }
              htmlFor="wa-url"
            >
              <input
                id="wa-url"
                value={whatsapp.apiUrl}
                placeholder={whatsapp.provider === 'wablas' ? 'https://jkt.wablas.com' : whatsapp.provider === 'custom' ? 'https://gateway.anda/send' : ''}
                onChange={(event) => setWhatsapp({ ...whatsapp, apiUrl: event.target.value })}
              />
            </PrefRow>
            <PrefRow stack title={`Token${whatsapp.tokenSet ? ' · tersimpan' : ''}`} htmlFor="wa-token">
              <input
                id="wa-token"
                className="secret"
                type="password"
                autoComplete="new-password"
                value={whatsapp.token}
                placeholder={whatsapp.tokenSet ? 'Kosongkan jika tidak diubah' : 'Token dari gateway WhatsApp'}
                onChange={(event) => setWhatsapp({ ...whatsapp, token: event.target.value })}
              />
              {whatsapp.tokenSet ? (
                <div className="pref-meta">
                  <label className="chip-check"><input type="checkbox" checked={whatsapp.clearToken} onChange={(event) => setWhatsapp({ ...whatsapp, clearToken: event.target.checked })} />Hapus token tersimpan</label>
                </div>
              ) : null}
            </PrefRow>
            <PrefRow stack title="Nomor atau ID grup tujuan" description="Satu per baris" htmlFor="wa-targets">
              <textarea id="wa-targets" rows={3} className="secret" value={whatsapp.targets} placeholder={'081234567890\n120363012345678901@g.us'} onChange={(event) => setWhatsapp({ ...whatsapp, targets: event.target.value })} />
            </PrefRow>
            <PrefRow title="Kejadian" description="Jenis alarm yang dikirim">
              <EventChecks value={whatsapp.events} onChange={(events) => setWhatsapp({ ...whatsapp, events })} />
            </PrefRow>
            </> : null}
          </div>
          {whatsapp.enabled ? (
            <PrefActions>
              <button className="btn-ghost" type="button" disabled={busy === 'whatsapp'} onClick={() => sendTest('whatsapp')}>{busy === 'whatsapp' ? 'Mengirim...' : 'Kirim tes WhatsApp'}</button>
            </PrefActions>
          ) : null}
        </PrefSection>

        <PrefSection title="Template pesan" description="Dipakai untuk Telegram dan WhatsApp">
          <p className="pref-hint">
            Kata dalam kurung kurawal diganti otomatis:{' '}
            {placeholders.split(' ').map((item) => <code key={item}>{item}</code>)}
          </p>
          <div className="pref-list">
            {(Object.keys(eventLabels) as EventId[]).map((key) => (
              <PrefRow
                stack
                key={key}
                title={eventLabels[key]}
                htmlFor={`tpl-${key}`}
                aside={<button className="btn-ghost btn-sm" type="button" onClick={() => setTemplates({ ...templates, [key]: defaults.templates[key] })}>Bawaan</button>}
              >
                <textarea id={`tpl-${key}`} rows={5} value={templates[key]} onChange={(event) => setTemplates({ ...templates, [key]: event.target.value })} />
              </PrefRow>
            ))}
          </div>
          <p className="pref-hint">
            Pesan dikirim setelah alarm bertahan selama Alert delay perangkat. Perangkat dengan notifikasi dimatikan atau dalam maintenance tidak dikirimi pesan.
            Pesan pulih hanya dikirim bila pesan DOWN atau WARNING-nya sudah terkirim.
          </p>
        </PrefSection>
        <PrefActions><button className="btn" type="submit">Simpan notifikasi</button></PrefActions>
        <PrefFlash message={message} error={error} />
      </form>
      <div className="pref wide">
        <PrefSection
          title="Riwayat pengiriman"
          description="Pesan Telegram dan WhatsApp terakhir"
          action={<button className="btn-ghost btn-sm" type="button" onClick={loadLogs}>Muat ulang</button>}
        >
          {logs.length === 0 ? <p className="pref-empty pref-pad">Belum ada pengiriman</p> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Waktu</th><th>Kanal</th><th>Tujuan</th><th>Kejadian</th><th>Status</th><th>Keterangan</th></tr></thead>
              <tbody>
                {logs.map((row) => (
                  <tr key={row.id}>
                    <td>{new Date(row.sentAt).toLocaleString('id-ID')}</td>
                    <td>{row.channel === 'telegram' ? 'Telegram' : 'WhatsApp'}</td>
                    <td className="secret">{row.target ?? '—'}</td>
                    <td>{logEventLabels[row.event] ?? row.event}</td>
                    <td><span className={row.status === 'sent' ? 'badge up' : 'badge down'}>{row.status === 'sent' ? 'Terkirim' : 'Gagal'}</span></td>
                    <td>{row.error ?? row.alarmTitle ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          )}
        </PrefSection>
      </div>
    </>
  );
}

function EventChecks({ value, onChange }: { value: EventId[]; onChange: (next: EventId[]) => void }) {
  return (
    <div className="chip-checks">
      {(Object.keys(eventLabels) as EventId[]).map((key) => (
        <label className="chip-check" key={key}>
          <input
            type="checkbox"
            checked={value.includes(key)}
            onChange={(event) => onChange(event.target.checked ? [...value, key] : value.filter((item) => item !== key))}
          />
          {eventLabels[key]}
        </label>
      ))}
    </div>
  );
}

function lines(value: string) {
  return [...new Set(value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean))];
}
