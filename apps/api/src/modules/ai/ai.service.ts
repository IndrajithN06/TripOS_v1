import { HttpException, HttpStatus, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Principal } from '../../common/auth';
import { Db } from '../../db/db.service';
import { AI, AiFeature, AiOutputError, AiProvider, AiResponse, AiUnavailableError } from '../../providers/ai/ai';
import { AI_KILL_KEY } from '../platform/platform.module';
import { buildSystemPrompt, parseAiOutput } from './ai-contracts';

const MAX_CONTEXT_MESSAGES = 30;
const clip = (s: unknown, n: number) => String(s ?? '').slice(0, n);

/**
 * Usage rows that count toward an agency's monthly limit: every call the provider answered, because each one cost real tokens.
 * 'invalid_output' (an answer TripOS rejected) counts like 'ok'; otherwise retrying calls that keep failing validation would be
 * billed but never capped. 'error' (the provider could not be reached) is recorded with zero tokens and does not count.
 */
const COUNTED_STATUSES = ['ok', 'invalid_output'];

@Injectable()
export class AiService {
  private readonly log = new Logger('AiService');
  constructor(private readonly db: Db, @Inject(AI) private readonly provider: AiProvider) {}

  private unavailable(message: string, code = 'ai_unavailable'): never {
    throw new HttpException({ code, message }, 503);
  }

  /**
   * The provider answered but the answer is unusable (cut off, not JSON, or not the shape this feature promises). The caller gets a
   * clear 502 and nothing is shown, saved or sent. Only problem codes and field names are logged, never model text or customer data.
   */
  private badOutput(feature: AiFeature, e: AiOutputError): never {
    this.log.warn(`AI output rejected feature=${feature} problem=${e.problem}${e.fields.length ? ` fields=${e.fields.join(',')}` : ''}`);
    throw new HttpException({
      code: 'ai_bad_output',
      message: 'The AI returned an answer TripOS could not use, so nothing was changed. Please try again, or continue manually. If this keeps happening, tell your TripOS administrator.',
    }, HttpStatus.BAD_GATEWAY);
  }

  /** Runs one AI feature. Every failure mode degrades to an error the UI can ignore; nothing else depends on AI. */
  async run(p: Principal, agencyId: string, feature: AiFeature, conversationId: string, extra: { quoteId?: string; customerMessage?: string } = {}) {
    const ctx = await this.db.tenant(agencyId, async (tx) => {
      const [agency, kill, used] = await Promise.all([
        tx.agency.findUniqueOrThrow({ where: { id: agencyId } }),
        this.db.system((s) => s.platformSetting.findUnique({ where: { key: AI_KILL_KEY } })),
        tx.aiUsage.count({ where: { agencyId, status: { in: COUNTED_STATUSES }, createdAt: { gte: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)) } } }),
      ]);
      const conv = await tx.conversation.findFirst({ where: { id: conversationId, agencyId } });
      if (!conv) throw new NotFoundException({ code: 'not_found', message: 'Conversation not found' });
      const msgs = await tx.message.findMany({ where: { agencyId, conversationId, text: { not: null } }, orderBy: { createdAt: 'desc' }, take: MAX_CONTEXT_MESSAGES });
      const vehicles = await tx.vehicleType.findMany({ where: { agencyId, active: true }, select: { name: true } });
      let quote: Record<string, unknown> | undefined;
      if (extra.quoteId) {
        const q = await tx.quote.findFirst({ where: { id: extra.quoteId, agencyId, deletedAt: null } });
        const v = q?.currentVersionId ? await tx.quoteVersion.findFirst({ where: { id: q.currentVersionId, agencyId } }) : null;
        if (v) quote = { vehicle: v.vehicleName, total: v.total.toString(), version: v.versionNumber };
      }
      return { agency, killed: (kill?.value as any)?.on === true, used, conv, msgs: msgs.reverse(), vehicles, quote };
    });

    if (ctx.killed) this.unavailable('AI assistance is temporarily disabled platform-wide', 'ai_kill_switch');
    if (!ctx.agency.aiEnabled) this.unavailable('AI assistance is turned off for this agency', 'ai_disabled');
    if (ctx.agency.aiMonthlyLimit > 0 && ctx.used >= ctx.agency.aiMonthlyLimit) this.unavailable('Monthly AI limit reached for this agency', 'ai_limit_reached');
    if (!this.provider.available) this.unavailable('AI is not configured in this environment');

    const messages = ctx.msgs.map((m) => ({ from: (m.direction === 'inbound' ? 'customer' : 'staff') as 'customer' | 'staff', text: clip(m.text, 1000) }));
    if (extra.customerMessage) messages.push({ from: 'customer', text: clip(extra.customerMessage, 1000) });
    const feat: AiFeature = feature;

    let r: AiResponse;
    try {
      r = await this.provider.generate({ feature: feat, system: buildSystemPrompt(feat), input: { messages, vehicleTypes: ctx.vehicles.map((v) => v.name), quote: ctx.quote } });
    } catch (e) {
      if (e instanceof AiOutputError) {
        // The provider answered, so the call was billed: keep the real token counts. It counts toward the monthly limit like an 'ok' call.
        await this.record(agencyId, p.userId, feat, e.usage?.model ?? this.provider.name, e.usage?.inputTokens ?? 0, e.usage?.outputTokens ?? 0, 'invalid_output');
        this.badOutput(feat, e);
      }
      await this.record(agencyId, p.userId, feat, this.provider.name, 0, 0, 'error');
      if (e instanceof AiUnavailableError) this.unavailable('The AI service is currently unavailable. You can continue manually.');
      this.unavailable('The AI service returned an unusable response. You can continue manually.');
    }

    let output: any;
    try {
      output = parseAiOutput(feat, r.output);
    } catch (e) {
      if (e instanceof AiOutputError) {
        await this.record(agencyId, p.userId, feat, r.model, r.inputTokens, r.outputTokens, 'invalid_output');
        this.badOutput(feat, e);
      }
      throw e;
    }

    await this.record(agencyId, p.userId, feat, r.model, r.inputTokens, r.outputTokens, 'ok');
    if (feat === 'summary') {
      await this.db.tenant(agencyId, (tx) => tx.conversation.update({ where: { id: conversationId }, data: { summary: output.summary, summaryAt: new Date() } }));
    }
    return { feature: feat, generatedAt: new Date().toISOString(), provider: this.provider.name, simulated: this.provider.name === 'mock', draft: true, output };
  }

  private record(agencyId: string, userId: string, feature: string, model: string, inputTokens: number, outputTokens: number, status: string) {
    // Rough cost estimate in USD; rates are illustrative and should be set from the provider's price sheet.
    const estimatedCost = ((inputTokens * 0.15 + outputTokens * 0.6) / 1_000_000).toFixed(6);
    return this.db.tenant(agencyId, (tx) => tx.aiUsage.create({ data: { agencyId, userId, feature, model, inputTokens, outputTokens, estimatedCost, status } }));
  }
}
