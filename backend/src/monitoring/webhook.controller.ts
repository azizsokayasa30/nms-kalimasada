import { Body, Controller, Headers, Post, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { Public } from '../auth/auth.decorators';
import { IntegrationConfig } from '../settings/integration-config';
import { SyncService } from './sync.service';

@Controller('internal/zabbix')
export class WebhookController {
  constructor(
    private readonly sync: SyncService,
    private readonly integration: IntegrationConfig,
  ) {}

  @Public()
  @Post('webhook')
  async hook(@Headers('x-webhook-token') token: string | undefined, @Body() body: unknown) {
    const expected = (await this.integration.read()).webhookToken;
    if (!token || !expected || token.length !== expected.length) {
      throw new UnauthorizedException('Token webhook salah');
    }
    const given = Buffer.from(token);
    const want = Buffer.from(expected);
    if (!timingSafeEqual(given, want)) throw new UnauthorizedException('Token webhook salah');
    void body;
    await this.sync.request();
    return { ok: true };
  }
}
