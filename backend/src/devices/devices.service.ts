import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DeviceType, MonitorMethod, Prisma } from '@prisma/client';
import { decryptSecret, encryptSecret } from '../infra/crypto';
import { PrismaService } from '../infra/prisma.service';
import { managedItemKey, managedProbeKey, ProvisionService } from '../zabbix/zabbix.provision';
import { ZabbixService } from '../zabbix/zabbix.service';
import { DeviceBody, UpdateDeviceBody } from './devices.dto';
import { presentDevice } from './present';
import { runDeviceProbe } from './probe';
import { billableUsage, mrtgSettingKeys, readMrtgStyle, shareOfMax } from '../settings/mrtg-settings';

const rangeSeconds: Record<string, number> = {
  '5m': 5 * 60,
  '1h': 60 * 60,
  '24h': 24 * 60 * 60,
  '7d': 7 * 24 * 60 * 60,
  '30d': 30 * 24 * 60 * 60,
};

@Injectable()
export class DevicesService {
  private readonly logger = new Logger(DevicesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly provision: ProvisionService,
    private readonly zabbix: ZabbixService,
  ) {}

  async list(query: { q?: string; status?: string; deviceType?: string; groupId?: string; page?: number; limit?: number }) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(500, Math.max(1, query.limit ?? 20));
    const where: Prisma.DeviceWhereInput = {};
    if (query.q) {
      where.OR = [
        { name: { contains: query.q, mode: 'insensitive' } },
        { ipAddress: { contains: query.q } },
        { location: { contains: query.q, mode: 'insensitive' } },
        { group: { is: { name: { contains: query.q, mode: 'insensitive' } } } },
      ];
    }
    if (query.status) where.status = query.status as Prisma.EnumDeviceStatusFilter['equals'];
    if (query.deviceType) where.deviceType = query.deviceType as DeviceType;
    if (query.groupId === 'none') where.groupId = null;
    else if (query.groupId) where.groupId = query.groupId;
    const [total, rows] = await Promise.all([
      this.prisma.device.count({ where }),
      this.prisma.device.findMany({
        where,
        include: {
          parent: { select: { id: true, name: true } },
          group: { select: { id: true, name: true } },
        },
        orderBy: { name: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);
    return { total, page, limit, devices: rows.map(presentDevice) };
  }

  async listGroups() {
    const groups = await this.prisma.deviceGroup.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { devices: true } } },
    });
    return {
      groups: groups.map((group) => ({
        id: group.id,
        name: group.name,
        deviceCount: group._count.devices,
      })),
    };
  }

  async createGroup(name: string) {
    const group = await this.ensureGroup(name);
    const deviceCount = await this.prisma.device.count({ where: { groupId: group.id } });
    return { id: group.id, name: group.name, deviceCount };
  }

  async renameGroup(id: string, name: string) {
    const trimmed = name.trim();
    if (trimmed.length < 2) throw new BadRequestException('Nama grup minimal 2 karakter');
    const current = await this.prisma.deviceGroup.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('Grup tidak ditemukan');
    const clash = await this.prisma.deviceGroup.findFirst({
      where: { name: { equals: trimmed, mode: 'insensitive' }, NOT: { id } },
    });
    if (clash) throw new ConflictException('Nama grup sudah dipakai');
    const saved = await this.prisma.deviceGroup.update({ where: { id }, data: { name: trimmed } });
    const deviceCount = await this.prisma.device.count({ where: { groupId: id } });
    return { id: saved.id, name: saved.name, deviceCount };
  }

  async removeGroup(id: string) {
    const current = await this.prisma.deviceGroup.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('Grup tidak ditemukan');
    await this.prisma.deviceGroup.delete({ where: { id } });
    return { ok: true };
  }

  async get(id: string) {
    const device = await this.prisma.device.findUnique({
      where: { id },
      include: {
        parent: { select: { id: true, name: true } },
        group: { select: { id: true, name: true } },
        events: { orderBy: { createdAt: 'desc' }, take: 30 },
      },
    });
    if (!device) throw new NotFoundException('Perangkat tidak ditemukan');
    const { events, ...rest } = device;
    return { ...presentDevice(rest), events };
  }

  async create(dto: DeviceBody) {
    await this.assertParent(dto.parentId);
    await this.assertGroup(dto.groupId);
    this.assertSnmp(dto.monitorMethod, dto.snmpCommunity, null);
    try {
      const device = await this.prisma.device.create({ data: this.toData(dto) });
      await this.linkParent(null, dto.parentId ?? null, device.id);
      await this.tryProvision(device.id);
      return this.get(device.id);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Alamat IP sudah dipakai');
      }
      throw error;
    }
  }

  async update(id: string, dto: UpdateDeviceBody) {
    const current = await this.prisma.device.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('Perangkat tidak ditemukan');
    if (dto.parentId) await this.assertNoCycle(id, dto.parentId);
    if (dto.groupId) await this.assertGroup(dto.groupId);
    this.assertSnmp(dto.monitorMethod ?? current.monitorMethod, dto.snmpCommunity, current.snmpCommunityEnc);
    try {
      await this.prisma.device.update({
        where: { id },
        data: this.toPatch(dto),
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Alamat IP sudah dipakai');
      }
      throw error;
    }
    if (dto.parentId !== undefined) await this.linkParent(current.parentId, dto.parentId, id);
    await this.tryProvision(id);
    return this.get(id);
  }

  async remove(id: string) {
    const device = await this.prisma.device.findUnique({ where: { id } });
    if (!device) throw new NotFoundException('Perangkat tidak ditemukan');
    await this.provision.removeHost(device.zabbixHostId);
    await this.prisma.device.updateMany({ where: { parentId: id }, data: { parentId: null } });
    await this.prisma.device.delete({ where: { id } });
    return { ok: true };
  }

  async test(id: string) {
    const device = await this.prisma.device.findUnique({ where: { id } });
    if (!device) throw new NotFoundException('Perangkat tidak ditemukan');
    const community = this.readSecret(device.snmpCommunityEnc);
    const password = this.readSecret(device.rosPasswordEnc);
    const results = await runDeviceProbe({
      ipAddress: device.ipAddress,
      monitorMethod: device.monitorMethod,
      snmpCommunity: community.value,
      snmpSecretBroken: community.broken,
      snmpVersion: device.snmpVersion,
      snmpPort: device.snmpPort,
      rosUsername: device.rosUsername,
      rosPassword: password.value,
      rosSecretBroken: password.broken,
      rosPort: device.rosPort,
    });
    return { ok: results.length > 0 && results.every((row) => row.ok), results };
  }

  async metrics(id: string, range = '1h') {
    const device = await this.prisma.device.findUnique({ where: { id } });
    if (!device) throw new NotFoundException('Perangkat tidak ditemukan');
    const span = rangeSeconds[range] ?? rangeSeconds['1h'];
    const from = Math.floor(Date.now() / 1000) - span;
    if (!device.zabbixLatencyItemId || !(await this.zabbix.ensureConnection())) {
      return { range, latency: [], loss: [], note: 'Zabbix belum mengirim histori' };
    }
    const useTrend = span > 24 * 60 * 60;
    const latency = device.zabbixLatencyItemId
      ? await this.readSeries(device.zabbixLatencyItemId, from, useTrend, 1000)
      : [];
    const loss = device.zabbixLossItemId
      ? await this.readSeries(device.zabbixLossItemId, from, useTrend, 1)
      : [];
    return { range, latency, loss };
  }

  async setBandwidthThreshold(id: string, bandwidthThresholdMbps: number | null) {
    const device = await this.prisma.device.findUnique({ where: { id } });
    if (!device) throw new NotFoundException('Perangkat tidak ditemukan');
    const saved = await this.prisma.device.update({
      where: { id },
      data: { bandwidthThresholdMbps },
    });
    return { id: saved.id, bandwidthThresholdMbps: saved.bandwidthThresholdMbps };
  }

  async mrtgOptions(id: string) {
    const device = await this.requireDevice(id);
    const saved = await this.prisma.mrtgGraph.findMany({ where: { deviceId: id, hidden: false } });
    const taken = new Set(saved.map((row) => `${row.kind}:${row.probeKey}`));
    const found = await this.discover(device);
    const [catalog, snmpProbes] = await Promise.all([
      this.provision.interfaceCatalog(device).catch(() => []),
      this.provision.probeCatalog(device).catch(() => []),
    ]);
    const interfaces = catalog.length ? catalog : found.interfaces.map((port) => ({ key: port.key, name: port.name }));
    const probes = new Map(found.probes.map((probe) => [probe.key, { key: probe.key, name: probe.name, unit: probe.unit }]));
    for (const probe of snmpProbes) {
      probes.set(probe.key, { key: probe.key, name: probe.name, unit: probe.unit });
    }
    return {
      snmp: !device.snmpCommunityEnc ? 'off' : interfaces.length ? 'ready' : 'waiting',
      probes: [...probes.values()].map((probe) => ({
        ...probe,
        added: taken.has(`probe:${probe.key}`),
      })),
      interfaces: interfaces.map((port) => ({
        key: port.key,
        name: port.name,
        added: taken.has(`interface:${port.key}`),
      })),
    };
  }

  async addMrtgGraph(id: string, kind: 'probe' | 'interface', key: string) {
    const device = await this.requireDevice(id);
    const found = await this.discover(device);
    const catalog = kind === 'interface' ? await this.provision.interfaceCatalog(device).catch(() => []) : [];
    const snmpProbe = kind === 'probe' && managedItemKey(key)
      ? (await this.provision.probeCatalog(device).catch(() => [])).find((probe) => probe.key === key)
      : undefined;
    const choice = kind === 'probe'
      ? snmpProbe ?? found.probes.find((probe) => probe.key === key)
      : catalog.find((port) => port.key === key) ?? found.interfaces.find((port) => port.key === key);
    if (!choice) throw new BadRequestException(kind === 'probe' ? 'Probe tidak tersedia di perangkat ini' : 'Interface tidak tersedia di perangkat ini');
    if (snmpProbe) {
      await this.provision.ensureProbeItem(device, snmpProbe).catch((error: unknown) => {
        throw new BadRequestException(`Probe gagal dipasang di Zabbix: ${error instanceof Error ? error.message : error}`);
      });
    }
    const saved = await this.prisma.mrtgGraph.upsert({
      where: { deviceId_kind_probeKey: { deviceId: id, kind, probeKey: key } },
      create: { deviceId: id, kind, probeKey: key, name: choice.name, hidden: false },
      update: { hidden: false, name: choice.name },
      select: { id: true, kind: true, probeKey: true, name: true },
    });
    if (kind === 'interface') {
      await this.provision.syncInterfacePolling(device).catch((error: unknown) => {
        this.logger.warn(`${device.name}: sadapan interface belum aktif: ${error instanceof Error ? error.message : error}`);
      });
    }
    return saved;
  }

  async removeMrtgGraph(id: string, graphId: string) {
    const row = await this.prisma.mrtgGraph.findFirst({ where: { id: graphId, deviceId: id, hidden: false } });
    if (!row) throw new NotFoundException('Graph tidak ditemukan');
    await this.prisma.mrtgGraph.update({ where: { id: graphId }, data: { hidden: true } });
    if (row.kind === 'probe' && managedItemKey(row.probeKey)) {
      const device = await this.requireDevice(id);
      await this.provision.pauseProbeItem(device, row.probeKey).catch((error: unknown) => {
        this.logger.warn(`${device.name}: probe ${row.probeKey} belum dihentikan: ${error instanceof Error ? error.message : error}`);
      });
    }
    if (row.kind === 'interface') {
      const device = await this.requireDevice(id);
      await this.provision.syncInterfacePolling(device).catch((error: unknown) => {
        this.logger.warn(`${device.name}: sadapan interface belum dihentikan: ${error instanceof Error ? error.message : error}`);
      });
    }
    return { ok: true };
  }

  async mrtg(id: string, query: { period?: string; from?: string; to?: string } = {}) {
    const device = await this.prisma.device.findUnique({ where: { id } });
    if (!device) throw new NotFoundException('Perangkat tidak ditemukan');
    const window = resolveWindow(query.period, query.from, query.to);
    const settings = await this.prisma.setting.findMany({
      where: { key: { in: ['latency_warn_ms', 'loss_warn_pct', ...mrtgSettingKeys] } },
    });
    const setting = Object.fromEntries(settings.map((row) => [row.key, row.value]));
    const latencyThreshold = Number(setting.latency_warn_ms ?? 150);
    const lossThreshold = Number(setting.loss_warn_pct ?? 20);
    const mrtgStyle = readMrtgStyle(setting);
    const empty = blankSeries();
    const header = {
      period: window.period,
      from: new Date(window.from * 1000).toISOString(),
      to: new Date(window.to * 1000).toISOString(),
      device: {
        id: device.id,
        name: device.name,
        ipAddress: device.ipAddress,
        status: device.status,
        location: device.location,
        bandwidthThresholdMbps: device.bandwidthThresholdMbps,
      },
      style: mrtgStyle,
      summary: {
        from: new Date(window.from * 1000).toISOString(),
        to: new Date(window.to * 1000).toISOString(),
        latency: { unit: 'ms', threshold: latencyThreshold, ...blankStats() },
        bandwidth: {
          unit: 'bps',
          threshold: null as number | null,
          inbound: blankStats(),
          outbound: blankStats(),
        },
      },
      bandwidth: { unit: 'bps', threshold: null as number | null, points: [] as TrafficPoint[], inbound: empty, outbound: empty },
      interfaces: [] as MrtgInterface[],
      latency: { ...empty, threshold: latencyThreshold },
      loss: { ...empty, threshold: lossThreshold },
      graphs: [] as MrtgView[],
      note: null as string | null,
    };
    const saved = await this.prisma.mrtgGraph.findMany({
      where: { deviceId: id, hidden: false },
      orderBy: { createdAt: 'asc' },
    });
    if (!(await this.zabbix.ensureConnection())) {
      header.note = 'Zabbix belum terhubung, grafik belum bisa dimuat';
      return header;
    }

    const found = await this.discover(device);
    const hasInterfaceGraph = saved.some((graph) => graph.kind === 'interface');
    if (!device.snmpCommunityEnc) {
      header.note = 'Isi SNMP community pada perangkat agar daftar interface bisa dipilih.';
    } else if (!found.interfaces.length) {
      header.note = 'Zabbix sedang mencari interface SNMP. Setelah perangkat menjawab, pilih interface yang ingin disadap lewat Tambah Graph.';
    } else if (!hasInterfaceGraph) {
      header.note = 'Belum ada interface yang disadap. Tambahkan manual lewat Tambah Graph.';
    }
    const floatIds: string[] = [];
    const counterIds: string[] = [];
    const remember = (itemId: string | null, valueType: string) => {
      if (!itemId) return;
      (valueType === '3' ? counterIds : floatIds).push(itemId);
    };
    for (const graph of saved) {
      if (graph.kind === 'probe') {
        const probe = found.probes.find((item) => item.key === graph.probeKey);
        if (probe) remember(probe.itemId, probe.valueType);
      } else {
        const port = found.interfaces.find((item) => item.key === graph.probeKey);
        if (port) {
          remember(port.inId, port.inType);
          remember(port.outId, port.outType);
        }
      }
    }
    const [floats, counters] = await Promise.all([
      this.zabbix.series(floatIds, window.from, window.useTrend, 0, window.to),
      this.zabbix.series(counterIds, window.from, window.useTrend, 3, window.to),
    ]);
    const read = (itemId: string | null) => (itemId ? floats.get(itemId) ?? counters.get(itemId) ?? [] : []);
    const trafficSeries: TrafficPoint[][] = [];
    header.graphs = saved.map((graph) => {
      if (graph.kind === 'interface') {
        const port = found.interfaces.find((item) => item.key === graph.probeKey);
        const points = port ? mergeTraffic(scale(read(port.inId), 1), scale(read(port.outId), 1)) : [];
        if (points.length) trafficSeries.push(points);
        const inbound = pack(points.flatMap((point) => (point.in == null ? [] : [{ t: point.t, v: point.in }])));
        const outbound = pack(points.flatMap((point) => (point.out == null ? [] : [{ t: point.t, v: point.out }])));
        return {
          id: graph.id,
          kind: 'interface' as const,
          key: graph.probeKey,
          name: graph.name,
          unit: port?.unit || 'bps',
          threshold: billableUsage(inbound.max, outbound.max, mrtgStyle.thresholdPct),
          points,
          inbound: { ...inbound, billed: shareOfMax(inbound.max, mrtgStyle.thresholdPct) },
          outbound: { ...outbound, billed: shareOfMax(outbound.max, mrtgStyle.thresholdPct) },
        };
      }
      const probe = found.probes.find((item) => item.key === graph.probeKey);
      const threshold = probe?.thresholdKind === 'latency' ? latencyThreshold : probe?.thresholdKind === 'loss' ? lossThreshold : null;
      const series = probe ? pack(scale(read(probe.itemId), probe.scale)) : blankSeries();
      if (graph.probeKey === 'latency') {
        header.summary.latency = { unit: 'ms', threshold: latencyThreshold, ...statsOf(probe ? scale(read(probe.itemId), probe.scale) : []) };
      }
      return {
        id: graph.id,
        kind: 'probe' as const,
        key: graph.probeKey,
        name: graph.name,
        unit: probe?.unit || '',
        threshold,
        points: series.points,
        min: series.min,
        max: series.max,
        avg: series.avg,
        current: series.current,
      };
    });
    const total = sumTraffic(trafficSeries);
    const inbound = statsOf(total.map((point) => ({ t: point.t, v: point.in })));
    const outbound = statsOf(total.map((point) => ({ t: point.t, v: point.out })));
    header.summary.bandwidth = {
      unit: 'bps',
      threshold: billableUsage(inbound.max, outbound.max, mrtgStyle.thresholdPct),
      inbound,
      outbound,
    };
    return header;
  }

  private async requireDevice(id: string) {
    const device = await this.prisma.device.findUnique({ where: { id } });
    if (!device) throw new NotFoundException('Perangkat tidak ditemukan');
    return device;
  }

  private async discover(device: { zabbixHostId: string | null; zabbixPingItemId: string | null; zabbixLatencyItemId: string | null; zabbixLossItemId: string | null }) {
    const items = device.zabbixHostId ? await this.zabbix.hostItems(device.zabbixHostId).catch(() => []) : [];
    const probes = new Map<string, ProbeSpec>();
    for (const item of items) {
      if (trafficDirection(item.key_)) continue;
      const probe = classifyProbe(item);
      if (!probe || probes.has(probe.key)) continue;
      probes.set(probe.key, { ...probe, itemId: item.itemid, valueType: item.value_type });
    }
    const fallback: Array<[string, ProbeSpec]> = [
      ['uptime', { key: 'uptime', name: 'Ping', unit: '%', scale: 100, thresholdKind: null, itemId: device.zabbixPingItemId ?? '', valueType: '0' }],
      ['latency', { key: 'latency', name: 'Latency', unit: 'ms', scale: 1000, thresholdKind: 'latency', itemId: device.zabbixLatencyItemId ?? '', valueType: '0' }],
      ['loss', { key: 'loss', name: 'Packet loss', unit: '%', scale: 1, thresholdKind: 'loss', itemId: device.zabbixLossItemId ?? '', valueType: '0' }],
    ];
    for (const [key, probe] of fallback) {
      if (!probes.has(key) && probe.itemId) probes.set(key, probe);
    }
    return { probes: [...probes.values()], interfaces: pairInterfaces(items) };
  }

  private async readSeries(itemId: string, from: number, useTrend: boolean, scale: number) {
    const rows = useTrend ? await this.zabbix.trends(itemId, from) : await this.zabbix.history(itemId, from);
    return rows.map((row) => ({ t: row.clock * 1000, v: Math.round(row.value * scale * 100) / 100 }));
  }

  private async tryProvision(id: string) {
    try {
      await this.provision.syncDevice(id);
    } catch (error) {
      this.logger.warn(error instanceof Error ? error.message : error);
    }
  }

  private readSecret(payload: string | null) {
    if (!payload) return { value: null, broken: false };
    try {
      return { value: decryptSecret(payload), broken: false };
    } catch {
      return { value: null, broken: true };
    }
  }

  private async ensureGroup(name: string) {
    const trimmed = name.trim();
    if (trimmed.length < 2) throw new BadRequestException('Nama grup minimal 2 karakter');
    const found = await this.prisma.deviceGroup.findFirst({
      where: { name: { equals: trimmed, mode: 'insensitive' } },
    });
    if (found) return found;
    return this.prisma.deviceGroup.create({ data: { name: trimmed } });
  }

  private async assertGroup(groupId?: string | null) {
    if (!groupId) return;
    const group = await this.prisma.deviceGroup.findUnique({ where: { id: groupId } });
    if (!group) throw new BadRequestException('Grup tidak ditemukan');
  }

  private async assertParent(parentId?: string | null) {
    if (!parentId) return;
    const parent = await this.prisma.device.findUnique({ where: { id: parentId } });
    if (!parent) throw new BadRequestException('Perangkat induk tidak ditemukan');
  }

  private async assertNoCycle(id: string, parentId: string) {
    if (parentId === id) throw new BadRequestException('Perangkat tidak boleh menjadi induk dirinya');
    let current: string | null = parentId;
    const seen = new Set<string>();
    while (current) {
      if (current === id) throw new BadRequestException('Induk membentuk siklus');
      if (seen.has(current)) break;
      seen.add(current);
      const row: { parentId: string | null } | null = await this.prisma.device.findUnique({
        where: { id: current },
        select: { parentId: true },
      });
      current = row?.parentId ?? null;
    }
  }

  private async linkParent(previous: string | null, next: string | null, id: string) {
    if (previous && previous !== next) {
      await this.prisma.topologyLink.deleteMany({ where: { sourceId: previous, targetId: id } });
    }
    if (next) {
      await this.prisma.topologyLink.upsert({
        where: { sourceId_targetId: { sourceId: next, targetId: id } },
        update: {},
        create: { sourceId: next, targetId: id },
      });
    }
  }

  private assertSnmp(method: string, community: string | undefined, existing: string | null) {
    if (method !== 'snmp' && method !== 'combination') return;
    if (community?.trim() || existing) return;
    throw new BadRequestException('SNMP community wajib diisi agar Zabbix bisa menemukan interface');
  }

  private toData(dto: DeviceBody): Prisma.DeviceCreateInput {
    return {
      name: dto.name.trim(),
      ipAddress: dto.ipAddress.trim(),
      deviceType: dto.deviceType,
      location: dto.location?.trim() || null,
      group: dto.groupId ? { connect: { id: dto.groupId } } : undefined,
      parent: dto.parentId ? { connect: { id: dto.parentId } } : undefined,
      monitorMethod: dto.monitorMethod,
      snmpCommunityEnc: dto.snmpCommunity ? encryptSecret(dto.snmpCommunity) : null,
      snmpVersion: dto.snmpVersion ?? '2c',
      snmpPort: dto.snmpPort ?? 161,
      rosUsername: dto.rosUsername?.trim() || null,
      rosPasswordEnc: dto.rosPassword ? encryptSecret(dto.rosPassword) : null,
      rosPort: dto.rosPort ?? 8728,
      pingIntervalSec: dto.pingIntervalSec,
      failedThreshold: dto.failedThreshold,
      recoveryThreshold: dto.recoveryThreshold,
      alertDelaySec: dto.alertDelaySec,
      criticality: dto.criticality,
      notificationEnabled: dto.notificationEnabled,
      maintenance: dto.maintenance,
    };
  }

  private toPatch(dto: UpdateDeviceBody): Prisma.DeviceUpdateInput {
    const data: Prisma.DeviceUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.ipAddress !== undefined) data.ipAddress = dto.ipAddress.trim();
    if (dto.deviceType !== undefined) data.deviceType = dto.deviceType;
    if (dto.location !== undefined) data.location = dto.location.trim() || null;
    if (dto.groupId !== undefined) data.group = dto.groupId ? { connect: { id: dto.groupId } } : { disconnect: true };
    if (dto.parentId !== undefined) {
      data.parent = dto.parentId ? { connect: { id: dto.parentId } } : { disconnect: true };
    }
    if (dto.monitorMethod !== undefined) data.monitorMethod = dto.monitorMethod;
    if (dto.snmpCommunity?.trim()) data.snmpCommunityEnc = encryptSecret(dto.snmpCommunity.trim());
    if (dto.snmpVersion !== undefined) data.snmpVersion = dto.snmpVersion;
    if (dto.snmpPort !== undefined) data.snmpPort = dto.snmpPort;
    if (dto.rosUsername !== undefined) data.rosUsername = dto.rosUsername.trim() || null;
    if (dto.rosPassword) data.rosPasswordEnc = encryptSecret(dto.rosPassword);
    if (dto.rosPort !== undefined) data.rosPort = dto.rosPort;
    if (dto.pingIntervalSec !== undefined) data.pingIntervalSec = dto.pingIntervalSec;
    if (dto.failedThreshold !== undefined) data.failedThreshold = dto.failedThreshold;
    if (dto.recoveryThreshold !== undefined) data.recoveryThreshold = dto.recoveryThreshold;
    if (dto.alertDelaySec !== undefined) data.alertDelaySec = dto.alertDelaySec;
    if (dto.criticality !== undefined) data.criticality = dto.criticality;
    if (dto.notificationEnabled !== undefined) data.notificationEnabled = dto.notificationEnabled;
    if (dto.maintenance !== undefined) data.maintenance = dto.maintenance;
    return data;
  }
}

