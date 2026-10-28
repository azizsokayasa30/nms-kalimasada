'use strict';

const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const fs = require('node:fs');
const path = require('node:path');
const ipu = require('./ip');
const sh = require('./sh');
const { writeIfChanged } = require('./store');

const MARK = '# Dikelola Kalimasada NMS. Perubahan manual akan ditimpa.';
const XL2TPD_MARK = `;${MARK.slice(1)}`;
const WG_DIR = '/etc/wireguard';
const OVPN_DIR = '/etc/openvpn/client';
const IPSEC_DIR = '/etc/ipsec.d/kalimasada';
const PPP_DIR = '/etc/ppp';
const XL2TPD_CONF = '/etc/xl2tpd/xl2tpd.conf';
const IFACE_PREFIX = { wireguard: 'wg', openvpn: 'ovpn', l2tp: 'l2tp' };
const RESTART_GAP_MS = 60000;

// Directives that run scripts, change the default route, or move files around as root.
const OVPN_BLOCKED = new Set([
  'dev', 'dev-type', 'dev-node', 'up', 'down', 'down-pre', 'up-restart', 'script-security', 'route-up',
  'route-pre-down', 'ipchange', 'tls-verify', 'auth-user-pass-verify', 'client-connect', 'client-disconnect',
  'learn-address', 'plugin', 'redirect-gateway', 'auth-user-pass', 'log', 'log-append', 'daemon', 'writepid',
  'cd', 'chroot', 'management', 'status', 'config', 'iproute', 'tmp-dir', 'route-nopull', 'persist-tun',
]);

const lastRestart = new Map();
const resolved = new Map();
const logCache = new Map();

function wgKeypair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
  return {
    privateKey: Buffer.from(privateKey.export({ format: 'jwk' }).d, 'base64url').toString('base64'),
    publicKey: Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64'),
  };
}

function nextIface(vpns, type) {
  const prefix = IFACE_PREFIX[type];
  const used = new Set(vpns.map((v) => v.iface));
  for (let n = 1; ; n += 1) if (!used.has(`${prefix}${n}`)) return `${prefix}${n}`;
}

function unitsOf(v) {
  if (v.type === 'wireguard') return [`wg-quick@${v.iface}`];
  if (v.type === 'openvpn') return [`openvpn-client@${v.iface}`];
  return ['xl2tpd', 'strongswan-starter'];
}

function parseOvpn(text) {
  const out = [];
  let block = null;
  let devType = 'tun';
  let cipher = null;
  let hasDataCiphers = false;
  let needsAuth = false;
  let remote = null;
  for (const raw of String(text ?? '').replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    if (block) {
      out.push(raw);
      if (line.toLowerCase() === `</${block}>`) block = null;
      continue;
    }
    const open = /^<([a-z0-9-]+)>$/i.exec(line);
    if (open) {
      block = open[1].toLowerCase();
      out.push(line);
      continue;
    }
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const [first, ...rest] = line.split(/\s+/);
    const key = first.toLowerCase().replace(/^--/, '');
    if (key === 'dev' && /^tap/.test(rest[0] ?? '')) devType = 'tap';
    if (key === 'dev-type') devType = rest[0] === 'tap' ? 'tap' : 'tun';
    if (key === 'auth-user-pass') needsAuth = true;
    if (key === 'remote' && !remote) remote = rest[1] ? `${rest[0]}:${rest[1]}` : rest[0] ?? null;
    if (key === 'cipher') cipher = rest[0] ?? null;
    if (key === 'data-ciphers' || key === 'ncp-ciphers') hasDataCiphers = true;
    if (OVPN_BLOCKED.has(key)) continue;
    out.push(line);
  }
  return { body: out.join('\n'), devType, cipher, hasDataCiphers, needsAuth, remote, unclosed: block };
}

function wgConf(v) {
  const net = ipu.parseCidr(v.address);
  const allowed = [...new Set([net.networkText, ...(v.networks ?? [])])];
  const lines = [MARK, '[Interface]', `PrivateKey = ${v.privateKey}`, `Address = ${v.address}`, 'Table = off'];
  if (v.listenPort) lines.push(`ListenPort = ${v.listenPort}`);
  if (v.mtu) lines.push(`MTU = ${v.mtu}`);
  lines.push('', '[Peer]', `PublicKey = ${v.peerPublicKey}`);
  if (v.presharedKey) lines.push(`PresharedKey = ${v.presharedKey}`);
  if (v.endpoint) lines.push(`Endpoint = ${v.endpoint}`);
  lines.push(`AllowedIPs = ${allowed.join(', ')}`);
  if (v.keepalive) lines.push(`PersistentKeepalive = ${v.keepalive}`);
  return `${lines.join('\n')}\n`;
}

