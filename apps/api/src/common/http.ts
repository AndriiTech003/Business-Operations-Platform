import { Body, Query, type PipeTransform } from '@nestjs/common';
import { badRequest, DomainError, type Principal } from '@bop/core';
import type { Request, Response } from 'express';
import type { ZodType } from 'zod';

export const CORE = Symbol('CORE');

export interface AuthedRequest extends Request {
  principal?: Principal;
}

export class ZodPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value ?? {});
    if (!result.success) {
      throw new DomainError(400, 'validation_failed', 'Request validation failed', {
        errors: result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      });
    }
    return result.data;
  }
}

export const ZBody = <T>(schema: ZodType<T>) => Body(new ZodPipe(schema));
export const ZQuery = <T>(schema: ZodType<T>) => Query(new ZodPipe(schema));

export function parse<T>(schema: ZodType<T>, value: unknown): T {
  return new ZodPipe(schema).transform(value);
}

export function principal(req: AuthedRequest): Principal {
  if (req.principal === undefined) throw new DomainError(401, 'unauthorized', 'Authentication required');
  return req.principal;
}

export function etag(res: Response, version: number): void {
  res.setHeader('ETag', `W/"${version}"`);
}

export function ifMatch(req: Request): number | undefined {
  const raw = req.header('if-match');
  if (raw === undefined || raw === '' || raw === '*') return undefined;
  const m = /^(?:W\/)?"?(\d+)"?$/.exec(raw.trim());
  if (m === null) throw badRequest('If-Match must be an ETag like W/"3"');
  return Number(m[1]);
}

export function idempotencyKey(req: Request): string | null {
  const key = req.header('idempotency-key');
  return key === undefined || key.trim() === '' ? null : key.trim();
}

export function isDryRun(req: Request): boolean {
  const q = req.query['dryRun'];
  return q === '1' || q === 'true';
}

export interface IdempotencyRunner {
  idempotency: {
    run(
      scope: string,
      key: string,
      body: unknown,
      fn: () => Promise<{ status: number; body: unknown }>,
    ): Promise<{ status: number; body: unknown; replayed: boolean }>;
  };
}

export async function withIdempotency<T>(
  core: IdempotencyRunner,
  req: Request,
  res: Response,
  scope: string,
  body: unknown,
  fn: () => Promise<T>,
  status = 200,
): Promise<unknown> {
  const key = idempotencyKey(req);
  if (key === null) {
    res.status(status);
    return fn();
  }
  const out = await core.idempotency.run(scope, key, body, async () => ({ status, body: await fn() }));
  res.status(out.status);
  if (out.replayed) res.setHeader('Idempotent-Replayed', 'true');
  return out.body;
}