const mrtgSeconds: Record<string, number> = {
  daily: 24 * 60 * 60,
  weekly: 7 * 24 * 60 * 60,
  monthly: 30 * 24 * 60 * 60,
  yearly: 365 * 24 * 60 * 60,
};

type Point = { t: number; v: number };
type ProbeSpec = {
  key: string;
  name: string;
  unit: string;
  scale: number;
  thresholdKind: 'latency' | 'loss' | null;
  itemId: string;
  valueType: string;
};
type MrtgView =
  | {
      id: string;
      kind: 'interface';
      key: string;
      name: string;
      unit: string;
      threshold: number | null;
      points: TrafficPoint[];
      inbound: { min: number | null; max: number | null; avg: number | null; current: number | null; points: Point[] };
      outbound: { min: number | null; max: number | null; avg: number | null; current: number | null; points: Point[] };
    }
  | {
      id: string;
      kind: 'probe';
      key: string;
      name: string;
      unit: string;
      threshold: number | null;
      points: Point[];
      min: number | null;
      max: number | null;
      avg: number | null;
      current: number | null;
    };
type TrafficPoint = { t: number; in: number | null; out: number | null };
type MrtgInterface = {
  name: string;
  unit: string;
  threshold: number | null;
  points: TrafficPoint[];
  inbound: { min: number | null; max: number | null; avg: number | null; current: number | null; points: Point[] };
  outbound: { min: number | null; max: number | null; avg: number | null; current: number | null; points: Point[] };
};

