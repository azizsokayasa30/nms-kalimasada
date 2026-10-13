import { Injectable, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../infra/prisma.service';
import { AppRole, AuthUser } from './auth.decorators';

@Injectable()
export class AuthService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async onModuleInit() {
    await this.seedAdmin();
    await this.seedSettings();
  }

  async login(identifier: string, password: string) {
    const value = identifier.trim();
    const candidates = await this.prisma.user.findMany({
      where: {
        OR: [
          { email: value.toLowerCase() },
          { name: { equals: value, mode: 'insensitive' } },
        ],
      },
    });
    let user: (typeof candidates)[number] | undefined;
    for (const candidate of candidates) {
      if (await bcrypt.compare(password, candidate.passwordHash)) {
        user = candidate;
        break;
      }
    }
    if (!user) throw new UnauthorizedException('Email/nama atau password salah');
    const payload: AuthUser = {
      sub: user.id,
      email: user.email,
      name: user.name,
      role: user.role as AppRole,
    };
    return {
      accessToken: await this.jwt.signAsync(payload),
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    };
  }

  private async seedAdmin() {
    const email = process.env.ADMIN_EMAIL?.toLowerCase().trim();
    const password = process.env.ADMIN_PASSWORD;
    if (!email || !password) throw new Error('ADMIN_EMAIL dan ADMIN_PASSWORD wajib diisi');
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) return;
    await this.prisma.user.create({
      data: {
        email,
        name: 'Super Admin',
        role: Role.super_admin,
        passwordHash: await bcrypt.hash(password, 10),
      },
    });
  }

  private async seedSettings() {
    const defaults: Record<string, string> = {
      sound_enabled: 'true',
      sound_repeat_minutes: '2',
      sound_volume: '80',
      latency_warn_ms: '150',
      loss_warn_pct: '20',
      mrtg_color_in: '#1f8a3b',
      mrtg_color_out: '#1d4e89',
      mrtg_color_threshold: '#c42318',
      mrtg_color_probe: '#1f8a3b',
      mrtg_color_loss: '#b45309',
      mrtg_threshold_pct: '95',
    };
    for (const [key, value] of Object.entries(defaults)) {
      await this.prisma.setting.upsert({
        where: { key },
        update: {},
        create: { key, value },
      });
    }
  }
}
