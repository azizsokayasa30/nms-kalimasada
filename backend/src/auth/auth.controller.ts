import { BadRequestException, Body, Controller, Get, Post, Req } from '@nestjs/common';
import { IsOptional, IsString, MinLength } from 'class-validator';
import { AuthUser, Public } from './auth.decorators';
import { AuthService } from './auth.service';

class LoginDto {
  @IsOptional()
  @IsString()
  login?: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsString()
  @MinLength(8)
  password!: string;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  login(@Body() dto: LoginDto) {
    const identifier = (dto.login ?? dto.email ?? '').trim();
    if (!identifier) throw new BadRequestException('Email atau nama wajib diisi');
    return this.auth.login(identifier, dto.password);
  }

  @Get('me')
  me(@Req() req: { user: AuthUser }) {
    return req.user;
  }
}
