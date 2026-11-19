import { Global, Module } from '@nestjs/common';
import { AccountService } from './account.service';
import { AuthController } from './auth.controller';
import { AuthGuard, SessionOnlyGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { MaintenanceService } from './maintenance.service';

@Global()
@Module({
  controllers: [AuthController],
  providers: [AuthService, AccountService, AuthGuard, SessionOnlyGuard, MaintenanceService],
  exports: [AuthService, AuthGuard, SessionOnlyGuard],
})
export class AuthModule {}
