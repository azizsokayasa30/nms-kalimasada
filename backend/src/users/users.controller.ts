import { BadRequestException, Body, ConflictException, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Req, UnauthorizedException } from '@nestjs/common';
import { Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { IsEmail, IsIn, IsOptional, IsString, MinLength } from 'class-validator';
import { AppRole, AuthUser, Roles } from '../auth/auth.decorators';
import { PrismaService } from '../infra/prisma.service';

const roles: AppRole[] = ['super_admin', 'admin', 'noc', 'viewer'];

class CreateUserBody {
  @IsString()
  @MinLength(2)
  name!: string;

  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;

  @IsIn(roles)
  role!: AppRole;
}

class UpdateUserBody {
  @IsOptional()
  @IsString()
  @MinLength(2)
  name?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @MinLength(8)
  password?: string;

  @IsOptional()
  @IsIn(roles)
  role?: AppRole;
}

class UpdateMeBody {
  @IsOptional()
  @IsString()
  @MinLength(2)
  name?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  currentPassword?: string;

  @IsOptional()
  @IsString()
  @MinLength(8)
  newPassword?: string;
}

@Controller('users')
@Roles('super_admin')
export class UsersController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list() {
    const users = await this.prisma.user.findMany({ orderBy: { name: 'asc' } });
    return users.map(present);
  }

  @Post()
  async create(@Body() body: CreateUserBody) {
    const email = body.email.toLowerCase().trim();
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) throw new ConflictException('Email sudah dipakai');
    await this.assertNameFree(body.name);
    const user = await this.prisma.user.create({
      data: {
        name: body.name.trim(),
        email,
        role: body.role as Role,
        passwordHash: await bcrypt.hash(body.password, 10),
      },
    });
    return present(user);
  }

  @Roles('viewer')
  @Patch('me')
  async updateMe(@Req() req: { user: AuthUser }, @Body() body: UpdateMeBody) {
    const user = await this.prisma.user.findUnique({ where: { id: req.user.sub } });
    if (!user) throw new NotFoundException('Pengguna tidak ditemukan');
    if (body.newPassword) {
      if (!body.currentPassword) throw new BadRequestException('Password saat ini wajib diisi');
      const matches = await bcrypt.compare(body.currentPassword, user.passwordHash);
      if (!matches) throw new UnauthorizedException('Password saat ini salah');
    }
    const email = body.email?.toLowerCase().trim();
    if (email && email !== user.email) {
      const taken = await this.prisma.user.findUnique({ where: { email } });
      if (taken) throw new ConflictException('Email sudah dipakai');
    }
    if (body.name?.trim()) await this.assertNameFree(body.name, user.id);
    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: {
        name: body.name?.trim() || undefined,
        email: email || undefined,
        passwordHash: body.newPassword ? await bcrypt.hash(body.newPassword, 10) : undefined,
      },
    });
    return present(updated);
  }

  @Patch(':id')
  async update(@Req() req: { user: AuthUser }, @Param('id') id: string, @Body() body: UpdateUserBody) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('Pengguna tidak ditemukan');
    if (body.role && body.role !== user.role) await this.keepLastAdmin(user, body.role);
    const email = body.email?.toLowerCase().trim();
    if (email && email !== user.email) {
      const taken = await this.prisma.user.findUnique({ where: { email } });
      if (taken) throw new ConflictException('Email sudah dipakai');
    }
    if (body.name?.trim()) await this.assertNameFree(body.name, id);
    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        name: body.name?.trim() || undefined,
        email: email || undefined,
        role: (body.role as Role | undefined) ?? undefined,
        passwordHash: body.password ? await bcrypt.hash(body.password, 10) : undefined,
      },
    });
    return present(updated);
  }

  @Delete(':id')
  async remove(@Req() req: { user: AuthUser }, @Param('id') id: string) {
    if (req.user.sub === id) throw new BadRequestException('Tidak bisa menghapus akun yang sedang dipakai');
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('Pengguna tidak ditemukan');
    await this.keepLastAdmin(user);
    await this.prisma.alarm.updateMany({ where: { acknowledgedById: id }, data: { acknowledgedById: null } });
    await this.prisma.user.delete({ where: { id } });
    return { ok: true };
  }

  private async assertNameFree(name: string, exceptId?: string) {
    const taken = await this.prisma.user.findFirst({
      where: {
        name: { equals: name.trim(), mode: 'insensitive' },
        ...(exceptId ? { NOT: { id: exceptId } } : {}),
      },
    });
    if (taken) throw new ConflictException('Nama sudah dipakai pengguna lain');
  }

  private async keepLastAdmin(user: { role: Role }, nextRole?: AppRole) {
    const demoting = user.role === Role.super_admin && nextRole !== undefined && nextRole !== 'super_admin';
    const removing = nextRole === undefined && user.role === Role.super_admin;
    if (!demoting && !removing) return;
    const count = await this.prisma.user.count({ where: { role: Role.super_admin } });
    if (count <= 1) throw new BadRequestException('Harus ada minimal satu Super Admin');
  }
}

function present(user: { id: string; name: string; email: string; role: Role; createdAt: Date }) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    createdAt: user.createdAt,
  };
}
