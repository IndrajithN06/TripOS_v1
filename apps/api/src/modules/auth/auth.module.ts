import { BadRequestException, Body, Controller, Get, Inject, Injectable, Module, Post, Res, UnauthorizedException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import { Response } from 'express';
import { z } from 'zod';
import { audit } from '../../common/audit';
import { CurrentUser, PERMISSIONS, parse, Principal, Public, SESSION_COOKIE, signSession } from '../../common/auth';
import { decryptSecret, encryptSecret, randomToken, sha256 } from '../../common/crypto';
import { config } from '../../config/config';
import { Db, Tx } from '../../db/db.service';
import { AI, AiProvider } from '../../providers/ai/ai';
import { EMAIL, EmailProvider } from '../../providers/email/email';
import { STORAGE, StorageProvider } from '../../providers/storage/storage';
import { WHATSAPP, WhatsAppProvider } from '../../providers/whatsapp/whatsapp';

const INVITE_TTL_MS = 72 * 3600 * 1000;
export const passwordSchema = z.string().min(10, 'Password must be at least 10 characters').max(128);

@Injectable()
export class InviteService {
  constructor(@Inject(EMAIL) private readonly email: EmailProvider) {}

  /** Creates an invitation inside the caller's transaction; call `deliver` after commit. */
  async create(tx: Tx, user: { id: string; agencyId: string | null; email: string; name: string }, agencyName: string | null) {
    const token = randomToken();
    await tx.invitation.create({ data: { agencyId: user.agencyId, userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + INVITE_TTL_MS) } });
    const link = `${config().APP_URL}/accept-invite?token=${token}`;
    return { link, deliver: () => this.email.send({
      to: user.email, subject: `You're invited to ${agencyName ?? 'TripOS'}`,
      text: `Hello ${user.name},\n\nSet your password to get started: ${link}\n\nThis link expires in 72 hours.`,
    }) };
  }
}

@Injectable()
export class AuthService {
  constructor(private readonly db: Db, private readonly invites: InviteService) {}

  async login(email: string, password: string, mfaCode: string | undefined) {
    const user = await this.db.system((tx) => tx.user.findUnique({ where: { email: email.toLowerCase() } }));
    const ok = user?.passwordHash ? await bcrypt.compare(password, user.passwordHash) : await bcrypt.compare(password, '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvali');
    if (!user || !ok || user.status !== 'active') throw new UnauthorizedException({ code: 'invalid_credentials', message: 'Invalid email or password' });
    if (user.mfaEnabled) {
      if (!mfaCode) return { mfaRequired: true as const };
      if (!authenticator.check(mfaCode, decryptSecret(user.mfaSecret!))) throw new UnauthorizedException({ code: 'invalid_mfa', message: 'Invalid verification code' });
    }
    await this.db.system(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
      await audit(tx, { agencyId: user.agencyId, actorUserId: user.id, action: 'auth.login', entityType: 'user', entityId: user.id });
    });
    return { token: signSession(user), user };
  }

  async acceptInvite(token: string, password: string) {
    const inv = await this.db.system((tx) => tx.invitation.findUnique({ where: { tokenHash: sha256(token) } }));
    if (!inv || inv.usedAt || inv.expiresAt < new Date()) throw new BadRequestException({ code: 'invalid_invite', message: 'This invitation link is invalid or has expired' });
    const hash = await bcrypt.hash(password, 11);
    await this.db.system(async (tx) => {
      await tx.user.update({ where: { id: inv.userId }, data: { passwordHash: hash, status: 'active', tokenVersion: { increment: 1 } } });
      await tx.invitation.update({ where: { id: inv.id }, data: { usedAt: new Date() } });
      if (inv.agencyId) await tx.agency.updateMany({ where: { id: inv.agencyId, status: 'setup_pending' }, data: { status: 'active' } });
      await audit(tx, { agencyId: inv.agencyId, actorUserId: inv.userId, action: 'auth.invite_accepted', entityType: 'user', entityId: inv.userId });
    });
  }

  async mfaSetup(p: Principal) {
    const secret = authenticator.generateSecret();
    await this.db.system((tx) => tx.user.update({ where: { id: p.userId }, data: { mfaSecret: encryptSecret(secret), mfaEnabled: false } }));
    return { secret, otpauthUrl: authenticator.keyuri(p.email, 'TripOS', secret) };
  }

  async mfaEnable(p: Principal, code: string) {
    const u = await this.db.system((tx) => tx.user.findUniqueOrThrow({ where: { id: p.userId } }));
    if (!u.mfaSecret || !authenticator.check(code, decryptSecret(u.mfaSecret))) throw new BadRequestException({ code: 'invalid_mfa', message: 'Invalid verification code' });
    await this.db.system(async (tx) => {
      await tx.user.update({ where: { id: p.userId }, data: { mfaEnabled: true } });
      await audit(tx, { agencyId: p.agencyId, actorUserId: p.userId, action: 'auth.mfa_enabled', entityType: 'user', entityId: p.userId });
    });
  }
}

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1), mfaCode: z.string().optional() });

