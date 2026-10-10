import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '../../common/auth';
import { Db } from '../../db/db.service';
import { STORAGE, StorageProvider } from '../../providers/storage/storage';

@Controller('health')
export class HealthController {
  constructor(private readonly db: Db, @Inject(STORAGE) private readonly storage: StorageProvider) {}

  /** Liveness: the process is up. */
  @Public() @Get() live() { return { status: 'ok' }; }

  /** Readiness: critical dependencies respond. Reports component names only, never connection details. */
  @Public()
  @Get('ready')
  async ready() {
    const checks: Record<string, string> = {};
    try { await this.db.ping(); checks.database = 'ok'; } catch { checks.database = 'down'; }
    try { await this.storage.signedUrl('healthcheck'); checks.storage = 'ok'; } catch { checks.storage = 'down'; }
    if (Object.values(checks).includes('down')) throw new ServiceUnavailableException({ status: 'degraded', checks });
    return { status: 'ready', checks };
  }
}
