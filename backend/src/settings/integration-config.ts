import { Injectable } from '@nestjs/common';
import { PrismaService } from '../infra/prisma.service';
import { decryptSecret, encryptSecret } from '../infra/crypto';

export type IntegrationSecrets = {
  zabbixApiUrl: string;
  zabbixUser: string;
  zabbixPassword: string;
  zabbixApiToken: string;
  webhookUrl: string;
  webhookToken: string;
};

const KEYS = [
  'zabbix_api_url',
  'zabbix_user',
  'zabbix_password_enc',
  'zabbix_api_token_enc',
  'zabbix_webhook_url',
  'zabbix_webhook_token',
] as const;

@Injectable()
export class IntegrationConfig {
  private cache: { at: number; value: IntegrationSecrets } | null = null;

  constructor(private readonly prisma: PrismaService) {}

  clearCache() {
    this.cache = null;
  }

  async read(): Promise<IntegrationSecrets> {
    if (this.cache && Date.now() - this.cache.at < 2000) return this.cache.value;
    const rows = await this.prisma.setting.findMany({ where: { key: { in: [...KEYS] } } });
    const map = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    const value: IntegrationSecrets = {
      zabbixApiUrl: map.zabbix_api_url || process.env.ZABBIX_API_URL || 'http://127.0.0.1:8080/api_jsonrpc.php',
      zabbixUser: map.zabbix_user || process.env.ZABBIX_USER || 'Admin',
      zabbixPassword: map.zabbix_password_enc ? decryptOrEmpty(map.zabbix_password_enc) : (process.env.ZABBIX_PASSWORD ?? ''),
      zabbixApiToken: map.zabbix_api_token_enc ? decryptOrEmpty(map.zabbix_api_token_enc) : (process.env.ZABBIX_API_TOKEN ?? ''),
      webhookUrl: map.zabbix_webhook_url || process.env.ZABBIX_WEBHOOK_URL || '',
      webhookToken: map.zabbix_webhook_token || process.env.ZABBIX_WEBHOOK_TOKEN || '',
    };
    this.cache = { at: Date.now(), value };
    return value;
  }

  async save(input: {
    zabbixApiUrl?: string;
    zabbixUser?: string;
    zabbixPassword?: string;
    clearZabbixPassword?: boolean;
    zabbixApiToken?: string;
    clearZabbixToken?: boolean;
    webhookUrl?: string;
    webhookToken?: string;
  }) {
    const writes: Array<[string, string | null]> = [];
    if (input.zabbixApiUrl !== undefined) writes.push(['zabbix_api_url', input.zabbixApiUrl.trim()]);
    if (input.zabbixUser !== undefined) writes.push(['zabbix_user', input.zabbixUser.trim()]);
    if (input.clearZabbixPassword) writes.push(['zabbix_password_enc', null]);
    else if (input.zabbixPassword) writes.push(['zabbix_password_enc', encryptSecret(input.zabbixPassword)]);
    if (input.clearZabbixToken) writes.push(['zabbix_api_token_enc', null]);
    else if (input.zabbixApiToken) writes.push(['zabbix_api_token_enc', encryptSecret(input.zabbixApiToken)]);
    if (input.webhookUrl !== undefined) writes.push(['zabbix_webhook_url', input.webhookUrl.trim()]);
    if (input.webhookToken !== undefined) writes.push(['zabbix_webhook_token', input.webhookToken.trim()]);
    for (const [key, value] of writes) {
      if (!value) await this.prisma.setting.deleteMany({ where: { key } });
      else await this.prisma.setting.upsert({ where: { key }, update: { value }, create: { key, value } });
    }
    this.cache = null;
  }
}

function decryptOrEmpty(payload: string) {
  try {
    return decryptSecret(payload);
  } catch {
    return '';
  }
}
