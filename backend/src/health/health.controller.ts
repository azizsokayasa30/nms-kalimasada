import { Controller, Get } from '@nestjs/common';
import Redis from 'ioredis';
import { Public } from '../auth/auth.decorators';
import { PrismaService } from '../infra/prisma.service';
import { ZabbixService } from '../zabbix/zabbix.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly zabbix: ZabbixService,
  ) {}

  @Public()
  @Get()
  async check() {
    let database: 'up' | 'down' = 'down';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      database = 'up';
    } catch {
      database = 'down';
    }
    const zabbixUp = await this.zabbix.ensureConnection();
    let redis: 'up' | 'down' | 'skipped' = 'skipped';
    if (process.env.REDIS_URL) {
      const client = new Redis(process.env.REDIS_URL, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
      });
      try {
        await client.connect();
        const pong = await client.ping();
        redis = pong === 'PONG' ? 'up' : 'down';
      } catch {
        redis = 'down';
      } finally {
        client.disconnect();
      }
    }
    return {
      api: 'up',
      database,
      zabbix: zabbixUp ? 'up' : 'down',
      zabbixVersion: this.zabbix.version,
      zabbixError: zabbixUp ? null : this.zabbix.lastError,
      redis,
    };
  }
}
