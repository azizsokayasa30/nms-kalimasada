import { execFile } from 'child_process';
import { Injectable, Logger } from '@nestjs/common';
import { Criticality, Device } from '@prisma/client';
import { promisify } from 'util';
import { decryptSecret } from '../infra/crypto';
import { PrismaService } from '../infra/prisma.service';
import { ZabbixService } from './zabbix.service';

const execFileAsync = promisify(execFile);
const catalogTtlMs = 5 * 60 * 1000;

export type SnmpProbe = {
  key: string;
  name: string;
  unit: string;
  itemKey: string;
  itemName: string;
  snmpOid: string;
  preprocessing: Array<{ type: number; params: string }>;
};

const cpuScript = [
  'var total = 0, count = 0;',
  "value.split('\\n').forEach(function (line) {",
  '  var match = line.match(/=\\s*(?:[A-Za-z0-9 -]+:\\s*)?(-?\\d+(?:\\.\\d+)?)\\s*$/);',
  '  if (match) { total += parseFloat(match[1]); count++; }',
  '});',
  "if (!count) throw 'CPU tidak terbaca';",
  'return (total / count).toFixed(2);',
].join('\n');

const memoryScript = [
  'var type = {}, size = {}, used = {};',
  "value.split('\\n').forEach(function (line) {",
  '  var match = line.match(/1\\.3\\.6\\.1\\.2\\.1\\.25\\.2\\.3\\.1\\.(\\d+)\\.(\\d+)\\s*=\\s*(?:[A-Za-z0-9 -]+:\\s*)?(.*)$/);',
  '  if (!match) return;',
  '  var raw = match[3].trim();',
  "  if (match[1] === '2') type[match[2]] = raw;",
  "  else if (match[1] === '5') size[match[2]] = parseFloat(raw);",
  "  else if (match[1] === '6') used[match[2]] = parseFloat(raw);",
  '});',
  'var total = 0, busy = 0;',
  'for (var index in type) {',
  '  if (!/1\\.3\\.6\\.1\\.2\\.1\\.25\\.2\\.1\\.2$/.test(type[index])) continue;',
  '  total += size[index] || 0;',
  '  busy += used[index] || 0;',
  '}',
  "if (!total) throw 'RAM tidak terbaca';",
  'return (busy / total * 100).toFixed(2);',
].join('\n');

const gaugeUnits: Record<string, { unit: string; multiplier: number }> = {
  '1': { unit: '°C', multiplier: 1 },
  '2': { unit: 'rpm', multiplier: 1 },
  '3': { unit: 'V', multiplier: 0.1 },
  '4': { unit: 'A', multiplier: 0.1 },
  '5': { unit: 'W', multiplier: 0.1 },
  '6': { unit: '', multiplier: 1 },
};

const legacyHealth = [
  { id: 'v8', oid: '1.3.6.1.4.1.14988.1.1.3.8.0', name: 'voltage', unit: 'V' },
  { id: 't10', oid: '1.3.6.1.4.1.14988.1.1.3.10.0', name: 'temperature', unit: '°C' },
  { id: 't11', oid: '1.3.6.1.4.1.14988.1.1.3.11.0', name: 'cpu-temperature', unit: '°C' },
];

export function managedItemKey(probeKey: string) {
  if (probeKey === 'cpu') return 'kalimasada.cpu';
  if (probeKey === 'memory') return 'kalimasada.memory';
  const health = probeKey.match(/^health:([\w-]+)$/);
  return health ? `kalimasada.health[${health[1]}]` : null;
}

export function managedProbeKey(itemKey: string) {
  if (itemKey === 'kalimasada.cpu') return 'cpu';
  if (itemKey === 'kalimasada.memory') return 'memory';
  const health = itemKey.match(/^kalimasada\.health\[([\w-]+)\]$/);
  return health ? `health:${health[1]}` : null;
}

const priorityOf: Record<Criticality, number> = {
  info: 1,
  warning: 2,
  major: 4,
  critical: 5,
};

