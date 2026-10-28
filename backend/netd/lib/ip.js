'use strict';

function parseIPv4(text) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(text ?? '').trim());
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => part > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function formatIPv4(value) {
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
}

function maskOf(prefix) {
  return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}

function parseCidr(text) {
  const parts = String(text ?? '').trim().split('/');
  if (parts.length > 2) return null;
  const ip = parseIPv4(parts[0]);
  const prefixText = parts[1] ?? '32';
  if (ip === null || !/^\d{1,2}$/.test(prefixText)) return null;
  const prefix = Number(prefixText);
  if (prefix > 32) return null;
  const mask = maskOf(prefix);
  const network = (ip & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  return {
    ip,
    prefix,
    network,
    broadcast,
    text: `${formatIPv4(ip)}/${prefix}`,
    networkText: `${formatIPv4(network)}/${prefix}`,
  };
}

function contains(net, ip) {
  return ((ip & maskOf(net.prefix)) >>> 0) === net.network;
}

function overlaps(a, b) {
  const mask = maskOf(Math.min(a.prefix, b.prefix));
  return ((a.network & mask) >>> 0) === ((b.network & mask) >>> 0);
}

function isHostAddress(net) {
  if (net.prefix >= 31) return true;
  return net.ip !== net.network && net.ip !== net.broadcast;
}

function otherHost(net) {
  if (net.prefix >= 32) return null;
  if (net.prefix === 31) return formatIPv4(net.ip === net.network ? net.broadcast : net.network);
  const first = net.network + 1;
  return formatIPv4(net.ip === first ? first + 1 : first);
}

const HOSTNAME = /^(?=.{1,253}$)[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

function isHost(text) {
  const value = String(text ?? '').trim();
  return parseIPv4(value) !== null || HOSTNAME.test(value);
}

function normalizeRouteDst(text) {
  if (text === 'default') return '0.0.0.0/0';
  return String(text).includes('/') ? String(text) : `${text}/32`;
}

module.exports = { parseIPv4, formatIPv4, parseCidr, contains, overlaps, isHostAddress, otherHost, isHost, normalizeRouteDst };
