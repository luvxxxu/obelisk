import { Module } from '@nestjs/common';
import { AdminClaimController, AdminController } from './admin.controller';
import { NoticeService } from './notice.service';
import { AdminOrgsService } from './orgs.service';
import { StatusService } from './status.service';
import { AdminUsersService } from './users.service';

/** 서버 관리: the operator's screens. Settings, the log and server invites live in ServerModule. */
@Module({
  controllers: [AdminClaimController, AdminController],
  providers: [AdminUsersService, AdminOrgsService, StatusService, NoticeService],
})
export class AdminModule {}