function resolveWindow(period?: string, from?: string, to?: string) {
  const now = Math.floor(Date.now() / 1000);
  if (from || to) {
    const start = Date.parse(from ?? '');
    const end = Date.parse(to ?? '');
    if (!Number.isFinite(start) || !Number.isFinite(end)) throw new BadRequestException('Tanggal tidak valid');
    if (end <= start) throw new BadRequestException('Tanggal akhir harus setelah tanggal awal');
    const span = Math.floor((end - start) / 1000);
    if (span < 5 * 60) throw new BadRequestException('Rentang minimal 5 menit');
    if (span > 366 * 24 * 60 * 60) throw new BadRequestException('Rentang maksimal 366 hari');
    return { period: 'custom', from: Math.floor(start / 1000), to: Math.floor(end / 1000), useTrend: zabbixUsesTrends(Math.floor(start / 1000), span) };
  }
  const selected = period && mrtgSeconds[period] ? period : 'daily';
  const span = mrtgSeconds[selected];
  return { period: selected, from: now - span, to: now, useTrend: zabbixUsesTrends(now - span, span) };
}

function zabbixUsesTrends(from: number, span: number) {
  const historySeconds = 31 * 24 * 60 * 60;
  const withinHistory = from >= Math.floor(Date.now() / 1000) - historySeconds;
  const secondsPerPixel = span / 900;
  return !(withinHistory && secondsPerPixel <= 3600 / 16);
}

