import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { mkdir, readFile, rm, writeFile, rename } from 'fs/promises';
import { join } from 'path';
import { gunzipSync, gzipSync } from 'zlib';
import { PrismaService } from '../infra/prisma.service';
import { NetdClient } from '../network/netd.client';
import { listAlarmSoundNames, readAlarmSounds, replaceAlarmSounds } from './alarm-sound';

const FORMAT = 'kalimasada-backup';
const VERSION = 1;
const MAX_GZIP = 256 * 1024 * 1024;
const MAX_JSON = 256 * 1024 * 1024;
const MAX_SOUND = 8 * 1024 * 1024;
const soundName = /^(alarm-sound|recovery-sound)\.(mp3|wav|ogg|webm|m4a|aac)$/;

const roles = ['super_admin', 'admin', 'noc', 'viewer'] as const;
const deviceTypes = ['mikrotik_router', 'mikrotik_switch', 'huawei_olt', 'switch', 'access_point', 'server', 'customer_router', 'other'] as const;
const methods = ['icmp', 'snmp', 'mikrotik_api', 'combination'] as const;
const criticalities = ['info', 'warning', 'major', 'critical'] as const;
const statuses = ['up', 'down', 'warning', 'unknown', 'flapping', 'unreachable'] as const;
const alarmStates = ['active', 'recovered'] as const;

export type BackupInventory = {
  users: number;
  groups: number;
  devices: number;
  links: number;
  graphs: number;
  alarms: number;
  events: number;
  clients: number;
  rules: number;
  tokens: number;
  settings: number;
  logs: number;
  sounds: number;
  network: boolean;
};

type SoundFile = { name: string; data: Buffer };

@Injectable()
export class BackupService {
  private readonly logger = new Logger(BackupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly netd: NetdClient,
  ) {}

