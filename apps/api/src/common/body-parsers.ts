import { json } from 'express';

const captureRaw = (req: any, _res: any, buf: Buffer) => { req.rawBody = buf; };

/**
 * JSON body parsing with the RAW body kept for webhook signature verification.
 * /webhooks/* gets its own limit (Meta documents payloads of up to 3 MB); every other route keeps 1 MB. The first parser that
 * handles a request marks it parsed, so the second never re-reads it. Rate limiting is untouched (see docs).
 */
export function installJsonParsers(app: { use: (...args: any[]) => unknown }, webhookLimitBytes: number) {
  app.use('/webhooks', json({ limit: webhookLimitBytes, verify: captureRaw }));
  app.use(json({ limit: '1mb', verify: captureRaw }));
}
