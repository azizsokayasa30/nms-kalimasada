import { BadRequestException, Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { Roles } from '../auth/auth.decorators';
import { PrismaService } from '../infra/prisma.service';
import {
  NotificationConfig,
  NotificationSettings,
  NotifyEvent,
  PopupPosition,
  WhatsappProvider,
  defaultTemplates,
  defaultWhatsappUrl,
  notifyEvents,
  popupPositions,
  whatsappProviders,
} from './notification-config';
import { NotificationService } from './notification.service';
import { telegramBot, telegramChats } from './senders';

class PopupBody {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsArray()
  @IsIn(notifyEvents, { each: true })
  events?: NotifyEvent[];

  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(600)
  durationSec?: number;

  @IsOptional()
  @IsIn(popupPositions)
  position?: PopupPosition;
}

class TelegramBody {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsArray()
  @IsIn(notifyEvents, { each: true })
  events?: NotifyEvent[];

  @IsOptional()
  @IsString()
  @MaxLength(200)
  botToken?: string;

  @IsOptional()
  @IsBoolean()
  clearBotToken?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  chatIds?: string[];
}

class WhatsappBody {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsArray()
  @IsIn(notifyEvents, { each: true })
  events?: NotifyEvent[];

  @IsOptional()
  @IsIn(whatsappProviders)
  provider?: WhatsappProvider;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  apiUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  token?: string;

  @IsOptional()
  @IsBoolean()
  clearToken?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  targets?: string[];
}

class TemplatesBody {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  down?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  warning?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  recovered?: string;
}

class NotificationBody {
  @IsOptional()
  @ValidateNested()
  @Type(() => PopupBody)
  popup?: PopupBody;

  @IsOptional()
  @ValidateNested()
  @Type(() => TelegramBody)
  telegram?: TelegramBody;

  @IsOptional()
  @ValidateNested()
  @Type(() => WhatsappBody)
  whatsapp?: WhatsappBody;

  @IsOptional()
  @ValidateNested()
  @Type(() => TemplatesBody)
  templates?: TemplatesBody;
}

class BotBody {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  botToken?: string;
}

@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: NotificationConfig,
    private readonly notifier: NotificationService,
  ) {}

  @Get('popup')
  async popup() {
    return (await this.config.read()).popup;
  }

  @Roles('admin')
  @Get()
  async get() {
    return present(await this.config.read());
  }

  @Roles('admin')
  @Put()
  async update(@Body() body: NotificationBody) {
    assertUrl(body.whatsapp?.apiUrl);
    await this.config.save(body);
    return present(await this.config.read());
  }

  @Roles('admin')
  @Post('test/:channel')
  async test(@Param('channel') channel: string, @Body() body: NotificationBody) {
    if (channel !== 'telegram' && channel !== 'whatsapp') throw new BadRequestException('Kanal tidak dikenal');
    assertUrl(body.whatsapp?.apiUrl);
    const saved = await this.config.read();
    const draft: NotificationSettings = {
      ...saved,
      telegram: {
        ...saved.telegram,
        ...pickDefined({ events: body.telegram?.events, chatIds: body.telegram?.chatIds }),
        botToken: body.telegram?.botToken?.trim() || saved.telegram.botToken,
      },
      whatsapp: {
        ...saved.whatsapp,
        ...pickDefined({ provider: body.whatsapp?.provider, apiUrl: body.whatsapp?.apiUrl?.trim(), targets: body.whatsapp?.targets }),
        token: body.whatsapp?.token?.trim() || saved.whatsapp.token,
      },
    };
    draft.telegram.chatIds = draft.telegram.chatIds.map((item) => item.trim()).filter(Boolean);
    draft.whatsapp.targets = draft.whatsapp.targets.map((item) => item.trim()).filter(Boolean);
    const results = await this.notifier.test(channel, draft);
    return { ok: results.every((row) => row.ok), results };
  }

  @Roles('admin')
  @Post('telegram/bot')
  async bot(@Body() body: BotBody) {
    const token = await this.botToken(body);
    return asBadRequest(() => telegramBot(token));
  }

  @Roles('admin')
  @Post('telegram/chats')
  async chats(@Body() body: BotBody) {
    const token = await this.botToken(body);
    return { chats: await asBadRequest(() => telegramChats(token)) };
  }

  @Roles('admin')
  @Get('logs')
  async logs() {
    const rows = await this.prisma.notificationLog.findMany({ orderBy: { sentAt: 'desc' }, take: 50 });
    const alarmIds = [...new Set(rows.map((row) => row.alarmId).filter((id): id is string => Boolean(id)))];
    const alarms = alarmIds.length
      ? await this.prisma.alarm.findMany({ where: { id: { in: alarmIds } }, select: { id: true, title: true } })
      : [];
    const titles = new Map(alarms.map((alarm) => [alarm.id, alarm.title]));
    return rows.map((row) => ({
      id: row.id,
      channel: row.channel,
      target: row.target,
      event: row.event,
      status: row.status,
      error: row.error,
      sentAt: row.sentAt,
      alarmTitle: row.alarmId ? titles.get(row.alarmId) ?? null : null,
    }));
  }

  private async botToken(body: BotBody) {
    const token = body.botToken?.trim() || (await this.config.read()).telegram.botToken;
    if (!token) throw new BadRequestException('Isi token bot Telegram');
    return token;
  }
}

function present(settings: NotificationSettings) {
  const { botToken, ...telegram } = settings.telegram;
  const { token, ...whatsapp } = settings.whatsapp;
  return {
    popup: settings.popup,
    telegram: { ...telegram, botTokenSet: Boolean(botToken) },
    whatsapp: { ...whatsapp, tokenSet: Boolean(token) },
    templates: settings.templates,
    defaults: { templates: defaultTemplates, whatsappUrl: defaultWhatsappUrl },
  };
}

async function asBadRequest<T>(task: () => Promise<T>) {
  try {
    return await task();
  } catch (error) {
    throw new BadRequestException(error instanceof Error ? error.message : 'Permintaan ke Telegram gagal');
  }
}

function pickDefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}

function assertUrl(value?: string) {
  const trimmed = value?.trim();
  if (trimmed && !/^https?:\/\//i.test(trimmed)) throw new BadRequestException('URL API WhatsApp harus diawali http:// atau https://');
}
