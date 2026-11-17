import { Module } from '@nestjs/common';
import { PlannerModule } from '../planner/planner.module';
import { AlertsService } from './alerts.service';
import { DeliveryService } from './delivery.service';
import { IncomingService } from './incoming.service';
import { IncomingHooksController, IncomingWebhooksController, WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

@Module({
  imports: [PlannerModule],
  controllers: [WebhooksController, IncomingWebhooksController, IncomingHooksController],
  providers: [DeliveryService, WebhooksService, AlertsService, IncomingService],
})
export class WebhooksModule {}
