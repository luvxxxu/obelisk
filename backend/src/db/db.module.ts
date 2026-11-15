import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { config } from '../config';
import * as schema from './schema';

export type Db = PostgresJsDatabase<typeof schema>;
export const DB = Symbol('DB');
export const InjectDb = () => Inject(DB);

const client = postgres(config.databaseUrl, { max: 10, onnotice: () => {} });
export const db: Db = drizzle(client, { schema });

export async function runMigrations() {
  await migrate(db, { migrationsFolder: config.migrationsDir });
}

@Global()
@Module({
  providers: [{ provide: DB, useValue: db }],
  exports: [DB],
})
export class DbModule implements OnApplicationShutdown {
  async onApplicationShutdown() {
    await client.end({ timeout: 5 });
  }
}
