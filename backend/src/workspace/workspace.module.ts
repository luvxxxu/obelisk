import { Global, Module } from '@nestjs/common';
import { ReservationsService } from '../migration/reservations.service';
import { AccessService } from './access.service';
import { ActivityService } from './activity.service';
import { AvatarsController } from './avatars.controller';
import { AvatarsService } from './avatars.service';
import { InvitesController, WorkspacesController } from './workspaces.controller';
import { WorkspacesService } from './workspaces.service';

@Global()
@Module({
  controllers: [WorkspacesController, InvitesController, AvatarsController],
  providers: [AccessService, ActivityService, WorkspacesService, AvatarsService, ReservationsService],
  exports: [AccessService, ActivityService, WorkspacesService, AvatarsService, ReservationsService],
})
export class WorkspaceModule {}
