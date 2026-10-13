import { Device } from '@prisma/client';

type WithParent = Device & {
  parent?: { id: string; name: string } | null;
  group?: { id: string; name: string } | null;
};

export function presentDevice(device: WithParent) {
  const downtimeSec = device.downSince
    ? Math.max(0, Math.floor((Date.now() - device.downSince.getTime()) / 1000))
    : device.downtimeSec;
  return {
    id: device.id,
    name: device.name,
    ipAddress: device.ipAddress,
    deviceType: device.deviceType,
    location: device.location,
    groupId: device.groupId,
    groupName: device.group?.name ?? null,
    parentId: device.parentId,
    parentName: device.parent?.name ?? null,
    monitorMethod: device.monitorMethod,
    snmpVersion: device.snmpVersion,
    snmpPort: device.snmpPort,
    snmpCommunitySet: Boolean(device.snmpCommunityEnc),
    rosUsername: device.rosUsername,
    rosPasswordSet: Boolean(device.rosPasswordEnc),
    rosPort: device.rosPort,
    pingIntervalSec: device.pingIntervalSec,
    failedThreshold: device.failedThreshold,
    recoveryThreshold: device.recoveryThreshold,
    alertDelaySec: device.alertDelaySec,
    criticality: device.criticality,
    notificationEnabled: device.notificationEnabled,
    maintenance: device.maintenance,
    status: device.status,
    latencyMs: device.latencyMs,
    packetLoss: device.packetLoss,
    bandwidthThresholdMbps: device.bandwidthThresholdMbps,
    lastSeenAt: device.lastSeenAt,
    downSince: device.downSince,
    downtimeSec,
    lastResponse: device.lastResponse,
    posX: device.posX,
    posY: device.posY,
    zabbixLinked: Boolean(device.zabbixHostId),
  };
}