function ovpnConf(v) {
  const parsed = parseOvpn(v.config);
  const lines = [
    MARK,
    parsed.body,
    '',
    `dev ${v.iface}`,
    `dev-type ${parsed.devType}`,
    'route-nopull',
    'pull-filter ignore "redirect-gateway"',
    'resolv-retry infinite',
    'connect-retry 5 30',
    'verb 3',
  ];
  if (!/^ping(-restart)?\s/m.test(parsed.body)) lines.push('ping 10', 'ping-restart 60');
  if (parsed.cipher && !parsed.hasDataCiphers) {
    lines.push(`data-ciphers AES-256-GCM:AES-128-GCM:CHACHA20-POLY1305:${parsed.cipher}`, `data-ciphers-fallback ${parsed.cipher}`);
  }
  if (v.username) lines.push(`auth-user-pass ${OVPN_DIR}/${v.iface}.auth`, 'auth-nocache');
  return `${lines.join('\n')}\n`;
}

function ipsecConf(v, serverIp) {
  return [
    MARK,
    `conn km-${v.iface}`,
    '  keyexchange=ikev1',
    '  authby=secret',
    '  type=transport',
    '  left=%defaultroute',
    '  leftprotoport=17/1701',
    `  right=${serverIp}`,
    '  rightprotoport=17/1701',
    '  ike=aes256-sha1-modp2048,aes128-sha1-modp2048,aes256-sha1-modp1024,aes128-sha1-modp1024,3des-sha1-modp1024!',
    '  esp=aes256-sha1-modp1024,aes128-sha1-modp1024,aes256-sha1,aes128-sha1,3des-sha1!',
    '  dpdaction=restart',
    '  dpddelay=30s',
    '  dpdtimeout=120s',
    '  keyingtries=%forever',
    '  auto=start',
    '',
  ].join('\n');
}

function pppOptions(v) {
  return [
    MARK,
    'ipcp-accept-local',
    'ipcp-accept-remote',
    'noipdefault',
    'refuse-eap',
    'noccp',
    'noauth',
    'nodefaultroute',
    `mtu ${v.mtu}`,
    `mru ${v.mtu}`,
    'lcp-echo-interval 20',
    'lcp-echo-failure 4',
    `ifname ${v.iface}`,
    `name "${v.username}"`,
    `password "${v.password}"`,
    '',
  ].join('\n');
}

function xl2tpdConf(list) {
  const lines = [XL2TPD_MARK, '[global]', 'access control = yes', ''];
  for (const v of list) {
    lines.push(
      `[lac ${v.iface}]`,
      `lns = ${v.serverIp}`,
      `pppoptfile = ${PPP_DIR}/options.km-${v.iface}`,
      'length bit = yes',
      'autodial = yes',
      'redial = yes',
      'redial timeout = 15',
      '',
    );
  }
  return `${lines.join('\n')}\n`;
}

function removeFile(file) {
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file, { force: true });
  return true;
}

function managedFile(file) {
  try {
    const head = fs.readFileSync(file, 'utf8');
    return head.startsWith(MARK) || head.startsWith(XL2TPD_MARK);
  } catch {
    return false;
  }
}

async function unitState(unit) {
  const result = await sh.run('systemctl', ['is-active', unit]);
  return result.stdout.trim() || 'unknown';
}

async function unitEnabled(unit) {
  const result = await sh.run('systemctl', ['is-enabled', unit]);
  return result.stdout.trim() === 'enabled';
}

async function stopUnit(unit) {
  const state = await unitState(unit);
  if (state === 'active' || state === 'activating' || state === 'failed' || (await unitEnabled(unit))) {
    await sh.run('systemctl', ['disable', unit]);
    await sh.run('systemctl', ['stop', unit]);
    await sh.run('systemctl', ['reset-failed', unit]);
  }
}

async function startUnit(unit, changed, report) {
  const state = await unitState(unit);
  const running = state === 'active' || state === 'activating' || state === 'reloading';
  if (!changed && running) return;
  const now = Date.now();
  if (!changed && now - (lastRestart.get(unit) ?? 0) < RESTART_GAP_MS) return;
  lastRestart.set(unit, now);
  await sh.run('systemctl', ['enable', unit]);
  const result = await sh.run('systemctl', ['restart', '--no-block', unit]);
  if (!result.ok) report.warn(`${unit} gagal dijalankan: ${result.stderr}`);
}

async function resolveServer(host, report) {
  if (ipu.parseIPv4(host) !== null) return host;
  try {
    const { address } = await dns.lookup(host, { family: 4 });
    resolved.set(host, address);
    return address;
  } catch {
    const cached = resolved.get(host);
    if (!cached) report.warn(`Server ${host} tidak bisa di-resolve`);
    return cached ?? null;
  }
}

