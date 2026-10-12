import 'reflect-metadata';
import { INestApplication, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { json, urlencoded } from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { config } from './config/config';

/** Shared HTTP setup, also used by tests that build the app from a testing module with overridden providers. */
export function configureApp<T extends INestApplication>(app: T): T {
  const cfg = config();
  // Raw body is kept for WhatsApp webhook signature verification.
  app.use(json({ limit: '1mb', verify: (req: any, _res, buf) => { req.rawBody = buf; } }));
  app.use(urlencoded({ extended: false, limit: '100kb' }));
  app.use(cookieParser());
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.enableCors({ origin: cfg.APP_URL, credentials: true });
  app.getHttpAdapter().getInstance().set('trust proxy', 1);
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  return app;
}

export async function createApp() {
  const cfg = config(); // fails fast with a precise message on unsafe/incomplete configuration
  const app = await NestFactory.create(AppModule, { bodyParser: false, logger: cfg.NODE_ENV === 'test' ? false : undefined });
  return configureApp(app);
}

async function bootstrap() {
  const app = await createApp();
  const cfg = config();
  await app.listen(cfg.PORT);
  const log = new Logger('Bootstrap');
  log.log(`TripOS API on :${cfg.PORT} (${cfg.NODE_ENV}) storage=${cfg.STORAGE_PROVIDER} whatsapp=${cfg.WHATSAPP_PROVIDER} ai=${cfg.AI_PROVIDER}`);
  if (cfg.WHATSAPP_PROVIDER === 'simulator') log.warn('WhatsApp SIMULATOR active: no real messages are sent.');
}

if (require.main === module) {
  void bootstrap().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
