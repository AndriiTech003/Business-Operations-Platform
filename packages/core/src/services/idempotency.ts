import { createHash } from 'node:crypto';
import type { CoreDeps } from '../deps';
import { requireTenantId } from '../context';
import { DomainError, isUniqueViolation } from '../errors';
import { jsonSafe } from '../util/json';

export interface StoredResponse {
  status: number;
  body: unknown;
  replayed: boolean;
}

function mismatch(what: string): DomainError {
  return new DomainError(422, 'idempotency_mismatch', `Idempotency-Key was already used with ${what}`);
}

function resultRef(body: unknown): Record<string, unknown> | null {
  if (body === null || typeof body !== 'object') return null;
  const o = body as Record<string, unknown>;
  const ref: Record<string, unknown> = {};
  for (const k of ['id', 'number', 'status']) if (typeof o[k] === 'string') ref[k] = o[k];
  return Object.keys(ref).length === 0 ? null : ref;
}

export class IdempotencyService {
  constructor(private readonly deps: CoreDeps) {}

  hash(body: unknown): string {
    return createHash('sha256')
      .update(JSON.stringify(body ?? null))
      .digest('hex');
  }

  async run(
    scope: string,
    key: string,
    body: unknown,
    fn: () => Promise<{ status: number; body: unknown }>,
  ): Promise<StoredResponse> {
    if (key.length < 1 || key.length > 200)
      throw new DomainError(400, 'bad_request', 'Idempotency-Key must be 1-200 characters');
    const tenantId = requireTenantId();
    const requestHash = this.hash(body);
    const lockKey = `${this.deps.config.redisPrefix}:idem:${tenantId}:${key}`;
    let locked = false;
    for (let attempt = 0; attempt < 50 && !locked; attempt += 1) {
      const existing = await this.deps.db.scoped.idempotencyRecord.findFirst({ where: { scope, key } });
      if (existing !== null) {
        if (existing.requestHash !== requestHash) throw mismatch('a different request body');
        return { status: existing.statusCode, body: existing.response, replayed: true };
      }
      const effect = await this.deps.db.scoped.effectLog.findFirst({ where: { origin: 'api', idempotencyKey: key } });
      if (effect !== null && effect.effect !== scope) throw mismatch('a different operation');
      locked = (await this.deps.redis.set(lockKey, '1', 'PX', 30_000, 'NX')) === 'OK';
      if (!locked) await new Promise((r) => setTimeout(r, 100));
    }
    if (!locked)
      throw new DomainError(409, 'idempotency_in_progress', 'A request with this Idempotency-Key is running');
    try {
      const again = await this.deps.db.scoped.idempotencyRecord.findFirst({ where: { scope, key } });
      if (again !== null) {
        if (again.requestHash !== requestHash) throw mismatch('a different request body');
        return { status: again.statusCode, body: again.response, replayed: true };
      }
      const other = await this.deps.db.scoped.effectLog.findFirst({ where: { origin: 'api', idempotencyKey: key } });
      if (other !== null) throw mismatch('a different operation');
      const result = await fn();
      const response = jsonSafe(result.body);
      try {
        await this.deps.db.scoped.$transaction(async (tx) => {
          await tx.idempotencyRecord.create({
            data: { tenantId, scope, key, requestHash, statusCode: result.status, response: response as never },
          });
          await tx.effectLog.create({
            data: {
              tenantId,
              origin: 'api',
              idempotencyKey: key,
              effect: scope,
              requestHash,
              result: { status: result.status, ref: resultRef(response) } as never,
            },
          });
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
      return { status: result.status, body: response, replayed: false };
    } finally {
      await this.deps.redis.del(lockKey);
    }
  }
}
