import type { CoreDeps } from '../deps';
import { requireTenantId } from '../context';
import { isUniqueViolation } from '../errors';
import type { ScopedTx } from '../db/tenancy';
import { jsonSafe } from '../util/json';

export class Effects {
  constructor(private readonly deps: CoreDeps) {}

  async lookup(key: string): Promise<unknown | undefined> {
    const row = await this.deps.db.scoped.effectLog.findFirst({ where: { idempotencyKey: key, origin: 'engine' } });
    return row === null ? undefined : row.result;
  }

  async record(key: string, effect: string, result: unknown): Promise<void> {
    try {
      await this.deps.db.scoped.effectLog.create({
        data: { idempotencyKey: key, tenantId: requireTenantId(), effect, result: (jsonSafe(result) ?? null) as never },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }

  async once<T>(
    key: string,
    effect: string,
    fn: (tx: ScopedTx) => Promise<T>,
  ): Promise<{ result: T; replayed: boolean }> {
    const existing = await this.lookup(key);
    if (existing !== undefined) return { result: existing as T, replayed: true };
    try {
      const result = await this.deps.db.scoped.$transaction(async (tx) => {
        const value = await fn(tx);
        await tx.effectLog.create({
          data: {
            idempotencyKey: key,
            tenantId: requireTenantId(),
            effect,
            result: (jsonSafe(value) ?? null) as never,
          },
        });
        return value;
      });
      return { result: jsonSafe(result) as T, replayed: false };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const again = await this.lookup(key);
      if (again === undefined) throw error;
      return { result: again as T, replayed: true };
    }
  }
}