function blankStats(): { min: number | null; max: number | null; avg: number | null; current: number | null } {
  return { min: null, max: null, avg: null, current: null };
}

function blankSeries() {
  return { ...blankStats(), points: [] as Point[] };
}

function scale(points: Point[], factor: number): Point[] {
  return points.map((point) => ({ t: point.t, v: Math.round(point.v * factor * 100) / 100 }));
}

function summarize(points: Point[]) {
  if (!points.length) return { min: null, max: null, avg: null, current: null, points };
  const values = points.map((point) => point.v);
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    min: Math.round(Math.min(...values) * 100) / 100,
    max: Math.round(Math.max(...values) * 100) / 100,
    avg: Math.round(average * 100) / 100,
    current: values[values.length - 1] ?? null,
    points,
  };
}

function statsOf(points: Point[]) {
  const { points: _points, ...stats } = summarize(points);
  return stats;
}

function pack(points: Point[]) {
  return { ...summarize(points), points: thinPoints(points) };
}

function thinPoints<T>(rows: T[], max = 400) {
  if (rows.length <= max) return rows;
  const step = Math.ceil(rows.length / max);
  return rows.filter((_, index) => index % step === 0);
}

function mergeTraffic(inbound: Point[], outbound: Point[]) {
  const left = [...inbound].sort((a, b) => a.t - b.t);
  const right = [...outbound].sort((a, b) => a.t - b.t);
  const tolerance = Math.max(8_000, Math.floor(Math.min(medianGap(left), medianGap(right)) * 0.45));
  const rows: TrafficPoint[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    const delta = left[i].t - right[j].t;
    if (Math.abs(delta) <= tolerance) {
      rows.push({ t: Math.min(left[i].t, right[j].t), in: left[i].v, out: right[j].v });
      i += 1;
      j += 1;
    } else if (delta < 0) {
      rows.push({ t: left[i].t, in: left[i].v, out: null });
      i += 1;
    } else {
      rows.push({ t: right[j].t, in: null, out: right[j].v });
      j += 1;
    }
  }
  while (i < left.length) {
    rows.push({ t: left[i].t, in: left[i].v, out: null });
    i += 1;
  }
  while (j < right.length) {
    rows.push({ t: right[j].t, in: null, out: right[j].v });
    j += 1;
  }
  return rows;
}

