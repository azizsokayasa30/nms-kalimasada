'use strict';

const dns = require('node:dns').promises;
const fs = require('node:fs');
const net = require('node:net');
const ipu = require('./ip');
const sh = require('./sh');
const { ALIAS, vlanName, isManagedProto, readForwarding, routeErrors, desiredRoutes } = require('./apply');
const vpn = require('./vpn');

const samples = new Map();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const bad = (message) => new HttpError(400, message);

async function snapshot() {
  const [links, addrs, routes] = await Promise.all([
    sh.json('ip', ['-j', '-s', '-d', 'link', 'show']),
    sh.json('ip', ['-j', '-4', 'addr', 'show']),
    sh.json('ip', ['-j', '-4', 'route', 'show', 'table', 'main']),
  ]);
  return { links, addrs, routes };
}

function isPhysical(name) {
  return fs.existsSync(`/sys/class/net/${name}/device`);
}

function physicalLinks(snap) {
  return snap.links.filter((link) => link.ifname !== 'lo' && isPhysical(link.ifname));
}

function ipv4Of(snap, name) {
  return (snap.addrs.find((row) => row.ifname === name)?.addr_info ?? [])
    .filter((info) => info.family === 'inet')
    .map((info) => ({ cidr: `${info.local}/${info.prefixlen}`, peer: info.address && info.address !== info.local ? info.address : null }));
}

async function management(snap, clientIp) {
  const def = snap.routes.find((route) => route.dst === 'default');
  const result = await sh.run('ss', ['-Htn', 'state', 'established', '( sport = :22 or sport = :80 or sport = :443 )']);
  const peers = new Set();
  for (const line of result.stdout.split('\n')) {
    const peer = line.trim().split(/\s+/).pop() ?? '';
    const match = /^(?:\[::ffff:)?(\d+\.\d+\.\d+\.\d+)\]?:\d+$/.exec(peer);
    if (match && !match[1].startsWith('127.')) peers.add(match[1]);
  }
  if (clientIp && ipu.parseIPv4(clientIp) !== null && !clientIp.startsWith('127.')) peers.add(clientIp);
  return {
    iface: def?.dev ?? null,
    gateway: def?.gateway ?? null,
    address: ipv4Of(snap, def?.dev)[0]?.cidr ?? null,
    peers: [...peers],
  };
}

function bestRoute(ip, routes) {
  let best = null;
  for (const route of routes) {
    const cidr = ipu.parseCidr(ipu.normalizeRouteDst(route.dst));
    if (!cidr || !ipu.contains(cidr, ip)) continue;
    if (!best || cidr.prefix > best.prefix) best = { prefix: cidr.prefix, dev: route.dev, gateway: route.gateway ?? null };
  }
  return best;
}

// Rejects a new connected network or route that would steal the path to the admin or the main gateway.
function guardPath(target, ctx, { iface = null, connected = false, label }) {
  const sensitive = ctx.mgmt.peers.map((ip) => ({ ip, name: `akses Anda (${ip})` }));
  if (ctx.mgmt.gateway) sensitive.push({ ip: ctx.mgmt.gateway, name: `gateway utama (${ctx.mgmt.gateway})` });
  for (const item of sensitive) {
    const ip = ipu.parseIPv4(item.ip);
    if (ip === null || !ipu.contains(target, ip)) continue;
    const best = bestRoute(ip, ctx.snap.routes);
    if (best && target.prefix < best.prefix) continue;
    if (connected && best && best.dev === iface && !best.gateway && target.prefix === best.prefix) continue;
    throw bad(`${label} ${target.networkText} akan memutus ${item.name}`);
  }
}

function linkState(link) {
  if (!link) return 'off';
  const flags = link.flags ?? [];
  if (!flags.includes('UP')) return 'off';
  if (flags.includes('NO-CARRIER') || link.operstate === 'DOWN' || link.operstate === 'LOWERLAYERDOWN') return 'down';
  if (link.operstate === 'UP' || flags.includes('LOWER_UP')) return 'up';
  return 'wait';
}