  async summary(): Promise<BackupInventory> {
    const [users, groups, devices, links, graphs, alarms, events, clients, rules, tokens, settings, logs, sounds, network] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.deviceGroup.count(),
      this.prisma.device.count(),
      this.prisma.topologyLink.count(),
      this.prisma.mrtgGraph.count(),
      this.prisma.alarm.count(),
      this.prisma.event.count(),
      this.prisma.client.count(),
      this.prisma.notificationRule.count(),
      this.prisma.apiToken.count(),
      this.prisma.setting.count(),
      this.prisma.notificationLog.count(),
      listAlarmSoundNames().then((names) => names.length),
      this.loadNetwork().then((config) => Boolean(config)),
    ]);
    return { users, groups, devices, links, graphs, alarms, events, clients, rules, tokens, settings, logs, sounds, network };
  }

  async exportFile() {
    const [users, deviceGroups, devices, topologyLinks, mrtgGraphs, alarms, events, settings, apiTokens, clients, notificationRules, notificationLogs, sounds, network] = await Promise.all([
      this.prisma.user.findMany(),
      this.prisma.deviceGroup.findMany(),
      this.prisma.device.findMany(),
      this.prisma.topologyLink.findMany(),
      this.prisma.mrtgGraph.findMany(),
      this.prisma.alarm.findMany(),
      this.prisma.event.findMany(),
      this.prisma.setting.findMany(),
      this.prisma.apiToken.findMany(),
      this.prisma.client.findMany(),
      this.prisma.notificationRule.findMany(),
      this.prisma.notificationLog.findMany(),
      readAlarmSounds(),
      this.loadNetwork(),
    ]);
    const inventory: BackupInventory = {
      users: users.length,
      groups: deviceGroups.length,
      devices: devices.length,
      links: topologyLinks.length,
      graphs: mrtgGraphs.length,
      alarms: alarms.length,
      events: events.length,
      clients: clients.length,
      rules: notificationRules.length,
      tokens: apiTokens.length,
      settings: settings.length,
      logs: notificationLogs.length,
      sounds: sounds.length,
      network: Boolean(network),
    };
    const payload = {
      format: FORMAT,
      version: VERSION,
      createdAt: new Date().toISOString(),
      inventory,
      tables: {
        users,
        deviceGroups,
        devices,
        topologyLinks,
        mrtgGraphs,
        alarms,
        events,
        settings,
        apiTokens,
        clients,
        notificationRules,
        notificationLogs,
      },
      files: {
        sounds: sounds.map((file) => ({ name: file.name, data: file.data.toString('base64') })),
        network: network ? { config: network, pending: null } : null,
      },
    };
    const body = gzipSync(Buffer.from(JSON.stringify(payload)));
    return { name: `kalimasada-${stamp(new Date())}.kmsbackup`, body };
  }

  async restore(buffer: Buffer) {
    if (!buffer.length) throw new BadRequestException('File cadangan kosong');
    if (buffer.length > MAX_GZIP) throw new BadRequestException('File cadangan lebih dari 256 MB');
    const parsed = parsePayload(openBackup(buffer));
    const warnings: string[] = [];
    const notes: string[] = [];
    const deviceIds = new Set(parsed.devices.map((row) => row.id));
    const userIds = new Set(parsed.users.map((row) => row.id));
    const groupIds = new Set(parsed.groups.map((row) => row.id));

    for (const row of parsed.devices) {
      if (row.groupId && !groupIds.has(row.groupId)) row.groupId = null;
      if (row.parentId === row.id || (row.parentId && !deviceIds.has(row.parentId))) row.parentId = null;
    }
    for (const row of parsed.alarms) {
      if (row.deviceId && !deviceIds.has(row.deviceId)) {
        throw new BadRequestException('Cadangan berisi alarm untuk perangkat yang tidak ada');
      }
      if (row.acknowledgedById && !userIds.has(row.acknowledgedById)) row.acknowledgedById = null;
    }
    for (const row of parsed.graphs) {
      if (!deviceIds.has(row.deviceId)) throw new BadRequestException('Cadangan berisi grafik MRTG untuk perangkat yang tidak ada');
    }
    for (const row of parsed.links) {
      if (!deviceIds.has(row.sourceId) || !deviceIds.has(row.targetId)) {
        throw new BadRequestException('Cadangan berisi topologi yang mengacu ke perangkat yang tidak ada');
      }
    }
    for (const row of parsed.events) {
      if (row.deviceId && !deviceIds.has(row.deviceId)) row.deviceId = null;
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('LOCK TABLE "User", "DeviceGroup", "Device", "mrtg_graph", "TopologyLink", "Alarm", "Event", "Setting", "api_tokens", "Client", "NotificationRule", "NotificationLog" IN ACCESS EXCLUSIVE MODE');
        await tx.notificationLog.deleteMany();
        await tx.alarm.deleteMany();
        await tx.event.deleteMany();
        await tx.mrtgGraph.deleteMany();
        await tx.topologyLink.deleteMany();
        await tx.device.updateMany({ data: { parentId: null } });
        await tx.device.deleteMany();
        await tx.deviceGroup.deleteMany();
        await tx.client.deleteMany();
        await tx.apiToken.deleteMany();
        await tx.notificationRule.deleteMany();
        await tx.setting.deleteMany();
        await tx.user.deleteMany();

        await batches(parsed.users, (chunk) => tx.user.createMany({ data: chunk }));
        await batches(parsed.groups, (chunk) => tx.deviceGroup.createMany({ data: chunk }));
        await batches(parsed.devices.map((row) => ({ ...row, parentId: null })), (chunk) => tx.device.createMany({ data: chunk }));
        for (const row of parsed.devices) {
          if (row.parentId && row.id) {
            await tx.$executeRaw`UPDATE "Device" SET "parent_id" = ${row.parentId} WHERE "id" = ${row.id}`;
          }
        }
        await batches(parsed.links, (chunk) => tx.topologyLink.createMany({ data: chunk }));
        await batches(parsed.graphs, (chunk) => tx.mrtgGraph.createMany({ data: chunk }));
        await batches(parsed.alarms, (chunk) => tx.alarm.createMany({ data: chunk }));
        await batches(parsed.events, (chunk) => tx.event.createMany({ data: chunk }));
        await batches(parsed.settings, (chunk) => tx.setting.createMany({ data: chunk }));
        await batches(parsed.tokens, (chunk) => tx.apiToken.createMany({ data: chunk }));
        await batches(parsed.clients, (chunk) => tx.client.createMany({ data: chunk }));
        await batches(parsed.rules, (chunk) => tx.notificationRule.createMany({ data: chunk }));
        await batches(parsed.logs, (chunk) => tx.notificationLog.createMany({ data: chunk }));
      }, { timeout: 180_000, maxWait: 20_000 });
    } catch (error) {
      this.logger.error(`Pemulihan gagal: ${error instanceof Error ? error.message : error}`);
      throw restoreError(error);
    }

    try {
      await replaceAlarmSounds(parsed.sounds);
    } catch (error) {
      this.logger.error(`Nada cadangan gagal ditulis: ${error instanceof Error ? error.message : error}`);
      warnings.push('Database sudah dipulihkan, tetapi nada alarm gagal ditulis.');
    }

    if (parsed.network) {
      const applied = await this.applyNetwork(parsed.network);
      warnings.push(...applied.warnings);
      if (applied.ok) notes.push('Konfigurasi jaringan diterapkan.');
    }

    this.logger.log(`Cadangan dipulihkan: ${parsed.devices.length} perangkat, ${parsed.links.length} tautan, ${parsed.graphs.length} grafik`);
    return { ok: true as const, inventory: parsed.inventory, warnings, notes };
  }

  private async loadNetwork() {
    try {
      const data = await this.netd.call<{ config?: unknown }>('GET', '/config');
      if (data?.config && typeof data.config === 'object' && !Array.isArray(data.config)) {
        return data.config as Record<string, unknown>;
      }
    } catch {
      // Layanan jaringan tidak menjawab; coba berkas lokal.
    }
    const file = await readNetwork();
    if (!file?.config || typeof file.config !== 'object' || Array.isArray(file.config)) return null;
    return file.config as Record<string, unknown>;
  }

  private async applyNetwork(config: Record<string, unknown>) {
    try {
      const result = await this.netd.call<{ warnings?: string[] }>('POST', '/config', config);
      return { ok: true, warnings: (result?.warnings ?? []).map((item) => `Jaringan: ${item}`) };
    } catch (error) {
      this.logger.warn(`Jaringan tidak diterapkan lewat layanan: ${error instanceof Error ? error.message : error}`);
      const fileWarning = await writeNetwork(config);
      if (!fileWarning) return { ok: true, warnings: [] as string[] };
      return { ok: false, warnings: [fileWarning] };
    }
  }
}

