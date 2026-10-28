import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Put, Req } from '@nestjs/common';
import { AuthUser, Roles } from '../auth/auth.decorators';
import { PrismaService } from '../infra/prisma.service';
import { NetdClient } from './netd.client';

type NetRequest = { user: AuthUser; headers: Record<string, string | string[] | undefined>; ip?: string };
type Change = { summary?: string };

const kinds = ['vlans', 'addresses', 'routes', 'vpns'];

@Controller('network')
export class NetworkController {
  constructor(
    private readonly netd: NetdClient,
    private readonly prisma: PrismaService,
  ) {}

  @Roles('admin')
  @Get()
  state(@Req() req: NetRequest) {
    return this.netd.call('GET', '/state', undefined, clientIp(req));
  }

  @Roles('admin')
  @Post('test')
  test(@Body() body: Record<string, unknown>) {
    return this.netd.call('POST', '/test', body);
  }

  @Roles('super_admin')
  @Post('confirm')
  confirm(@Body() body: Record<string, unknown>) {
    return this.netd.call('POST', '/confirm', body);
  }

  @Roles('super_admin')
  @Post('forwarding')
  forwarding(@Req() req: NetRequest, @Body() body: Record<string, unknown>) {
    return this.change(req, 'POST', '/forwarding', body, 'diubah');
  }

  @Roles('super_admin')
  @Post('vpns/:id/restart')
  restart(@Req() req: NetRequest, @Param('id') id: string) {
    return this.change(req, 'POST', `/vpns/${encodeURIComponent(id)}/restart`, {}, '');
  }

  @Roles('super_admin')
  @Post(':kind')
  create(@Req() req: NetRequest, @Param('kind') kind: string, @Body() body: Record<string, unknown>) {
    return this.change(req, 'POST', `/${checkKind(kind)}`, body, 'ditambahkan');
  }

  @Roles('super_admin')
  @Put(':kind/:id')
  update(@Req() req: NetRequest, @Param('kind') kind: string, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.change(req, 'PUT', `/${checkKind(kind)}/${encodeURIComponent(id)}`, body, 'diubah');
  }

  @Roles('super_admin')
  @Delete(':kind/:id')
  remove(@Req() req: NetRequest, @Param('kind') kind: string, @Param('id') id: string) {
    return this.change(req, 'DELETE', `/${checkKind(kind)}/${encodeURIComponent(id)}`, undefined, 'dihapus');
  }

  private async change(req: NetRequest, method: string, path: string, body: unknown, verb: string) {
    const result = await this.netd.call<Change>(method, path, body, clientIp(req));
    if (result?.summary) {
      const message = `${result.summary}${verb ? ` ${verb}` : ''} oleh ${req.user.name}`;
      await this.prisma.event.create({ data: { type: 'network', message } }).catch(() => undefined);
    }
    return result;
  }
}

function checkKind(kind: string) {
  if (!kinds.includes(kind)) throw new BadRequestException('Jenis pengaturan tidak dikenal');
  return kind;
}

function clientIp(req: NetRequest) {
  const real = req.headers['x-real-ip'];
  return (Array.isArray(real) ? real[0] : real) ?? req.ip ?? '';
}
