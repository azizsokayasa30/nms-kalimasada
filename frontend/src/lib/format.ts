export const deviceTypeLabels: Record<string, string> = {
  mikrotik_router: 'MikroTik Router',
  mikrotik_switch: 'MikroTik Switch',
  huawei_olt: 'Huawei OLT',
  switch: 'Switch',
  access_point: 'Access Point',
  server: 'Server',
  customer_router: 'Customer Router',
  other: 'Lainnya',
};

export const methodLabels: Record<string, string> = {
  icmp: 'ICMP',
  snmp: 'SNMP',
  mikrotik_api: 'MikroTik API',
  combination: 'Kombinasi',
};

export const connectionLabels: Record<string, string> = {
  icmp: 'ICMP',
  snmp: 'SNMP',
  mikrotik_api: 'API',
  combination: 'ICMP + SNMP + API',
};

export const roleLabels: Record<string, string> = {
  super_admin: 'Super Admin',
  admin: 'Admin',
  noc: 'NOC',
  viewer: 'Viewer',
};

const rank: Record<string, number> = { viewer: 0, noc: 1, admin: 2, super_admin: 3 };

export function can(role: string | undefined, minimum: string) {
  return rank[role ?? 'viewer'] >= rank[minimum];
}

export function formatDuration(seconds: number) {
  const sec = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(sec / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  const rest = sec % 60;
  if (hours > 0) return `${hours} jam ${minutes} menit`;
  if (minutes > 0) return `${minutes} menit ${rest} detik`;
  return `${rest} detik`;
}

export function formatClock(value?: string | null) {
  if (!value) return '—';
  return new Date(value).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function formatLatency(ms?: number | null) {
  if (ms == null || Number.isNaN(ms)) return '—';
  return `${Math.round(ms)} ms`;
}

export function formatBps(value?: number | null) {
  if (value == null || Number.isNaN(value)) return '—';
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)} Gbps`;
  if (absolute >= 1_000_000) return `${(value / 1_000_000).toFixed(2)} Mbps`;
  if (absolute >= 1_000) return `${(value / 1_000).toFixed(2)} Kbps`;
  return `${value.toFixed(0)} bps`;
}

export function formatPercent(value?: number | null) {
  if (value == null || Number.isNaN(value)) return '—';
  return `${value.toFixed(1)}%`;
}