type ParsedBackup = {
  inventory: BackupInventory;
  users: Prisma.UserCreateManyInput[];
  groups: Prisma.DeviceGroupCreateManyInput[];
  devices: Prisma.DeviceCreateManyInput[];
  links: Prisma.TopologyLinkCreateManyInput[];
  graphs: Prisma.MrtgGraphCreateManyInput[];
  alarms: Prisma.AlarmCreateManyInput[];
  events: Prisma.EventCreateManyInput[];
  settings: Prisma.SettingCreateManyInput[];
  tokens: Prisma.ApiTokenCreateManyInput[];
  clients: Prisma.ClientCreateManyInput[];
  rules: Prisma.NotificationRuleCreateManyInput[];
  logs: Prisma.NotificationLogCreateManyInput[];
  sounds: SoundFile[];
  network: Record<string, unknown> | null;
};

function parsePayload(value: unknown): ParsedBackup {
  const root = record(value, 'File cadangan');
  if (root.format !== FORMAT || root.version !== VERSION) {
    throw new BadRequestException('File ini bukan cadangan Kalimasada');
  }
  const tables = record(root.tables, 'Isi cadangan');
  const files = root.files == null ? {} : record(root.files, 'Berkas cadangan');
  const users = unique(rows(tables.users, 'pengguna').map(userRow), 'Pengguna');
  if (!users.length) throw new BadRequestException('Cadangan tidak berisi pengguna, pemulihan dibatalkan');
  uniqueValues(users.map((row) => row.email), 'Email pengguna');
  const groups = unique(rows(tables.deviceGroups, 'grup').map(groupRow), 'Grup');
  uniqueValues(groups.map((row) => row.name), 'Nama grup');
  const devices = unique(rows(tables.devices, 'perangkat').map(deviceRow), 'Perangkat');
  uniqueValues(devices.map((row) => row.ipAddress), 'Alamat IP perangkat');
  uniqueValues(devices.map((row) => row.zabbixHostId).filter((item): item is string => Boolean(item)), 'Host Zabbix');
  uniqueValues(devices.map((row) => row.zabbixTechnicalName).filter((item): item is string => Boolean(item)), 'Nama teknis Zabbix');
  const links = unique(rows(tables.topologyLinks, 'topologi').map(linkRow), 'Topologi');
  uniqueValues(links.map((row) => `${row.sourceId}\0${row.targetId}`), 'Tautan topologi');
  const graphs = unique(rows(tables.mrtgGraphs, 'grafik MRTG').map(graphRow), 'Grafik MRTG');
  uniqueValues(graphs.map((row) => `${row.deviceId}\0${row.kind}\0${row.probeKey}`), 'Grafik MRTG');
  const alarms = unique(rows(tables.alarms, 'alarm').map(alarmRow), 'Alarm');
  uniqueValues(alarms.map((row) => row.zabbixEventId).filter((item): item is string => Boolean(item)), 'Kejadian Zabbix');
  const events = unique(rows(tables.events, 'kejadian').map(eventRow), 'Kejadian');
  const settings = rows(tables.settings, 'pengaturan').map(settingRow);
  uniqueValues(settings.map((row) => row.key), 'Kunci pengaturan');
  const tokens = unique(rows(tables.apiTokens, 'token').map(tokenRow), 'Token API');
  uniqueValues(tokens.map((row) => row.tokenHash), 'Token API');
  const clients = unique(rows(tables.clients, 'klien').map(clientRow), 'Klien');
  const rules = unique(rows(tables.notificationRules, 'notifikasi').map(ruleRow), 'Notifikasi');
  uniqueValues(rules.map((row) => row.channel), 'Kanal notifikasi');
  const logs = unique(rows(tables.notificationLogs, 'log notifikasi').map(logRow), 'Log notifikasi');
  const sounds = soundRows(files.sounds);
  const network = networkRow(files.network);
  return {
    inventory: {
      users: users.length,
      groups: groups.length,
      devices: devices.length,
      links: links.length,
      graphs: graphs.length,
      alarms: alarms.length,
      events: events.length,
      clients: clients.length,
      rules: rules.length,
      tokens: tokens.length,
      settings: settings.length,
      logs: logs.length,
      sounds: sounds.length,
      network: Boolean(network),
    },
    users,
    groups,
    devices,
    links,
    graphs,
    alarms,
    events,
    settings,
    tokens,
    clients,
    rules,
    logs,
    sounds,
    network,
  };
}

