import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { PricingError } from '@tripos/pricing';
import { config } from '../config/config';

/** Consistent error envelope: { error: { code, message, issues?, retryable?, needsNewCode? } }. No stack traces or internals leak. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly log = new Logger('Errors');

  catch(ex: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    const req = host.switchToHttp().getRequest();
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let body: any = { code: 'internal_error', message: 'Something went wrong' };

    if (ex instanceof HttpException) {
      status = ex.getStatus();
      const r = ex.getResponse() as any;
      body = typeof r === 'string' ? { code: 'error', message: r } : { code: r.code ?? 'error', message: r.message ?? ex.message, issues: r.issues, retryable: r.retryable, needsNewCode: r.needsNewCode };
      if (Array.isArray(body.message)) body.message = body.message.join('; ');
    } else if (ex instanceof PricingError) {
      status = 422;
      body = { code: 'pricing_error', message: ex.message };
    } else if ((ex as any)?.type === 'entity.too.large') {
      status = 413;
      body = { code: 'payload_too_large', message: 'The request body is too large' };
      this.log.error(`${req.method} ${String(req.url).split('?')[0]}: body of ${req.headers?.['content-length'] ?? 'unknown'} bytes exceeds the limit`);
    } else if ((ex as any)?.code === 'P2002') {
      status = 409;
      body = { code: 'conflict', message: 'A record with these details already exists' };
    } else if (/immutable|cannot be deleted/i.test(String((ex as any)?.message))) {
      status = 409;
      body = { code: 'immutable', message: 'This quote version has been sent and cannot be changed. Create a new version.' };
    } else {
      this.log.error(`${req.method} ${req.url}: ${(ex as Error)?.stack ?? ex}`);
      if (!config().isProd) body.detail = String((ex as Error)?.message);
    }
    res.status(status).json({ error: body });
  }
}
