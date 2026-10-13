import { Module } from '@nestjs/common';
import { AlarmsController } from './alarms/alarms.controller';
import { AuthModule } from './auth/auth.module';
import { DashboardController } from './dashboard/dashboard.controller';
import { DevicesController } from './devices/devices.controller';
import { DevicesService } from './devices/devices.service';
import { HealthController } from './health/health.controller';
import { PrismaModule } from './infra/prisma.module';
import { InternetController } from './internet/internet.controller';
import { InternetService } from './internet/internet.service';
import { SyncService } from './monitoring/sync.service';
import { WebhookController } from './monitoring/webhook.controller';
import { NotificationConfig } from './notifications/notification-config';
import { NotificationService } from './notifications/notification.service';
import { NotificationsController } from './notifications/notifications.controller';
import { RealtimeGateway } from './realtime/realtime.gateway';
import { IntegrationConfig } from './settings/integration-config';
import { SettingsController } from './settings/settings.controller';
import { TopologyController } from './topology/topology.controller';
import { UsersController } from './users/users.controller';
import { ProvisionService } from './zabbix/zabbix.provision';
import { ZabbixService } from './zabbix/zabbix.service';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [
    HealthController,
    DevicesController,
    AlarmsController,
    TopologyController,
    DashboardController,
    SettingsController,
    UsersController,
    WebhookController,
    NotificationsController,
    InternetController,
  ],
  providers: [
    ZabbixService,
    ProvisionService,
    RealtimeGateway,
    SyncService,
    DevicesService,
    IntegrationConfig,
    NotificationConfig,
    NotificationService,
    InternetService,
  ],
})
export class AppModule {}