function userRow(value: unknown): Prisma.UserCreateManyInput {
  const row = record(value, 'Pengguna');
  return {
    id: idOf(row.id, 'Pengguna'),
    email: text(row.email, 'Email pengguna', 200, true),
    passwordHash: text(row.passwordHash, 'Sandi pengguna', 200, true),
    name: text(row.name, 'Nama pengguna', 200, true),
    role: oneOf(row.role, roles, 'Peran pengguna', 'viewer'),
    fcmToken: text(row.fcmToken, 'Token perangkat', 400, false),
    createdAt: when(row.createdAt, 'Pengguna', false) ?? undefined,
    updatedAt: when(row.updatedAt, 'Pengguna', false) ?? undefined,
  };
}

function groupRow(value: unknown): Prisma.DeviceGroupCreateManyInput {
  const row = record(value, 'Grup');
  return {
    id: idOf(row.id, 'Grup'),
    name: text(row.name, 'Nama grup', 200, true),
    createdAt: when(row.createdAt, 'Grup', false) ?? undefined,
    updatedAt: when(row.updatedAt, 'Grup', false) ?? undefined,
  };
}

function deviceRow(value: unknown): Prisma.DeviceCreateManyInput {
  const row = record(value, 'Perangkat');
  return {
    id: idOf(row.id, 'Perangkat'),
    name: text(row.name, 'Nama perangkat', 200, true),
    ipAddress: text(row.ipAddress, 'Alamat IP', 64, true),
    deviceType: oneOf(row.deviceType, deviceTypes, 'Jenis perangkat'),
    location: text(row.location, 'Lokasi', 200, false),
    groupId: optionalId(row.groupId, 'Grup perangkat'),
    parentId: optionalId(row.parentId, 'Induk perangkat'),
    monitorMethod: oneOf(row.monitorMethod, methods, 'Metode pantau', 'icmp'),
    snmpCommunityEnc: text(row.snmpCommunityEnc, 'Komunitas SNMP', 4000, false),
    snmpVersion: text(row.snmpVersion, 'Versi SNMP', 16, false) ?? '2c',
    snmpPort: integer(row.snmpPort, 'Port SNMP', false) ?? 161,
    rosUsername: text(row.rosUsername, 'Username RouterOS', 200, false),
    rosPasswordEnc: text(row.rosPasswordEnc, 'Sandi RouterOS', 4000, false),
    rosPort: integer(row.rosPort, 'Port RouterOS', false) ?? 8728,
    pingIntervalSec: integer(row.pingIntervalSec, 'Interval ping', false) ?? 10,
    failedThreshold: integer(row.failedThreshold, 'Ambang gagal', false) ?? 3,
    recoveryThreshold: integer(row.recoveryThreshold, 'Ambang pulih', false) ?? 2,
    alertDelaySec: integer(row.alertDelaySec, 'Tunda alarm', false) ?? 30,
    criticality: oneOf(row.criticality, criticalities, 'Tingkat perangkat', 'major'),
    notificationEnabled: flag(row.notificationEnabled, 'Notifikasi perangkat', true),
    maintenance: flag(row.maintenance, 'Pemeliharaan', false),
    status: oneOf(row.status, statuses, 'Status perangkat', 'unknown'),
    latencyMs: decimal(row.latencyMs, 'Latensi'),
    packetLoss: decimal(row.packetLoss, 'Packet loss'),
    bandwidthThresholdMbps: integer(row.bandwidthThresholdMbps, 'Ambang bandwidth', false),
    lastSeenAt: when(row.lastSeenAt, 'Perangkat', false),
    downSince: when(row.downSince, 'Perangkat', false),
    downtimeSec: integer(row.downtimeSec, 'Durasi putus', false) ?? 0,
    lastResponse: text(row.lastResponse, 'Respons terakhir', 20000, false),
    zabbixHostId: text(row.zabbixHostId, 'Host Zabbix', 64, false),
    zabbixTechnicalName: text(row.zabbixTechnicalName, 'Nama teknis Zabbix', 200, false),
    zabbixDownTriggerId: text(row.zabbixDownTriggerId, 'Trigger Zabbix', 64, false),
    zabbixLatencyTriggerId: text(row.zabbixLatencyTriggerId, 'Trigger Zabbix', 64, false),
    zabbixLossTriggerId: text(row.zabbixLossTriggerId, 'Trigger Zabbix', 64, false),
    zabbixPingItemId: text(row.zabbixPingItemId, 'Item Zabbix', 64, false),
    zabbixLatencyItemId: text(row.zabbixLatencyItemId, 'Item Zabbix', 64, false),
    zabbixLossItemId: text(row.zabbixLossItemId, 'Item Zabbix', 64, false),
    zabbixMaintenanceId: text(row.zabbixMaintenanceId, 'Pemeliharaan Zabbix', 64, false),
    posX: decimal(row.posX, 'Posisi'),
    posY: decimal(row.posY, 'Posisi'),
    createdAt: when(row.createdAt, 'Perangkat', false) ?? undefined,
    updatedAt: when(row.updatedAt, 'Perangkat', false) ?? undefined,
  };
}

