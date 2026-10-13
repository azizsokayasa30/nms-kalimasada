import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { createSocket } from 'dgram';
import { Socket, connect as connectTcp } from 'net';

export type ProbeMethod = 'icmp' | 'snmp' | 'mikrotik_api';

export type ProbeResult = {
  method: ProbeMethod;
  ok: boolean;
  message: string;
  latencyMs: number | null;
};

export type ProbeTarget = {
  ipAddress: string;
  monitorMethod: 'icmp' | 'snmp' | 'mikrotik_api' | 'combination';
  snmpCommunity: string | null;
  snmpSecretBroken: boolean;
  snmpVersion: string;
  snmpPort: number;
  rosUsername: string | null;
  rosPassword: string | null;
  rosSecretBroken: boolean;
  rosPort: number;
};

const ipv4 = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

export async function runDeviceProbe(target: ProbeTarget): Promise<ProbeResult[]> {
  if (!ipv4.test(target.ipAddress)) {
    return [{ method: 'icmp', ok: false, message: 'Alamat IP tidak valid', latencyMs: null }];
  }
  const jobs: Array<Promise<ProbeResult>> = [];
  const method = target.monitorMethod;
  if (method === 'icmp' || method === 'combination') jobs.push(probeIcmp(target.ipAddress));
  if (method === 'snmp' || method === 'combination') jobs.push(probeSnmp(target));
  if (method === 'mikrotik_api' || method === 'combination') jobs.push(probeApi(target));
  if (!jobs.length) return [{ method: 'icmp', ok: false, message: 'Mode koneksi tidak dikenali', latencyMs: null }];
  return Promise.all(jobs);
}

function probeIcmp(ip: string): Promise<ProbeResult> {
  const args = process.platform === 'win32' ? ['-n', '1', '-w', '2000', ip] : ['-c', '1', '-W', '2', ip];
  const started = Date.now();
  return new Promise((resolve) => {
    execFile('ping', args, { timeout: 6000, windowsHide: true }, (error, stdout, stderr) => {
      const output = `${stdout ?? ''}\n${stderr ?? ''}`;
      const latencyMs = readPingLatency(output) ?? (error ? null : Date.now() - started);
      if (!error) {
        resolve({ method: 'icmp', ok: true, message: 'ICMP OK', latencyMs });
        return;
      }
      resolve({ method: 'icmp', ok: false, message: 'ICMP tidak menjawab', latencyMs });
    });
  });
}

function readPingLatency(output: string) {
  const match = output.match(/(?:time|waktu)\s*[=<]\s*(\d+)/i);
  if (!match) return null;
  return Number(match[1]);
}

function probeSnmp(target: ProbeTarget): Promise<ProbeResult> {
  if (target.snmpSecretBroken) {
    return Promise.resolve({ method: 'snmp', ok: false, message: 'Rahasia SNMP tidak bisa dibaca', latencyMs: null });
  }
  if (!target.snmpCommunity) {
    return Promise.resolve({ method: 'snmp', ok: false, message: 'Community SNMP belum diisi', latencyMs: null });
  }
  if (target.snmpVersion === '3') {
    return Promise.resolve({ method: 'snmp', ok: false, message: 'Uji SNMP v3 belum didukung', latencyMs: null });
  }
  const port = target.snmpPort >= 1 && target.snmpPort <= 65535 ? target.snmpPort : 161;
  const packet = snmpGetPacket(target.snmpCommunity);
  const started = Date.now();
  return new Promise((resolve) => {
    const socket = createSocket('udp4');
    let settled = false;
    const finish = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({ method: 'snmp', ok: false, message: 'SNMP tidak menjawab', latencyMs: Date.now() - started });
    }, 3000);
    socket.once('error', () => {
      finish({ method: 'snmp', ok: false, message: 'SNMP tidak terjangkau', latencyMs: Date.now() - started });
    });
    socket.once('message', (msg) => {
      const ok = snmpResponseOk(msg);
      finish({
        method: 'snmp',
        ok,
        message: ok ? 'SNMP OK' : 'SNMP menolak permintaan',
        latencyMs: Date.now() - started,
      });
    });
    socket.send(packet, port, target.ipAddress);
  });
}

function snmpGetPacket(community: string) {
  const varbind = sequence(Buffer.concat([
    oid([1, 3, 6, 1, 2, 1, 1, 3, 0]),
    Buffer.from([0x05, 0x00]),
  ]));
  const pdu = tlv(0xa0, Buffer.concat([
    integer(Date.now() & 0x7fffffff),
    integer(0),
    integer(0),
    sequence(varbind),
  ]));
  return sequence(Buffer.concat([
    integer(1),
    tlv(0x04, Buffer.from(community, 'utf8')),
    pdu,
  ]));
}

