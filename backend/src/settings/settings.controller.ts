import { ArgumentsHost, BadRequestException, Body, Catch, Controller, Delete, ExceptionFilter, ForbiddenException, Get, NotFoundException, Param, Post, Put, Req, StreamableFile, UploadedFile, UseFilters, UseInterceptors } from '@nestjs/common';
import { Role } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { MulterError } from 'multer';
import { FileInterceptor } from '@nestjs/platform-express';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Max, Min, MinLength } from 'class-validator';
import { memoryStorage } from 'multer';
import { AppRole, AuthUser, Roles, roleAtLeast } from '../auth/auth.decorators';
import { PrismaService } from '../infra/prisma.service';
import { ProvisionService } from '../zabbix/zabbix.provision';
import { ZabbixService } from '../zabbix/zabbix.service';
import { SoundSlot, alarmExtension, cleanSoundName, hasAlarmSound, openAlarmSound, removeAlarmSound, saveAlarmSound } from './alarm-sound';
import { BackupService } from './backup.service';
import { IntegrationConfig } from './integration-config';
import { mrtgSettingEntries, readMrtgStyle } from './mrtg-settings';

const tokenRoles: AppRole[] = ['super_admin', 'admin', 'noc', 'viewer'];

type UploadedAudio = { buffer: Buffer; mimetype: string; originalname: string; size: number };