function linkRow(value: unknown): Prisma.TopologyLinkCreateManyInput {
  const row = record(value, 'Topologi');
  return {
    id: idOf(row.id, 'Topologi'),
    sourceId: idOf(row.sourceId, 'Sumber topologi'),
    targetId: idOf(row.targetId, 'Tujuan topologi'),
    capacityBps: decimal(row.capacityBps, 'Kapasitas tautan'),
    interfaceDeviceId: optionalId(row.interfaceDeviceId, 'Perangkat antarmuka'),
    interfaceKey: text(row.interfaceKey, 'Kunci antarmuka', 200, false),
    interfaceName: text(row.interfaceName, 'Nama antarmuka', 200, false),
  };
}

function graphRow(value: unknown): Prisma.MrtgGraphCreateManyInput {
  const row = record(value, 'Grafik MRTG');
  return {
    id: idOf(row.id, 'Grafik MRTG'),
    deviceId: idOf(row.deviceId, 'Perangkat grafik'),
    kind: text(row.kind, 'Jenis grafik', 64, true),
    probeKey: text(row.probeKey, 'Kunci probe', 200, true),
    name: text(row.name, 'Nama grafik', 200, true),
    hidden: flag(row.hidden, 'Grafik tersembunyi', false),
    createdAt: when(row.createdAt, 'Grafik MRTG', false) ?? undefined,
  };
}

