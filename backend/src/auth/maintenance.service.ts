import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { and, isNotNull, lt, or } from 'drizzle-orm';
import { InjectDb, type Db } from '../db/db.module';
import { emailTokens, migrationCodes, oauthCodes, oauthGrants, passwordResets, sessions } from '../db/schema';

/** Hourly sweep of expired credentials so the tables don't grow forever. */
@Injectable()
export class MaintenanceService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;

  constructor(@InjectDb() private readonly db: Db) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.sweep().catch(() => {}), 60 * 60_000);
    this.timer.unref?.();
    void this.sweep().catch(() => {});
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep() {
    const now = new Date();
    const weekAgo = new Date(Date.now() - 7 * 86_400_000);
    await this.db.delete(sessions).where(lt(sessions.expiresAt, now));
    await this.db.delete(passwordResets).where(lt(passwordResets.expiresAt, new Date(Date.now() - 86_400_000)));
    await this.db.delete(migrationCodes).where(lt(migrationCodes.expiresAt, new Date(Date.now() - 86_400_000)));
    await this.db.delete(emailTokens).where(lt(emailTokens.expiresAt, new Date(Date.now() - 86_400_000)));
    await this.db.delete(oauthCodes).where(lt(oauthCodes.expiresAt, weekAgo));
    await this.db
      .delete(oauthGrants)
      .where(
        or(
          lt(oauthGrants.refreshExpiresAt, now),
          and(isNotNull(oauthGrants.revokedAt), lt(oauthGrants.revokedAt, weekAgo)),
        ),
      );
  }
}
