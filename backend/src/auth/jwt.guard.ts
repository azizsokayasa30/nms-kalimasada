import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { createHash } from 'crypto';
import { Request } from 'express';
import { PrismaService } from '../infra/prisma.service';
import { AppRole, AuthUser, IS_PUBLIC } from './auth.decorators';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('Login diperlukan');
    const raw = header.slice(7);
    if (raw.startsWith('kms_')) {
      request.user = await this.userFromApiToken(raw);
      return true;
    }
    try {
      request.user = await this.jwt.verifyAsync<AuthUser>(raw);
      return true;
    } catch {
      throw new UnauthorizedException('Sesi berakhir');
    }
  }

  private async userFromApiToken(raw: string): Promise<AuthUser> {
    const tokenHash = createHash('sha256').update(raw).digest('hex');
    const row = await this.prisma.apiToken.findUnique({ where: { tokenHash } });
    if (!row) throw new UnauthorizedException('Token API tidak berlaku');
    const stale = !row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 5 * 60 * 1000;
    if (stale) {
      await this.prisma.apiToken.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
    }
    return {
      sub: row.id,
      email: 'api-token',
      name: row.name,
      role: row.role as AppRole,
    };
  }
}