function alarmRow(value: unknown): Prisma.AlarmCreateManyInput {
  const row = record(value, 'Alarm');
  return {
    id: idOf(row.id, 'Alarm'),
    deviceId: idOf(row.deviceId, 'Perangkat alarm'),
    severity: oneOf(row.severity, criticalities, 'Tingkat alarm'),
    state: oneOf(row.state, alarmStates, 'Status alarm', 'active'),
    suppressed: flag(row.suppressed, 'Alarm ditekan', false),
    title: text(row.title, 'Judul alarm', 500, true),
    message: text(row.message, 'Pesan alarm', 20000, false),
    kind: text(row.kind, 'Jenis alarm', 64, false) ?? 'down',
    zabbixEventId: text(row.zabbixEventId, 'Kejadian Zabbix', 64, false),
    zabbixTriggerId: text(row.zabbixTriggerId, 'Trigger Zabbix', 64, false),
    openedAt: when(row.openedAt, 'Alarm', false) ?? undefined,
    recoveredAt: when(row.recoveredAt, 'Alarm', false),
    downtimeSec: integer(row.downtimeSec, 'Durasi alarm', false),
    acknowledgedAt: when(row.acknowledgedAt, 'Alarm', false),
    acknowledgedById: optionalId(row.acknowledgedById, 'Pengakuan alarm'),
    downstreamCount: integer(row.downstreamCount, 'Perangkat terdampak', false) ?? 0,
    rootCauseName: text(row.rootCauseName, 'Akar masalah', 200, false),
    lastResponse: text(row.lastResponse, 'Respons alarm', 20000, false),
  };
}

function eventRow(value: unknown): Prisma.EventCreateManyInput {
  const row = record(value, 'Kejadian');
  return {
    id: idOf(row.id, 'Kejadian'),
    deviceId: optionalId(row.deviceId, 'Perangkat kejadian'),
    type: text(row.type, 'Jenis kejadian', 64, true),
    message: text(row.message, 'Pesan kejadian', 20000, true),
    createdAt: when(row.createdAt, 'Kejadian', false) ?? undefined,
  };
}

function settingRow(value: unknown): Prisma.SettingCreateManyInput {
  const row = record(value, 'Pengaturan');
  return {
    key: text(row.key, 'Kunci pengaturan', 120, true),
    value: text(row.value, 'Nilai pengaturan', 20000, true),
  };
}

function tokenRow(value: unknown): Prisma.ApiTokenCreateManyInput {
  const row = record(value, 'Token API');
  return {
    id: idOf(row.id, 'Token API'),
    name: text(row.name, 'Nama token', 200, true),
    role: oneOf(row.role, roles, 'Peran token', 'viewer'),
    tokenHash: text(row.tokenHash, 'Hash token', 128, true),
    prefix: text(row.prefix, 'Awalan token', 32, true),
    createdAt: when(row.createdAt, 'Token API', false) ?? undefined,
    lastUsedAt: when(row.lastUsedAt, 'Token API', false),
  };
}

function clientRow(value: unknown): Prisma.ClientCreateManyInput {
  const row = record(value, 'Klien');
  return {
    id: idOf(row.id, 'Klien'),
    name: text(row.name, 'Nama klien', 200, true),
    username: text(row.username, 'Username klien', 200, false),
    ipAddress: text(row.ipAddress, 'IP klien', 64, false),
    nasDeviceId: text(row.nasDeviceId, 'NAS klien', 64, false),
    kind: text(row.kind, 'Jenis klien', 32, false) ?? 'pppoe',
    online: flag(row.online, 'Status klien', false),
    uptimeSec: integer(row.uptimeSec, 'Uptime klien', false),
    lastDisconnect: when(row.lastDisconnect, 'Klien', false),
    rxBps: decimal(row.rxBps, 'Trafik klien'),
    txBps: decimal(row.txBps, 'Trafik klien'),
    latencyMs: decimal(row.latencyMs, 'Latensi klien'),
    monitorPriority: text(row.monitorPriority, 'Prioritas klien', 32, false) ?? 'normal',
    createdAt: when(row.createdAt, 'Klien', false) ?? undefined,
    updatedAt: when(row.updatedAt, 'Klien', false) ?? undefined,
  };
}

