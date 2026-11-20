import { Global, Module } from '@nestjs/common';
import { AccountService } from './account.service';
import { AuthController } from './auth.controller';
import { AdminGuard, AuthGuard, SessionOnlyGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { EmailService } from './email.service';
import { MaintenanceService } from './maintenance.service';

@Global()
@Module({
  controllers: [AuthController],
  providers: [AuthService, AccountService, EmailService, AuthGuard, SessionOnlyGuard, AdminGuard, MaintenanceService],
  exports: [AuthService, AccountService, EmailService, AuthGuard, SessionOnlyGuard, AdminGuard],
})
export class AuthModule {}
