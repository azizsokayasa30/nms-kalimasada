import { Injectable, Logger } from '@nestjs/common';
import { Alarm, Device, DeviceGroup, NotificationLog } from '@prisma/client';
import { PrismaService } from '../infra/prisma.service';
import { NotificationConfig, NotificationSettings, NotifyEvent, Templates, WhatsappConfig } from './notification-config';
import { sendTelegram, sendWhatsapp } from './senders';

type Channel = 'telegram' | 'whatsapp';
type Delivery = { channel: Channel; target: string; events: NotifyEvent[]; send: (text: string) => Promise<void> };
type AlarmRow = Alarm & { device: Device & { group: DeviceGroup | null } };

const LOOKBACK_MS = 30 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const SILENT_RECOVERY = ['Digantikan alarm DOWN', 'Alarm diganti kejadian baru'];

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: NotificationConfig,
  ) {}

  async process() {
    if (this.running) return;
    this.running = true;
    try {
      await this.dispatch();
    } catch (error) {
      this.logger.warn(`Notifikasi gagal diproses: ${error instanceof Error ? error.message : error}`);
    } finally {
      this.running = false;
    }
  }

  async test(channel: Channel, settings: NotificationSettings) {
    const missing = channel === 'telegram'
      ? (!settings.telegram.botToken ? 'Isi token bot Telegram' : !settings.telegram.chatIds.length ? 'Isi minimal satu chat ID' : '')
      : (!settings.whatsapp.apiUrl ? 'Isi URL API WhatsApp' : !settings.whatsapp.targets.length ? 'Isi minimal satu nomor tujuan' : '');
    if (missing) return [{ target: '', ok: false, error: missing }];
    const deliveries = buildDeliveries(settings, true).filter((item) => item.channel === channel);
    const text = `Tes notifikasi Kalimasada NMS via ${channel === 'telegram' ? 'Telegram' : 'WhatsApp'}.\nJika pesan ini masuk, pengaturan sudah benar.\nWaktu: ${formatTime(new Date())}`;
    const results: Array<{ target: string; ok: boolean; error: string | null }> = [];
    for (const delivery of deliveries) {
      const error = await this.deliver(delivery, null, 'test', text);
      results.push({ target: delivery.target, ok: !error, error });
    }
    return results;
  }

  private async dispatch() {
    const settings = await this.config.read();
    const deliveries = buildDeliveries(settings, false);
    if (!deliveries.length) return;
    const since = new Date(Date.now() - LOOKBACK_MS);
    const include = { device: { include: { group: true } } } as const;
    const [opened, recovered] = await Promise.all([
      this.prisma.alarm.findMany({ where: { state: 'active', suppressed: false, openedAt: { gte: since } }, include }),
      this.prisma.alarm.findMany({
        where: { state: 'recovered', recoveredAt: { gte: since }, NOT: { message: { in: SILENT_RECOVERY } } },
        include,
      }),
    ]);
    const ids = [...opened, ...recovered].map((alarm) => alarm.id);
    if (!ids.length) return;
    const logs = await this.prisma.notificationLog.findMany({ where: { alarmId: { in: ids } } });
    const now = Date.now();

    for (const alarm of opened) {
      const { device } = alarm;
      if (!device.notificationEnabled || device.maintenance) continue;
      if (alarm.openedAt.getTime() + device.alertDelaySec * 1000 > now) continue;
      const event: NotifyEvent = alarm.kind === 'down' ? 'down' : 'warning';
      for (const delivery of deliveries) {
        if (!delivery.events.includes(event) || !shouldSend(logs, alarm.id, delivery, [event])) continue;
        await this.deliver(delivery, alarm.id, event, render(settings.templates, event, alarm));
      }
    }

    for (const alarm of recovered) {
      if (!alarm.device.notificationEnabled) continue;
      for (const delivery of deliveries) {
        if (!delivery.events.includes('recovered')) continue;
        if (!wasSent(logs, alarm.id, delivery, ['down', 'warning'])) continue;
        if (!shouldSend(logs, alarm.id, delivery, ['recovered'])) continue;
        await this.deliver(delivery, alarm.id, 'recovered', render(settings.templates, 'recovered', alarm));
      }
    }
  }

  private async deliver(delivery: Delivery, alarmId: string | null, event: string, text: string) {
    let error: string | null = null;
    try {
      await delivery.send(text);
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
      this.logger.warn(`${delivery.channel} ke ${delivery.target} gagal: ${error}`);
    }
    await this.prisma.notificationLog.create({
      data: {
        alarmId,
        channel: delivery.channel,
        target: delivery.target,
        event,
        status: error ? 'failed' : 'sent',
        error,
      },
    });
    return error;
  }
}

function buildDeliveries(settings: NotificationSettings, ignoreEnabled: boolean): Delivery[] {
  const list: Delivery[] = [];
  const { telegram, whatsapp } = settings;
  if ((ignoreEnabled || telegram.enabled) && telegram.botToken) {
    for (const chatId of telegram.chatIds) {
      list.push({ channel: 'telegram', target: chatId, events: telegram.events, send: (text) => sendTelegram(telegram.botToken, chatId, text) });
    }
  }
  if ((ignoreEnabled || whatsapp.enabled) && whatsapp.apiUrl) {
    const gateway: Pick<WhatsappConfig, 'provider' | 'apiUrl' | 'token'> = whatsapp;
    for (const target of whatsapp.targets) {
      list.push({ channel: 'whatsapp', target, events: whatsapp.events, send: (text) => sendWhatsapp(gateway, target, text) });
    }
  }
  return list;
}

function matching(logs: NotificationLog[], alarmId: string, delivery: Delivery, events: string[]) {
  return logs.filter((log) => log.alarmId === alarmId
    && log.channel === delivery.channel
    && log.target === delivery.target
    && events.includes(log.event));
}

function wasSent(logs: NotificationLog[], alarmId: string, delivery: Delivery, events: string[]) {
  return matching(logs, alarmId, delivery, events).some((log) => log.status === 'sent');
}

function shouldSend(logs: NotificationLog[], alarmId: string, delivery: Delivery, events: string[]) {
  const rows = matching(logs, alarmId, delivery, events);
  if (rows.some((log) => log.status === 'sent')) return false;
  return rows.length < MAX_ATTEMPTS;
}

export function render(templates: Templates, event: NotifyEvent, alarm: AlarmRow) {
  const { device } = alarm;
  const at = event === 'recovered' ? alarm.recoveredAt ?? new Date() : alarm.openedAt;
  const vars: Record<string, string> = {
    device: device.name,
    ip: device.ipAddress,
    location: device.location || '-',
    group: device.group?.name || '-',
    title: alarm.title,
    severity: alarm.severity.toUpperCase(),
    status: event === 'recovered' ? 'UP' : event.toUpperCase(),
    time: formatTime(at),
    duration: formatDuration(alarm.downtimeSec ?? Math.floor((Date.now() - alarm.openedAt.getTime()) / 1000)),
    downstream: String(alarm.downstreamCount),
  };
  return templates[event].replace(/\{(\w+)\}/g, (match, key: string) => vars[key] ?? match);
}

function formatTime(date: Date) {
  return `${date.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'medium', timeStyle: 'medium' })} WIB`;
}

function formatDuration(totalSec: number) {
  const sec = Math.max(0, totalSec);
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  const seconds = sec % 60;
  const parts = [
    days ? `${days} hari` : '',
    hours ? `${hours} jam` : '',
    minutes ? `${minutes} menit` : '',
    !days && !hours ? `${seconds} detik` : '',
  ].filter(Boolean);
  return parts.join(' ');
}
