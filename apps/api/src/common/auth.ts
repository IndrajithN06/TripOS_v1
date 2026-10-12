import {
  BadRequestException, CanActivate, createParamDecorator, ExecutionContext, ForbiddenException, Injectable,
  SetMetadata, UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { config } from '../config/config';
import { Db } from '../db/db.service';

export type RoleName = 'SUPER_ADMIN' | 'AGENCY_ADMIN' | 'SALES';

export interface Principal {
  userId: string;
  /** Always taken from the authenticated token/DB row, never from request input. */
  agencyId: string | null;
  role: RoleName;
  name: string;
  email: string;
  canOverrideRates: boolean;
  mfaEnabled: boolean;
}

export const SESSION_COOKIE = 'tripos_session';

export const Public = () => SetMetadata('public', true);
export const Roles = (...roles: RoleName[]) => SetMetadata('roles', roles);
export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): Principal => ctx.switchToHttp().getRequest().principal);

/** Agency-scoped principal: guarantees agencyId is present. */
export function agencyOf(p: Principal): string {
  if (!p.agencyId) throw new ForbiddenException('This action requires an agency account');
  return p.agencyId;
}

export function signSession(user: { id: string; tokenVersion: number }, mfaPending = false) {
  return jwt.sign({ sub: user.id, tv: user.tokenVersion, mfa: mfaPending ? 'pending' : undefined }, config().SESSION_SECRET, { expiresIn: '12h' });
}

export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw new BadRequestException({
      code: 'validation_error',
      message: 'Request validation failed',
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}

export const PERMISSIONS: Record<RoleName, string[]> = {
  SUPER_ADMIN: ['platform.agencies.manage', 'platform.usage.view'],
  AGENCY_ADMIN: [
    'dashboard.full', 'users.manage', 'branding.manage', 'vehicles.manage', 'vehicles.read', 'whatsapp.manage', 'templates.manage',
    'inbox.use', 'quotes.use', 'quotes.view_all', 'settings.manage', 'ai.use', 'ai.usage.view',
  ],
  SALES: ['dashboard.limited', 'vehicles.read', 'inbox.use', 'quotes.use', 'ai.use'],
};

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly db: Db) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const handler = ctx.getHandler(), cls = ctx.getClass();
    if (this.reflector.getAllAndOverride<boolean>('public', [handler, cls])) return true;
    const req = ctx.switchToHttp().getRequest();
    const token = req.cookies?.[SESSION_COOKIE];
    if (!token) throw new UnauthorizedException({ code: 'unauthenticated', message: 'Sign in required' });
    let payload: any;
    try { payload = jwt.verify(token, config().SESSION_SECRET); } catch { throw new UnauthorizedException({ code: 'unauthenticated', message: 'Session expired' }); }

    const user = await this.db.system((tx) =>
      tx.user.findUnique({ where: { id: payload.sub } }).then(async (u) => {
        if (!u) return null;
        const agency = u.agencyId ? await tx.agency.findUnique({ where: { id: u.agencyId } }) : null;
        return { u, agency };
      }),
    );
    if (!user || user.u.status !== 'active' || user.u.tokenVersion !== payload.tv) throw new UnauthorizedException({ code: 'unauthenticated', message: 'Session no longer valid' });
    if (user.agency?.status === 'suspended') throw new ForbiddenException({ code: 'agency_suspended', message: 'This agency is suspended' });
    if (payload.mfa === 'pending') throw new UnauthorizedException({ code: 'mfa_required', message: 'MFA verification required' });

    // Super Admins in production must have MFA enrolled before touching anything except MFA setup.
    if (config().isProd && user.u.role === 'SUPER_ADMIN' && !user.u.mfaEnabled && !req.path.startsWith('/auth') && req.path !== '/me') {
      throw new ForbiddenException({ code: 'mfa_enrolment_required', message: 'Super Admin accounts must enable MFA' });
    }

    const principal: Principal = {
      userId: user.u.id, agencyId: user.u.agencyId, role: user.u.role as RoleName, name: user.u.name,
      email: user.u.email, canOverrideRates: user.u.canOverrideRates, mfaEnabled: user.u.mfaEnabled,
    };
    req.principal = principal;

    const roles = this.reflector.getAllAndOverride<RoleName[]>('roles', [handler, cls]);
    if (roles && !roles.includes(principal.role)) throw new ForbiddenException({ code: 'forbidden', message: 'You do not have access to this resource' });
    return true;
  }
}

/** CSRF defence for cookie-authenticated mutating calls: custom header + Origin check. */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;
    if (this.reflector.getAllAndOverride<boolean>('public', [ctx.getHandler(), ctx.getClass()]) && req.path.startsWith('/webhooks')) return true;
    if (req.headers['x-tripos-csrf'] !== '1') throw new ForbiddenException({ code: 'csrf', message: 'Missing CSRF header' });
    const origin = req.headers.origin;
    if (origin && origin !== config().APP_URL) throw new ForbiddenException({ code: 'csrf', message: 'Cross-origin request blocked' });
    return true;
  }
}
