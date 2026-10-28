'use strict';

const fs = require('node:fs');
const ipu = require('./ip');
const sh = require('./sh');

const ALIAS = 'kalimasada-nms';
const PROTO = '77';
const FORWARD_FILE = '/proc/sys/net/ipv4/ip_forward';
const routeErrors = new Map();

function vlanName(v) {
  return `${v.parent}.${v.vid}`;
}

function isManagedProto(protocol) {
  return String(protocol) === PROTO || protocol === 'kalimasada';
}

function readForwarding() {
  try {
    return fs.readFileSync(FORWARD_FILE, 'utf8').trim() === '1';
  } catch {
    return false;
  }
}

function applyForwarding(prev, next) {
  const current = readForwarding();
  if (next.forwarding && !current) fs.writeFileSync(FORWARD_FILE, '1');
  if (!next.forwarding && prev?.forwarding && current) fs.writeFileSync(FORWARD_FILE, '0');
}

async function applyVlans(next, report) {
  const links = await sh.json('ip', ['-j', '-d', 'link', 'show']);
  const byName = new Map(links.map((link) => [link.ifname, link]));
  const wanted = new Map(next.vlans.filter((v) => v.enabled).map((v) => [vlanName(v), v]));

  for (const link of links) {
    if (link.ifalias === ALIAS && link.linkinfo?.info_kind === 'vlan' && !wanted.has(link.ifname)) {
      await sh.run('ip', ['link', 'del', 'dev', link.ifname]);
    }
  }

  for (const [name, v] of wanted) {
    const link = byName.get(name);
    if (link && link.ifalias !== ALIAS) {
      report.warn(`${name} sudah dibuat di luar NMS, dilewati`);
      continue;
    }
    try {
      if (!link) {
        await sh.must('ip', ['link', 'add', 'link', v.parent, 'name', name, 'type', 'vlan', 'id', String(v.vid)]);
        await sh.must('ip', ['link', 'set', 'dev', name, 'alias', ALIAS]);
      }
      if (!link || link.mtu !== v.mtu) await sh.must('ip', ['link', 'set', 'dev', name, 'mtu', String(v.mtu)]);
      if (!link || !link.flags.includes('UP')) await sh.must('ip', ['link', 'set', 'dev', name, 'up']);
    } catch (error) {
      report.warn(`VLAN ${name}: ${error.message}`);
    }
  }
}

async function applyAddresses(prev, next, report) {
  const rows = await sh.json('ip', ['-j', '-4', 'addr', 'show']);
  const present = new Set();
  for (const row of rows) {
    for (const info of row.addr_info ?? []) present.add(`${row.ifname}|${info.local}/${info.prefixlen}`);
  }
  const exists = new Set((await sh.json('ip', ['-j', 'link', 'show'])).map((link) => link.ifname));
  const wanted = new Set(next.addresses.map((a) => `${a.iface}|${a.cidr}`));

  for (const a of prev?.addresses ?? []) {
    const key = `${a.iface}|${a.cidr}`;
    if (!wanted.has(key) && present.has(key)) await sh.run('ip', ['addr', 'del', a.cidr, 'dev', a.iface]);
  }
  for (const a of next.addresses) {
    const key = `${a.iface}|${a.cidr}`;
    if (!exists.has(a.iface) || present.has(key)) continue;
    const result = await sh.run('ip', ['addr', 'add', a.cidr, 'dev', a.iface]);
    if (!result.ok) report.warn(`IP ${a.cidr} di ${a.iface}: ${result.stderr}`);
  }
}

function desiredRoutes(config) {
  const list = config.routes
    .filter((r) => r.enabled)
    .map((r) => ({ id: r.id, dst: r.dst, gateway: r.gateway || null, iface: r.iface || null, metric: r.metric }));
  for (const v of config.vpns) {
    if (!v.enabled) continue;
    for (const dst of v.networks ?? []) list.push({ id: `vpn:${v.id}:${dst}`, dst, gateway: null, iface: v.iface, metric: 10 });
  }
  return list;
}

function routeError(stderr) {
  if (/invalid gateway|unreachable/i.test(stderr)) return 'Gateway tidak terjangkau';
  if (/Cannot find device/i.test(stderr)) return 'Interface belum ada';
  if (/Network is down/i.test(stderr)) return 'Interface mati';
  return stderr || 'Gagal dipasang';
}

async function applyRoutes(config) {
  const kernel = (await sh.json('ip', ['-j', '-4', 'route', 'show', 'table', 'main'])).map((r) => ({
    dst: ipu.normalizeRouteDst(r.dst),
    metric: r.metric ?? 0,
    gateway: r.gateway ?? null,
    dev: r.dev ?? null,
    managed: isManagedProto(r.protocol),
  }));
  const linkNames = new Set((await sh.json('ip', ['-j', 'link', 'show'])).map((link) => link.ifname));
  const wanted = desiredRoutes(config);
  const wantedKeys = new Set(wanted.map((w) => `${w.dst}|${w.metric}`));

  for (const k of kernel) {
    if (k.managed && !wantedKeys.has(`${k.dst}|${k.metric}`)) {
      await sh.run('ip', ['route', 'del', k.dst, 'metric', String(k.metric), 'proto', PROTO]);
    }
  }

  routeErrors.clear();
  for (const w of wanted) {
    const current = kernel.find((k) => k.dst === w.dst && k.metric === w.metric);
    if (current && !current.managed) {
      routeErrors.set(w.id, 'Bentrok dengan rute sistem');
      continue;
    }
    if (current && current.gateway === w.gateway && (!w.iface || w.iface === current.dev)) continue;
    if (w.iface && !linkNames.has(w.iface)) {
      routeErrors.set(w.id, `Menunggu ${w.iface}`);
      continue;
    }
    const args = ['route', 'replace', w.dst];
    if (w.gateway) args.push('via', w.gateway);
    if (w.iface) args.push('dev', w.iface);
    args.push('metric', String(w.metric), 'proto', PROTO);
    const result = await sh.run('ip', args);
    if (!result.ok) routeErrors.set(w.id, routeError(result.stderr));
  }
}

module.exports = {
  ALIAS,
  vlanName,
  isManagedProto,
  readForwarding,
  applyForwarding,
  applyVlans,
  applyAddresses,
  applyRoutes,
  desiredRoutes,
  routeErrors,
};