function medianGap(points: Point[]) {
  if (points.length < 2) return 60_000;
  const gaps = points.slice(1).map((point, index) => point.t - points[index].t).sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)] || 60_000;
}

function sumTraffic(series: TrafficPoint[][]) {
  const rows = new Map<number, { t: number; in: number; out: number }>();
  for (const points of series) {
    for (const point of points) {
      const row = rows.get(point.t) ?? { t: point.t, in: 0, out: 0 };
      row.in += point.in ?? 0;
      row.out += point.out ?? 0;
      rows.set(point.t, row);
    }
  }
  return [...rows.values()].sort((left, right) => left.t - right.t);
}

function pairInterfaces(items: Array<{ itemid: string; key_: string; name: string; value_type: string; units: string }>) {
  const ports = new Map<string, { key: string; name: string; unit: string; inId: string | null; outId: string | null; inType: string; outType: string }>();
  for (const item of items) {
    const direction = trafficDirection(item.key_);
    if (!direction) continue;
    const key = interfaceKey(item.key_);
    const current = ports.get(key) ?? { key, name: key, unit: '', inId: null, outId: null, inType: '0', outType: '0' };
    if (direction === 'in') {
      current.inId = item.itemid;
      current.inType = item.value_type;
      current.name = interfaceName(item.name, current.name);
      current.unit = item.units || current.unit;
    } else {
      current.outId = item.itemid;
      current.outType = item.value_type;
      if (current.name === key) current.name = interfaceName(item.name, current.name);
      current.unit = current.unit || item.units;
    }
    ports.set(key, current);
  }
  return [...ports.values()].filter((port) => !/loopback|^lo$|^lo\d/i.test(port.name));
}

