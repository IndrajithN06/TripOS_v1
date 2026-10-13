import { Global, Injectable, Module, OnApplicationBootstrap } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AssetService } from './common/assets';
import { AuthGuard, CsrfGuard } from './common/auth';
import { AllExceptionsFilter } from './common/errors';
import { config } from './config/config';
import { DbModule } from './db/db.service';
import { AiService } from './modules/ai/ai.service';
import { AgencyController } from './modules/agency/agency.module';
import { AuthModule } from './modules/auth/auth.module';
import { AnalyticsController, AnalyticsService } from './modules/dashboard/analytics.module';
import { DashboardController, DashboardService } from './modules/dashboard/dashboard.module';
import { DevController, MediaController } from './modules/dev/dev.module';
import { HealthController } from './modules/health/health.controller';
import { InboxController, InboxService } from './modules/inbox/inbox.module';
import { OutboundService } from './modules/inbox/outbound.service';
import { JobsService } from './modules/jobs/jobs.service';
import { PlatformController, PlatformService } from './modules/platform/platform.module';
import { QuotesController } from './modules/quotes/quotes.controller';
import { QuotesService } from './modules/quotes/quotes.service';
import { VehiclesController } from './modules/vehicles/vehicles.module';
import { WhatsappAccountService } from './modules/whatsapp/whatsapp-account.service';
import { InboundService, WebhooksController } from './modules/webhooks/webhooks.module';
import { ProvidersModule } from './providers/providers.module';

@Injectable()
class WorkerBootstrap implements OnApplicationBootstrap {
  constructor(private readonly jobs: JobsService, private readonly quotes: QuotesService, private readonly whatsapp: WhatsappAccountService) {}
  onApplicationBootstrap() {
    // Retry only what is still failing; items already sent are skipped by idempotency in execute().
    this.jobs.register('quote.retry', async (j) => { await this.quotes.execute(j.agencyId, j.payload.versionId, null, { auto: true }); });
    if (config().NODE_ENV !== 'test' && process.env.JOBS_WORKER !== 'false') {
      this.jobs.start();
      setInterval(() => void this.quotes.expireOverdue().catch(() => undefined), 10 * 60 * 1000).unref();
      // Real WhatsApp only: re-check token validity, quality rating and limits for every connected number.
      if (config().WHATSAPP_PROVIDER === 'cloud') setInterval(() => void this.whatsapp.checkAll().catch(() => undefined), 15 * 60 * 1000).unref();
    }
  }
}

@Global()
@Module({ providers: [AssetService, JobsService], exports: [AssetService, JobsService] })
class CoreModule {}

@Module({
  imports: [
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 600, skipIf: () => config().NODE_ENV === 'test' }]),
    DbModule, ProvidersModule, CoreModule, AuthModule,
  ],
  controllers: [
    AgencyController, PlatformController, VehiclesController, QuotesController, InboxController, WebhooksController,
    DashboardController, AnalyticsController, HealthController, MediaController, DevController,
  ],
  providers: [
    PlatformService, WhatsappAccountService, QuotesService, OutboundService, InboxService, InboundService, AiService, DashboardService, AnalyticsService, WorkerBootstrap,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