function snmpResponseOk(packet: Buffer) {
  try {
    const message = readBer(packet, 0);
    if (message.tag !== 0x30) return false;
    let offset = 0;
    offset = readBer(message.value, offset).next;
    offset = readBer(message.value, offset).next;
    const pdu = readBer(message.value, offset);
    if (pdu.tag !== 0xa2) return false;
    let inner = 0;
    inner = readBer(pdu.value, inner).next;
    const errorStatus = readBer(pdu.value, inner);
    if (readInteger(errorStatus.value) !== 0) return false;
    inner = errorStatus.next;
    inner = readBer(pdu.value, inner).next;
    const varbinds = readBer(pdu.value, inner);
    const binding = readBer(varbinds.value, 0);
    const name = readBer(binding.value, 0);
    const value = readBer(binding.value, name.next);
    return value.tag !== 0x80 && value.tag !== 0x81 && value.tag !== 0x82;
  } catch {
    return false;
  }
}

function probeApi(target: ProbeTarget): Promise<ProbeResult> {
  if (target.rosSecretBroken) {
    return Promise.resolve({ method: 'mikrotik_api', ok: false, message: 'Rahasia API tidak bisa dibaca', latencyMs: null });
  }
  if (!target.rosUsername || !target.rosPassword) {
    return Promise.resolve({ method: 'mikrotik_api', ok: false, message: 'Username atau password API belum diisi', latencyMs: null });
  }
  const port = target.rosPort >= 1 && target.rosPort <= 65535 ? target.rosPort : 8728;
  const started = Date.now();
  return new Promise((resolve) => {
    const socket = connectTcp({ host: target.ipAddress, port });
    const reader = new ApiReader();
    let settled = false;
    const finish = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({ method: 'mikrotik_api', ok: false, message: 'API tidak menjawab', latencyMs: Date.now() - started });
    }, 5000);
    socket.setTimeout(5000);
    socket.on('timeout', () => finish({ method: 'mikrotik_api', ok: false, message: 'API tidak menjawab', latencyMs: Date.now() - started }));
    socket.on('error', () => finish({ method: 'mikrotik_api', ok: false, message: 'API tidak terjangkau', latencyMs: Date.now() - started }));
    socket.on('data', (chunk) => reader.push(chunk));
    socket.on('connect', () => {
      void loginApi(socket, reader, target.rosUsername!, target.rosPassword!)
        .then(async () => {
          const identity = await readIdentity(socket, reader);
          const latencyMs = Date.now() - started;
          finish({
            method: 'mikrotik_api',
            ok: true,
            message: identity ? `API OK · ${identity}` : 'API OK',
            latencyMs,
          });
        })
        .catch((error: Error) => {
          finish({
            method: 'mikrotik_api',
            ok: false,
            message: error.message || 'API ditolak',
            latencyMs: Date.now() - started,
          });
        });
    });
  });
}

async function loginApi(socket: Socket, reader: ApiReader, username: string, password: string) {
  const modern = await talk(socket, reader, ['/login', `=name=${username}`, `=password=${password}`]);
  const inlineChallenge = wordValue(modern.words, '=ret=');
  if (!modern.trap && !inlineChallenge) return;
  const challenge = inlineChallenge && !modern.trap ? modern : await talk(socket, reader, ['/login']);
  const ret = wordValue(challenge.words, '=ret=');
  if (!ret) throw new Error(trapMessage(modern.trap ? modern.words : challenge.words));
  const digest = createHash('md5')
    .update(Buffer.concat([Buffer.from([0]), Buffer.from(password), Buffer.from(ret, 'hex')]))
    .digest('hex');
  const legacy = await talk(socket, reader, ['/login', `=name=${username}`, `=response=00${digest}`]);
  if (legacy.trap) throw new Error(trapMessage(legacy.words));
}

async function readIdentity(socket: Socket, reader: ApiReader) {
  const reply = await talk(socket, reader, ['/system/identity/print']);
  if (reply.trap) return null;
  return wordValue(reply.words, '=name=');
}

function talk(socket: Socket, reader: ApiReader, words: string[]) {
  socket.write(encodeSentence(words));
  return reader.done();
}

function trapMessage(words: string[]) {
  return wordValue(words, '=message=') ?? 'API ditolak';
}

