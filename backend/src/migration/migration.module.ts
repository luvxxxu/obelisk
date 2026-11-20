import { Module } from '@nestjs/common';
import { ExportService } from './export.service';
import { ImportService } from './import.service';
import { MigrationController, MigrationPullController } from './migration.controller';
import { ReservationsController } from './reservations.controller';
import { TransferService } from './transfer.service';

/** 데이터 이전 between servers. ReservationsService lives in WorkspaceModule (invites and sign-up use it). */
@Module({
  controllers: [MigrationController, MigrationPullController, ReservationsController],
  providers: [ExportService, ImportService, TransferService],
})
export class MigrationModule {}
