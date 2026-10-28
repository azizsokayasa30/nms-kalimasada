import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { execFile } from 'child_process';

const INTERVAL_MS = 5_000;
const PUBLIC_ANCHORS = ['1.1.1.1', '8.8.8.8'];
const TRUST_MS = 10 * 60 * 1000;

@Injectable()
export class UplinkService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(UplinkService.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private lastOkAt = 0;
  private lastBadAt = 0;
  private badSince = 0;

  onModuleInit() {
    void this.probe();
    this.timer = setInterval(() => void this.probe(), INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  degradedWithin(windowMs: number) {
    return this.lastBadAt > 0 && Date.now() - this.lastBadAt <= windowMs;
  }

  private async probe() {
    if (this.running) return;
    this.running = true;
    try {
      const gateway = await defaultGateway();
      const anchors = gateway ? [gateway, ...PUBLIC_ANCHORS] : PUBLIC_ANCHORS;
      const results = await Promise.all(anchors.map(reachable));
      const now = Date.now();
      if (results.some(Boolean)) {
        if (this.badSince) {
          this.logger.log(`Jaringan server NMS pulih setelah ${Math.round((now - this.badSince) / 1000)} detik`);
        }
        this.badSince = 0;
        this.lastOkAt = now;
        return;
      }
      // Anchors that never answered (ICMP blocked) must not mute every alarm forever.
      if (!this.lastOkAt || now - this.lastOkAt > TRUST_MS) return;
      if (!this.badSince) {
        this.badSince = now;
        this.logger.warn(`Jaringan server NMS terganggu: ${anchors.join(', ')} tidak menjawab ping`);
      }
      this.lastBadAt = now;
    } finally {
      this.running = false;
    }
  }
}

function defaultGateway(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('ip', ['-4', 'route', 'show', 'default'], { timeout: 2_000 }, (_error, stdout) => {
      resolve(String(stdout ?? '').match(/via (\d+\.\d+\.\d+\.\d+)/)?.[1] ?? null);
    });
  });
}

function reachable(host: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('ping', ['-4', '-n', '-c', '2', '-i', '0.2', '-W', '1', '--', host], { timeout: 4_000 }, (_error, stdout) => {
      const received = String(stdout ?? '').match(/(\d+) received/);
      resolve(Boolean(received && Number(received[1]) > 0));
    });
  });
}