function rates(link, now) {
  const rx = link.stats64?.rx?.bytes ?? 0;
  const tx = link.stats64?.tx?.bytes ?? 0;
  const prev = samples.get(link.ifname);
  if (prev && now - prev.t < 1500) return prev;
  let rxBps = 0;
  let txBps = 0;
  if (prev) {
    const seconds = (now - prev.t) / 1000;
    rxBps = rx >= prev.rx ? ((rx - prev.rx) * 8) / seconds : 0;
    txBps = tx >= prev.tx ? ((tx - prev.tx) * 8) / seconds : 0;
  }
  const next = { t: now, rx, tx, rxBps, txBps };
  samples.set(link.ifname, next);
  return next;
}

function speedOf(name) {
  try {
    const value = Number(fs.readFileSync(`/sys/class/net/${name}/speed`, 'utf8').trim());
    return value > 0 ? value : null;
  } catch {
    return null;
  }
}

function presentVpn(v) {
  const base = { id: v.id, type: v.type, name: v.name, iface: v.iface, enabled: v.enabled, networks: v.networks ?? [] };
  if (v.type === 'wireguard') {
    return {
      ...base,
      address: v.address,
      publicKey: v.publicKey,
      peerPublicKey: v.peerPublicKey,
      endpoint: v.endpoint ?? '',
      listenPort: v.listenPort ?? null,
      keepalive: v.keepalive ?? 0,
      mtu: v.mtu ?? null,
      presharedKeySet: Boolean(v.presharedKey),
    };
  }
  if (v.type === 'openvpn') {
    return { ...base, remote: vpn.parseOvpn(v.config).remote, username: v.username ?? '', passwordSet: Boolean(v.password) };
  }
  return { ...base, server: v.server, username: v.username, passwordSet: Boolean(v.password), pskSet: Boolean(v.psk), mtu: v.mtu };
}

function testTarget(v, addresses) {
  const first = addresses[0];
  if (first?.peer) return first.peer;
  const cidr = ipu.parseCidr(v?.type === 'wireguard' ? v.address : first?.cidr);
  return cidr ? ipu.otherHost(cidr) : null;
}

