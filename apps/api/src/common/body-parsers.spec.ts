import { createHmac } from 'crypto';
import express from 'express';
import request from 'supertest';
import { validateConfig } from '../config/config';
import { verifyMetaSignature } from '../providers/whatsapp/signature';
import { installJsonParsers } from './body-parsers';
import { AllExceptionsFilter } from './errors';

// Real express + the real parser installer. Proves: webhook routes accept larger bodies than the 1 MB default, the RAW body is still
// captured byte-for-byte so signatures verify, other routes keep the 1 MB limit, and oversize bodies are refused with 413.
const SECRET = 'unit-test-webhook-secret';
const MB = 1024 * 1024;
const sign = (raw: string) => `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}`;
const payloadOfAbout = (bytes: number) => JSON.stringify({ object: 'whatsapp_business_account', pad: 'a'.repeat(bytes) });

function makeApp(webhookLimit = 4 * MB) {
  const app = express();
  installJsonParsers(app, webhookLimit);
  const handler = (req: any, res: any) => res.json({ rawLength: req.rawBody?.length ?? 0, signatureValid: verifyMetaSignature(req.rawBody ?? Buffer.alloc(0), req.headers['x-hub-signature-256'], SECRET), parsedPad: typeof req.body?.pad === 'string' ? req.body.pad.length : 0 });
  app.post('/webhooks/whatsapp', handler);
  app.post('/webhooks/whatsapp/signup', handler);
  app.post('/agency/anything', handler);
  app.use((err: any, _req: any, res: any, _next: any) => res.status(err.status ?? 500).json({ type: err.type }));
  return app;
}
const post = (app: express.Express, path: string, raw: string, withSignature = true) => {
  const r = request(app).post(path).set('Content-Type', 'application/json');
  if (withSignature) r.set('x-hub-signature-256', sign(raw));
  return r.send(raw);
};

describe('webhook body limit (documented payloads of up to 3 MB)', () => {
  it('accepts a 2.5 MB webhook on both webhook routes, keeps the raw body exactly, and the signature still verifies', async () => {
    const app = makeApp();
    const raw = payloadOfAbout(2.5 * MB);
    for (const route of ['/webhooks/whatsapp', '/webhooks/whatsapp/signup']) {
      const r = await post(app, route, raw);
      expect(r.status).toBe(200);
      expect(r.body.rawLength).toBe(Buffer.byteLength(raw)); // byte-for-byte, so HMAC verification is possible
      expect(r.body.signatureValid).toBe(true);
      expect(r.body.parsedPad).toBe(Math.floor(2.5 * MB)); // and it was parsed normally too
    }
  });
  it('a tampered large webhook fails its signature (raw-body verification is not weakened)', async () => {
    const app = makeApp();
    const raw = payloadOfAbout(2 * MB);
    const r = await request(app).post('/webhooks/whatsapp').set('Content-Type', 'application/json').set('x-hub-signature-256', sign(raw)).send(raw.replace('"a', '"b'));
    expect(r.status).toBe(200);
    expect(r.body.signatureValid).toBe(false);
  });
  it('a webhook above the configured limit is refused with 413 (never partially read)', async () => {
    const app = makeApp(4 * MB);
    const r = await post(app, '/webhooks/whatsapp', payloadOfAbout(4.5 * MB));
    expect(r.status).toBe(413);
    expect(r.body.type).toBe('entity.too.large');
  });
  it('every NON-webhook route keeps the 1 MB limit (no global loosening)', async () => {
    const app = makeApp();
    expect((await post(app, '/agency/anything', payloadOfAbout(0.5 * MB), false)).status).toBe(200);
    expect((await post(app, '/agency/anything', payloadOfAbout(2 * MB), false)).status).toBe(413);
  });
  it('the limit is configurable but bounded and defaults to 4 MiB', () => {
    const base = { DATABASE_URL: 'x', SESSION_SECRET: 'unit-test-session-secret-0123456789', APP_ENCRYPTION_KEY: 'unit-test-encryption-key-0123456789' };
    expect(validateConfig(base).WHATSAPP_WEBHOOK_MAX_BODY_BYTES).toBe(4 * MB);
    expect(validateConfig({ ...base, WHATSAPP_WEBHOOK_MAX_BODY_BYTES: String(10 * MB) }).WHATSAPP_WEBHOOK_MAX_BODY_BYTES).toBe(10 * MB);
    expect(() => validateConfig({ ...base, WHATSAPP_WEBHOOK_MAX_BODY_BYTES: String(MB - 1) })).toThrow(/WHATSAPP_WEBHOOK_MAX_BODY_BYTES/); // never below the default 1 MB
    expect(() => validateConfig({ ...base, WHATSAPP_WEBHOOK_MAX_BODY_BYTES: String(26 * MB) })).toThrow(/WHATSAPP_WEBHOOK_MAX_BODY_BYTES/); // hard ceiling: 25 MiB
  });
});

describe('oversize bodies are reported as 413, not as an internal error', () => {
  it('maps the body-parser error to 413 payload_too_large without leaking details', () => {
    const sent: any = {};
    const res: any = { status: (c: number) => { sent.status = c; return res; }, json: (b: any) => { sent.body = b; } };
    const host: any = { switchToHttp: () => ({ getResponse: () => res, getRequest: () => ({ method: 'POST', url: '/webhooks/whatsapp?x=1', headers: { 'content-length': '5000000' } }) }) };
    new AllExceptionsFilter().catch(Object.assign(new Error('request entity too large'), { type: 'entity.too.large', status: 413 }), host);
    expect(sent.status).toBe(413);
    expect(sent.body).toEqual({ error: { code: 'payload_too_large', message: 'The request body is too large' } });
  });
});