@Controller()
export class AuthController {
  constructor(
    private readonly auth: AuthService, private readonly db: Db,
    @Inject(STORAGE) private readonly storage: StorageProvider, @Inject(WHATSAPP) private readonly wa: WhatsAppProvider,
    @Inject(AI) private readonly ai: AiProvider,
  ) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('auth/login')
  async login(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const b = parse(loginSchema, body);
    const r = await this.auth.login(b.email, b.password, b.mfaCode);
    if ('mfaRequired' in r) return { mfaRequired: true };
    res.cookie(SESSION_COOKIE, r.token, { httpOnly: true, sameSite: 'lax', secure: config().isProd, maxAge: 12 * 3600 * 1000, path: '/' });
    return { ok: true, role: r.user.role };
  }

  @Post('auth/logout')
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('auth/accept-invite')
  async accept(@Body() body: unknown) {
    const b = parse(z.object({ token: z.string().min(10), password: passwordSchema }), body);
    await this.auth.acceptInvite(b.token, b.password);
    return { ok: true };
  }

  @Post('auth/mfa/setup')
  mfaSetup(@CurrentUser() p: Principal) { return this.auth.mfaSetup(p); }

  @Post('auth/mfa/enable')
  async mfaEnable(@CurrentUser() p: Principal, @Body() body: unknown) {
    await this.auth.mfaEnable(p, parse(z.object({ code: z.string().length(6) }), body).code);
    return { ok: true };
  }

  @Get('me')
  async me(@CurrentUser() p: Principal) {
    const agency = p.agencyId
      ? await this.db.tenant(p.agencyId, async (tx) => {
          const [a, b] = await Promise.all([tx.agency.findUnique({ where: { id: p.agencyId! } }), tx.agencyBranding.findUnique({ where: { agencyId: p.agencyId! } })]);
          const logo = b?.logoAssetId ? await tx.asset.findUnique({ where: { id: b.logoAssetId } }) : null;
          return a && { id: a.id, name: a.name, status: a.status, timezone: a.timezone, currency: a.currency, brandColour: b?.brandColour ?? '#157f58', logoUrl: logo ? await this.storage.signedUrl(logo.storageKey) : null, salesVisibility: a.salesVisibility };
        })
      : null;
    return {
      user: { id: p.userId, name: p.name, email: p.email, role: p.role, mfaEnabled: p.mfaEnabled, canOverrideRates: p.canOverrideRates },
      agency,
      permissions: PERMISSIONS[p.role],
      environment: {
        nodeEnv: config().NODE_ENV, whatsapp: this.wa.name, whatsappSimulated: this.wa.simulated,
        ai: this.ai.name, aiAvailable: this.ai.available, storage: this.storage.name,
      },
    };
  }
}

@Module({ controllers: [AuthController], providers: [AuthService, InviteService], exports: [InviteService] })
export class AuthModule {}
