import { Controller, Get, NotFoundException, Param, Post, Query, Req } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuthUser, Roles } from '../auth/auth.decorators';
import { PrismaService } from '../infra/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { ZabbixService } from '../zabbix/zabbix.service';

@Controller('alarms')
export class AlarmsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly zabbix: ZabbixService,
    private readonly gateway: RealtimeGateway,
  ) {}

  @Get()
  async list(@Query('state') state?: string) {
    const where: Prisma.AlarmWhereInput =
      state === 'history'
        ? { state: 'recovered' }
        : { state: 'active', suppressed: false };
    const alarms = await this.prisma.alarm.findMany({
      where,
      include: { device: true, acknowledgedBy: { select: { name: true } } },
      orderBy: { openedAt: 'desc' },
      take: 200,
    });
    return alarms.map((alarm) => ({
      id: alarm.id,
      title: alarm.title,
      severity: alarm.severity,
      state: alarm.state,
      kind: alarm.kind,
      deviceId: alarm.deviceId,
      deviceName: alarm.device.name,
      ipAddress: alarm.device.ipAddress,
      status: alarm.device.status,
      openedAt: alarm.openedAt,
      recoveredAt: alarm.recoveredAt,
      downtimeSec: alarm.recoveredAt
        ? alarm.downtimeSec
        : Math.max(0, Math.floor((Date.now() - alarm.openedAt.getTime()) / 1000)),
      acknowledgedAt: alarm.acknowledgedAt,
      acknowledgedBy: alarm.acknowledgedBy?.name ?? null,
      downstreamCount: alarm.downstreamCount,
      rootCauseName: alarm.rootCauseName,
      lastResponse: alarm.lastResponse ?? alarm.device.lastResponse,
      latencyMs: alarm.device.latencyMs,
    }));
  }

  @Roles('noc')
  @Post(':id/acknowledge')
  async acknowledge(@Param('id') id: string, @Req() req: { user: AuthUser }) {
    const alarm = await this.prisma.alarm.findUnique({ where: { id } });
    if (!alarm || alarm.state !== 'active') throw new NotFoundException('Alarm aktif tidak ditemukan');
    const updated = await this.prisma.alarm.update({
      where: { id },
      data: { acknowledgedAt: new Date(), acknowledgedById: req.user.sub },
    });
    await this.prisma.event.create({
      data: {
        deviceId: alarm.deviceId,
        type: 'alarm_acked',
        message: `Alarm diakui oleh ${req.user.name}`,
      },
    });
    if (alarm.zabbixEventId && (await this.zabbix.ensureConnection())) {
      try {
        await this.zabbix.acknowledge(alarm.zabbixEventId);
      } catch {
        // Pengakuan lokal tetap tersimpan bila API Zabbix menolak.
      }
    }
    this.gateway.emit('device_status_changed', { ids: [alarm.deviceId] });
    return updated;
  }
}
