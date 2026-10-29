import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { decryptSecret, encryptSecret } from '../infra/crypto';
import { PrismaService } from '../infra/prisma.service';

export const notifyEvents = ['down', 'warning', 'recovered'] as const;
export type NotifyEvent = (typeof notifyEvents)[number];

export const whatsappProviders = ['fonnte', 'wablas', 'custom'] as const;
export type WhatsappProvider = (typeof whatsappProviders)[number];

export const popupPositions = ['center', 'top-right', 'bottom-right'] as const;
export type PopupPosition = (typeof popupPositions)[number];

export type PopupConfig = {
  enabled: boolean;
  events: NotifyEvent[];
  durationSec: number;
  position: PopupPosition;
};

export type TelegramConfig = {
  enabled: boolean;
  events: NotifyEvent[];
  botToken: string;
  chatIds: string[];
};

export type WhatsappConfig = {
  enabled: boolean;
  events: NotifyEvent[];
  provider: WhatsappProvider;
  apiUrl: string;
  token: string;
  targets: string[];
};

export type Templates = Record<NotifyEvent, string>;

export type NotificationSettings = {
  popup: PopupConfig;
  telegram: TelegramConfig;
  whatsapp: WhatsappConfig;
  templates: Templates;
};

export type NotificationPatch = {
  popup?: Partial<PopupConfig>;
  telegram?: Partial<Omit<TelegramConfig, 'botToken'>> & { botToken?: string; clearBotToken?: boolean };
  whatsapp?: Partial<Omit<WhatsappConfig, 'token'>> & { token?: string; clearToken?: boolean };
  templates?: Partial<Templates>;
};

export const defaultTemplates: Templates = {
  down: '[DOWN] {device} ({ip})\nLokasi: {location}\nGrup: {group}\nMulai: {time}\nPerangkat terdampak di bawahnya: {downstream}',
  warning: '[WARNING] {title}\nIP: {ip}\nLokasi: {location}\nMulai: {time}',
  recovered: '[UP] {device} ({ip}) sudah pulih\nDowntime: {duration}\nPulih: {time}',
};

export const defaultWhatsappUrl: Record<WhatsappProvider, string> = {
  fonnte: 'https://api.fonnte.com/send',
  wablas: '',
  custom: '',
};

@Injectable()
export class NotificationConfig {
  private readonly logger = new Logger(NotificationConfig.name);

  constructor(private readonly prisma: PrismaService) {}

  async read(): Promise<NotificationSettings> {
    const rows = await this.prisma.notificationRule.findMany();
    const byChannel = new Map(rows.map((row) => [row.channel, row]));
    const popup = byChannel.get('popup');
    const telegram = byChannel.get('telegram');
    const whatsapp = byChannel.get('whatsapp');
    const template = asObject(byChannel.get('template')?.config);
    const popupConfig = asObject(popup?.config);
    const telegramConfig = asObject(telegram?.config);
    const whatsappConfig = asObject(whatsapp?.config);
    const provider = pick(whatsappConfig.provider, whatsappProviders, 'fonnte');
    return {
      popup: {
        enabled: popup ? popup.enabled : true,
        events: asEvents(popup?.events, ['down', 'warning', 'recovered']),
        durationSec: clampInt(popupConfig.durationSec, 0, 600, 15),
        position: pick(popupConfig.position, popupPositions, 'center'),
      },
      telegram: {
        enabled: telegram?.enabled ?? false,
        events: asEvents(telegram?.events, ['down', 'recovered']),
        botToken: this.reveal(telegramConfig.botTokenEnc, 'token bot Telegram'),
        chatIds: asList(telegramConfig.chatIds),
      },
      whatsapp: {
        enabled: whatsapp?.enabled ?? false,
        events: asEvents(whatsapp?.events, ['down', 'recovered']),
        provider,
        apiUrl: typeof whatsappConfig.apiUrl === 'string' && whatsappConfig.apiUrl ? whatsappConfig.apiUrl : defaultWhatsappUrl[provider],
        token: this.reveal(whatsappConfig.tokenEnc, 'token WhatsApp'),
        targets: asList(whatsappConfig.targets),
      },
      templates: {
        down: textOr(template.down, defaultTemplates.down),
        warning: textOr(template.warning, defaultTemplates.warning),
        recovered: textOr(template.recovered, defaultTemplates.recovered),
      },
    };
  }

  async save(patch: NotificationPatch) {
    const current = await this.read();
    if (patch.popup) {
      const next = { ...current.popup, ...defined(patch.popup) };
      await this.write('popup', next.enabled, next.events, { durationSec: next.durationSec, position: next.position });
    }
    if (patch.telegram) {
      const { botToken, clearBotToken, ...rest } = patch.telegram;
      const next = { ...current.telegram, ...defined(rest) };
      const token = clearBotToken ? '' : botToken?.trim() || current.telegram.botToken;
      await this.write('telegram', next.enabled, next.events, {
        botTokenEnc: token ? encryptSecret(token) : null,
        chatIds: cleanList(next.chatIds),
      });
    }
    if (patch.whatsapp) {
      const { token, clearToken, ...rest } = patch.whatsapp;
      const next = { ...current.whatsapp, ...defined(rest) };
      const secret = clearToken ? '' : token?.trim() || current.whatsapp.token;
      await this.write('whatsapp', next.enabled, next.events, {
        provider: next.provider,
        apiUrl: next.apiUrl.trim(),
        tokenEnc: secret ? encryptSecret(secret) : null,
        targets: cleanList(next.targets),
      });
    }
    if (patch.templates) {
      const next = { ...current.templates };
      for (const event of notifyEvents) {
        const value = patch.templates[event];
        if (value !== undefined) next[event] = value.trim() || defaultTemplates[event];
      }
      await this.write('template', true, [], next);
    }
  }

  private async write(channel: string, enabled: boolean, events: NotifyEvent[], config: Record<string, unknown>) {
    const data = {
      enabled,
      events: events as unknown as Prisma.InputJsonValue,
      config: config as Prisma.InputJsonValue,
    };
    await this.prisma.notificationRule.upsert({
      where: { channel },
      update: data,
      create: { channel, ...data },
    });
  }

  private reveal(payload: unknown, label: string) {
    if (typeof payload !== 'string' || !payload) return '';
    try {
      return decryptSecret(payload);
    } catch {
      this.logger.warn(`${label} tidak bisa dibaca, isi ulang di Pengaturan > Notifikasi`);
      return '';
    }
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asEvents(value: unknown, fallback: NotifyEvent[]): NotifyEvent[] {
  if (!Array.isArray(value)) return fallback;
  return notifyEvents.filter((event) => value.includes(event));
}

function asList(value: unknown) {
  return Array.isArray(value) ? cleanList(value.map(String)) : [];
}

function cleanList(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function textOr(value: unknown, fallback: string) {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function clampInt(value: unknown, min: number, max: number, fallback: number) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? value as T : fallback;
}

function defined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}
