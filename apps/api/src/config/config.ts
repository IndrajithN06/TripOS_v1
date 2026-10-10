import { z } from 'zod';

const bool = z.enum(['true', 'false']).default('false').transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_URL: z.string().url().default('http://localhost:3100'),
  API_URL: z.string().url().default('http://localhost:4100'),
  PORT: z.coerce.number().default(4100),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(16),
  APP_ENCRYPTION_KEY: z.string().min(16),
  AUTH_PROVIDER: z.enum(['password']).default('password'),

  STORAGE_PROVIDER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./storage'),
  STORAGE_SIGNING_SECRET: z.string().min(8).default('dev-only-storage-signing-secret'),
  STORAGE_ENDPOINT: z.string().optional(),
  STORAGE_BUCKET: z.string().optional(),
  STORAGE_REGION: z.string().optional(),
  STORAGE_ACCESS_KEY_ID: z.string().optional(),
  STORAGE_SECRET_ACCESS_KEY: z.string().optional(),

  WHATSAPP_PROVIDER: z.enum(['simulator', 'cloud']).default('simulator'),
  WHATSAPP_API_BASE_URL: z.string().default('https://graph.facebook.com/v21.0'),
  WHATSAPP_APP_ID: z.string().optional(),
  WHATSAPP_APP_SECRET: z.string().optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),

  AI_PROVIDER: z.enum(['mock', 'disabled', 'openai']).default('mock'),
  AI_MODEL: z.string().default('gpt-4o-mini'),
  AI_API_KEY: z.string().optional(),
  AI_TIMEOUT_MS: z.coerce.number().default(15000),

  EMAIL_PROVIDER: z.enum(['console', 'resend']).default('console'),
  EMAIL_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default('TripOS <no-reply@localhost>'),

  /** Explicit, loud opt-in required to run mock providers with NODE_ENV=production (e.g. a staging box). */
  ALLOW_MOCK_PROVIDERS_IN_PRODUCTION: bool,
  /** Seconds a signed media URL stays valid. */
  SIGNED_URL_TTL_SECONDS: z.coerce.number().default(300),
});

export type AppConfig = z.infer<typeof schema> & { isProd: boolean };

/** Pure so it can be unit-tested. Throws one error listing every problem. */
export function validateConfig(env: Record<string, string | undefined>): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(
      'Invalid configuration:\n' + parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n'),
    );
  }
  const c = parsed.data;
  const problems: string[] = [];
  if (c.NODE_ENV === 'production') {
    const allowMock = c.ALLOW_MOCK_PROVIDERS_IN_PRODUCTION;
    if (/dev-only|change-me/i.test(c.SESSION_SECRET) || c.SESSION_SECRET.length < 32) problems.push('SESSION_SECRET must be a unique random value of 32+ characters (not a development default)');
    if (/dev-only|change-me/i.test(c.APP_ENCRYPTION_KEY) || c.APP_ENCRYPTION_KEY.length < 32) problems.push('APP_ENCRYPTION_KEY must be a unique random value of 32+ characters (not a development default)');
    if (/dev-only/i.test(c.STORAGE_SIGNING_SECRET)) problems.push('STORAGE_SIGNING_SECRET must not be the development default');
    if (/tripos_app_dev_only|tripos_dev_only/.test(c.DATABASE_URL)) problems.push('DATABASE_URL uses development credentials');
    if (!c.APP_URL.startsWith('https://')) problems.push('APP_URL must be https in production');
    if (!c.API_URL.startsWith('https://')) problems.push('API_URL must be https in production');
    if (c.STORAGE_PROVIDER !== 's3') problems.push('STORAGE_PROVIDER must be "s3" in production (local disk storage is development-only)');
    if (c.STORAGE_PROVIDER === 's3') {
      for (const k of ['STORAGE_BUCKET', 'STORAGE_REGION', 'STORAGE_ACCESS_KEY_ID', 'STORAGE_SECRET_ACCESS_KEY'] as const) if (!c[k]) problems.push(`${k} is required for s3 storage`);
    }
    if (c.WHATSAPP_PROVIDER !== 'cloud' && !allowMock) problems.push('WHATSAPP_PROVIDER must be "cloud" in production (the simulator is development-only)');
    if (c.WHATSAPP_PROVIDER === 'cloud') {
      for (const k of ['WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN'] as const) if (!c[k]) problems.push(`${k} is required for the WhatsApp cloud provider`);
    }
    if (c.AI_PROVIDER === 'mock' && !allowMock) problems.push('AI_PROVIDER "mock" is not allowed in production; use "openai" or "disabled"');
    if (c.AI_PROVIDER === 'openai' && !c.AI_API_KEY) problems.push('AI_API_KEY is required when AI_PROVIDER=openai');
    if (c.EMAIL_PROVIDER === 'console' && !allowMock) problems.push('EMAIL_PROVIDER "console" is not allowed in production');
    if (c.EMAIL_PROVIDER === 'resend' && !c.EMAIL_API_KEY) problems.push('EMAIL_API_KEY is required when EMAIL_PROVIDER=resend');
  }
  if (c.AI_PROVIDER === 'openai' && !c.AI_API_KEY) problems.push('AI_API_KEY is required when AI_PROVIDER=openai');
  if (problems.length) throw new Error('Unsafe or incomplete configuration:\n' + problems.map((p) => `  - ${p}`).join('\n'));
  return { ...c, isProd: c.NODE_ENV === 'production' };
}

let cached: AppConfig | undefined;
export function config(): AppConfig {
  return (cached ??= validateConfig(process.env));
}
export function resetConfigForTests() {
  cached = undefined;
}
