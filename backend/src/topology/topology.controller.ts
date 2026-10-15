import { BadRequestException, Body, Controller, Delete, Get, Logger, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsNumber, IsOptional, IsString } from 'class-validator';
import { Device } from '@prisma/client';
import { Roles } from '../auth/auth.decorators';
import { PrismaService } from '../infra/prisma.service';
import { presentDevice } from '../devices/present';
import { ProvisionService } from '../zabbix/zabbix.provision';
import { ZabbixItem, ZabbixService } from '../zabbix/zabbix.service';

class PositionBody {
  @Type(() => Number)
  @IsNumber()
  x!: number;

  @Type(() => Number)
  @IsNumber()
  y!: number;
}

class LinkBody {
  @IsString()
  sourceId!: string;

  @IsString()
  targetId!: string;
}

class LinkInterfaceBody {
  @IsOptional()
  @IsString()
  deviceId?: string | null;

  @IsOptional()
  @IsString()
  key?: string | null;
}

type Traffic = { down: number | null; up: number | null; at: number | null };

const trafficTtlMs = 30_000;
const staleAfterSec = 5 * 60;

@Controller('topology')
export class TopologyController {
  private readonly logger = new Logger(TopologyController.name);
  private trafficCache: { signature: string; at: number; items: Promise<ZabbixItem[]> } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly provision: ProvisionService,
    private readonly zabbix: ZabbixService,
  ) {}

  @Get()
  async get(@Query('location') location?: string) {
    const devices = await this.prisma.device.findMany({
      where: location ? { location } : undefined,
      include: { parent: { select: { id: true, name: true } } },
      orderBy: { name: 'asc' },
    });
    const ids = devices.map((device) => device.id);
    const links = await this.prisma.topologyLink.findMany({
      where: { sourceId: { in: ids }, targetId: { in: ids } },
    });
    const locations = await this.prisma.device.findMany({
      where: { location: { not: null } },
      distinct: ['location'],
      select: { location: true },
    });
    const traffic = await this.linkTraffic(links, devices);
    return {
      devices: devices.map(presentDevice),
      links: links.map((link) => ({
        id: link.id,
        sourceId: link.sourceId,
        targetId: link.targetId,
        interfaceDeviceId: link.interfaceDeviceId,
        interfaceKey: link.interfaceKey,
        interfaceName: link.interfaceName,
        traffic: traffic.get(link.id) ?? null,
      })),
      locations: locations.map((row) => row.location).filter((value): value is string => Boolean(value)),
    };
  }

  @Roles('noc')
  @Patch('nodes/:id')
  async move(@Param('id') id: string, @Body() body: PositionBody) {
    await this.prisma.device.update({ where: { id }, data: { posX: body.x, posY: body.y } });
    return { ok: true };
  }

  @Roles('noc')
  @Post('links')
  async createLink(@Body() body: LinkBody) {
    if (body.sourceId === body.targetId) throw new BadRequestException('Link tidak boleh ke perangkat yang sama');
    return this.prisma.topologyLink.upsert({
      where: { sourceId_targetId: { sourceId: body.sourceId, targetId: body.targetId } },
      update: {},
      create: { sourceId: body.sourceId, targetId: body.targetId },
    });
  }

  @Roles('noc')
  @Get('links/:id/interfaces')
  async linkInterfaces(@Param('id') id: string) {
    const link = await this.prisma.topologyLink.findUnique({
      where: { id },
      include: { source: true, target: true },
    });
    if (!link) throw new NotFoundException('Link tidak ditemukan');
    const [source, target] = await Promise.all([this.portsOf(link.source), this.portsOf(link.target)]);
    return { source, target };
  }

  @Roles('noc')
  @Patch('links/:id')
  async updateLink(@Param('id') id: string, @Body() body: LinkInterfaceBody) {
    const link = await this.prisma.topologyLink.findUnique({
      where: { id },
      include: { source: true, target: true },
    });
    if (!link) throw new NotFoundException('Link tidak ditemukan');
    let data: { interfaceDeviceId: string | null; interfaceKey: string | null; interfaceName: string | null } = {
      interfaceDeviceId: null,
      interfaceKey: null,
      interfaceName: null,
    };
    if (body.deviceId && body.key) {
      const device = body.deviceId === link.sourceId ? link.source : body.deviceId === link.targetId ? link.target : null;
      if (!device) throw new BadRequestException('Interface harus milik salah satu ujung link');
      const catalog = await this.provision.interfaceCatalog(device).catch(() => []);
      const port = catalog.find((item) => item.key === body.key);
      if (!port) throw new BadRequestException('Interface tidak tersedia di perangkat ini');
      data = { interfaceDeviceId: device.id, interfaceKey: port.key, interfaceName: port.name };
    }
    const saved = await this.prisma.topologyLink.update({ where: { id }, data });
    this.trafficCache = null;
    await this.syncPolling([link.interfaceDeviceId, saved.interfaceDeviceId]);
    return saved;
  }

  @Roles('noc')
  @Delete('links/:id')
  async removeLink(@Param('id') id: string) {
    const link = await this.prisma.topologyLink.findUnique({ where: { id } });
    if (!link) throw new NotFoundException('Link tidak ditemukan');
    await this.prisma.topologyLink.delete({ where: { id } });
    await this.syncPolling([link.interfaceDeviceId]);
    return { ok: true };
  }

  private async portsOf(device: Device) {
    const interfaces = await this.provision.interfaceCatalog(device).catch(() => []);
    return {
      id: device.id,
      name: device.name,
      snmp: !device.snmpCommunityEnc || device.snmpVersion === '3' ? 'off' : interfaces.length ? 'ready' : 'waiting',
      interfaces,
    };
  }

  private async syncPolling(deviceIds: Array<string | null>) {
    const ids = [...new Set(deviceIds.filter((value): value is string => Boolean(value)))];
    if (!ids.length) return;
    const devices = await this.prisma.device.findMany({ where: { id: { in: ids } } });
    for (const device of devices) {
      await this.provision.syncInterfacePolling(device).catch((error: unknown) => {
        this.logger.warn(`${device.name}: sadapan interface link belum aktif: ${error instanceof Error ? error.message : error}`);
      });
    }
  }

  private async linkTraffic(
    links: Array<{ id: string; sourceId: string; interfaceDeviceId: string | null; interfaceKey: string | null }>,
    devices: Device[],
  ) {
    const result = new Map<string, Traffic>();
    const hostOf = new Map(devices.map((device) => [device.id, device.zabbixHostId]));
    const watched = links.filter((link) => link.interfaceDeviceId && link.interfaceKey && hostOf.get(link.interfaceDeviceId));
    if (!watched.length) return result;
    const hostIds = [...new Set(watched.map((link) => hostOf.get(link.interfaceDeviceId!)!))].sort();
    let items: ZabbixItem[];
    try {
      items = await this.lastValues(hostIds);
    } catch (error) {
      this.logger.warn(`Trafik link tidak terbaca: ${error instanceof Error ? error.message : error}`);
      return result;
    }
    const values = new Map<string, { value: number; clock: number }>();
    const now = Math.floor(Date.now() / 1000);
    for (const item of items) {
      const match = item.key_.match(/^net\.if\.(in|out)\[[^\]]*?(\d+)\]$/);
      if (!match || /error|discard|drop/i.test(item.key_)) continue;
      const clock = Number(item.lastclock);
      if (!clock || now - clock > staleAfterSec || item.lastvalue === '') continue;
      values.set(`${item.hostid}:${match[2]}:${match[1]}`, { value: Number(item.lastvalue), clock });
    }
    for (const link of watched) {
      const host = hostOf.get(link.interfaceDeviceId!)!;
      const inbound = values.get(`${host}:${link.interfaceKey}:in`);
      const outbound = values.get(`${host}:${link.interfaceKey}:out`);
      const onSource = link.interfaceDeviceId === link.sourceId;
      const down = onSource ? outbound : inbound;
      const up = onSource ? inbound : outbound;
      result.set(link.id, {
        down: down?.value ?? null,
        up: up?.value ?? null,
        at: Math.max(down?.clock ?? 0, up?.clock ?? 0) || null,
      });
    }
    return result;
  }

  private lastValues(hostIds: string[]) {
    const signature = hostIds.join(',');
    const cached = this.trafficCache;
    if (cached && cached.signature === signature && Date.now() - cached.at < trafficTtlMs) return cached.items;
    const items = this.zabbix.ensureConnection().then((connected) => (connected ? this.zabbix.interfaceLastValues(hostIds) : []));
    this.trafficCache = { signature, at: Date.now(), items };
    items.catch(() => {
      if (this.trafficCache?.items === items) this.trafficCache = null;
    });
    return items;
  }
}
