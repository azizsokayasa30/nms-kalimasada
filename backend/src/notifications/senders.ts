import { WhatsappConfig } from './notification-config';

const TIMEOUT_MS = 15000;

type TelegramReply<T> = { ok?: boolean; description?: string; result?: T };

async function telegram<T>(token: string, method: string, body?: Record<string, unknown>) {
  if (!token) throw new Error('Token bot Telegram belum diisi');
  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`Telegram tidak terjangkau: ${reason(error)}`);
  }
  const data = (await response.json().catch(() => null)) as TelegramReply<T> | null;
  if (!response.ok || !data?.ok) {
    if (response.status === 401) throw new Error('Token bot Telegram ditolak');
    throw new Error(`Telegram: ${data?.description ?? `HTTP ${response.status}`}`);
  }
  return data.result as T;
}

export async function sendTelegram(token: string, chatId: string, text: string) {
  await telegram(token, 'sendMessage', { chat_id: chatId, text, disable_web_page_preview: true });
}

export async function telegramBot(token: string) {
  const bot = await telegram<{ id: number; username?: string; first_name?: string }>(token, 'getMe');
  return { id: String(bot.id), username: bot.username ?? '', name: bot.first_name ?? '' };
}

type TelegramChat = { id: number; type: string; title?: string; username?: string; first_name?: string; last_name?: string };
type TelegramUpdate = {
  message?: { chat: TelegramChat };
  channel_post?: { chat: TelegramChat };
  my_chat_member?: { chat: TelegramChat };
};

export async function telegramChats(token: string) {
  const updates = await telegram<TelegramUpdate[]>(token, 'getUpdates', { limit: 100, allowed_updates: ['message', 'channel_post', 'my_chat_member'] });
  const chats = new Map<string, { id: string; name: string; type: string }>();
  for (const update of updates) {
    const chat = update.message?.chat ?? update.channel_post?.chat ?? update.my_chat_member?.chat;
    if (!chat) continue;
    const person = [chat.first_name, chat.last_name].filter(Boolean).join(' ');
    chats.set(String(chat.id), {
      id: String(chat.id),
      name: chat.title || person || (chat.username ? `@${chat.username}` : String(chat.id)),
      type: chat.type,
    });
  }
  return [...chats.values()];
}

export async function sendWhatsapp(config: Pick<WhatsappConfig, 'provider' | 'apiUrl' | 'token'>, target: string, text: string) {
  if (!config.apiUrl) throw new Error('URL API WhatsApp belum diisi');
  if (config.provider !== 'custom' && !config.token) throw new Error('Token WhatsApp belum diisi');
  const destination = config.provider === 'custom' ? target : normalizePhone(target);
  const headers: Record<string, string> = {};
  if (config.token) headers.Authorization = config.token;
  let url = config.apiUrl.trim();
  let body: string | URLSearchParams;
  if (config.provider === 'fonnte') {
    body = new URLSearchParams({ target: destination, message: text, countryCode: '62' });
  } else if (config.provider === 'wablas') {
    url = url.replace(/\/+$/, '');
    if (!/\/api\/send-message$/.test(url)) url = `${url}/api/send-message`;
    body = new URLSearchParams({ phone: destination, message: text });
  } else {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify({ target: destination, message: text });
  }
  let response: Response;
  try {
    response = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    throw new Error(`Gateway WhatsApp tidak terjangkau: ${reason(error)}`);
  }
  const raw = await response.text();
  const data = parseJson(raw);
  if (!response.ok) throw new Error(`WhatsApp: ${describe(data) || `HTTP ${response.status}`}`);
  if (config.provider !== 'custom' && data && data.status === false) {
    throw new Error(`WhatsApp: ${describe(data) || 'ditolak gateway'}`);
  }
}

export function normalizePhone(target: string) {
  const value = target.trim();
  if (value.includes('@') || value.includes('-')) return value;
  const digits = value.replace(/\D/g, '');
  return digits.startsWith('0') ? `62${digits.slice(1)}` : digits;
}

function parseJson(raw: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function describe(data: Record<string, unknown> | null) {
  if (!data) return '';
  for (const key of ['reason', 'message', 'detail', 'error']) {
    const value = data[key];
    if (typeof value === 'string' && value) return value;
  }
  return '';
}

function reason(error: unknown) {
  if (error instanceof Error && error.name === 'TimeoutError') return 'waktu habis';
  if (error instanceof Error) return (error.cause instanceof Error ? error.cause.message : '') || error.message;
  return String(error);
}