function classifyProbe(item: { key_: string; name: string; units: string }): Omit<ProbeSpec, 'itemId' | 'valueType'> | null {
  const key = item.key_;
  const managed = managedProbeKey(key);
  if (managed === 'cpu') return { key: managed, name: 'CPU', unit: '%', scale: 1, thresholdKind: null };
  if (managed === 'memory') return { key: managed, name: 'RAM', unit: '%', scale: 1, thresholdKind: null };
  if (managed) return { key: managed, name: item.name.replace(/^Health\s+/, 'Health · '), unit: item.units, scale: 1, thresholdKind: null };
  if (key === 'icmpping') return { key: 'uptime', name: 'Ping', unit: '%', scale: 100, thresholdKind: null };
  if (key === 'icmppingsec') return { key: 'latency', name: 'Latency', unit: 'ms', scale: 1000, thresholdKind: 'latency' };
  if (key === 'icmppingloss') return { key: 'loss', name: 'Packet loss', unit: '%', scale: 1, thresholdKind: 'loss' };
  if (key.startsWith('system.uptime')) return { key, name: 'Uptime sistem', unit: item.units || 's', scale: 1, thresholdKind: null };
  if (key.startsWith('system.cpu.util')) return { key, name: item.name || 'CPU', unit: '%', scale: 1, thresholdKind: null };
  if (key.startsWith('vm.memory.util') || key.includes('memory.util')) return { key, name: item.name || 'Memory', unit: '%', scale: 1, thresholdKind: null };
  return null;
}

function trafficDirection(key: string) {
  const normalized = key.toLowerCase();
  if (/error|discard|drop|speed|status|type|name|alias/.test(normalized)) return null;
  if (normalized.startsWith('net.if.in') || normalized.includes('hcin') || normalized.includes('inoctets')) return 'in';
  if (normalized.startsWith('net.if.out') || normalized.includes('hcout') || normalized.includes('outoctets')) return 'out';
  return null;
}

function interfaceKey(key: string) {
  const bracket = key.match(/\[([^\]]+)\]/)?.[1] ?? key;
  const index = bracket.match(/(\d+)\s*$/)?.[1];
  return index ?? bracket;
}

function interfaceName(name: string, fallback: string) {
  const cleaned = name
    .replace(/:\s*(bits received|bits sent|incoming|outgoing).*$/i, '')
    .replace(/^interface\s+/i, '')
    .trim();
  return cleaned || fallback;
}
