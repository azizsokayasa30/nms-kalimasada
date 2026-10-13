import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Roles } from '../auth/auth.decorators';
import { DeviceBody, UpdateDeviceBody } from './devices.dto';
import { DevicesService } from './devices.service';

class ThresholdBody {
  @Transform(({ value }) => (value === '' || value === null || value === undefined ? null : Number(value)))
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100000)
  bandwidthThresholdMbps?: number | null;
}

class GraphBody {
  @IsIn(['probe', 'interface'])
  kind!: 'probe' | 'interface';

  @IsString()
  @MinLength(1)
  key!: string;
}

class GroupBody {
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name!: string;
}

class ListQuery {
  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  deviceType?: string;

  @IsOptional()
  @IsString()
  groupId?: string;

  @Type(() => Number)
  @IsOptional()
  page?: number;

  @Type(() => Number)
  @IsOptional()
  limit?: number;
}

@Controller('devices')
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Get()
  list(@Query() query: ListQuery) {
    return this.devices.list(query);
  }

  @Get('groups')
  listGroups() {
    return this.devices.listGroups();
  }

  @Roles('admin')
  @Post('groups')
  createGroup(@Body() body: GroupBody) {
    return this.devices.createGroup(body.name);
  }

  @Roles('admin')
  @Put('groups/:id')
  renameGroup(@Param('id') id: string, @Body() body: GroupBody) {
    return this.devices.renameGroup(id, body.name);
  }

  @Roles('admin')
  @Delete('groups/:id')
  removeGroup(@Param('id') id: string) {
    return this.devices.removeGroup(id);
  }

  @Roles('admin')
  @Post()
  create(@Body() dto: DeviceBody) {
    return this.devices.create(dto);
  }

  @Get(':id/metrics')
  metrics(@Param('id') id: string, @Query('range') range?: string) {
    return this.devices.metrics(id, range);
  }

  @Get(':id/mrtg/options')
  mrtgOptions(@Param('id') id: string) {
    return this.devices.mrtgOptions(id);
  }

  @Roles('admin')
  @Post(':id/mrtg/graphs')
  addMrtgGraph(@Param('id') id: string, @Body() body: GraphBody) {
    return this.devices.addMrtgGraph(id, body.kind, body.key);
  }

  @Roles('admin')
  @Delete(':id/mrtg/graphs/:graphId')
  removeMrtgGraph(@Param('id') id: string, @Param('graphId') graphId: string) {
    return this.devices.removeMrtgGraph(id, graphId);
  }

  @Get(':id/mrtg')
  mrtg(
    @Param('id') id: string,
    @Query('period') period?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.devices.mrtg(id, { period, from, to });
  }

  @Roles('admin')
  @Put(':id/bandwidth-threshold')
  bandwidthThreshold(@Param('id') id: string, @Body() body: ThresholdBody) {
    return this.devices.setBandwidthThreshold(id, body.bandwidthThresholdMbps ?? null);
  }

  @Roles('noc')
  @Post(':id/test')
  test(@Param('id') id: string) {
    return this.devices.test(id);
  }

  @Get(':id/status')
  status(@Param('id') id: string) {
    return this.devices.get(id);
  }

  @Get(':id/interfaces')
  interfaces() {
    return { interfaces: [], note: 'Pemantauan interface SNMP menyusul di fase berikutnya' };
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.devices.get(id);
  }

  @Roles('admin')
  @Put(':id')
  update(@Param('id') id: string, @Body() dto: UpdateDeviceBody) {
    return this.devices.update(id, dto);
  }

  @Roles('admin')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.devices.remove(id);
  }
}
