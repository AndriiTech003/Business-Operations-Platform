import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { API_ROUTES, type RouteSpec } from '@bop/contracts';
import { DomainError, runInContext, type Core } from '@bop/core';
import type { NextFunction, Request, Response } from 'express';
import { CORE, type AuthedRequest } from './http';

const routeIndex = new Map<string, RouteSpec>(API_ROUTES.map((r) => [`${r.method} ${r.path}`, r]));

export function routeSpec(method: string, path: string): RouteSpec | undefined {
  return routeIndex.get(`${method.toUpperCase()} ${path}`);
}

function bearerOf(req: Request): string | null {
  const header = req.header('authorization');
  if (header !== undefined) {
    const m = /^Bearer\s+(.+)$/i.exec(header);
    if (m?.[1] !== undefined) return m[1].trim();
  }
  if (req.path === '/v1/notifications/stream' && typeof req.query['access_token'] === 'string')
    return req.query['access_token'];
  return null;
}

export function authMiddleware(core: Core) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    const token = bearerOf(req);
    if (token === null) {
      next();
      return;
    }
    core.accounts
      .authenticate(token)
      .then((p) => {
        req.principal = p;
        runInContext({ tenantId: p.tenantId, actor: p.actor, causation: [], scopes: p.scopes }, () => next());
      })
      .catch((error: unknown) => {
        if (error instanceof DomainError) {
          res
            .status(error.status)
            .type('application/problem+json')
            .json({
              type: `https://bop.dev/problems/${error.code}`,
              title: error.message,
              status: error.status,
              code: error.code,
            });
          return;
        }
        next(error);
      });
  };
}

@Injectable()
export class ScopeGuard implements CanActivate {
  constructor(@Inject(CORE) private readonly core: Core) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const path = (req.route as { path?: string } | undefined)?.path ?? req.path;
    const spec = routeSpec(req.method, path);
    if (spec === undefined)
      throw new DomainError(500, 'undocumented_route', `Route ${req.method} ${path} is not in API_ROUTES`);
    if (spec.auth === 'public') return true;
    const p = req.principal;
    if (p === undefined) throw new DomainError(401, 'unauthorized', 'Authentication required');
    if (spec.auth === 'user' && p.tokenId !== null && spec.scope === undefined) {
      if (spec.path === '/v1/api-tokens' || spec.path === '/v1/auth/switch-tenant')
        throw new DomainError(403, 'forbidden', 'This endpoint requires an interactive user session');
    }
    if (spec.scope !== undefined && !p.scopes.includes(spec.scope)) {
      throw new DomainError(403, 'insufficient_scope', `Missing scope ${spec.scope}`, {
        extra: { required: spec.scope },
      });
    }
    return true;
  }
}
