import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Alarm, AlarmSeverity, Criticality, Device, DeviceStatus } from '@prisma/client';
import { PrismaService } from '../infra/prisma.service';
import { NotificationService } from '../notifications/notification.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { ProvisionService } from '../zabbix/zabbix.provision';
import { ZabbixProblem, ZabbixService } from '../zabbix/zabbix.service';
import { UplinkService } from './uplink.service';

@Injectable()
export class SyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SyncService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private misses = 0;
  private webhookReady = false;
  private triggersRefreshed = false;
  private readonly flips = new Map<string, number[]>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly zabbix: ZabbixService,
    private readonly provision: ProvisionService,
    private readonly gateway: RealtimeGateway,
    private readonly notifier: NotificationService,
    private readonly uplink: UplinkService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.sync(), 10000);
    setTimeout(() => void this.sync(), 2500);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  request() {
    return this.sync();
  }

  async sync() {
    if (this.running) return;
    this.running = true;
    try {
      const connected = await this.zabbix.ensureConnection();
      if (!connected) {
        this.misses += 1;
        if (this.misses === 1 || this.misses % 6 === 0) {
          this.logger.warn(this.zabbix.lastError ?? 'Zabbix belum terhubung');
        }
        return;
      }
      if (this.misses > 0) {
        this.logger.log(`Zabbix terhubung, versi ${this.zabbix.version}`);
      }
      if (!this.webhookReady) this.webhookReady = await this.zabbix.ensureWebhook();
      this.misses = 0;
      if (!this.triggersRefreshed) {
        this.triggersRefreshed = true;
        await this.provision.refreshWarningTriggers();
      }

      const pending = await this.prisma.device.findMany({ where: { zabbixHostId: null } });
      for (const device of pending) {
        try {
          await this.provision.syncDevice(device.id);
        } catch (error) {
          this.logger.warn(`${device.name}: ${error instanceof Error ? error.message : error}`);
        }
      }

      const devices = await this.prisma.device.findMany();
      try {
        await this.provision.reconcile(devices);
      } catch (error) {
        this.logger.warn(`Sinkron graph gagal: ${error instanceof Error ? error.message : error}`);
      }
      const hostIds = devices.map((device) => device.zabbixHostId).filter((id): id is string => Boolean(id));
      const snapshot = await this.zabbix.snapshot(hostIds);
      const itemsByHost = new Map<string, typeof snapshot.items>();
      for (const item of snapshot.items) {
        const list = itemsByHost.get(item.hostid) ?? [];
        list.push(item);
        itemsByHost.set(item.hostid, list);
      }
      const problemsByTrigger = new Map<string, ZabbixProblem>();
      for (const problem of snapshot.problems) problemsByTrigger.set(problem.objectid, problem);

      const raw = new Map<string, DeviceStatus>();
      for (const device of devices) raw.set(device.id, this.rawStatus(device, itemsByHost, problemsByTrigger));
      const effective = this.applyTree(devices, raw);
      const children = this.groupChildren(devices);
      const changed: string[] = [];
      let alarmOpened = false;
      let alarmRecovered = false;

      for (const device of devices) {
        const nextEffective = effective.get(device.id) ?? 'unknown';
        const wasDown = device.status === 'down' || (device.status === 'flapping' && device.downSince);
        const flapping = this.trackFlips(device, Boolean(wasDown), nextEffective);
        const display: DeviceStatus = flapping ? 'flapping' : nextEffective;
        const probe = this.probeOf(device, itemsByHost);
        let downSince = device.downSince;
        let downtimeSec = device.downtimeSec;
        if (nextEffective === 'down') {
          if (!downSince) {
            const problem = device.zabbixDownTriggerId
              ? problemsByTrigger.get(device.zabbixDownTriggerId)
              : undefined;
            downSince = problem ? new Date(Number(problem.clock) * 1000) : new Date();
          }
        } else if (wasDown && downSince) {
          downtimeSec += Math.max(0, Math.floor((Date.now() - downSince.getTime()) / 1000));
          downSince = null;
        }

        const changedRow =
          display !== device.status ||
          probe.latencyMs !== device.latencyMs ||
          probe.packetLoss !== device.packetLoss ||
          probe.lastResponse !== device.lastResponse ||
          downSince?.getTime() !== device.downSince?.getTime();
        if (changedRow) {
          await this.prisma.device.update({
            where: { id: device.id },
            data: {
              status: display,
              latencyMs: probe.latencyMs,
              packetLoss: probe.packetLoss,
              lastResponse: probe.lastResponse,
              lastSeenAt: probe.seen ? new Date() : device.lastSeenAt,
              downSince,
              downtimeSec,
            },
          });
          changed.push(device.id);
        }
        if (display !== device.status) {
          await this.prisma.event.create({
            data: {
              deviceId: device.id,
              type: 'status_change',
              message: `${device.name} ${display.toUpperCase()}`,
            },
          });
        }

        const alarmEvent = await this.syncAlarms(device, nextEffective, problemsByTrigger, children);
        alarmOpened = alarmOpened || alarmEvent.opened;
        alarmRecovered = alarmRecovered || alarmEvent.recovered;
      }

      if (changed.length) this.gateway.emit('device_status_changed', { ids: changed });
      if (alarmOpened) this.gateway.emit('alarm_created', { at: new Date().toISOString() });
      if (alarmRecovered) this.gateway.emit('alarm_recovered', { at: new Date().toISOString() });
      void this.notifier.process();
    } catch (error) {
      this.logger.error(error instanceof Error ? error.message : error);
    } finally {
      this.running = false;
    }
  }

  private trackFlips(device: Device, wasDown: boolean, next: DeviceStatus) {
    const now = Date.now();
    const recent = (this.flips.get(device.id) ?? []).filter((at) => now - at < FLAP_WINDOW_MS);
    const reachable = next === 'up' || next === 'warning' || next === 'down';
    const known = device.status !== 'unknown' && device.status !== 'unreachable';
    if (reachable && known && wasDown !== (next === 'down')) recent.push(now);
    if (recent.length) this.flips.set(device.id, recent);
    else this.flips.delete(device.id);
    return reachable && recent.length >= FLAP_MIN_FLIPS;
  }

  private rawStatus(
    device: Device,
    itemsByHost: Map<string, Array<{ key_: string; lastvalue: string }>>,
    problemsByTrigger: Map<string, ZabbixProblem>,
  ): DeviceStatus {
    if (!device.zabbixHostId) return 'unknown';
    const down = device.zabbixDownTriggerId ? problemsByTrigger.get(device.zabbixDownTriggerId) : undefined;
    const latency = device.zabbixLatencyTriggerId ? problemsByTrigger.get(device.zabbixLatencyTriggerId) : undefined;
    const loss = device.zabbixLossTriggerId ? problemsByTrigger.get(device.zabbixLossTriggerId) : undefined;
    if (down) return 'down';
    if (latency || loss) return 'warning';
    const ping = itemsByHost.get(device.zabbixHostId)?.find((item) => item.key_ === 'icmpping');
    if (!ping || ping.lastvalue === '') return 'unknown';
    return 'up';
  }

  private probeOf(device: Device, itemsByHost: Map<string, Array<{ key_: string; lastvalue: string }>>) {
    const items = device.zabbixHostId ? itemsByHost.get(device.zabbixHostId) ?? [] : [];
    const ping = items.find((item) => item.key_ === 'icmpping')?.lastvalue;
    const latency = items.find((item) => item.key_ === 'icmppingsec')?.lastvalue;
    const loss = items.find((item) => item.key_ === 'icmppingloss')?.lastvalue;
    const latencyNumber = latency === undefined || latency === '' ? null : Math.round(Number(latency) * 1000);
    const lossNumber = loss === undefined || loss === '' ? null : Number(loss);
    return {
      latencyMs: Number.isFinite(latencyNumber) ? latencyNumber : null,
      packetLoss: Number.isFinite(lossNumber) ? lossNumber : null,
      lastResponse: ping === '0' ? 'Timeout' : ping === '1' ? 'OK' : null,
      seen: ping === '1',
    };
  }

  private applyTree(devices: Device[], raw: Map<string, DeviceStatus>) {
    const children = this.groupChildren(devices);
    const result = new Map<string, DeviceStatus>();
    const walk = (id: string, blocked: boolean) => {
      const status: DeviceStatus = blocked ? 'unreachable' : (raw.get(id) ?? 'unknown');
      result.set(id, status);
      const nextBlocked = blocked || status === 'down';
      for (const child of children.get(id) ?? []) walk(child.id, nextBlocked);
    };
    for (const device of devices) {
      if (!device.parentId) walk(device.id, false);
    }
    for (const device of devices) {
      if (!result.has(device.id)) walk(device.id, false);
    }
    return result;
  }

  private groupChildren(devices: Device[]) {
    const children = new Map<string, Device[]>();
    for (const device of devices) {
      if (!device.parentId) continue;
      const list = children.get(device.parentId) ?? [];
      list.push(device);
      children.set(device.parentId, list);
    }
    return children;
  }

  private countDescendants(id: string, children: Map<string, Device[]>): number {
    let total = 0;
    for (const child of children.get(id) ?? []) total += 1 + this.countDescendants(child.id, children);
    return total;
  }

  private async syncAlarms(
    device: Device,
    effective: DeviceStatus,
    problemsByTrigger: Map<string, ZabbixProblem>,
    children: Map<string, Device[]>,
  ) {
    const active = await this.prisma.alarm.findMany({ where: { deviceId: device.id, state: 'active' } });
    let opened = false;
    let recovered = false;
    const recover = async (alarm: Alarm, message: string) => {
      const downtimeSec = Math.max(0, Math.floor((Date.now() - alarm.openedAt.getTime()) / 1000));
      await this.prisma.alarm.update({
        where: { id: alarm.id },
        data: {
          state: 'recovered',
          recoveredAt: new Date(),
          downtimeSec,
          suppressed: alarm.rootCauseName === SERVER_ROOT_CAUSE,
          message,
        },
      });
      await this.prisma.event.create({
        data: { deviceId: device.id, type: 'alarm_recovered', message: `${device.name} pulih. Downtime ${downtimeSec} detik` },
      });
      recovered = true;
    };

    if (device.maintenance) {
      for (const alarm of active) await recover(alarm, 'Maintenance');
      return { opened, recovered };
    }
    if (effective === 'unreachable') {
      if (active.some((alarm) => !alarm.suppressed)) {
        await this.prisma.alarm.updateMany({
          where: { deviceId: device.id, state: 'active' },
          data: { suppressed: true },
        });
      }
      return { opened, recovered };
    }

    const serverBlip = this.uplink.degradedWithin(device.failedThreshold * device.pingIntervalSec * 1000 + BLIP_MARGIN_MS);
    const rootCauseName = serverBlip ? SERVER_ROOT_CAUSE : device.name;

    if (effective === 'down' && device.zabbixDownTriggerId) {
      const problem = problemsByTrigger.get(device.zabbixDownTriggerId);
      if (problem) {
        const downstreamCount = this.countDescendants(device.id, children);
        const existing = active.find((alarm) => alarm.kind === 'down' && alarm.zabbixEventId === problem.eventid);
        if (existing) {
          await this.prisma.alarm.update({
            where: { id: existing.id },
            data: { suppressed: serverBlip, downstreamCount, rootCauseName, lastResponse: 'Timeout' },
          });
          if (existing.suppressed && !serverBlip) opened = true;
        } else {
          await this.prisma.alarm.create({
            data: {
              deviceId: device.id,
              severity: severityOf(device.criticality),
              title: `${device.name} DOWN`,
              message: device.ipAddress,
              kind: 'down',
              zabbixEventId: problem.eventid,
              zabbixTriggerId: problem.objectid,
              openedAt: new Date(Number(problem.clock) * 1000),
              lastResponse: 'Timeout',
              downstreamCount,
              rootCauseName,
              suppressed: serverBlip,
            },
          });
          await this.prisma.event.create({
            data: {
              deviceId: device.id,
              type: 'alarm_opened',
              message: serverBlip ? `${device.name} DOWN (jaringan server NMS terganggu)` : `${device.name} DOWN`,
            },
          });
          opened = !serverBlip;
        }
      }
      for (const alarm of active) {
        if (alarm.kind !== 'down') await recover(alarm, 'Digantikan alarm DOWN');
        else if (problem && alarm.zabbixEventId !== problem.eventid) await recover(alarm, 'Alarm diganti kejadian baru');
      }
      return { opened, recovered };
    }

    if (effective === 'warning') {
      const problem = device.zabbixLatencyTriggerId
        ? problemsByTrigger.get(device.zabbixLatencyTriggerId)
        : undefined;
      const lossProblem = device.zabbixLossTriggerId ? problemsByTrigger.get(device.zabbixLossTriggerId) : undefined;
      const source = problem ?? lossProblem;
      if (source) {
        const existing = active.find((alarm) => alarm.kind === 'warning' && alarm.zabbixEventId === source.eventid);
        if (existing && existing.suppressed !== serverBlip) {
          await this.prisma.alarm.update({ where: { id: existing.id }, data: { suppressed: serverBlip, rootCauseName } });
          opened = !serverBlip;
        } else if (!existing) {
          await this.prisma.alarm.create({
            data: {
              deviceId: device.id,
              severity: 'warning',
              title: problem ? `${device.name} latency tinggi` : `${device.name} packet loss tinggi`,
              message: device.ipAddress,
              kind: 'warning',
              zabbixEventId: source.eventid,
              zabbixTriggerId: source.objectid,
              openedAt: new Date(Number(source.clock) * 1000),
              lastResponse: problem ? 'Latency' : 'Packet loss',
              rootCauseName,
              suppressed: serverBlip,
            },
          });
          opened = !serverBlip;
        }
      }
      for (const alarm of active) {
        if (alarm.kind === 'down') await recover(alarm, 'Perangkat terjangkau');
      }
      return { opened, recovered };
    }

    for (const alarm of active) await recover(alarm, 'Perangkat UP');
    return { opened, recovered };
  }
}

const BLIP_MARGIN_MS = 20_000;
const SERVER_ROOT_CAUSE = 'Jaringan server NMS';
const FLAP_WINDOW_MS = 5 * 60 * 1000;
const FLAP_MIN_FLIPS = 4;

function severityOf(criticality: Criticality): AlarmSeverity {
  if (criticality === 'info') return 'info';
  if (criticality === 'warning') return 'warning';
  if (criticality === 'major') return 'major';
  return 'critical';
}
