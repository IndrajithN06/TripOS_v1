import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Db } from '../../db/db.service';

export type JobHandler = (job: { id: string; agencyId: string; payload: any; attempts: number }) => Promise<void>;

/**
 * Minimal durable queue on PostgreSQL (SKIP LOCKED). Same semantics we need from BullMQ for V1
 * (delay, retry with exponential backoff, failure visibility) without another piece of infrastructure.
 * The `JobsService` interface is the seam for swapping in BullMQ/SQS later.
 */
@Injectable()
export class JobsService implements OnModuleDestroy {
  private readonly log = new Logger('Jobs');
  private readonly handlers = new Map<string, JobHandler>();
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly db: Db) {}

  register(type: string, h: JobHandler) { this.handlers.set(type, h); }

  async enqueue(agencyId: string, type: string, payload: object, opts: { delayMs?: number; maxAttempts?: number } = {}) {
    // De-duplicate identical pending jobs so repeated failures do not pile up.
    return this.db.tenant(agencyId, async (tx) => {
      const dup = await tx.job.findFirst({ where: { agencyId, type, status: 'pending', payload: { equals: payload as any } } });
      if (dup) return dup;
      return tx.job.create({ data: { agencyId, type, payload: payload as any, runAt: new Date(Date.now() + (opts.delayMs ?? 0)), maxAttempts: opts.maxAttempts ?? 4 } });
    });
  }

  start(intervalMs = 5000) {
    this.timer = setInterval(() => void this.tick().catch((e) => this.log.error(e)), intervalMs);
    this.log.log(`Worker started (poll ${intervalMs}ms)`);
  }

  /** Claims and runs due jobs; exported so tests and the dev UI can drive it deterministically. */
  async tick(limit = 10): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let n = 0;
    try {
      for (; n < limit; n++) {
        const job = await this.db.system(async (tx) => {
          const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Job" WHERE status = 'pending' AND "runAt" <= now() ORDER BY "runAt" LIMIT 1 FOR UPDATE SKIP LOCKED`;
          if (!rows.length) return null;
          return tx.job.update({ where: { id: rows[0].id }, data: { status: 'running', attempts: { increment: 1 } } });
        });
        if (!job) break;
        const h = this.handlers.get(job.type);
        try {
          if (!h) throw new Error(`No handler for ${job.type}`);
          await h({ id: job.id, agencyId: job.agencyId, payload: job.payload, attempts: job.attempts });
          await this.db.system((tx) => tx.job.update({ where: { id: job.id }, data: { status: 'done', lastError: null } }));
        } catch (e) {
          const final = job.attempts >= job.maxAttempts;
          this.log.warn(`Job ${job.type} ${job.id} failed (attempt ${job.attempts}): ${(e as Error).message}`);
          await this.db.system((tx) => tx.job.update({
            where: { id: job.id },
            data: { status: final ? 'failed' : 'pending', lastError: (e as Error).message.slice(0, 500), runAt: new Date(Date.now() + 60_000 * 2 ** job.attempts) },
          }));
        }
      }
    } finally { this.running = false; }
    return n;
  }

  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }
}
