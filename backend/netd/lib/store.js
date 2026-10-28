'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DIR = process.env.NETD_CONFIG_DIR || '/etc/kalimasada';
const CONFIG = path.join(DIR, 'network.json');
const PENDING = path.join(DIR, 'network.pending.json');

function empty() {
  return { forwarding: false, vlans: [], addresses: [], routes: [], vpns: [] };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function load() {
  return { ...empty(), ...(readJson(CONFIG) ?? {}) };
}

function save(config) {
  writeJson(CONFIG, config);
}

function loadPending() {
  return readJson(PENDING);
}

function savePending(pending) {
  writeJson(PENDING, pending);
}

function clearPending() {
  fs.rmSync(PENDING, { force: true });
}

function newId() {
  return crypto.randomBytes(6).toString('hex');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function writeIfChanged(file, content, mode = 0o600) {
  let current = null;
  try {
    current = fs.readFileSync(file, 'utf8');
  } catch {
    current = null;
  }
  if (current === content) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content, { mode });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, mode);
  return true;
}

module.exports = { load, save, loadPending, savePending, clearPending, newId, clone, writeIfChanged, empty };
