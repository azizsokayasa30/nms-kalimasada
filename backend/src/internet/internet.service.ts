import { BadRequestException, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { execFile } from 'child_process';
import { PrismaService } from '../infra/prisma.service';

const INTERVAL_MS = 30_000;
const HISTORY = 30;
const MAX_TARGETS = 12;
const SETTING_KEY = 'internet_targets';

export type InternetTarget = { name: string; host: string };

const DEFAULT_TARGETS: InternetTarget[] = [
  { name: 'Google', host: 'google.com' },
  { name: 'YouTube', host: 'youtube.com' },
  { name: 'Facebook', host: 'facebook.com' },
  { name: 'Instagram', host: 'instagram.com' },
  { name: 'WhatsApp', host: 'whatsapp.com' },
  { name: 'TikTok', host: 'tiktok.com' },
  { name: 'Netflix', host: 'netflix.com' },
  { name: 'Cloudflare DNS', host: '1.1.1.1' },
];

const hostPattern = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

type PingResult = { latencyMs: number | null; loss: number | null };
type TargetState = PingResult & { history: Array<number | null> };

@Injectable()
export class InternetService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running = false;
  private checkedAt: Date | null = null;
  private targets: InternetTarget[] = DEFAULT_TARGETS;
  private readonly state = new Map<string, TargetState>();

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    this.targets = await this.loadTargets();
    void this.run();
    this.timer = setInterval(() => void this.run(), INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  snapshot() {
    return {
      checkedAt: this.checkedAt,
      intervalSec: INTERVAL_MS / 1000,
      maxTargets: MAX_TARGETS,
      targets: this.targets.map((target) => {
        const state = this.state.get(target.host);
        return {
          id: target.host,
          ...target,
          latencyMs: state?.latencyMs ?? null,
          loss: state?.loss ?? null,
          history: state?.history ?? [],
        };
      }),
    };
  }

  async saveTargets(input: InternetTarget[]) {
    const targets = cleanTargets(input);
    await this.prisma.setting.upsert({
      where: { key: SETTING_KEY },
      update: { value: JSON.stringify(targets) },
      create: { key: SETTING_KEY, value: JSON.stringify(targets) },
    });
    this.targets = targets;
    for (const host of [...this.state.keys()]) {
      if (!targets.some((target) => target.host === host)) this.state.delete(host);
    }
    await this.run();
    return this.snapshot();
  }

  private async loadTargets() {
    const row = await this.prisma.setting.findUnique({ where: { key: SETTING_KEY } });
    if (!row) return DEFAULT_TARGETS;
    try {
      return cleanTargets(JSON.parse(row.value) as InternetTarget[]);
    } catch {
      return DEFAULT_TARGETS;
    }
  }

  private async run() {
    if (this.running) return;
    this.running = true;
    try {
      const targets = this.targets;
      const results = await Promise.all(targets.map((target) => pingHost(target.host)));
      targets.forEach((target, index) => {
        const result = results[index];
        const history = [...(this.state.get(target.host)?.history ?? []), result.latencyMs].slice(-HISTORY);
        this.state.set(target.host, { ...result, history });
      });
      this.checkedAt = new Date();
    } finally {
      this.running = false;
    }
  }
}

function cleanTargets(input: unknown): InternetTarget[] {
  if (!Array.isArray(input)) throw new BadRequestException('Daftar situs tidak valid');
  if (input.length > MAX_TARGETS) throw new BadRequestException(`Maksimal ${MAX_TARGETS} situs`);
  const seen = new Set<string>();
  return input.map((item, index) => {
    const row = item as Partial<InternetTarget>;
    const host = String(row?.host ?? '')
      .trim()
      .toLowerCase()
      .replace(/^[a-z]+:\/\//, '')
      .replace(/[/?#].*$/, '');
    const name = String(row?.name ?? '').trim().slice(0, 40) || host;
    if (!hostPattern.test(host)) throw new BadRequestException(`Host baris ${index + 1} tidak valid`);
    if (seen.has(host)) throw new BadRequestException(`Host ${host} dobel`);
    seen.add(host);
    return { name, host };
  });
}

function pingHost(host: string): Promise<PingResult> {
  return new Promise((resolve) => {
    execFile('ping', ['-4', '-n', '-c', '4', '-i', '0.3', '-W', '2', '--', host], { timeout: 12_000 }, (_error, stdout, stderr) => {
      const output = `${stdout ?? ''}\n${stderr ?? ''}`;
      const loss = output.match(/([\d.]+)% packet loss/);
      const rtt = output.match(/= [\d.]+\/([\d.]+)\//);
      resolve({
        latencyMs: rtt ? Math.round(Number(rtt[1]) * 10) / 10 : null,
        loss: loss ? Number(loss[1]) : 100,
      });
    });
  });
}
