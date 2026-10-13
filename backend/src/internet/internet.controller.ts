import { Body, Controller, Get, Put } from '@nestjs/common';
import { Roles } from '../auth/auth.decorators';
import { InternetService, InternetTarget } from './internet.service';

@Controller('internet')
export class InternetController {
  constructor(private readonly internet: InternetService) {}

  @Get()
  status() {
    return this.internet.snapshot();
  }

  @Roles('admin')
  @Put('targets')
  update(@Body() body: { targets?: InternetTarget[] }) {
    return this.internet.saveTargets(body?.targets as InternetTarget[]);
  }
}
