'use strict';

const ipu = require('./ip');
const { newId } = require('./store');
const { vlanName } = require('./apply');
const { HttpError, bad, guardPath, ipv4Of, physicalLinks } = require('./status');
const vpn = require('./vpn');

const KEY = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/;
const typeLabels = { wireguard: 'WireGuard', openvpn: 'OpenVPN', l2tp: 'L2TP' };

function text(value, label, { max = 60, required = false } = {}) {
  const result = String(value ?? '').trim();
  if (required && !result) throw bad(`${label} wajib diisi`);
  if (result.length > max) throw bad(`${label} maksimal ${max} karakter`);
  return result;
}

function secret(value, label, { max = 200 } = {}) {
  const result = String(value ?? '');
  if (result.length > max) throw bad(`${label} terlalu panjang`);
  if (/["\\\r\n]/.test(result)) throw bad(`${label} tidak boleh berisi tanda kutip, backslash, atau baris baru`);
  return result;
}

function int(value, label, min, max, fallback) {
  if (value === undefined || value === null || value === '') {
    if (fallback !== undefined) return fallback;
    throw bad(`${label} wajib diisi`);
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw bad(`${label} harus ${min}-${max}`);
  return number;
}

function find(list, id, label) {
  const item = list.find((row) => row.id === id);
  if (!item) throw new HttpError(404, `${label} tidak ditemukan`);
  return item;
}

function hostCidr(value, label) {
  const cidr = ipu.parseCidr(value);
  if (!cidr || !String(value).includes('/')) throw bad(`${label} harus ditulis seperti 192.168.10.1/24`);
  if (cidr.prefix < 8) throw bad(`${label}: prefix minimal /8`);
  if (!ipu.isHostAddress(cidr)) throw bad(`${label} ${cidr.text} adalah alamat jaringan/broadcast`);
  return cidr;
}

function networkList(value) {
  const items = Array.isArray(value) ? value : String(value ?? '').split(/[\s,]+/);
  const result = [];
  for (const item of items.map((row) => String(row).trim()).filter(Boolean)) {
    const cidr = ipu.parseCidr(item);
    if (!cidr) throw bad(`Jaringan ${item} tidak valid`);
    if (cidr.prefix === 0) throw bad('Rute default (0.0.0.0/0) tidak boleh lewat sini');
    if (!result.includes(cidr.networkText)) result.push(cidr.networkText);
  }
  if (result.length > 32) throw bad('Maksimal 32 jaringan');
  return result;
}

function knownIfaces(config, ctx) {
  const names = new Set(ctx.snap.links.map((link) => link.ifname));
  for (const v of config.vlans) names.add(vlanName(v));
  for (const v of config.vpns) names.add(v.iface);
  names.delete('lo');
  return names;
}

// Every IPv4 network that is (or will be) connected, except the entry being edited.
function connectedNetworks(config, ctx, skip) {
  const list = [];
  for (const row of ctx.snap.addrs) {
    if (row.ifname === 'lo') continue;
    for (const a of ipv4Of(ctx.snap, row.ifname)) {
      if (skip && skip.iface === row.ifname && skip.cidr === a.cidr) continue;
      list.push({ iface: row.ifname, cidr: a.cidr });
    }
  }
  for (const a of config.addresses) if (a.id !== skip?.id) list.push({ iface: a.iface, cidr: a.cidr });
  for (const v of config.vpns) if (v.type === 'wireguard' && v.id !== skip?.id && v.address) list.push({ iface: v.iface, cidr: v.address });
  return list;
}

function checkAddress(config, ctx, iface, cidr, skip) {
  for (const other of connectedNetworks(config, ctx, skip)) {
    const parsed = ipu.parseCidr(other.cidr);
    if (!parsed) continue;
    if (parsed.ip === cidr.ip) throw bad(`IP ${ipu.formatIPv4(cidr.ip)} sudah dipakai di ${other.iface}`);
    if (other.iface !== iface && ipu.overlaps(parsed, cidr)) throw bad(`Jaringan ${cidr.networkText} bentrok dengan ${other.cidr} di ${other.iface}`);
  }
  guardPath(cidr, ctx, { iface, connected: true, label: 'Jaringan' });
}

function checkRouteKey(config, dst, metric, skipId, ctx) {
  const clash = config.routes.find((r) => r.id !== skipId && r.dst === dst && r.metric === metric);
  if (clash) throw bad(`Rute ${dst} dengan metric ${metric} sudah ada`);
  for (const v of config.vpns) {
    if (v.id !== skipId && metric === 10 && (v.networks ?? []).includes(dst)) throw bad(`Rute ${dst} sudah dipakai VPN ${v.name}`);
  }
  const system = ctx.snap.routes.find((r) => ipu.normalizeRouteDst(r.dst) === dst && (r.metric ?? 0) === metric && String(r.protocol) !== '77' && r.protocol !== 'kalimasada');
  if (system) throw bad(`Rute ${dst} sudah ada di sistem`);
}

// ---- forwarding ----

function setForwarding(config, body) {
  config.forwarding = Boolean(body?.enabled);
  return { summary: `Routing antar interface ${config.forwarding ? 'aktif' : 'mati'}` };
}

// ---- VLAN ----

function createVlan(config, body, ctx) {
  const vid = int(body.vid, 'VLAN ID', 1, 4094);
  const parents = physicalLinks(ctx.snap);
  const parent = parents.find((link) => link.ifname === String(body.parent ?? ''));
  if (!parent) throw bad('Pilih interface induk');
  const vlan = {
    id: newId(),
    vid,
    parent: parent.ifname,
    name: text(body.name, 'Nama', { max: 40 }),
    mtu: int(body.mtu, 'MTU', 576, parent.mtu, Math.min(1500, parent.mtu)),
    enabled: body.enabled === undefined ? true : Boolean(body.enabled),
  };
  const ifname = vlanName(vlan);
  if (ifname.length > 15) throw bad('Nama interface terlalu panjang');
  if (config.vlans.some((v) => vlanName(v) === ifname)) throw bad(`VLAN ${vid} di ${parent.ifname} sudah ada`);
  if (ctx.snap.links.some((link) => link.ifname === ifname)) throw bad(`${ifname} sudah ada di sistem`);
  config.vlans.push(vlan);
  if (body.address) {
    const cidr = hostCidr(body.address, 'IP');
    checkAddress(config, ctx, ifname, cidr);
    config.addresses.push({ id: newId(), iface: ifname, cidr: cidr.text, comment: vlan.name });
  }
  return { id: vlan.id, summary: `VLAN ${vid} (${ifname})` };
}

function updateVlan(config, id, body, ctx) {
  const vlan = find(config.vlans, id, 'VLAN');
  const parent = physicalLinks(ctx.snap).find((link) => link.ifname === vlan.parent);
  if (body.name !== undefined) vlan.name = text(body.name, 'Nama', { max: 40 });
  if (body.mtu !== undefined) vlan.mtu = int(body.mtu, 'MTU', 576, parent?.mtu ?? 9000);
  if (body.enabled !== undefined) vlan.enabled = Boolean(body.enabled);
  return { id, summary: `VLAN ${vlan.vid} (${vlanName(vlan)})` };
}

function removeVlan(config, id) {
  const vlan = find(config.vlans, id, 'VLAN');
  const ifname = vlanName(vlan);
  config.vlans = config.vlans.filter((v) => v.id !== id);
  config.addresses = config.addresses.filter((a) => a.iface !== ifname);
  config.routes = config.routes.filter((r) => r.iface !== ifname);
  return { id, summary: `VLAN ${vlan.vid} (${ifname})` };
}

// ---- IP address ----

function addressIfaces(config, ctx) {
  return new Set([...physicalLinks(ctx.snap).map((link) => link.ifname), ...config.vlans.map(vlanName)]);
}

function createAddress(config, body, ctx) {
  const iface = String(body.iface ?? '');
  if (!addressIfaces(config, ctx).has(iface)) throw bad('Pilih interface (fisik atau VLAN)');
  const cidr = hostCidr(body.cidr, 'IP');
  checkAddress(config, ctx, iface, cidr);
  const row = { id: newId(), iface, cidr: cidr.text, comment: text(body.comment, 'Keterangan') };
  config.addresses.push(row);
  return { id: row.id, summary: `IP ${row.cidr} di ${iface}` };
}

function updateAddress(config, id, body, ctx) {
  const row = find(config.addresses, id, 'IP');
  if (body.cidr !== undefined || body.iface !== undefined) {
    const iface = body.iface !== undefined ? String(body.iface) : row.iface;
    if (!addressIfaces(config, ctx).has(iface)) throw bad('Pilih interface (fisik atau VLAN)');
    const cidr = hostCidr(body.cidr ?? row.cidr, 'IP');
    checkAddress(config, ctx, iface, cidr, { id, iface: row.iface, cidr: row.cidr });
    row.iface = iface;
    row.cidr = cidr.text;
  }
  if (body.comment !== undefined) row.comment = text(body.comment, 'Keterangan');
  return { id, summary: `IP ${row.cidr} di ${row.iface}` };
}

function removeAddress(config, id) {
  const row = find(config.addresses, id, 'IP');
  config.addresses = config.addresses.filter((a) => a.id !== id);
  return { id, summary: `IP ${row.cidr} di ${row.iface}` };
}

// ---- Route ----

function readRoute(config, body, ctx, current) {
  const dstText = body.dst ?? current?.dst;
  const dst = ipu.parseCidr(dstText);
  if (!dst) throw bad('Tujuan harus ditulis seperti 10.20.0.0/16');
  if (dst.prefix === 0) throw bad('Rute default (0.0.0.0/0) tidak boleh diubah dari sini');
  const gateway = String(body.gateway ?? current?.gateway ?? '').trim();
  if (gateway && ipu.parseIPv4(gateway) === null) throw bad('Gateway harus berupa IPv4');
  const iface = String(body.iface ?? current?.iface ?? '').trim();
  if (iface && !knownIfaces(config, ctx).has(iface)) throw bad(`Interface ${iface} tidak ada`);
  if (!gateway && !iface) throw bad('Isi gateway atau pilih interface');
  const metric = int(body.metric ?? current?.metric, 'Metric', 0, 9999, 10);
  checkRouteKey(config, dst.networkText, metric, current?.id, ctx);
  guardPath(dst, ctx, { label: 'Rute' });
  return {
    dst: dst.networkText,
    gateway: gateway || null,
    iface: iface || null,
    metric,
    comment: text(body.comment ?? current?.comment, 'Keterangan'),
    enabled: body.enabled === undefined ? current?.enabled ?? true : Boolean(body.enabled),
  };
}

function createRoute(config, body, ctx) {
  const route = { id: newId(), ...readRoute(config, body, ctx) };
  config.routes.push(route);
  return { id: route.id, summary: `rute ${route.dst}` };
}

function updateRoute(config, id, body, ctx) {
  const route = find(config.routes, id, 'Rute');
  Object.assign(route, readRoute(config, body, ctx, route));
  return { id, summary: `rute ${route.dst}` };
}

function removeRoute(config, id) {
  const route = find(config.routes, id, 'Rute');
  config.routes = config.routes.filter((r) => r.id !== id);
  return { id, summary: `rute ${route.dst}` };
}

// ---- VPN ----

function readNetworks(config, body, ctx, v) {
  if (body.networks === undefined) return v.networks ?? [];
  const list = networkList(body.networks);
  for (const dst of list) {
    if (config.routes.some((r) => r.dst === dst && r.metric === 10)) throw bad(`Rute ${dst} sudah ada di menu Route`);
    const other = config.vpns.find((row) => row.id !== v.id && (row.networks ?? []).includes(dst));
    if (other) throw bad(`Jaringan ${dst} sudah dipakai VPN ${other.name}`);
    guardPath(ipu.parseCidr(dst), ctx, { label: 'Jaringan' });
  }
  return list;
}

function applyWireguard(config, v, body, ctx, creating) {
  if (body.address !== undefined || creating) {
    const cidr = hostCidr(body.address, 'IP tunnel');
    checkAddress(config, ctx, v.iface, cidr, { id: v.id, iface: v.iface, cidr: v.address });
    v.address = cidr.text;
  }
  if (body.peerPublicKey !== undefined || creating) {
    const key = String(body.peerPublicKey ?? '').trim();
    if (!KEY.test(key)) throw bad('Public key server tidak valid (44 karakter base64)');
    v.peerPublicKey = key;
  }
  if (body.presharedKey !== undefined && body.presharedKey !== '') {
    const key = String(body.presharedKey).trim();
    if (!KEY.test(key)) throw bad('Preshared key tidak valid');
    v.presharedKey = key;
  }
  if (body.clearPresharedKey) v.presharedKey = null;
  if (body.endpoint !== undefined) {
    const endpoint = String(body.endpoint ?? '').trim();
    if (endpoint) {
      const match = /^(.+):(\d{1,5})$/.exec(endpoint);
      if (!match || !ipu.isHost(match[1]) || Number(match[2]) < 1 || Number(match[2]) > 65535) throw bad('Endpoint ditulis seperti vpn.contoh.id:13231');
    }
    v.endpoint = endpoint || null;
  }
  if (body.listenPort !== undefined) v.listenPort = body.listenPort === '' || body.listenPort === null ? null : int(body.listenPort, 'Port listen', 1, 65535);
  if (body.keepalive !== undefined || creating) v.keepalive = int(body.keepalive, 'Keepalive', 0, 600, 25);
  if (body.mtu !== undefined) v.mtu = body.mtu === '' || body.mtu === null ? null : int(body.mtu, 'MTU', 1280, 1500);
  if (!v.endpoint && !v.listenPort) throw bad('Isi endpoint server, atau port listen bila server yang menghubungi NMS');
  if (creating || body.regenerateKey) Object.assign(v, vpn.wgKeypair());
}

function applyOpenvpn(v, body, creating) {
  if (body.config !== undefined && String(body.config).trim()) {
    const raw = String(body.config);
    if (raw.length > 100000) throw bad('File .ovpn terlalu besar');
    const parsed = vpn.parseOvpn(raw);
    if (parsed.unclosed) throw bad(`Blok <${parsed.unclosed}> di file .ovpn tidak ditutup`);
    if (!parsed.remote) throw bad('File .ovpn tidak berisi baris remote');
    v.config = raw;
  } else if (creating) {
    throw bad('Unggah atau tempel file .ovpn');
  }
  if (body.username !== undefined) v.username = secret(body.username, 'Username', { max: 100 }).trim() || null;
  if (body.password !== undefined && body.password !== '') v.password = secret(body.password, 'Password');
  if (vpn.parseOvpn(v.config).needsAuth && (!v.username || !v.password)) throw bad('File .ovpn ini butuh username dan password');
}

function applyL2tp(v, body, creating) {
  if (body.server !== undefined || creating) {
    const server = String(body.server ?? '').trim();
    if (!ipu.isHost(server)) throw bad('Server harus IP atau nama host');
    v.server = server;
  }
  if (body.username !== undefined || creating) v.username = text(secret(body.username, 'Username', { max: 100 }), 'Username', { max: 100, required: true });
  if (body.password !== undefined && body.password !== '') v.password = secret(body.password, 'Password');
  if (!v.password) throw bad('Password wajib diisi');
  if (body.useIpsec === false) v.psk = null;
  if (body.psk !== undefined && body.psk !== '') v.psk = secret(body.psk, 'IPsec secret');
  if (body.useIpsec === true && !v.psk) throw bad('Isi IPsec secret');
  if (body.mtu !== undefined || creating) v.mtu = int(body.mtu, 'MTU', 576, 1500, 1400);
}

function createVpn(config, body, ctx) {
  const type = String(body.type ?? '');
  if (!typeLabels[type]) throw bad('Pilih jenis VPN');
  const v = {
    id: newId(),
    type,
    name: text(body.name, 'Nama', { max: 40, required: true }),
    iface: vpn.nextIface(config.vpns, type),
    enabled: body.enabled === undefined ? true : Boolean(body.enabled),
    networks: [],
  };
  if (ctx.snap.links.some((link) => link.ifname === v.iface)) throw bad(`${v.iface} sudah ada di sistem`);
  v.networks = readNetworks(config, body, ctx, v);
  if (type === 'wireguard') applyWireguard(config, v, body, ctx, true);
  if (type === 'openvpn') applyOpenvpn(v, body, true);
  if (type === 'l2tp') applyL2tp(v, body, true);
  config.vpns.push(v);
  return { id: v.id, summary: `VPN ${typeLabels[type]} "${v.name}" (${v.iface})` };
}

function updateVpn(config, id, body, ctx) {
  const v = find(config.vpns, id, 'VPN');
  if (body.name !== undefined) v.name = text(body.name, 'Nama', { max: 40, required: true });
  if (body.enabled !== undefined) v.enabled = Boolean(body.enabled);
  v.networks = readNetworks(config, body, ctx, v);
  if (v.type === 'wireguard') applyWireguard(config, v, body, ctx, false);
  if (v.type === 'openvpn') applyOpenvpn(v, body, false);
  if (v.type === 'l2tp') applyL2tp(v, body, false);
  return { id, summary: `VPN ${typeLabels[v.type]} "${v.name}" (${v.iface})` };
}

function removeVpn(config, id) {
  const v = find(config.vpns, id, 'VPN');
  config.vpns = config.vpns.filter((row) => row.id !== id);
  config.routes = config.routes.filter((r) => r.iface !== v.iface);
  return { id, summary: `VPN ${typeLabels[v.type]} "${v.name}" (${v.iface})` };
}

const handlers = {
  vlans: { create: createVlan, update: updateVlan, remove: removeVlan },
  addresses: { create: createAddress, update: updateAddress, remove: removeAddress },
  routes: { create: createRoute, update: updateRoute, remove: removeRoute },
  vpns: { create: createVpn, update: updateVpn, remove: removeVpn },
};

module.exports = { handlers, setForwarding };
