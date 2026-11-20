import { Global, Module } from '@nestjs/common';
import { AccessService } from './access.service';
import { ActivityService } from './activity.service';
import { AvatarsController } from './avatars.controller';
import { AvatarsService } from './avatars.service';
import { InvitesController, WorkspacesController } from './workspaces.controller';
import { WorkspacesService } from './workspaces.service';

@Global()
@Module({
  controllers: [WorkspacesController, InvitesController, AvatarsController],
  providers: [AccessService, ActivityService, WorkspacesService, AvatarsService],
  exports: [AccessService, ActivityService, WorkspacesService, AvatarsService],
})
export class WorkspaceModule {}