class SettingsBody {
  @IsOptional()
  @IsBoolean()
  soundEnabled?: boolean;

  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(60)
  soundRepeatMinutes?: number;

  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  soundVolume?: number;

  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5000)
  latencyWarnMs?: number;

  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  lossWarnPct?: number;

  @IsOptional()
  @IsString()
  zabbixApiUrl?: string;

  @IsOptional()
  @IsString()
  zabbixUser?: string;

  @IsOptional()
  @IsString()
  zabbixPassword?: string;

  @IsOptional()
  @IsBoolean()
  clearZabbixPassword?: boolean;

  @IsOptional()
  @IsString()
  zabbixApiToken?: string;

  @IsOptional()
  @IsBoolean()
  clearZabbixToken?: boolean;

  @IsOptional()
  @IsString()
  webhookUrl?: string;

  @IsOptional()
  @IsString()
  @Matches(/^#[0-9a-fA-F]{6}$/)
  mrtgColorIn?: string;

  @IsOptional()
  @IsString()
  @Matches(/^#[0-9a-fA-F]{6}$/)
  mrtgColorOut?: string;

  @IsOptional()
  @IsString()
  @Matches(/^#[0-9a-fA-F]{6}$/)
  mrtgColorThreshold?: string;

  @IsOptional()
  @IsString()
  @Matches(/^#[0-9a-fA-F]{6}$/)
  mrtgColorProbe?: string;

  @IsOptional()
  @IsString()
  @Matches(/^#[0-9a-fA-F]{6}$/)
  mrtgColorLoss?: string;

  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  mrtgThresholdPct?: number;
}

class TestZabbixBody {
  @IsOptional()
  @IsString()
  zabbixApiUrl?: string;

  @IsOptional()
  @IsString()
  zabbixUser?: string;

  @IsOptional()
  @IsString()
  zabbixPassword?: string;

  @IsOptional()
  @IsString()
  zabbixApiToken?: string;

  @IsOptional()
  @IsBoolean()
  clearZabbixToken?: boolean;
}

class ApiTokenBody {
  @IsString()
  @MinLength(2)
  name!: string;

  @IsIn(tokenRoles)
  role!: AppRole;
}

@Catch(MulterError)
class BackupUploadFilter implements ExceptionFilter {
  catch(exception: MulterError, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<{ status: (code: number) => { json: (body: unknown) => void } }>();
    const message = exception.code === 'LIMIT_FILE_SIZE' ? 'File cadangan lebih dari 256 MB' : 'File cadangan tidak bisa diterima';
    response.status(400).json({ message });
  }
}

@Catch(MulterError)
class UploadErrorFilter implements ExceptionFilter {
  catch(exception: MulterError, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<{ status: (code: number) => { json: (body: unknown) => void } }>();
    const message = exception.code === 'LIMIT_FILE_SIZE' ? 'File lebih dari 8 MB' : 'File tidak bisa diterima';
    response.status(400).json({ message });
  }
}

@Controller('settings')
export class SettingsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly provision: ProvisionService,
    private readonly integration: IntegrationConfig,
    private readonly zabbix: ZabbixService,
    private readonly backup: BackupService,
  ) {}

  @Roles('admin')
  @Get('backup/summary')
  backupSummary() {
    return this.backup.summary();
  }

  @Roles('admin')
  @Get('backup')
  async downloadBackup() {
    const file = await this.backup.exportFile();
    return new StreamableFile(file.body, {
      type: 'application/gzip',
      disposition: `attachment; filename="${file.name}"`,
      length: file.body.length,
    });
  }

  @Roles('admin')
  @Post('backup/restore')
  @UseFilters(BackupUploadFilter)
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 256 * 1024 * 1024 } }))
  async restoreBackup(
    @Req() req: { user: AuthUser },
    @UploadedFile() file?: UploadedAudio,
    @Body('confirm') confirm?: string,
  ) {
    if (confirm !== 'PULIHKAN') throw new BadRequestException('Konfirmasi pemulihan diperlukan');
    if (!file?.size) throw new BadRequestException('Pilih file cadangan');
    const result = await this.backup.restore(file.buffer);
    await this.prisma.event.create({
      data: { type: 'backup', message: `Seluruh data dipulihkan dari cadangan oleh ${req.user.name}` },
    }).catch(() => undefined);
    this.integration.clearCache();
    await this.zabbix.refreshConfig();
    void this.zabbix.ensureConnection();
    void this.zabbix.ensureWebhook();
    return result;
  }

  @Get()
  get() {
    return this.read();
  }

  @Roles('admin')
  @Get('integration')
  async integrationView() {
    const secrets = await this.integration.read();
    return { webhookToken: secrets.webhookToken };
  }

  @Get('alarm-sound')
  download() {
    return this.downloadSound('alarm-sound', 'Nada alarm khusus belum diunggah');
  }

  @Roles('admin')
  @Post('alarm-sound')
  @UseFilters(UploadErrorFilter)
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } }))
  upload(@UploadedFile() file?: UploadedAudio) {
    return this.uploadSound('alarm-sound', 'alarm_sound_name', file);
  }

  @Roles('admin')
  @Delete('alarm-sound')
  clearSound() {
    return this.clearSoundSlot('alarm-sound', 'alarm_sound_name');
  }

  @Get('recovery-sound')
  downloadRecovery() {
    return this.downloadSound('recovery-sound', 'Nada UP khusus belum diunggah');
  }

  @Roles('admin')
  @Post('recovery-sound')
  @UseFilters(UploadErrorFilter)
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } }))
  uploadRecovery(@UploadedFile() file?: UploadedAudio) {
    return this.uploadSound('recovery-sound', 'recovery_sound_name', file);
  }

  @Roles('admin')
  @Delete('recovery-sound')
  clearRecovery() {
    return this.clearSoundSlot('recovery-sound', 'recovery_sound_name');
  }

  private async downloadSound(slot: SoundSlot, missing: string) {
    const file = await openAlarmSound(slot);
    if (!file) throw new NotFoundException(missing);
    return new StreamableFile(file.stream, { type: file.mime, disposition: 'inline' });
  }

  private async uploadSound(slot: SoundSlot, key: string, file?: UploadedAudio) {
    if (!file?.size) throw new BadRequestException('Pilih file audio');
    const extension = alarmExtension(file.mimetype, file.originalname);
    if (!extension) throw new BadRequestException('Format harus mp3, wav, ogg, m4a, aac, atau webm');
    await saveAlarmSound(file.buffer, extension, slot);
    const value = cleanSoundName(file.originalname);
    await this.prisma.setting.upsert({ where: { key }, update: { value }, create: { key, value } });
    return this.read();
  }

  private async clearSoundSlot(slot: SoundSlot, key: string) {
    await removeAlarmSound(slot);
    await this.prisma.setting.deleteMany({ where: { key } });
    return this.read();
  }

  @Roles('admin')
  @Put()
  async update(@Body() body: SettingsBody) {
    assertHttpUrl(body.zabbixApiUrl, 'URL Zabbix');
    assertHttpUrl(body.webhookUrl, 'URL webhook');
    const current = await this.read();
    const next = { ...current };
    for (const [key, value] of Object.entries(body)) {
      if (value !== undefined) (next as Record<string, unknown>)[key] = value;
    }
    const entries: Record<string, string> = {
      sound_enabled: String(next.soundEnabled),
      sound_repeat_minutes: String(next.soundRepeatMinutes),
      sound_volume: String(next.soundVolume),
      latency_warn_ms: String(next.latencyWarnMs),
      loss_warn_pct: String(next.lossWarnPct),
      ...mrtgSettingEntries(readMrtgStyle({
        mrtg_color_in: body.mrtgColorIn ?? current.mrtgColorIn,
        mrtg_color_out: body.mrtgColorOut ?? current.mrtgColorOut,
        mrtg_color_threshold: body.mrtgColorThreshold ?? current.mrtgColorThreshold,
        mrtg_color_probe: body.mrtgColorProbe ?? current.mrtgColorProbe,
        mrtg_color_loss: body.mrtgColorLoss ?? current.mrtgColorLoss,
        mrtg_threshold_pct: String(body.mrtgThresholdPct ?? current.mrtgThresholdPct),
      })),
    };
    for (const [key, value] of Object.entries(entries)) {
      await this.prisma.setting.upsert({ where: { key }, update: { value }, create: { key, value } });
    }
    const touchesApi = body.zabbixApiUrl !== undefined
      || body.zabbixUser !== undefined
      || Boolean(body.zabbixPassword)
      || Boolean(body.clearZabbixPassword)
      || Boolean(body.zabbixApiToken)
      || Boolean(body.clearZabbixToken)
      || body.webhookUrl !== undefined;
    if (touchesApi) {
      await this.integration.save(body);
      await this.zabbix.refreshConfig();
      void this.zabbix.ensureConnection();
      void this.zabbix.ensureWebhook();
    }
    if (body.latencyWarnMs !== undefined || body.lossWarnPct !== undefined) {
      void this.provision.refreshWarningTriggers();
    }
    return this.read();
  }

  @Roles('admin')
  @Post('test-zabbix')
  async testZabbix(@Body() body: TestZabbixBody) {
    assertHttpUrl(body.zabbixApiUrl, 'URL Zabbix');
    const saved = await this.integration.read();
    return this.zabbix.probe({
      url: body.zabbixApiUrl?.trim() || saved.zabbixApiUrl,
      user: body.zabbixUser?.trim() || saved.zabbixUser,
      password: body.zabbixPassword || saved.zabbixPassword,
      token: body.clearZabbixToken ? '' : (body.zabbixApiToken || saved.zabbixApiToken),
    });
  }

  @Roles('admin')
  @Post('webhook-token')
  async regenerateWebhook() {
    const webhookToken = randomBytes(24).toString('hex');
    await this.integration.save({ webhookToken });
    await this.zabbix.refreshConfig();
    void this.zabbix.ensureWebhook();
    return { webhookToken };
  }

  @Roles('admin')
  @Get('api-tokens')
  async listTokens() {
    const rows = await this.prisma.apiToken.findMany({ orderBy: { createdAt: 'desc' } });
    return rows.map(presentToken);
  }

  @Roles('admin')
  @Post('api-tokens')
  async createToken(@Req() req: { user: AuthUser }, @Body() body: ApiTokenBody) {
    if (!roleAtLeast(req.user.role, body.role)) {
      throw new ForbiddenException('Token tidak boleh lebih tinggi dari hak akses Anda');
    }
    const secret = `kms_${randomBytes(24).toString('hex')}`;
    const row = await this.prisma.apiToken.create({
      data: {
        name: body.name.trim(),
        role: body.role as Role,
        tokenHash: hashToken(secret),
        prefix: secret.slice(0, 12),
      },
    });
    return { ...presentToken(row), token: secret };
  }

  @Roles('admin')
  @Delete('api-tokens/:id')
  async revokeToken(@Param('id') id: string) {
    const row = await this.prisma.apiToken.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Token tidak ditemukan');
    await this.prisma.apiToken.delete({ where: { id } });
    return { ok: true };
  }

  private async read() {
    const rows = await this.prisma.setting.findMany();
    const map = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    const integration = await this.integration.read();
    return {
      soundEnabled: map.sound_enabled !== 'false',
      soundRepeatMinutes: Number(map.sound_repeat_minutes ?? 2),
      soundVolume: Number(map.sound_volume ?? 80),
      latencyWarnMs: Number(map.latency_warn_ms ?? 150),
      lossWarnPct: Number(map.loss_warn_pct ?? 20),
      ...presentMrtg(map),
      soundName: (await hasAlarmSound()) ? map.alarm_sound_name || null : null,
      recoverySoundName: (await hasAlarmSound('recovery-sound')) ? map.recovery_sound_name || null : null,
      zabbixApiUrl: integration.zabbixApiUrl,
      zabbixUser: integration.zabbixUser,
      zabbixPasswordSet: Boolean(integration.zabbixPassword),
      zabbixTokenSet: Boolean(integration.zabbixApiToken),
      webhookUrl: integration.webhookUrl,
      webhookTokenSet: Boolean(integration.webhookToken),
    };
  }
}

function presentMrtg(map: Record<string, string | undefined>) {
  const style = readMrtgStyle(map);
  return {
    mrtgColorIn: style.colorIn,
    mrtgColorOut: style.colorOut,
    mrtgColorThreshold: style.colorThreshold,
    mrtgColorProbe: style.colorProbe,
    mrtgColorLoss: style.colorLoss,
    mrtgThresholdPct: style.thresholdPct,
  };
}

function presentToken(row: { id: string; name: string; role: Role; prefix: string; createdAt: Date; lastUsedAt: Date | null }) {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    prefix: row.prefix,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  };
}

function hashToken(secret: string) {
  return createHash('sha256').update(secret).digest('hex');
}

function assertHttpUrl(value: string | undefined, label: string) {
  if (value === undefined) return;
  const trimmed = value.trim();
  if (!trimmed) return;
  if (!/^https?:\/\//i.test(trimmed)) throw new BadRequestException(`${label} harus diawali http:// atau https://`);
}