function ensureIncludeLine(file, line) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    text = '';
  }
  if (text.split('\n').some((row) => row.trim() === line)) return false;
  fs.writeFileSync(file, `${text.replace(/\n*$/, '\n')}${line}\n`, { mode: file.endsWith('secrets') ? 0o600 : 0o644 });
  return true;
}

async function teardown(v) {
  if (v.type === 'wireguard') {
    await stopUnit(`wg-quick@${v.iface}`);
    removeFile(`${WG_DIR}/${v.iface}.conf`);
  } else if (v.type === 'openvpn') {
    await stopUnit(`openvpn-client@${v.iface}`);
    removeFile(`${OVPN_DIR}/${v.iface}.conf`);
    removeFile(`${OVPN_DIR}/${v.iface}.auth`);
  } else {
    removeFile(`${IPSEC_DIR}/${v.iface}.conf`);
    removeFile(`${IPSEC_DIR}/${v.iface}.secrets`);
    removeFile(`${PPP_DIR}/options.km-${v.iface}`);
  }
}

async function removeOrphans(config) {
  const keep = new Set(config.vpns.map((v) => v.iface));
  const scan = (dir, pattern) => {
    try {
      return fs.readdirSync(dir).map((name) => ({ name, match: pattern.exec(name) })).filter((row) => row.match);
    } catch {
      return [];
    }
  };
  for (const { name, match } of scan(WG_DIR, /^(wg\d+)\.conf$/)) {
    if (keep.has(match[1]) || !managedFile(path.join(WG_DIR, name))) continue;
    await teardown({ type: 'wireguard', iface: match[1] });
  }
  for (const { name, match } of scan(OVPN_DIR, /^(ovpn\d+)\.conf$/)) {
    if (keep.has(match[1]) || !managedFile(path.join(OVPN_DIR, name))) continue;
    await teardown({ type: 'openvpn', iface: match[1] });
  }
  for (const { match } of scan(IPSEC_DIR, /^(l2tp\d+)\.(conf|secrets)$/)) {
    if (!keep.has(match[1])) await teardown({ type: 'l2tp', iface: match[1] });
  }
  for (const { match } of scan(PPP_DIR, /^options\.km-(l2tp\d+)$/)) {
    if (!keep.has(match[1])) await teardown({ type: 'l2tp', iface: match[1] });
  }
}

async function ensureSimple(v, report) {
  const unit = unitsOf(v)[0];
  let changed;
  if (v.type === 'wireguard') {
    changed = writeIfChanged(`${WG_DIR}/${v.iface}.conf`, wgConf(v));
  } else {
    changed = writeIfChanged(`${OVPN_DIR}/${v.iface}.conf`, ovpnConf(v));
    const authFile = `${OVPN_DIR}/${v.iface}.auth`;
    if (v.username) changed = writeIfChanged(authFile, `${v.username}\n${v.password ?? ''}\n`) || changed;
    else changed = removeFile(authFile) || changed;
  }
  if (!v.enabled) {
    await stopUnit(unit);
    return;
  }
  await startUnit(unit, changed, report);
}

async function ensureL2tp(list, report) {
  const enabled = [];
  let ipsecChanged = false;
  let pppChanged = false;
  for (const v of list) {
    const serverIp = v.enabled ? await resolveServer(v.server, report) : null;
    const confFile = `${IPSEC_DIR}/${v.iface}.conf`;
    const secretFile = `${IPSEC_DIR}/${v.iface}.secrets`;
    if (v.enabled && v.psk && serverIp) {
      ipsecChanged = writeIfChanged(confFile, ipsecConf(v, serverIp), 0o644) || ipsecChanged;
      ipsecChanged = writeIfChanged(secretFile, `${MARK}\n%any ${serverIp} : PSK "${v.psk}"\n`) || ipsecChanged;
    } else if (!v.enabled || !v.psk) {
      ipsecChanged = removeFile(confFile) || ipsecChanged;
      ipsecChanged = removeFile(secretFile) || ipsecChanged;
    }
    pppChanged = writeIfChanged(`${PPP_DIR}/options.km-${v.iface}`, pppOptions(v)) || pppChanged;
    if (v.enabled && serverIp) enabled.push({ ...v, serverIp });
  }
  const xlChanged = (list.length > 0 || managedFile(XL2TPD_CONF))
    ? writeIfChanged(XL2TPD_CONF, xl2tpdConf(enabled), 0o644)
    : false;

  if (enabled.some((v) => v.psk)) {
    fs.mkdirSync(IPSEC_DIR, { recursive: true, mode: 0o700 });
    ipsecChanged = ensureIncludeLine('/etc/ipsec.conf', `include ${IPSEC_DIR}/*.conf`) || ipsecChanged;
    ipsecChanged = ensureIncludeLine('/etc/ipsec.secrets', `include ${IPSEC_DIR}/*.secrets`) || ipsecChanged;
    await startUnit('strongswan-starter', ipsecChanged, report);
  } else {
    await stopUnit('strongswan-starter');
  }

  if (enabled.length) await startUnit('xl2tpd', xlChanged || pppChanged, report);
  else await stopUnit('xl2tpd');
}