async function buildState({ config, pending, clientIp }) {
  const snap = await snapshot();
  const mgmt = await management(snap, clientIp);
  const now = Date.now();
  const vpnByIface = new Map(config.vpns.map((v) => [v.iface, v]));
  const vlanByIface = new Map(config.vlans.map((v) => [vlanName(v), v]));
  const linkByName = new Map(snap.links.map((link) => [link.ifname, link]));

  const vpns = [];
  const vpnStatus = new Map();
  for (const v of config.vpns) {
    const link = linkByName.get(v.iface);
    const addresses = ipv4Of(snap, v.iface);
    const st = await vpn.status(v, link ? { ipv4: addresses } : null);
    vpnStatus.set(v.iface, st);
    vpns.push({ ...presentVpn(v), status: st, addresses: addresses.map((a) => a.cidr), testTarget: testTarget(v, addresses) });
  }

  const interfaces = [];
  for (const link of snap.links) {
    if (link.ifname === 'lo') continue;
    const v = vpnByIface.get(link.ifname);
    const vlan = vlanByIface.get(link.ifname);
    const kindInfo = link.linkinfo?.info_kind;
    let kind = 'other';
    if (kindInfo === 'vlan') kind = 'vlan';
    else if (v) kind = v.type;
    else if (kindInfo === 'wireguard') kind = 'wireguard';
    else if (kindInfo === 'bridge') kind = 'bridge';
    else if (link.link_type === 'ppp') kind = 'l2tp';
    else if (kindInfo === 'tun') kind = 'openvpn';
    else if (isPhysical(link.ifname)) kind = 'ethernet';
    const addresses = ipv4Of(snap, link.ifname);
    const rate = rates(link, now);
    const st = v ? vpnStatus.get(link.ifname) : null;
    interfaces.push({
      name: link.ifname,
      kind,
      label: v?.name ?? vlan?.name ?? (link.ifname === mgmt.iface ? 'Uplink utama' : ''),
      state: st ? st.state : linkState(link),
      stateText: st?.text ?? null,
      managed: Boolean(v || link.ifalias === ALIAS),
      main: link.ifname === mgmt.iface,
      parent: link.link ?? null,
      vlanId: link.linkinfo?.info_data?.id ?? null,
      mtu: link.mtu,
      mac: link.link_type === 'ether' ? link.address : null,
      speedMbps: speedOf(link.ifname),
      addresses: addresses.map((a) => a.cidr),
      testTarget: link.ifname === mgmt.iface ? mgmt.gateway : testTarget(v, addresses),
      rx: { bytes: rate.rx, bps: rate.rxBps, packets: link.stats64?.rx?.packets ?? 0, errors: link.stats64?.rx?.errors ?? 0, dropped: link.stats64?.rx?.dropped ?? 0 },
      tx: { bytes: rate.tx, bps: rate.txBps, packets: link.stats64?.tx?.packets ?? 0, errors: link.stats64?.tx?.errors ?? 0, dropped: link.stats64?.tx?.dropped ?? 0 },
    });
  }
  const zero = { bytes: 0, bps: 0, packets: 0, errors: 0, dropped: 0 };
  for (const vlan of config.vlans) {
    const name = vlanName(vlan);
    if (linkByName.has(name)) continue;
    interfaces.push({ name, kind: 'vlan', label: vlan.name, state: vlan.enabled ? 'down' : 'off', stateText: vlan.enabled ? 'Belum terpasang' : 'Nonaktif', managed: true, main: false, parent: vlan.parent, vlanId: vlan.vid, mtu: vlan.mtu, mac: null, speedMbps: null, addresses: [], testTarget: null, rx: zero, tx: zero });
  }
  for (const v of config.vpns) {
    if (linkByName.has(v.iface)) continue;
    const st = vpnStatus.get(v.iface);
    interfaces.push({ name: v.iface, kind: v.type, label: v.name, state: st.state, stateText: st.text, managed: true, main: false, parent: null, vlanId: null, mtu: null, mac: null, speedMbps: null, addresses: [], testTarget: null, rx: zero, tx: zero });
  }

  const addresses = [];
  const seen = new Set();
  for (const row of snap.addrs) {
    if (row.ifname === 'lo') continue;
    for (const info of row.addr_info ?? []) {
      const cidr = `${info.local}/${info.prefixlen}`;
      const own = config.addresses.find((a) => a.iface === row.ifname && a.cidr === cidr);
      seen.add(`${row.ifname}|${cidr}`);
      addresses.push({
        id: own?.id ?? null,
        iface: row.ifname,
        cidr,
        network: ipu.parseCidr(cidr)?.networkText ?? cidr,
        comment: own?.comment ?? '',
        source: own ? 'nms' : vpnByIface.has(row.ifname) ? 'vpn' : 'system',
        active: true,
      });
    }
  }
  for (const a of config.addresses) {
    if (seen.has(`${a.iface}|${a.cidr}`)) continue;
    addresses.push({ id: a.id, iface: a.iface, cidr: a.cidr, network: ipu.parseCidr(a.cidr)?.networkText ?? a.cidr, comment: a.comment ?? '', source: 'nms', active: false });
  }

  const kernelRoutes = snap.routes.map((r) => ({
    dst: ipu.normalizeRouteDst(r.dst),
    gateway: r.gateway ?? null,
    dev: r.dev ?? null,
    metric: r.metric ?? 0,
    protocol: String(r.protocol ?? ''),
    managed: isManagedProto(r.protocol),
  }));
  const routes = config.routes.map((r) => {
    const live = kernelRoutes.find((k) => k.managed && k.dst === r.dst && k.metric === r.metric);
    return { ...r, active: Boolean(live) && r.enabled, error: r.enabled ? routeErrors.get(r.id) ?? null : null, dev: live?.dev ?? r.iface ?? null };
  });
  const vpnRouteKeys = new Set(desiredRoutes({ ...config, routes: [] }).map((w) => `${w.dst}|${w.metric}`));
  const systemRoutes = kernelRoutes
    .filter((k) => !k.managed || vpnRouteKeys.has(`${k.dst}|${k.metric}`))
    .map((k) => ({ ...k, source: k.managed ? 'vpn' : 'system' }));

  return {
    forwarding: readForwarding(),
    pending: pending ? { id: pending.id, expiresAt: pending.expiresAt } : null,
    management: mgmt,
    parents: physicalLinks(snap).map((link) => ({ name: link.ifname, mtu: link.mtu })),
    interfaces,
    addresses,
    vlans: config.vlans.map((v) => ({ ...v, ifname: vlanName(v), state: interfaces.find((i) => i.name === vlanName(v))?.state ?? 'off' })),
    routes,
    systemRoutes,
    vpns,
  };
}

