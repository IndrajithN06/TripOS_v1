import { Global, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

export type Tx = Prisma.TransactionClient;

/**
 * All database access goes through one of two explicit contexts:
 *  - tenant(agencyId, fn): runs in a transaction with `app.agency_id` set, so PostgreSQL row-level
 *    security restricts every statement to that agency even if a WHERE clause is forgotten.
 *  - system(fn): trusted platform code only (login, webhook tenant resolution, platform console, workers).
 */
@Injectable()
export class Db implements OnModuleDestroy {
  readonly client = new PrismaClient();

  tenant<T>(agencyId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    if (!/^[0-9a-f-]{36}$/i.test(agencyId)) throw new Error('Invalid tenant id');
    return this.client.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.agency_id', ${agencyId}, true)`;
        return fn(tx);
      },
      { timeout: 20000 },
    );
  }

  system<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.client.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.bypass', 'on', true)`;
        return fn(tx);
      },
      { timeout: 20000 },
    );
  }

  async ping() {
    await this.client.$queryRaw`SELECT 1`;
  }

  async onModuleDestroy() {
    await this.client.$disconnect();
  }
}

@Global()
@Module({ providers: [Db], exports: [Db] })
export class DbModule {}
