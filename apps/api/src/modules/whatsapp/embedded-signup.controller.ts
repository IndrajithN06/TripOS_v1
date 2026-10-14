import { Body, Controller, Get, Post } from '@nestjs/common';
import { z } from 'zod';
import { agencyOf, CurrentUser, parse, Principal, Roles } from '../../common/auth';
import { EmbeddedSignupService } from './embedded-signup.service';

const id = z.string().trim().min(1).max(64);
const startSchema = z.object({ requestSync: z.boolean().default(false) });
const completeSchema = z.object({
  attemptId: z.string().uuid(),
  state: z.string().trim().min(16).max(200),
  code: z.string().trim().min(1).max(2000).optional(),
  event: z.object({ type: z.string().trim().min(1).max(60), wabaId: id.optional(), phoneNumberId: id.optional(), businessId: id.optional() }),
  displayName: z.string().trim().min(2).max(80),
});

/**
 * Embedded Signup v4 (coexistence). Admin only; the agency always comes from the authenticated principal, never from the body.
 * Everything here is inert unless WHATSAPP_EMBEDDED_SIGNUP_ENABLED=true, and none of it touches the manual connection routes.
 */
@Roles('AGENCY_ADMIN')
@Controller('agency/whatsapp/embedded')
export class EmbeddedSignupController {
  constructor(private readonly signup: EmbeddedSignupService) {}

  @Get()
  settings(@CurrentUser() p: Principal) { return this.signup.settings(agencyOf(p)); }

  @Post('start')
  start(@CurrentUser() p: Principal, @Body() body: unknown) { return this.signup.start(agencyOf(p), p.userId, parse(startSchema, body ?? {})); }

  @Post('complete')
  complete(@CurrentUser() p: Principal, @Body() body: unknown) { return this.signup.complete(agencyOf(p), p.userId, parse(completeSchema, body)); }

  @Post('cancel')
  cancel(@CurrentUser() p: Principal, @Body() body: unknown) { return this.signup.cancel(agencyOf(p), p.userId, parse(z.object({ attemptId: z.string().uuid() }), body).attemptId); }
}
