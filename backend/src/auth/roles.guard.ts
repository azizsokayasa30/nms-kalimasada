import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { AppRole, AuthUser, ROLES_KEY, minimumRole, roleAtLeast } from './auth.decorators';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext) {
    const roles = this.reflector.getAllAndOverride<AppRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!roles?.length) return true;
    const request = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    if (!request.user) return true;
    if (!roleAtLeast(request.user.role, minimumRole(roles))) {
      throw new ForbiddenException('Hak akses tidak cukup');
    }
    return true;
  }
}
