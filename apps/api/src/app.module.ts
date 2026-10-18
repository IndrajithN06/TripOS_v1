import { Global, Injectable, Module, NotFoundException, OnApplicationBootstrap } from '@nestjs/common';
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
import { PublicQuoteController } from './modules/quotes/public-quote.controller';
import { QUOTE_DELETED, QuotesService } from './modules/quotes/quotes.service';
import { VehiclesController } from './modules/vehicles/vehicles.module';
import { TemplatesController } from './modules/templates/templates.controller';
import { TemplatesService } from './modules/templates/templates.service';
import { EmbeddedSignupController } from './modules/whatsapp/embedded-signup.controller';
import { EmbeddedSignupService } from './modules/whatsapp/embedded-signup.service';
import { WhatsappAccountService } from './modules/whatsapp/whatsapp-account.service';
import { InboundService, SignupWebhooksController, WebhooksController } from './modules/webhooks/webhooks.module';
import { ProvidersModule } from './providers/providers.module';

@Injectable()
class WorkerBootstrap implements OnApplicationBootstrap {
  constructor(private readonly jobs: JobsService, private readonly quotes: QuotesService, private readonly whatsapp: WhatsappAccountService, private readonly signup: EmbeddedSignupService) {}
  onApplicationBootstrap() {
    // Retry only what is still failing; items already sent are skipped by idempotency in execute().
    this.jobs.register('quote.retry', async (j) => {
      try { await this.quotes.execute(j.agencyId, j.payload.versionId, null, { auto: true }); }
      catch (e) { if (e instanceof NotFoundException && (e.getResponse() as { code?: string })?.code === QUOTE_DELETED) return; throw e; } // deleted quote: nothing to send, nothing to reschedule
    });
    // Flag (never disconnect) any account tied to a Meta app that is not configured here, and say so if the migration is missing.
    if (config().NODE_ENV !== 'test') void this.whatsapp.auditAppIdentitiesSafely();
    if (config().NODE_ENV !== 'test' && process.env.JOBS_WORKER !== 'false') {
      this.jobs.start();
      setInterval(() => void this.quotes.expireOverdue().catch(() => undefined), 10 * 60 * 1000).unref();
      // Forget the encrypted token of any sign-up attempt that is past its deadline (same in-process timer pattern as above; idempotent).
      void this.signup.sweepExpiredAttemptsSafely();
      setInterval(() => void this.signup.sweepExpiredAttemptsSafely(), 5 * 60 * 1000).unref();
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
    AgencyController, EmbeddedSignupController, TemplatesController, PlatformController, VehiclesController, QuotesController, PublicQuoteController, InboxController, WebhooksController, SignupWebhooksController,
    DashboardController, AnalyticsController, HealthController, MediaController, DevController,
  ],
  providers: [
    PlatformService, WhatsappAccountService, EmbeddedSignupService, TemplatesService, QuotesService, OutboundService, InboxService, InboundService, AiService, DashboardService, AnalyticsService, WorkerBootstrap,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
