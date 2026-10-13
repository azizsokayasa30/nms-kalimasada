import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../infra/prisma.service';

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async summary() {
    const devices = await this.prisma.device.findMany({
      select: { status: true, latencyMs: true, packetLoss: true },
    });
    const count = (status: string) => devices.filter((device) => device.status === status).length;
    const latency = devices.map((device) => device.latencyMs).filter((value): value is number => value != null);
    const loss = devices.map((device) => device.packetLoss).filter((value): value is number => value != null);
    const total = devices.length;
    const up = count('up');
    const monitored = total - count('unknown');
    const activeAlarmTotal = await this.prisma.alarm.count({ where: { state: 'active', suppressed: false } });
    const problems = await this.prisma.alarm.findMany({
      where: { state: 'active', suppressed: false },
      include: { device: true },
      orderBy: { openedAt: 'desc' },
      take: 8,
    });
    const downstream = problems.reduce((sum, alarm) => sum + alarm.downstreamCount, 0);
    return {
      total,
      up,
      down: count('down'),
      warning: count('warning'),
      unknown: count('unknown'),
      flapping: count('flapping'),
      unreachable: count('unreachable'),
      rxBps: null,
      txBps: null,
      activeAlarms: activeAlarmTotal,
      downstream,
      latencyMs: latency.length ? latency.reduce((sum, value) => sum + value, 0) / latency.length : null,
      packetLoss: loss.length ? loss.reduce((sum, value) => sum + value, 0) / loss.length : null,
      uptimePct: monitored ? (up / monitored) * 100 : null,
      problems: problems.map((alarm) => ({
        id: alarm.id,
        deviceId: alarm.deviceId,
        name: alarm.device.name,
        ipAddress: alarm.device.ipAddress,
        status: alarm.device.status,
        downSince: alarm.device.downSince ?? alarm.openedAt,
        lastResponse: alarm.lastResponse ?? alarm.device.lastResponse,
        latencyMs: alarm.device.latencyMs,
        severity: alarm.severity,
        downstreamCount: alarm.downstreamCount,
      })),
    };
  }
}