async function apply(prev, next, report, { startup = false } = {}) {
  const keep = new Set(next.vpns.map((v) => `${v.type}:${v.iface}`));
  if (prev) {
    for (const v of prev.vpns) if (!keep.has(`${v.type}:${v.iface}`)) await teardown(v);
  }
  if (startup) await removeOrphans(next);
  for (const v of next.vpns) {
    if (v.type === 'l2tp') continue;
    try {
      await ensureSimple(v, report);
    } catch (error) {
      report.warn(`${v.name}: ${error.message}`);
    }
  }
  try {
    await ensureL2tp(next.vpns.filter((v) => v.type === 'l2tp'), report);
  } catch (error) {
    report.warn(`L2TP: ${error.message}`);
  }
}

async function restart(v) {
  for (const unit of unitsOf(v)) {
    if (unit === 'strongswan-starter' && !v.psk) continue;
    lastRestart.set(unit, Date.now());
    await sh.run('systemctl', ['restart', '--no-block', unit]);
  }
}

async function cachedLog(units) {
  const key = units.join(',');
  const hit = logCache.get(key);
  if (hit && Date.now() - hit.at < 5000) return hit.text;
  const text = await sh.unitLog(units);
  logCache.set(key, { at: Date.now(), text });
  return text;
}

function ago(seconds) {
  if (seconds < 60) return `${seconds} dtk`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} mnt`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} jam`;
  return `${Math.floor(seconds / 86400)} hari`;
}

async function wgPeer(iface) {
  const result = await sh.run('wg', ['show', iface, 'dump']);
  const peer = result.stdout.trim().split('\n')[1];
  if (!peer) return null;
  const [, , endpoint, , handshake, rx, tx] = peer.split('\t');
  return {
    endpoint: endpoint === '(none)' ? null : endpoint,
    handshake: Number(handshake) || 0,
    rx: Number(rx) || 0,
    tx: Number(tx) || 0,
  };
}

async function status(v, link) {
  if (!v.enabled) return { state: 'off', text: 'Nonaktif' };
  const hasIp = Boolean(link?.ipv4?.length);
  if (v.type === 'wireguard') {
    const unit = `wg-quick@${v.iface}`;
    const state = await unitState(unit);
    if (state !== 'active') return { state: 'down', text: (await cachedLog([unit])) || 'Tidak berjalan' };
    const peer = await wgPeer(v.iface);
    if (!peer?.handshake) return { state: 'wait', text: 'Menunggu handshake', endpoint: peer?.endpoint ?? null };
    const age = Math.max(0, Math.floor(Date.now() / 1000) - peer.handshake);
    return {
      state: age < 180 ? 'up' : 'wait',
      text: `Handshake ${ago(age)} lalu`,
      endpoint: peer.endpoint,
      handshakeAgoSec: age,
    };
  }
  if (v.type === 'openvpn') {
    const unit = `openvpn-client@${v.iface}`;
    const state = await unitState(unit);
    if (state !== 'active' && state !== 'activating') return { state: 'down', text: (await cachedLog([unit])) || 'Tidak berjalan' };
    if (hasIp) return { state: 'up', text: 'Terhubung' };
    return { state: 'wait', text: (await cachedLog([unit])) || 'Menghubungkan' };
  }
  const xl = await unitState('xl2tpd');
  if (xl !== 'active') return { state: 'down', text: (await cachedLog(['xl2tpd'])) || 'xl2tpd tidak berjalan' };
  if (hasIp) return { state: 'up', text: 'Terhubung' };
  if (v.psk) {
    const ipsec = await sh.run('ipsec', ['status', `km-${v.iface}`]);
    if (!/ESTABLISHED/.test(ipsec.stdout)) return { state: 'wait', text: (await cachedLog(['strongswan-starter'])) || 'Menunggu IPsec' };
  }
  return { state: 'wait', text: (await cachedLog(['xl2tpd'])) || 'Menghubungkan' };
}

module.exports = { apply, restart, status, wgKeypair, nextIface, parseOvpn, IFACE_PREFIX };