function ruleRow(value: unknown): Prisma.NotificationRuleCreateManyInput {
  const row = record(value, 'Notifikasi');
  return {
    id: idOf(row.id, 'Notifikasi'),
    channel: text(row.channel, 'Kanal notifikasi', 64, true),
    enabled: flag(row.enabled, 'Notifikasi aktif', false),
    config: jsonValue(row.config, 'Konfigurasi notifikasi'),
    events: jsonValue(row.events ?? [], 'Kejadian notifikasi'),
    severities: jsonValue(row.severities ?? [], 'Tingkat notifikasi'),
    quietStart: text(row.quietStart, 'Jam senyap', 8, false),
    quietEnd: text(row.quietEnd, 'Jam senyap', 8, false),
  };
}

function logRow(value: unknown): Prisma.NotificationLogCreateManyInput {
  const row = record(value, 'Log notifikasi');
  return {
    id: idOf(row.id, 'Log notifikasi'),
    alarmId: text(row.alarmId, 'Alarm log', 64, false),
    channel: text(row.channel, 'Kanal log', 64, true),
    target: text(row.target, 'Tujuan log', 500, false),
    event: text(row.event, 'Kejadian log', 64, false) ?? 'test',
    status: text(row.status, 'Status log', 64, true),
    error: text(row.error, 'Galat log', 4000, false),
    sentAt: when(row.sentAt, 'Log notifikasi', false) ?? undefined,
  };
}

function soundRows(value: unknown): SoundFile[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new BadRequestException('Nada di cadangan tidak valid');
  if (value.length > 2) throw new BadRequestException('Cadangan berisi terlalu banyak nada');
  return value.map((item) => {
    const row = record(item, 'Nada');
    const name = text(row.name, 'Nama nada', 80, true);
    if (!soundName.test(name)) throw new BadRequestException('Nama file nada tidak valid');
    const encoded = text(row.data, 'Isi nada', MAX_SOUND * 2, true);
    const data = Buffer.from(encoded, 'base64');
    if (!data.length || data.length > MAX_SOUND) throw new BadRequestException('Nada cadangan kosong atau lebih dari 8 MB');
    return { name, data };
  });
}

function networkRow(value: unknown) {
  if (value == null) return null;
  const row = record(value, 'Jaringan');
  if (row.config == null) return null;
  const config = record(row.config, 'Konfigurasi jaringan');
  return config;
}

function openBackup(buffer: Buffer) {
  const gzip = buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
  let raw = buffer;
  if (gzip) {
    try {
      raw = gunzipSync(buffer, { maxOutputLength: MAX_JSON });
    } catch {
      throw new BadRequestException('File cadangan rusak atau terlalu besar');
    }
  }
  if (raw.length > MAX_JSON) throw new BadRequestException('Isi cadangan terlalu besar');
  try {
    return JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, '')) as unknown;
  } catch {
    throw new BadRequestException('File cadangan bukan data Kalimasada');
  }
}

function networkDir() {
  return process.env.NETD_CONFIG_DIR || '/etc/kalimasada';
}

async function readNetwork() {
  try {
    const config = JSON.parse(await readFile(join(networkDir(), 'network.json'), 'utf8')) as unknown;
    if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
    let pending: unknown = null;
    try {
      pending = JSON.parse(await readFile(join(networkDir(), 'network.pending.json'), 'utf8'));
    } catch {
      pending = null;
    }
    return { config, pending };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM') return null;
    return null;
  }
}

async function writeNetwork(config: Record<string, unknown>) {
  const dir = networkDir();
  const file = join(dir, 'network.json');
  const temporary = `${file}.tmp`;
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, file);
    await rm(join(dir, 'network.pending.json'), { force: true });
    return null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    await rm(temporary, { force: true }).catch(() => undefined);
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
      return 'Database sudah dipulihkan. Konfigurasi jaringan ada di cadangan, tetapi server tidak punya izin menulisnya.';
    }
    return 'Database sudah dipulihkan, tetapi konfigurasi jaringan gagal ditulis.';
  }
}

