import { Criticality, DeviceType, MonitorMethod } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsIP,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
} from 'class-validator';

const deviceTypes: DeviceType[] = [
  'mikrotik_router',
  'mikrotik_switch',
  'huawei_olt',
  'switch',
  'access_point',
  'server',
  'customer_router',
  'other',
];
const methods: MonitorMethod[] = ['icmp', 'snmp', 'mikrotik_api', 'combination'];
const criticalities: Criticality[] = ['info', 'warning', 'major', 'critical'];

export class DeviceBody {
  @IsString()
  @MinLength(2)
  name!: string;

  @IsIP(4)
  ipAddress!: string;

  @IsIn(deviceTypes)
  deviceType!: DeviceType;

  @IsOptional()
  @IsString()
  location?: string;

  @Transform(({ value }) => (value === '' ? null : value))
  @IsOptional()
  @IsString()
  groupId?: string | null;

  @Transform(({ value }) => (value === '' ? null : value))
  @IsOptional()
  @IsString()
  parentId?: string | null;

  @IsIn(methods)
  monitorMethod!: MonitorMethod;

  @IsOptional()
  @IsString()
  snmpCommunity?: string;

  @IsOptional()
  @IsIn(['2c', '3'])
  snmpVersion?: string;

  @Type(() => Number)
  @IsOptional()
  @IsInt()
  snmpPort?: number;

  @IsOptional()
  @IsString()
  rosUsername?: string;

  @IsOptional()
  @IsString()
  rosPassword?: string;

  @Type(() => Number)
  @IsOptional()
  @IsInt()
  rosPort?: number;

  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(300)
  pingIntervalSec!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  failedThreshold!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  recoveryThreshold!: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(3600)
  alertDelaySec!: number;

  @IsIn(criticalities)
  criticality!: Criticality;

  @IsBoolean()
  notificationEnabled!: boolean;

  @IsBoolean()
  maintenance!: boolean;
}

export class UpdateDeviceBody {
  @IsOptional()
  @IsString()
  @MinLength(2)
  name?: string;

  @IsOptional()
  @IsIP(4)
  ipAddress?: string;

  @IsOptional()
  @IsIn(deviceTypes)
  deviceType?: DeviceType;

  @IsOptional()
  @IsString()
  location?: string;

  @Transform(({ value }) => (value === '' ? null : value))
  @IsOptional()
  @IsString()
  groupId?: string | null;

  @Transform(({ value }) => (value === '' ? null : value))
  @IsOptional()
  @IsString()
  parentId?: string | null;

  @IsOptional()
  @IsIn(methods)
  monitorMethod?: MonitorMethod;

  @IsOptional()
  @IsString()
  snmpCommunity?: string;

  @IsOptional()
  @IsIn(['2c', '3'])
  snmpVersion?: string;

  @Type(() => Number)
  @IsOptional()
  @IsInt()
  snmpPort?: number;

  @IsOptional()
  @IsString()
  rosUsername?: string;

  @IsOptional()
  @IsString()
  rosPassword?: string;

  @Type(() => Number)
  @IsOptional()
  @IsInt()
  rosPort?: number;

  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(300)
  pingIntervalSec?: number;

  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  failedThreshold?: number;

  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  recoveryThreshold?: number;

  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3600)
  alertDelaySec?: number;

  @IsOptional()
  @IsIn(criticalities)
  criticality?: Criticality;

  @IsOptional()
  @IsBoolean()
  notificationEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  maintenance?: boolean;
}
