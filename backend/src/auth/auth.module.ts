import { Global, Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthGuard, SessionOnlyGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { MaintenanceService } from './maintenance.service';

@Global()
@Module({
  controllers: [AuthController],
  providers: [AuthService, AuthGuard, SessionOnlyGuard, MaintenanceService],
  exports: [AuthService, AuthGuard, SessionOnlyGuard],
})
export class AuthModule {}
