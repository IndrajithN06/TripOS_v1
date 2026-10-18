import { Body, Controller, Delete, Get, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { z } from 'zod';
import { agencyOf, CurrentUser, parse, Principal, Roles } from '../../common/auth';
import { createSchema, draftSchema, patchSchema, QuotesService } from './quotes.service';

const iso = z.string().datetime({ offset: true });

@Roles('AGENCY_ADMIN', 'SALES')
@Controller('quotes')
export class QuotesController {
  constructor(private readonly svc: QuotesService) {}

  @Post('calculate')
  calculate(@CurrentUser() p: Principal, @Body() b: unknown) { return this.svc.calculate(p, agencyOf(p), parse(draftSchema, b)); }

  @Post()
  create(@CurrentUser() p: Principal, @Body() b: unknown) { return this.svc.create(p, agencyOf(p), parse(createSchema, b)); }

  @Get()
  list(@CurrentUser() p: Principal, @Query() q: Record<string, string>) {
    const f = parse(z.object({
      search: z.string().max(100).optional(), status: z.string().max(30).optional(), conversationId: z.string().uuid().optional(),
      page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20),
    }), q);
    return this.svc.list(p, agencyOf(p), f);
  }

  @Get(':id') get(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) { return this.svc.get(p, agencyOf(p), id); }

  @Patch(':id/draft')
  updateDraft(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) { return this.svc.updateDraft(p, agencyOf(p), id, parse(patchSchema, b)); }

  @Post(':id/versions')
  newVersion(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) { return this.svc.newVersion(p, agencyOf(p), id, parse(patchSchema, b ?? {})); }

  @Get(':id/diff')
  diff(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Query('from', ParseIntPipe) from: number, @Query('to', ParseIntPipe) to: number) { return this.svc.diff(p, agencyOf(p), id, from, to); }

  @Get(':id/versions/:n/preview')
  preview(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Param('n', ParseIntPipe) n: number) { return this.svc.preview(p, agencyOf(p), id, n); }

  @Get(':id/versions/:n/pdf')
  async pdf(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Param('n', ParseIntPipe) n: number, @Res() res: Response) {
    const r = await this.svc.pdf(p, agencyOf(p), id, n);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${r.filename}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(r.data);
  }

  @Post(':id/versions/:n/send')
  send(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Param('n', ParseIntPipe) n: number, @Body() b: unknown) {
    const body = parse(z.object({ followUpAt: iso.nullable().optional() }), b ?? {});
    return this.svc.send(p, agencyOf(p), id, n, body);
  }

  @Get(':id/versions/:n/templates')
  templateOptions(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Param('n', ParseIntPipe) n: number) { return this.svc.templateOptions(p, agencyOf(p), id, n); }

  @Post(':id/versions/:n/send-template')
  sendTemplate(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Param('n', ParseIntPipe) n: number, @Body() b: unknown) {
    const body = parse(z.object({ templateId: z.string().uuid(), includePdf: z.boolean().optional(), followUpAt: iso.nullable().optional(), approvedTotal: z.string().regex(/^\d+(\.\d{1,2})?$/).optional() }), b ?? {});
    return this.svc.sendWithTemplate(p, agencyOf(p), id, n, body);
  }

  @Post(':id/versions/:n/retry')
  retry(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Param('n', ParseIntPipe) n: number) { return this.svc.retry(p, agencyOf(p), id, n); }

  @Post(':id/status')
  status(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) {
    return this.svc.setStatus(p, agencyOf(p), id, parse(z.object({ status: z.enum(['draft', 'ready_to_send', 'negotiating', 'accepted', 'declined', 'expired']) }), b).status);
  }

  /** Soft delete. The optional reason is kept in the audit log only. */
  @Delete(':id')
  remove(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) {
    return this.svc.remove(p, agencyOf(p), id, parse(z.object({ reason: z.string().max(500).optional() }), b ?? {}).reason);
  }

  @Post(':id/duplicate')
  duplicate(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) { return this.svc.duplicate(p, agencyOf(p), id); }

  @Post(':id/follow-up')
  followUp(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) {
    return this.svc.setFollowUp(p, agencyOf(p), id, parse(z.object({ followUpAt: iso.nullable() }), b).followUpAt);
  }
}