@Injectable()
export class ProvisionService {
  private readonly logger = new Logger(ProvisionService.name);
  private groupId: string | null = null;
  private readonly snmpReady = new Set<string>();
  private readonly trafficSync = new Map<string, string>();
  private readonly catalogCache = new Map<string, { signature: string; at: number; ports: Promise<Array<{ key: string; name: string }>> }>();
  private readonly probeCache = new Map<string, { signature: string; at: number; probes: Promise<SnmpProbe[]> }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly zabbix: ZabbixService,
  ) {}

  technicalName(id: string) {
    return `k${id.replace(/[^a-zA-Z0-9]/g, '')}`;
  }

  async syncDevice(id: string) {
    const connected = await this.zabbix.ensureConnection();
    if (!connected) return;
    const device = await this.prisma.device.findUnique({ where: { id } });
    if (!device) return;
    const technical = device.zabbixTechnicalName ?? this.technicalName(device.id);
    const hostId = await this.ensureHost(device, technical);
    const delay = `${device.pingIntervalSec}s`;
    const interfaceId = await this.mainInterfaceId(hostId);
    const pingItemId = await this.ensureItem(hostId, 'icmpping', interfaceId, {
      name: 'ICMP ping',
      type: 3,
      value_type: 3,
      delay,
      units: '',
    });
    const latencyItemId = await this.ensureItem(hostId, 'icmppingsec', interfaceId, {
      name: 'ICMP response time',
      type: 3,
      value_type: 0,
      delay,
      units: 's',
    });
    const lossItemId = await this.ensureItem(hostId, 'icmppingloss', interfaceId, {
      name: 'ICMP loss',
      type: 3,
      value_type: 0,
      delay,
      units: '%',
    });
    const settings = await this.readThresholds();
    const downTriggerId = await this.ensureTrigger(device.zabbixDownTriggerId, {
      description: `${technical} DOWN`,
      expression: `max(/${technical}/icmpping,#${device.failedThreshold})=0`,
      recovery_expression: `min(/${technical}/icmpping,#${device.recoveryThreshold})=1`,
      priority: priorityOf[device.criticality],
    });
    const seconds = (settings.latencyWarnMs / 1000).toFixed(3);
    const latencyTriggerId = await this.ensureTrigger(device.zabbixLatencyTriggerId, {
      description: `${technical} high latency`,
      expression: `min(/${technical}/icmppingsec,#3)>${seconds}`,
      recovery_expression: `max(/${technical}/icmppingsec,#3)<=${seconds}`,
      priority: 2,
    });
    const lossTriggerId = await this.ensureTrigger(device.zabbixLossTriggerId, {
      description: `${technical} high packet loss`,
      expression: `min(/${technical}/icmppingloss,#3)>${settings.lossWarnPct} and max(/${technical}/icmppingloss,#3)<100`,
      recovery_expression: `max(/${technical}/icmppingloss,#3)<=${settings.lossWarnPct} or last(/${technical}/icmppingloss)=100`,
      priority: 2,
    });
    const maintenanceId = await this.syncMaintenance(device, hostId);
    await this.prisma.device.update({
      where: { id: device.id },
      data: {
        zabbixHostId: hostId,
        zabbixTechnicalName: technical,
        zabbixPingItemId: pingItemId,
        zabbixLatencyItemId: latencyItemId,
        zabbixLossItemId: lossItemId,
        zabbixDownTriggerId: downTriggerId,
        zabbixLatencyTriggerId: latencyTriggerId,
        zabbixLossTriggerId: lossTriggerId,
        zabbixMaintenanceId: maintenanceId,
      },
    });
    await this.syncDependency(device.id, downTriggerId);
    await this.prepareMonitoring(device, hostId);
  }

  async reconcile(devices: Device[]) {
    const linked = devices.filter((device) => device.zabbixHostId);
    for (const device of linked) {
      if (!device.zabbixHostId || this.snmpReady.has(device.zabbixHostId)) continue;
      await this.prepareMonitoring(device, device.zabbixHostId);
    }
    await this.syncGraphs(linked);
    for (const device of linked) {
      try {
        await this.syncInterfacePolling(device);
      } catch (error) {
        this.logger.warn(`${device.name}: sadapan interface tidak tersinkron: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  async interfaceCatalog(device: Device) {
    const community = this.communityOf(device);
    if (!community || device.snmpVersion === '3') return [];
    const port = String(device.snmpPort || 161);
    const signature = `${device.ipAddress}:${port}:${device.snmpCommunityEnc}`;
    const cached = this.catalogCache.get(device.id);
    if (cached && cached.signature === signature && Date.now() - cached.at < catalogTtlMs) return cached.ports;
    const ports = this.walkInterfaces(device.ipAddress, port, community);
    this.catalogCache.set(device.id, { signature, at: Date.now(), ports });
    ports.then(
      (list) => {
        if (!list.length && this.catalogCache.get(device.id)?.ports === ports) this.catalogCache.delete(device.id);
      },
      () => {
        if (this.catalogCache.get(device.id)?.ports === ports) this.catalogCache.delete(device.id);
      },
    );
    return ports;
  }

  async probeCatalog(device: Device) {
    const community = this.communityOf(device);
    if (!community || device.snmpVersion === '3') return [] as SnmpProbe[];
    const port = String(device.snmpPort || 161);
    const signature = `${device.ipAddress}:${port}:${device.snmpCommunityEnc}`;
    const cached = this.probeCache.get(device.id);
    if (cached && cached.signature === signature && Date.now() - cached.at < catalogTtlMs) return cached.probes;
    const probes = discoverSnmpProbes(device.ipAddress, port, community);
    this.probeCache.set(device.id, { signature, at: Date.now(), probes });
    probes.then(
      (list) => {
        if (!list.length && this.probeCache.get(device.id)?.probes === probes) this.probeCache.delete(device.id);
      },
      () => {
        if (this.probeCache.get(device.id)?.probes === probes) this.probeCache.delete(device.id);
      },
    );
    return probes;
  }

  async ensureProbeItem(device: Device, probe: SnmpProbe) {
    if (!device.zabbixHostId) throw new Error('Perangkat belum terdaftar di Zabbix');
    const community = this.communityOf(device);
    if (!community || device.snmpVersion === '3') throw new Error('Isi SNMP community v2c pada perangkat');
    if (!(await this.zabbix.ensureConnection())) throw new Error('Zabbix belum terhubung');
    const hostId = device.zabbixHostId;
    const interfaceId = await this.ensureSnmpInterface(hostId, device.ipAddress, String(device.snmpPort || 161), community);
    const found = await this.zabbix.call<Array<{ itemid: string }>>('item.get', {
      hostids: [hostId],
      filter: { key_: [probe.itemKey] },
      output: ['itemid'],
    });
    const fields = {
      name: probe.itemName,
      type: 20,
      snmp_oid: probe.snmpOid,
      value_type: 0,
      units: probe.unit,
      delay: '60s',
      history: '31d',
      trends: '365d',
      interfaceid: interfaceId,
      status: 0,
      preprocessing: probe.preprocessing.map((step) => ({ ...step, error_handler: 0, error_handler_params: '' })),
    };
    if (found[0]) {
      await this.zabbix.call('item.update', { itemid: found[0].itemid, ...fields });
    } else {
      await this.zabbix.call('item.create', { hostid: hostId, key_: probe.itemKey, ...fields });
    }
  }

  async pauseProbeItem(device: Device, probeKey: string) {
    const itemKey = managedItemKey(probeKey);
    if (!itemKey || !device.zabbixHostId) return;
    if (!(await this.zabbix.ensureConnection())) return;
    const found = await this.zabbix.call<Array<{ itemid: string }>>('item.get', {
      hostids: [device.zabbixHostId],
      filter: { key_: [itemKey] },
      output: ['itemid'],
    });
    if (found[0]) await this.zabbix.call('item.update', { itemid: found[0].itemid, status: 1 });
  }

  private async walkInterfaces(host: string, port: string, community: string) {
    const names = await snmpNames(host, port, community, '1.3.6.1.2.1.31.1.1.1.1');
    const source = names.size ? names : await snmpNames(host, port, community, '1.3.6.1.2.1.2.2.1.2');
    return [...source.entries()]
      .map(([key, name]) => ({ key, name: name.trim() || key }))
      .filter((item) => !/loopback|^lo$|^lo\d/i.test(item.name))
      .sort((left, right) => left.name.localeCompare(right.name, 'id', { numeric: true }));
  }

  async syncInterfacePolling(device: Device) {
    if (!device.zabbixHostId) return;
    const connected = await this.zabbix.ensureConnection();
    if (!connected) return;
    const [selected, links] = await Promise.all([
      this.prisma.mrtgGraph.findMany({
        where: { deviceId: device.id, kind: 'interface', hidden: false },
        select: { probeKey: true },
      }),
      this.prisma.topologyLink.findMany({
        where: { interfaceDeviceId: device.id, interfaceKey: { not: null } },
        select: { interfaceKey: true },
      }),
    ]);
    const keys = [...selected.map((row) => row.probeKey), ...links.map((row) => row.interfaceKey ?? '')];
    const indexes = [...new Set(keys.filter((key) => /^\d+$/.test(key)))].sort((left, right) => Number(left) - Number(right));
    const signature = indexes.join(',');
    if (this.trafficSync.get(device.zabbixHostId) === signature) return;
    const community = this.communityOf(device);
    if (!community || device.snmpVersion === '3') return;

    const hostId = device.zabbixHostId;
    const interfaceId = await this.ensureSnmpInterface(hostId, device.ipAddress, String(device.snmpPort || 161), community);
    const ruleId = await this.ensureInterfaceDiscovery(hostId, interfaceId);
    await this.zabbix.call('discoveryrule.update', {
      itemid: ruleId,
      lifetime: '0',
      filter: {
        evaltype: 1,
        conditions: [{ macro: '{#SNMPINDEX}', value: indexes.length ? `^(${indexes.join('|')})$` : '^$', operator: 8 }],
      },
    });
    const items = await this.zabbix.call<Array<{ itemid: string; key_: string }>>('item.get', {
      hostids: [hostId],
      output: ['itemid', 'key_'],
      search: { key_: 'net.if.' },
      startSearch: true,
    });
    const present = new Set<string>();
    const remove: string[] = [];
    for (const item of items) {
      const index = trafficIndex(item.key_);
      if (!index) continue;
      const allowed = indexes.includes(index);
      if (!allowed) remove.push(item.itemid);
      else present.add(`${index}:${item.key_.startsWith('net.if.in') ? 'in' : 'out'}`);
    }
    if (remove.length) await this.zabbix.call('item.delete', remove);
    const missing = indexes.some((index) => !present.has(`${index}:in`) || !present.has(`${index}:out`));
    if (missing) {
      await this.zabbix.call('task.create', { type: 6, request: { itemid: ruleId } }).catch(() => undefined);
      return;
    }
    this.trafficSync.set(hostId, signature);
  }

  async removeHost(hostId: string | null) {
    if (!hostId) return;
    const connected = await this.zabbix.ensureConnection();
    if (!connected) return;
    try {
      await this.zabbix.call('host.delete', [hostId]);
    } catch (error) {
      this.logger.warn(`Host Zabbix tidak terhapus: ${error instanceof Error ? error.message : error}`);
    }
  }

  async refreshWarningTriggers() {
    const connected = await this.zabbix.ensureConnection();
    if (!connected) return;
    const devices = await this.prisma.device.findMany({ where: { zabbixHostId: { not: null } } });
    for (const device of devices) {
      try {
        await this.syncDevice(device.id);
      } catch (error) {
        this.logger.warn(`${device.name}: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  private async readThresholds() {
    const rows = await this.prisma.setting.findMany({
      where: { key: { in: ['latency_warn_ms', 'loss_warn_pct'] } },
    });
    const map = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    return {
      latencyWarnMs: Number(map.latency_warn_ms ?? 150),
      lossWarnPct: Number(map.loss_warn_pct ?? 20),
    };
  }

  private async ensureGroup() {
    if (this.groupId) return this.groupId;
    const found = await this.zabbix.call<Array<{ groupid: string }>>('hostgroup.get', {
      filter: { name: ['Kalimasada'] },
      output: ['groupid'],
    });
    if (found[0]) {
      this.groupId = found[0].groupid;
      return this.groupId;
    }
    const created = await this.zabbix.call<{ groupids: string[] }>('hostgroup.create', { name: 'Kalimasada' });
    this.groupId = created.groupids[0];
    return this.groupId;
  }

  private async ensureHost(device: Device, technical: string) {
    const groupId = await this.ensureGroup();
    let hostId = device.zabbixHostId;
    if (hostId) {
      const found = await this.zabbix.call<Array<{ hostid: string }>>('host.get', {
        hostids: [hostId],
        output: ['hostid'],
      });
      if (!found[0]) hostId = null;
    }
    if (!hostId) {
      const byName = await this.zabbix.call<Array<{ hostid: string }>>('host.get', {
        filter: { host: [technical] },
        output: ['hostid'],
      });
      hostId = byName[0]?.hostid ?? null;
    }
    if (!hostId) {
      const payload = {
        host: technical,
        name: device.name,
        groups: [{ groupid: groupId }],
        interfaces: [this.interfaceOf(device.ipAddress)],
        tags: [
          { tag: 'source', value: 'kalimasada' },
          { tag: 'device_id', value: device.id },
        ],
      };
      try {
        const created = await this.zabbix.call<{ hostids: string[] }>('host.create', payload);
        hostId = created.hostids[0];
      } catch (error) {
        if (!String(error).includes('groups')) throw error;
        const created = await this.zabbix.call<{ hostids: string[] }>('host.create', {
          host: technical,
          name: device.name,
          groupids: [groupId],
          interfaces: [this.interfaceOf(device.ipAddress)],
          tags: payload.tags,
        });
        hostId = created.hostids[0];
      }
    } else {
      await this.zabbix.call('host.update', { hostid: hostId, name: device.name });
      const ifaces = await this.zabbix.call<Array<{ interfaceid: string; ip: string; type: string }>>('hostinterface.get', {
        hostids: [hostId],
        output: ['interfaceid', 'ip', 'type'],
      });
      if (!ifaces.some((iface) => String(iface.type) === '1')) {
        await this.zabbix.call('hostinterface.create', { hostid: hostId, ...this.interfaceOf(device.ipAddress) });
      }
      for (const iface of ifaces) {
        if (iface.ip !== device.ipAddress) {
          await this.zabbix.call('hostinterface.update', { interfaceid: iface.interfaceid, ip: device.ipAddress });
        }
      }
    }
    return hostId;
  }

  private interfaceOf(ip: string) {
    return { type: 1, main: 1, useip: 1, ip, dns: '', port: '10050' };
  }

  private async mainInterfaceId(hostId: string) {
    const ifaces = await this.zabbix.call<Array<{ interfaceid: string; main: string; type: string }>>('hostinterface.get', {
      hostids: [hostId],
      output: ['interfaceid', 'main', 'type'],
    });
    const agent = ifaces.filter((iface) => String(iface.type) === '1');
    return agent.find((iface) => iface.main === '1')?.interfaceid ?? agent[0]?.interfaceid ?? null;
  }

  private async ensureItem(
    hostId: string,
    key: string,
    interfaceId: string | null,
    spec: { name: string; type: number; value_type: number; delay: string; units: string },
  ) {
    const found = await this.zabbix.call<Array<{ itemid: string; delay: string; interfaceid: string }>>('item.get', {
      hostids: [hostId],
      filter: { key_: [key] },
      output: ['itemid', 'delay', 'interfaceid'],
    });
    if (found[0]) {
      const update: Record<string, string> = { itemid: found[0].itemid };
      if (found[0].delay !== spec.delay) update.delay = spec.delay;
      if (interfaceId && (!found[0].interfaceid || found[0].interfaceid === '0')) update.interfaceid = interfaceId;
      if (Object.keys(update).length > 1) await this.zabbix.call('item.update', update);
      return found[0].itemid;
    }
    const created = await this.zabbix.call<{ itemids: string[] }>('item.create', {
      hostid: hostId,
      key_: key,
      name: spec.name,
      type: spec.type,
      value_type: spec.value_type,
      delay: spec.delay,
      units: spec.units,
      history: '31d',
      trends: '365d',
      ...(interfaceId ? { interfaceid: interfaceId } : {}),
    });
    return created.itemids[0];
  }

  private async ensureTrigger(
    currentId: string | null,
    spec: { description: string; expression: string; recovery_expression: string; priority: number },
  ) {
    const body = {
      description: spec.description,
      expression: spec.expression,
      recovery_mode: 1,
      recovery_expression: spec.recovery_expression,
      priority: spec.priority,
      manual_close: 0,
    };
    if (currentId) {
      const found = await this.zabbix.call<Array<{ triggerid: string }>>('trigger.get', {
        triggerids: [currentId],
        output: ['triggerid'],
      });
      if (found[0]) {
        await this.zabbix.call('trigger.update', { triggerid: currentId, ...body });
        return currentId;
      }
    }
    const byName = await this.zabbix.call<Array<{ triggerid: string }>>('trigger.get', {
      filter: { description: [spec.description] },
      output: ['triggerid'],
    });
    if (byName[0]) {
      await this.zabbix.call('trigger.update', { triggerid: byName[0].triggerid, ...body });
      return byName[0].triggerid;
    }
    const created = await this.zabbix.call<{ triggerids: string[] }>('trigger.create', body);
    return created.triggerids[0];
  }

  private async syncDependency(deviceId: string, downTriggerId: string) {
    const device = await this.prisma.device.findUnique({ where: { id: deviceId } });
    if (!device) return;
    let parentTrigger: string | null = null;
    if (device.parentId) {
      const parent = await this.prisma.device.findUnique({ where: { id: device.parentId } });
      parentTrigger = parent?.zabbixDownTriggerId ?? null;
    }
    try {
      await this.zabbix.call('trigger.update', {
        triggerid: downTriggerId,
        dependencies: parentTrigger ? [{ triggerid: parentTrigger }] : [],
      });
    } catch (error) {
      this.logger.warn(`Dependensi trigger gagal: ${error instanceof Error ? error.message : error}`);
    }
    const children = await this.prisma.device.findMany({
      where: { parentId: deviceId, zabbixDownTriggerId: { not: null } },
    });
    for (const child of children) {
      if (!child.zabbixDownTriggerId) continue;
      try {
        await this.zabbix.call('trigger.update', {
          triggerid: child.zabbixDownTriggerId,
          dependencies: [{ triggerid: downTriggerId }],
        });
      } catch (error) {
        this.logger.warn(`Dependensi anak gagal: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  private async syncMaintenance(device: Device, hostId: string) {
    if (device.maintenance && device.zabbixMaintenanceId) return device.zabbixMaintenanceId;
    if (!device.maintenance && device.zabbixMaintenanceId) {
      try {
        await this.zabbix.call('maintenance.delete', [device.zabbixMaintenanceId]);
      } catch (error) {
        this.logger.warn(`Maintenance tidak terhapus: ${error instanceof Error ? error.message : error}`);
      }
      return null;
    }
    if (!device.maintenance) return null;
    const now = Math.floor(Date.now() / 1000);
    const period = 86_399_940;
    const created = await this.zabbix.call<{ maintenanceids: string[] }>('maintenance.create', {
      name: `kalimasada-${device.id}`,
      active_since: now,
      active_till: now + period,
      maintenance_type: 0,
      hostids: [hostId],
      timeperiods: [{ timeperiod_type: 0, start_date: now, period }],
    });
    return created.maintenanceids[0];
  }

  private async prepareMonitoring(device: Device, hostId: string) {
    try {
      const ready = await this.ensureSnmp(device, hostId);
      if (ready) this.snmpReady.add(hostId);
    } catch (error) {
      this.logger.warn(`${device.name}: SNMP belum terpasang (${this.safeMessage(error, this.communityOf(device))})`);
    }
  }

  private communityOf(device: Device) {
    if (!device.snmpCommunityEnc) return null;
    try {
      const value = decryptSecret(device.snmpCommunityEnc).trim();
      return value || null;
    } catch {
      this.logger.warn(`${device.name}: community SNMP tidak bisa dibaca`);
      return null;
    }
  }

  private async ensureSnmp(device: Device, hostId: string) {
    const community = this.communityOf(device);
    if (!community) return false;
    if (device.snmpVersion === '3') {
      this.logger.warn(`${device.name}: SNMP v3 belum dipasang otomatis, gunakan v2c`);
      return true;
    }
    const interfaceId = await this.ensureSnmpInterface(hostId, device.ipAddress, String(device.snmpPort || 161), community);
    await this.ensureInterfaceDiscovery(hostId, interfaceId);
    return true;
  }

  private async ensureSnmpInterface(hostId: string, ip: string, port: string, community: string) {
    const ifaces = await this.zabbix.call<Array<{
      interfaceid: string;
      type: string;
      ip: string;
      port: string;
      details?: { community?: string };
    }>>('hostinterface.get', {
      hostids: [hostId],
      output: ['interfaceid', 'type', 'ip', 'port'],
      selectDetails: 'extend',
    });
    const details = {
      version: 2,
      bulk: 1,
      community,
      max_repetitions: 10,
      securityname: '',
      securitylevel: 0,
      authpassphrase: '',
      privpassphrase: '',
      authprotocol: 0,
      privprotocol: 0,
      contextname: '',
    };
    const snmp = ifaces.find((iface) => String(iface.type) === '2');
    if (!snmp) {
      const created = await this.zabbix.call<{ interfaceids: string[] }>('hostinterface.create', {
        hostid: hostId,
        type: 2,
        main: 1,
        useip: 1,
        ip,
        dns: '',
        port,
        details,
      });
      return created.interfaceids[0];
    }
    if (snmp.ip === ip && String(snmp.port) === port && snmp.details?.community === community) return snmp.interfaceid;
    await this.zabbix.call('hostinterface.update', { interfaceid: snmp.interfaceid, ip, port, details });
    return snmp.interfaceid;
  }

  private async ensureInterfaceDiscovery(hostId: string, interfaceId: string) {
    const found = await this.zabbix.call<Array<{ itemid: string }>>('discoveryrule.get', {
      hostids: [hostId],
      filter: { key_: ['net.if.discovery'] },
      output: ['itemid'],
    });
    let ruleId = found[0]?.itemid;
    if (!ruleId) {
      const created = await this.zabbix.call<{ itemids: string[] }>('discoveryrule.create', {
        hostid: hostId,
        name: 'Network interfaces',
        key_: 'net.if.discovery',
        type: 20,
        snmp_oid: 'discovery[{#IFOPERSTATUS},1.3.6.1.2.1.2.2.1.8,{#IFADMINSTATUS},1.3.6.1.2.1.2.2.1.7,{#IFALIAS},1.3.6.1.2.1.31.1.1.1.18,{#IFNAME},1.3.6.1.2.1.31.1.1.1.1,{#IFDESCR},1.3.6.1.2.1.2.2.1.2,{#IFTYPE},1.3.6.1.2.1.2.2.1.3]',
        delay: '60s',
        lifetime: '0',
        interfaceid: interfaceId,
        status: 0,
        filter: {
          evaltype: 1,
          conditions: [{ macro: '{#SNMPINDEX}', value: '^$', operator: 8 }],
        },
      });
      ruleId = created.itemids[0];
    }
    await this.ensureInterfacePrototypes(hostId, ruleId, interfaceId);
    return ruleId;
  }

  private async ensureInterfacePrototypes(hostId: string, ruleId: string, interfaceId: string) {
    const existing = await this.zabbix.call<Array<{ key_: string }>>('itemprototype.get', {
      discoveryids: [ruleId],
      output: ['key_'],
    });
    const keys = new Set(existing.map((item) => item.key_));
    const prototypes = [
      {
        key_: 'net.if.in[ifHCInOctets.{#SNMPINDEX}]',
        name: 'Interface {#IFNAME}: Bits received',
        snmp_oid: 'get[1.3.6.1.2.1.31.1.1.1.6.{#SNMPINDEX}]',
      },
      {
        key_: 'net.if.out[ifHCOutOctets.{#SNMPINDEX}]',
        name: 'Interface {#IFNAME}: Bits sent',
        snmp_oid: 'get[1.3.6.1.2.1.31.1.1.1.10.{#SNMPINDEX}]',
      },
    ];
    for (const proto of prototypes) {
      if (keys.has(proto.key_)) continue;
      await this.zabbix.call('itemprototype.create', {
        hostid: hostId,
        ruleid: ruleId,
        name: proto.name,
        key_: proto.key_,
        type: 20,
        snmp_oid: proto.snmp_oid,
        value_type: 3,
        units: 'bps',
        delay: '60s',
        history: '31d',
        trends: '365d',
        interfaceid: interfaceId,
        preprocessing: [
          { type: 10, params: '', error_handler: 0, error_handler_params: '' },
          { type: 1, params: '8', error_handler: 0, error_handler_params: '' },
        ],
      });
    }
  }

  private async syncGraphs(devices: Device[]) {
    const linked = devices.filter((device) => device.zabbixHostId);
    if (!linked.length) return;
    for (const device of linked) {
      await this.prisma.mrtgGraph.createMany({
        data: [
          { deviceId: device.id, kind: 'probe', probeKey: 'uptime', name: 'Ping' },
          { deviceId: device.id, kind: 'probe', probeKey: 'latency', name: 'Latency' },
        ],
        skipDuplicates: true,
      });
    }
  }

  private safeMessage(error: unknown, community: string | null) {
    const message = error instanceof Error ? error.message : String(error);
    return community ? message.split(community).join('***') : message;
  }
}

function trafficIndex(key: string) {
  if (!/^net\.if\.(in|out)\[/.test(key) || /error|discard|drop/.test(key)) return null;
  return key.match(/(\d+)\]/)?.[1] ?? null;
}

async function discoverSnmpProbes(host: string, port: string, community: string) {
  const [cpu, storage, health] = await Promise.all([
    snmpWalk(host, port, community, '1.3.6.1.2.1.25.3.3.1.2').catch(() => []),
    snmpWalk(host, port, community, '1.3.6.1.2.1.25.2.3.1.2').catch(() => []),
    snmpWalk(host, port, community, '1.3.6.1.4.1.14988.1.1.3').catch(() => []),
  ]);
  const probes: SnmpProbe[] = [];
  if (cpu.some((row) => /^\d+(\.\d+)?$/.test(row.value))) {
    probes.push({
      key: 'cpu',
      name: 'CPU',
      unit: '%',
      itemKey: 'kalimasada.cpu',
      itemName: 'CPU load',
      snmpOid: 'walk[1.3.6.1.2.1.25.3.3.1.2]',
      preprocessing: [{ type: 21, params: cpuScript }],
    });
  }
  if (storage.some((row) => /1\.3\.6\.1\.2\.1\.25\.2\.1\.2$/.test(row.value))) {
    probes.push({
      key: 'memory',
      name: 'RAM',
      unit: '%',
      itemKey: 'kalimasada.memory',
      itemName: 'RAM usage',
      snmpOid: 'walk[1.3.6.1.2.1.25.2.3.1.2,1.3.6.1.2.1.25.2.3.1.5,1.3.6.1.2.1.25.2.3.1.6]',
      preprocessing: [{ type: 21, params: memoryScript }],
    });
  }
  const gaugeBase = '.1.3.6.1.4.1.14988.1.1.3.100.1.';
  const gaugeNames = new Map<string, string>();
  const gaugeUnitCodes = new Map<string, string>();
  for (const row of health) {
    if (!row.oid.startsWith(gaugeBase)) continue;
    const [column, index] = row.oid.slice(gaugeBase.length).split('.');
    if (!index) continue;
    if (column === '2') gaugeNames.set(index, row.value);
    if (column === '4') gaugeUnitCodes.set(index, row.value);
  }
  for (const [index, name] of gaugeNames) {
    const unit = gaugeUnits[gaugeUnitCodes.get(index) ?? ''] ?? { unit: '', multiplier: 1 };
    probes.push({
      key: `health:${index}`,
      name: `Health · ${name}`,
      unit: unit.unit,
      itemKey: `kalimasada.health[${index}]`,
      itemName: `Health ${name}`,
      snmpOid: `get[1.3.6.1.4.1.14988.1.1.3.100.1.3.${index}]`,
      preprocessing: unit.multiplier === 1 ? [] : [{ type: 1, params: String(unit.multiplier) }],
    });
  }
  if (!gaugeNames.size) {
    for (const legacy of legacyHealth) {
      const row = health.find((item) => item.oid === `.${legacy.oid}`);
      if (!row || !/^\d+$/.test(row.value) || row.value === '0') continue;
      probes.push({
        key: `health:${legacy.id}`,
        name: `Health · ${legacy.name}`,
        unit: legacy.unit,
        itemKey: `kalimasada.health[${legacy.id}]`,
        itemName: `Health ${legacy.name}`,
        snmpOid: `get[${legacy.oid}]`,
        preprocessing: [{ type: 1, params: '0.1' }],
      });
    }
  }
  return probes;
}

async function snmpWalk(host: string, port: string, community: string, oid: string) {
  let stdout = '';
  try {
    const result = await execFileAsync('snmpbulkwalk', [
      '-v2c', '-c', community, '-On', '-OQ', '-Oe', '-t', '3', '-r', '1', '-Cr50', `${host}:${port}`, oid,
    ], { timeout: 20000, maxBuffer: 4 * 1024 * 1024 });
    stdout = result.stdout;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.split(community).join('***'));
  }
  const rows: Array<{ oid: string; value: string }> = [];
  for (const line of stdout.split('\n')) {
    const match = line.trim().match(/^(\.[\d.]+)\s+=\s+(.*)$/);
    if (!match) continue;
    const value = match[2].trim().replace(/^"(.*)"$/, '$1');
    if (/no such|end of mib/i.test(value)) continue;
    rows.push({ oid: match[1], value });
  }
  return rows;
}

async function snmpNames(host: string, port: string, community: string, oid: string) {
  const names = new Map<string, string>();
  let stdout = '';
  try {
    const result = await execFileAsync('snmpbulkwalk', [
      '-v2c',
      '-c',
      community,
      '-On',
      '-OQ',
      '-t',
      '3',
      '-r',
      '1',
      '-Cr50',
      `${host}:${port}`,
      oid,
    ], { timeout: 20000, maxBuffer: 16 * 1024 * 1024 });
    stdout = result.stdout;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.split(community).join('***'));
  }
  for (const line of stdout.split('\n')) {
    const match = line.trim().match(/\.(\d+)\s+=\s+(?:"([^"]*)"|(.+))$/) ?? line.trim().match(/\.(\d+)\s+(?:"([^"]*)"|(.+))$/);
    if (!match) continue;
    const name = (match[2] ?? match[3] ?? '').trim();
    if (!name || /no such|end of mib/i.test(name)) continue;
    names.set(match[1], name);
  }
  return names;
}
