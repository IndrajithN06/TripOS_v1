import { Controller, Get, Param, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Response } from 'express';
import { Public } from '../../common/auth';
import { QuotesService } from './quotes.service';

/** What a customer opens from the WhatsApp message. Authorised by the unguessable per-version token alone. */
@Public()
@Controller('public/quotes')
export class PublicQuoteController {
  constructor(private readonly svc: QuotesService) {}

  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @Get(':token')
  view(@Param('token') token: string) { return this.svc.publicView(token); }

  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Get(':token/pdf')
  async pdf(@Param('token') token: string, @Res() res: Response) {
    const f = await this.svc.publicPdf(token);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${f.filename}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(f.data);
  }
}
