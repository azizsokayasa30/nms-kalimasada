import { api } from '../../lib/api';

export type LinkState = 'up' | 'down' | 'wait' | 'off';
export type IfaceKind = 'ethernet' | 'vlan' | 'wireguard' | 'openvpn' | 'l2tp' | 'bridge' | 'other';
export type VpnType = 'wireguard' | 'openvpn' | 'l2tp';

export type Traffic = { bytes: number; bps: number; packets: number; errors: number; dropped: number };

export type Iface = {
  name: string;
  kind: IfaceKind;
  label: string;
  state: LinkState;
  stateText: string | null;
  managed: boolean;
  main: boolean;
  parent: string | null;
  vlanId: number | null;
  mtu: number | null;
  mac: string | null;
  speedMbps: number | null;
  addresses: string[];
  testTarget: string | null;
  rx: Traffic;
  tx: Traffic;
};

export type AddressRow = {
  id: string | null;
  iface: string;
  cidr: string;
  network: string;
  comment: string;
  source: 'nms' | 'system' | 'vpn';
  active: boolean;
};

export type VlanRow = { id: string; vid: number; parent: string; name: string; mtu: number; enabled: boolean; ifname: string; state: LinkState };

export type RouteRow = {
  id: string;
  dst: string;
  gateway: string | null;
  iface: string | null;
  metric: number;
  comment: string;
  enabled: boolean;
  active: boolean;
  error: string | null;
  dev: string | null;
};

export type SystemRoute = { dst: string; gateway: string | null; dev: string | null; metric: number; protocol: string; source: 'system' | 'vpn' };

export type VpnRow = {
  id: string;
  type: VpnType;
  name: string;
  iface: string;
  enabled: boolean;
  networks: string[];
  status: { state: LinkState; text: string; endpoint?: string | null };
  addresses: string[];
  testTarget: string | null;
  address?: string;
  publicKey?: string;
  peerPublicKey?: string;
  endpoint?: string;
  listenPort?: number | null;
  keepalive?: number;
  mtu?: number | null;
  presharedKeySet?: boolean;
  remote?: string | null;
  username?: string;
  passwordSet?: boolean;
  server?: string;
  pskSet?: boolean;
};

export type NetSnapshot = {
  forwarding: boolean;
  pending: { id: string; expiresAt: number } | null;
  management: { iface: string | null; gateway: string | null; address: string | null; peers: string[] };
  parents: Array<{ name: string; mtu: number }>;
  interfaces: Iface[];
  addresses: AddressRow[];
  vlans: VlanRow[];
  routes: RouteRow[];
  systemRoutes: SystemRoute[];
  vpns: VpnRow[];
};

export type ChangeResult = { ok: boolean; summary?: string; pendingId?: string; warnings?: string[] };

export type TestRequest = { target: string; iface: string };

export const kindLabels: Record<IfaceKind, string> = {
  ethernet: 'Ethernet',
  vlan: 'VLAN',
  wireguard: 'WireGuard',
  openvpn: 'OpenVPN',
  l2tp: 'L2TP',
  bridge: 'Bridge',
  other: 'Lainnya',
};

export const vpnLabels: Record<VpnType, string> = { wireguard: 'WireGuard', openvpn: 'OpenVPN', l2tp: 'L2TP/IPsec' };

export const stateLabels: Record<LinkState, string> = { up: 'Aktif', down: 'Putus', wait: 'Menunggu', off: 'Nonaktif' };

export const stateTone: Record<LinkState, string> = { up: 'up', down: 'down', wait: 'warning', off: 'unknown' };

const LOST = 'Koneksi ke server terputus. Perubahan dibatalkan otomatis dalam 60 detik.';

// Every change is applied in safe mode: the server rolls it back unless this
// browser can still reach it and confirm right after.
export async function applyChange(path: string, method: string, body?: unknown): Promise<ChangeResult> {
  let result: ChangeResult;
  try {
    result = await api<ChangeResult>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (err) {
    if (err instanceof TypeError) throw new Error(LOST);
    throw err;
  }
  if (result.pendingId) {
    try {
      await api('/api/network/confirm', { method: 'POST', body: JSON.stringify({ id: result.pendingId }) });
    } catch {
      throw new Error(LOST);
    }
  }
  return result;
}

export function vpnPeerCommand(vpn: VpnRow) {
  const ip = vpn.address?.split('/')[0] ?? '';
  return `/interface wireguard peers add interface=wireguard1 public-key="${vpn.publicKey}" allowed-address=${ip}/32 comment="NMS Kalimasada"`;
}

// First usable host of the network, skipping our own address.
export function guessPeer(cidr: string) {
  const [ip, prefixText] = cidr.split('/');
  const parts = ip.split('.').map(Number);
  const prefix = Number(prefixText ?? 32);
  if (parts.length !== 4 || prefix >= 31) return ip;
  const own = ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  let value = ((own & mask) >>> 0) + 1;
  if (value === own) value += 1;
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
}
