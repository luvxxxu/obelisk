import { Global, Module } from '@nestjs/common';
import { AccessService } from './access.service';
import { ActivityService } from './activity.service';
import { InvitesController, WorkspacesController } from './workspaces.controller';
import { WorkspacesService } from './workspaces.service';

@Global()
@Module({
  controllers: [WorkspacesController, InvitesController],
  providers: [AccessService, ActivityService, WorkspacesService],
  exports: [AccessService, ActivityService, WorkspacesService],
})
export class WorkspaceModule {}
