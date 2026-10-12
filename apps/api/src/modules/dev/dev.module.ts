import { Body, Controller, Get, Inject, NotFoundException, Post, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { z } from 'zod';
import { agencyOf, CurrentUser, parse, Principal, Public, Roles } from '../../common/auth';
import { config } from '../../config/config';
import { Db } from '../../db/db.service';
import { AI, MockAi } from '../../providers/ai/ai';
import { ConsoleEmail } from '../../providers/email/email';
import { STORAGE, StorageProvider, verifyLocalSignature, LocalStorageProvider } from '../../providers/storage/storage';
import { SimulatorWhatsApp, WHATSAPP, WhatsAppProvider } from '../../providers/whatsapp/whatsapp';
import { JobsService } from '../jobs/jobs.service';
import { InboundService } from '../webhooks/webhooks.module';
import { promises as fs } from 'fs';
import path from 'path';

const MIME: Record<string, string> = { '.jpg': 'image/jpeg', '.png': 'image/png', '.pdf': 'application/pdf' };

/** Signed media delivery for the local storage adapter (S3 deployments use bucket-signed URLs instead). */
@Controller('media')
export class MediaController {
  constructor(@Inject(STORAGE) private readonly storage: StorageProvider) {}

  @Public()
  @Get('local')
  async serve(@Query('key') key: string, @Query('exp') exp: string, @Query('sig') sig: string, @Res() res: Response) {
    if (!(this.storage instanceof LocalStorageProvider) || !verifyLocalSignature(key, Number(exp), sig)) throw new NotFoundException();
    const data = await this.storage.get(key).catch(() => null);
    if (!data) throw new NotFoundException();
    res.setHeader('Content-Type', MIME[path.extname(key)] ?? 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(data);
  }
}

function assertSimulator(wa: WhatsAppProvider): SimulatorWhatsApp {
  if (config().isProd || !(wa instanceof SimulatorWhatsApp)) throw new NotFoundException();
  return wa;
}

/** Development-only tools. They do not exist (404) in production or when the real WhatsApp provider is configured. */
@Roles('AGENCY_ADMIN', 'SALES')
@Controller('dev')
export class DevController {
  constructor(
    private readonly db: Db, private readonly inbound: InboundService, private readonly jobs: JobsService,
    @Inject(WHATSAPP) private readonly wa: WhatsAppProvider,
  ) {}

  /** Injects a customer message through the SAME webhook pipeline as production. Tenant comes from the signed-in user's account. */
  @Post('simulator/inbound')
  async inbound_(@CurrentUser() p: Principal, @Body() body: unknown) {
    assertSimulator(this.wa);
    const b = parse(z.object({ from: z.string().regex(/^\+\d{8,15}$/), name: z.string().max(80).optional(), text: z.string().max(2000).optional(), type: z.enum(['text', 'image', 'document']).default('text') }), body);
    const acct = await this.db.tenant(agencyOf(p), (tx) => tx.whatsappAccount.findFirst({ where: { agencyId: p.agencyId! } }));
    if (!acct) throw new NotFoundException({ code: 'whatsapp_not_connected', message: 'Connect the (simulated) WhatsApp account first' });
    const id = `sim.in.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}`;
    const media = b.type === 'text' ? undefined : { id: `simmedia-${id}`, mime_type: b.type === 'image' ? 'image/png' : 'application/pdf', caption: b.text };
    const msg: any = { id, from: b.from.slice(1), timestamp: String(Math.floor(Date.now() / 1000)), type: b.type, ...(b.type === 'text' ? { text: { body: b.text ?? '' } } : { [b.type]: media }) };
    return this.inbound.process(this.wa.parseWebhook({ entry: [{ changes: [{ value: { metadata: { phone_number_id: acct.phoneNumberId }, contacts: [{ wa_id: b.from.slice(1), profile: { name: b.name } }], messages: [msg] } }] }] }));
  }

  @Post('simulator/status')
  async status(@CurrentUser() p: Principal, @Body() body: unknown) {
    assertSimulator(this.wa);
    const b = parse(z.object({ providerMessageId: z.string(), status: z.enum(['sent', 'delivered', 'read', 'failed']), errorMessage: z.string().optional() }), body);
    const acct = await this.db.tenant(agencyOf(p), (tx) => tx.whatsappAccount.findFirst({ where: { agencyId: p.agencyId! } }));
    if (!acct) throw new NotFoundException();
    const st: any = { id: b.providerMessageId, status: b.status, timestamp: String(Math.floor(Date.now() / 1000)), ...(b.status === 'failed' ? { errors: [{ code: 131000, title: b.errorMessage ?? '[simulated] delivery failed' }] } : {}) };
    return this.inbound.process(this.wa.parseWebhook({ entry: [{ changes: [{ value: { metadata: { phone_number_id: acct.phoneNumberId }, statuses: [st] } }] }] }));
  }

  /** Make the next N sends of a kind fail, to exercise partial-delivery and retry behaviour. */
  @Post('simulator/fail-next')
  failNext(@Body() body: unknown) {
    const sim = assertSimulator(this.wa);
    const b = parse(z.object({ kind: z.enum(['text', 'document', 'image', 'template']), count: z.number().int().min(0).max(20).default(1) }), body);
    sim.failNext[b.kind] = b.count;
    return { failNext: sim.failNext };
  }

  @Post('simulator/template-decision')
  async templateDecision(@CurrentUser() p: Principal, @Body() body: unknown) {
    assertSimulator(this.wa);
    const b = parse(z.object({ templateId: z.string().uuid(), status: z.enum(['pending', 'approved', 'rejected', 'paused']) }), body);
    return this.db.tenant(agencyOf(p), async (tx) => {
      const t = await tx.whatsappTemplate.findFirst({ where: { id: b.templateId, agencyId: p.agencyId! } });
      if (!t) throw new NotFoundException();
      return tx.whatsappTemplate.update({ where: { id: t.id }, data: { providerStatus: b.status } });
    });
  }

  @Post('simulator/ai-fail-next')
  aiFail() { assertSimulator(this.wa); MockAi.failNext = true; return { ok: true }; }

  @Post('jobs/tick')
  async tick() { assertSimulator(this.wa); return { ran: await this.jobs.tick() }; }

  @Get('emails')
  emails() { assertSimulator(this.wa); return ConsoleEmail.outbox.slice(-20); }
}
