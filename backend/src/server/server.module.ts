import { Global, Module } from '@nestjs/common';
import { ServerInvitesService } from './invites.service';
import { AdminLogService } from './log.service';
import { ServerSettingsService } from './settings.service';

/**
 * Server-wide pieces every other module may need (sign-up reads the settings, creating an
 * organization checks who may). They depend on the database only, so nothing here can loop back.
 */
@Global()
@Module({
  providers: [ServerSettingsService, AdminLogService, ServerInvitesService],
  exports: [ServerSettingsService, AdminLogService, ServerInvitesService],
})
export class ServerModule {}