function wordValue(words: string[], prefix: string) {
  const found = words.find((word) => word.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

class ApiReader {
  private buffer = Buffer.alloc(0);
  private queue: string[][] = [];
  private waiter: (() => void) | null = null;

  push(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.drain();
  }

  done() {
    return new Promise<{ trap: boolean; words: string[] }>((resolve, reject) => {
      const words: string[] = [];
      const take = () => {
        const sentence = this.queue.shift();
        if (!sentence) {
          this.waiter = take;
          return;
        }
        const head = sentence[0] ?? '';
        if (head === '!trap' || head === '!fatal') {
          resolve({ trap: true, words: [...words, ...sentence] });
          return;
        }
        if (head === '!done') {
          resolve({ trap: false, words: [...words, ...sentence] });
          return;
        }
        words.push(...sentence);
        take();
      };
      take();
      setTimeout(() => reject(new Error('API tidak menjawab')), 5000);
    });
  }

  private drain() {
    const sentence = this.readSentence();
    if (!sentence) return;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      this.queue.push(sentence);
      waiter();
    } else {
      this.queue.push(sentence);
    }
    this.drain();
  }

  private readSentence() {
    const words: string[] = [];
    let offset = 0;
    while (true) {
      const parsed = readLength(this.buffer, offset);
      if (!parsed) return null;
      if (parsed.length === 0) {
        this.buffer = this.buffer.subarray(offset + parsed.size);
        return words;
      }
      const start = offset + parsed.size;
      const end = start + parsed.length;
      if (this.buffer.length < end) return null;
      words.push(this.buffer.subarray(start, end).toString('utf8'));
      offset = end;
    }
  }
}

function encodeSentence(words: string[]) {
  return Buffer.concat([...words.map(encodeWord), Buffer.from([0])]);
}

function encodeWord(word: string) {
  const data = Buffer.from(word, 'utf8');
  return Buffer.concat([encodeLength(data.length), data]);
}

function encodeLength(length: number) {
  if (length < 0x80) return Buffer.from([length]);
  if (length < 0x4000) return Buffer.from([(length >> 8) | 0x80, length & 0xff]);
  if (length < 0x200000) return Buffer.from([(length >> 16) | 0xc0, (length >> 8) & 0xff, length & 0xff]);
  if (length < 0x10000000) {
    return Buffer.from([(length >> 24) | 0xe0, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff]);
  }
  return Buffer.from([0xf0, (length >> 24) & 0xff, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff]);
}

function readLength(buffer: Buffer, offset: number) {
  if (offset >= buffer.length) return null;
  const first = buffer[offset];
  if ((first & 0x80) === 0) return { length: first, size: 1 };
  if ((first & 0xc0) === 0x80) {
    if (buffer.length < offset + 2) return null;
    return { length: ((first & 0x3f) << 8) | buffer[offset + 1], size: 2 };
  }
  if ((first & 0xe0) === 0xc0) {
    if (buffer.length < offset + 3) return null;
    return { length: ((first & 0x1f) << 16) | (buffer[offset + 1] << 8) | buffer[offset + 2], size: 3 };
  }
  if ((first & 0xf0) === 0xe0) {
    if (buffer.length < offset + 4) return null;
    return {
      length: ((first & 0x0f) << 24) | (buffer[offset + 1] << 16) | (buffer[offset + 2] << 8) | buffer[offset + 3],
      size: 4,
    };
  }
  if (first === 0xf0) {
    if (buffer.length < offset + 5) return null;
    return { length: buffer.readUInt32BE(offset + 1), size: 5 };
  }
  return null;
}

function sequence(value: Buffer) {
  return tlv(0x30, value);
}

function integer(value: number) {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32BE(value);
  return tlv(0x02, buffer);
}

function oid(parts: number[]) {
  const bytes = [parts[0] * 40 + parts[1]];
  for (const part of parts.slice(2)) {
    if (part < 128) {
      bytes.push(part);
      continue;
    }
    const chunk: number[] = [part & 0x7f];
    let value = part >> 7;
    while (value > 0) {
      chunk.push((value & 0x7f) | 0x80);
      value >>= 7;
    }
    bytes.push(...chunk.reverse());
  }
  return tlv(0x06, Buffer.from(bytes));
}

function tlv(tag: number, value: Buffer) {
  return Buffer.concat([Buffer.from([tag]), berLength(value.length), value]);
}

function berLength(length: number) {
  if (length < 128) return Buffer.from([length]);
  if (length < 256) return Buffer.from([0x81, length]);
  return Buffer.from([0x82, (length >> 8) & 0xff, length & 0xff]);
}

function readBer(buffer: Buffer, offset: number) {
  if (offset + 1 >= buffer.length) throw new Error('pendek');
  const tag = buffer[offset];
  let length = buffer[offset + 1];
  let cursor = offset + 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    if (!count || count > 3 || cursor + count > buffer.length) throw new Error('pendek');
    length = 0;
    for (let index = 0; index < count; index += 1) length = (length << 8) | buffer[cursor + index];
    cursor += count;
  }
  const end = cursor + length;
  if (end > buffer.length) throw new Error('pendek');
  return { tag, value: buffer.subarray(cursor, end), next: end };
}

function readInteger(value: Buffer) {
  let number = 0;
  for (const byte of value) number = (number << 8) | byte;
  const bits = value.length * 8;
  if (bits < 32 && value.length && value[0] & 0x80) number -= 1 << bits;
  return number;
}