function tcpCheck(host, port, localAddress) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const socket = net.connect({ host, port, localAddress: localAddress || undefined, timeout: 3000 });
    const done = (ok, error) => {
      socket.destroy();
      resolve({ port, ok, ms: ok ? Number(process.hrtime.bigint() - started) / 1e6 : null, error: error ?? null });
    };
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false, 'Timeout'));
    socket.once('error', (error) => done(false, error.code === 'ECONNREFUSED' ? 'Port tertutup' : error.message));
  });
}

async function runTest(body) {
  const target = String(body?.target ?? '').trim();
  const iface = String(body?.iface ?? '').trim();
  const port = body?.port ? Number(body.port) : null;
  if (!ipu.isHost(target)) throw bad('Alamat tujuan tidak valid');
  if (iface && !/^[a-zA-Z0-9._-]{1,15}$/.test(iface)) throw bad('Interface tidak valid');
  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) throw bad('Port harus 1-65535');

  let ip = target;
  if (ipu.parseIPv4(target) === null) {
    try {
      ip = (await dns.lookup(target, { family: 4 })).address;
    } catch {
      throw bad('Nama host tidak ditemukan');
    }
  }

  const routeArgs = ['-j', 'route', 'get', ip];
  if (iface) routeArgs.push('oif', iface);
  const routeResult = await sh.run('ip', routeArgs);
  let route = null;
  if (routeResult.ok) {
    const row = JSON.parse(routeResult.stdout || '[]')[0];
    if (row) route = { dev: row.dev ?? null, gateway: row.gateway ?? null, src: row.prefsrc ?? null };
  }

  const pingArgs = ['-n', '-c', '5', '-i', '0.2', '-W', '1'];
  if (iface) pingArgs.push('-I', iface);
  pingArgs.push(ip);
  const pingResult = await sh.run('ping', pingArgs, { timeout: 12000 });
  const out = pingResult.stdout;
  const counts = /(\d+) packets transmitted, (\d+) (?:packets )?received/.exec(out);
  const rtt = /= ([\d.]+)\/([\d.]+)\/([\d.]+)/.exec(out);
  const sent = counts ? Number(counts[1]) : 0;
  const received = counts ? Number(counts[2]) : 0;
  const ping = {
    sent,
    received,
    lossPct: sent ? Math.round(((sent - received) / sent) * 100) : 100,
    min: rtt ? Number(rtt[1]) : null,
    avg: rtt ? Number(rtt[2]) : null,
    max: rtt ? Number(rtt[3]) : null,
    replies: [...out.matchAll(/time=([\d.]+) ms/g)].map((m) => Number(m[1])),
    error: counts ? null : (pingResult.stderr || 'Ping gagal'),
  };

  const tcp = port ? await tcpCheck(ip, port, iface ? route?.src : null) : null;
  return { target, ip, iface: iface || null, route, routeError: routeResult.ok ? null : routeResult.stderr, ping, tcp };
}

module.exports = { HttpError, bad, snapshot, management, physicalLinks, ipv4Of, guardPath, buildState, runTest };