function restoreError(error: unknown): BadRequestException {
  if (error instanceof BadRequestException) return error;
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') return new BadRequestException('Cadangan berisi data ganda yang tidak boleh sama');
    if (error.code === 'P2003') return new BadRequestException('Cadangan berisi tautan ke data yang tidak ada');
    if (error.code === 'P2028') return new BadRequestException('Database sedang sibuk. Coba pulihkan lagi.');
  }
  const message = error instanceof Error ? error.message : '';
  if (/timeout|closed/i.test(message)) return new BadRequestException('Database sedang sibuk. Coba pulihkan lagi.');
  return new BadRequestException('Cadangan tidak bisa dipulihkan');
}

async function batches<T>(rows: T[], write: (chunk: T[]) => Promise<unknown>) {
  const size = 100;
  for (let index = 0; index < rows.length; index += size) {
    await write(rows.slice(index, index + size));
  }
}

function rows(value: unknown, label: string) {
  if (!Array.isArray(value)) throw new BadRequestException(`Bagian ${label} tidak ada di cadangan`);
  if (value.length > 500_000) throw new BadRequestException(`Bagian ${label} terlalu besar`);
  return value;
}

function record(value: unknown, label: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException(`${label} tidak valid`);
  }
  return value as Record<string, unknown>;
}

function unique<T extends { id?: string | null }>(items: T[], label: string) {
  const seen = new Set<string>();
  for (const item of items) {
    if (!item.id) throw new BadRequestException(`${label} memiliki id tidak valid`);
    if (seen.has(item.id)) throw new BadRequestException(`${label} memiliki id ganda`);
    seen.add(item.id);
  }
  return items;
}

function uniqueValues(values: string[], label: string) {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new BadRequestException(`${label} ganda di cadangan`);
    seen.add(value);
  }
}

function idOf(value: unknown, label: string) {
  if (typeof value !== 'string' || !/^[\w-]{1,64}$/.test(value)) {
    throw new BadRequestException(`${label} memiliki id tidak valid`);
  }
  return value;
}

function optionalId(value: unknown, label: string) {
  if (value == null || value === '') return null;
  return idOf(value, label);
}

function text(value: unknown, label: string, max: number, required: true): string;
function text(value: unknown, label: string, max: number, required: false): string | null;
function text(value: unknown, label: string, max: number, required: boolean) {
  if (value == null) {
    if (required) throw new BadRequestException(`${label} kosong`);
    return null;
  }
  if (typeof value !== 'string') throw new BadRequestException(`${label} harus teks`);
  if (required && !value.length) throw new BadRequestException(`${label} kosong`);
  if (value.length > max) throw new BadRequestException(`${label} terlalu panjang`);
  return value;
}

function integer(value: unknown, label: string, required: boolean) {
  if (value == null) {
    if (required) throw new BadRequestException(`${label} kosong`);
    return null;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < -2147483648 || value > 2147483647) {
    throw new BadRequestException(`${label} harus bilangan bulat`);
  }
  return value;
}

function decimal(value: unknown, label: string) {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new BadRequestException(`${label} harus angka`);
  return value;
}

function flag(value: unknown, label: string, fallback: boolean) {
  if (value == null) return fallback;
  if (typeof value !== 'boolean') throw new BadRequestException(`${label} harus ya atau tidak`);
  return value;
}

function when(value: unknown, label: string, required: boolean) {
  if (value == null || value === '') {
    if (required) throw new BadRequestException(`${label} tanpa waktu`);
    return null;
  }
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new BadRequestException(`${label} memiliki waktu tidak valid`);
  }
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string, fallback?: T): T {
  if ((value == null || value === '') && fallback) return fallback;
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new BadRequestException(`${label} tidak dikenal`);
  }
  return value as T;
}

function jsonValue(value: unknown, label: string): Prisma.InputJsonValue {
  if (value == null) return {};
  if (typeof value !== 'object') throw new BadRequestException(`${label} tidak valid`);
  return value as Prisma.InputJsonValue;
}

function stamp(date: Date) {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
