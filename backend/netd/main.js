'use strict';

// Kalimasada NMS network daemon. Runs as root and is the only part of the NMS
// that changes interfaces, VLANs, IP addresses, routes and VPN tunnels.
// The API talks to it over a Unix socket that only the service group can open.

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const store = require('./lib/store');
const apply = require('./lib/apply');
const vpn = require('./lib/vpn');
const status = require('./lib/status');
const { handlers, setForwarding } = require('./lib/ops');

const SOCKET = process.env.NETD_SOCKET || '/run/kalimasada-netd/netd.sock';
const GROUP = process.env.NETD_GROUP || 'kalimasada';
const ROLLBACK_SEC = Number(process.env.NETD_ROLLBACK_SEC || 60);
const RECONCILE_MS = 20000;

let config = store.load();
let pending = null;
let pendingTimer = null;
let queue = Promise.resolve();

function log(message) {
  process.stdout.write(`${message}\n`);
}

function enqueue(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

function newReport() {
  const warnings = [];
  return { warnings, warn: (message) => warnings.push(message) };
}

async function reconcile(prev, next, options = {}) {
  const report = newReport();
  const steps = [
    ['forwarding', () => apply.applyForwarding(prev, next)],
    ['vlan', () => apply.applyVlans(next, report)],
    ['ip', () => apply.applyAddresses(prev, next, report)],
    ['vpn', () => vpn.apply(prev, next, report, options)],
    ['route', () => apply.applyRoutes(next)],
  ];
  for (const [name, step] of steps) {
    try {
      await step();
    } catch (error) {
      report.warn(`${name}: ${error.message}`);
    }
  }
  return report;
}

function clearPendingState() {
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = null;
  pending = null;
  store.clearPending();
}

function rollback(id) {
  return enqueue(async () => {
    if (!pending || pending.id !== id) return;
    const current = config;
    config = pending.previous;
    store.save(config);
    clearPendingState();
    const report = await reconcile(current, config);
    log(`Perubahan ${id} tidak dikonfirmasi, dikembalikan. ${report.warnings.join('; ')}`);
  });
}

function mutate(change) {
  return enqueue(async () => {
    if (pending) clearPendingState();
    const previous = store.clone(config);
    const next = store.clone(config);
    const snap = await status.snapshot();
    const ctx = { snap, mgmt: await status.management(snap, change.clientIp) };
    const result = change.run(next, ctx) ?? {};
    store.save(next);
    config = next;
    const report = await reconcile(previous, next);
    const id = store.newId();
    const expiresAt = Date.now() + ROLLBACK_SEC * 1000;
    pending = { id, previous, expiresAt };
    store.savePending(pending);
    pendingTimer = setTimeout(() => void rollback(id), ROLLBACK_SEC * 1000);
    log(`Diterapkan: ${result.summary ?? 'perubahan'} (${id})`);
    return { ok: true, ...result, pendingId: id, rollbackSec: ROLLBACK_SEC, warnings: report.warnings };
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 512 * 1024) {
        reject(new status.HttpError(413, 'Data terlalu besar'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new status.HttpError(400, 'JSON tidak valid'));
      }
    });
    req.on('error', reject);
  });
}

async function route(req, body) {
  const url = new URL(req.url, 'http://netd');
  const parts = url.pathname.split('/').filter(Boolean);
  const method = req.method;
  const clientIp = String(req.headers['x-client-ip'] ?? '');

  if (method === 'GET' && url.pathname === '/state') return status.buildState({ config, pending, clientIp });
  if (method === 'POST' && url.pathname === '/test') return status.runTest(body);
  if (method === 'POST' && url.pathname === '/confirm') {
    if (pending && (!body.id || pending.id === body.id)) {
      clearPendingState();
      log('Perubahan dikonfirmasi');
    }
    return { ok: true };
  }
  if (method === 'POST' && url.pathname === '/forwarding') {
    return mutate({ clientIp, run: (next) => setForwarding(next, body) });
  }
  if (method === 'POST' && parts.length === 3 && parts[0] === 'vpns' && parts[2] === 'restart') {
    const v = config.vpns.find((row) => row.id === parts[1]);
    if (!v) throw new status.HttpError(404, 'VPN tidak ditemukan');
    await vpn.restart(v);
    return { ok: true, summary: `VPN "${v.name}" (${v.iface}) di-restart` };
  }

  const kind = handlers[parts[0]];
  if (kind && parts.length === 1 && method === 'POST') {
    return mutate({ clientIp, run: (next, ctx) => kind.create(next, body, ctx) });
  }
  if (kind && parts.length === 2 && method === 'PUT') {
    return mutate({ clientIp, run: (next, ctx) => kind.update(next, parts[1], body, ctx) });
  }
  if (kind && parts.length === 2 && method === 'DELETE') {
    return mutate({ clientIp, run: (next, ctx) => kind.remove(next, parts[1], ctx) });
  }
  throw new status.HttpError(404, 'Tidak ditemukan');
}

function send(res, code, data) {
  const text = JSON.stringify(data);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function listen() {
  fs.mkdirSync(path.dirname(SOCKET), { recursive: true });
  fs.rmSync(SOCKET, { force: true });
  const server = http.createServer(async (req, res) => {
    try {
      const body = req.method === 'GET' ? {} : await readBody(req);
      send(res, 200, await route(req, body));
    } catch (error) {
      const code = error.status ?? 500;
      if (code >= 500) log(`Error: ${error.stack ?? error.message}`);
      send(res, code, { message: error.message || 'Gagal' });
    }
  });
  server.requestTimeout = 120000;
  server.listen(SOCKET, () => {
    let gid = 0;
    try {
      gid = Number(execFileSync('getent', ['group', GROUP]).toString().split(':')[2]) || 0;
    } catch {
      log(`Grup ${GROUP} tidak ditemukan, socket hanya untuk root`);
    }
    fs.chownSync(SOCKET, 0, gid);
    fs.chmodSync(SOCKET, 0o660);
    log(`kalimasada-netd siap di ${SOCKET}`);
  });
}

async function start() {
  try {
    fs.mkdirSync('/etc/iproute2/rt_protos.d', { recursive: true });
    store.writeIfChanged('/etc/iproute2/rt_protos.d/kalimasada.conf', '77\tkalimasada\n', 0o644);
  } catch {
    // Route protocol name is cosmetic; routes are matched by number too.
  }
  const unconfirmed = store.loadPending();
  if (unconfirmed?.previous) {
    log('Perubahan terakhir belum dikonfirmasi sebelum restart, dikembalikan.');
    config = { ...store.empty(), ...unconfirmed.previous };
    store.save(config);
    store.clearPending();
  }
  const report = await reconcile(null, config, { startup: true });
  if (report.warnings.length) log(`Startup: ${report.warnings.join('; ')}`);
  listen();
  let lastWarnings = '';
  setInterval(() => {
    void enqueue(async () => {
      const result = await reconcile(config, config);
      const text = result.warnings.join('; ');
      if (text && text !== lastWarnings) log(`Reconcile: ${text}`);
      lastWarnings = text;
    });
  }, RECONCILE_MS);
}

process.on('SIGTERM', () => process.exit(0));
void start();
