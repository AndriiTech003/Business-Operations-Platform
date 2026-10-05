import { AsyncLocalStorage } from 'node:async_hooks';
import type { ActorType, CausationEntry, Scope } from '@bop/contracts';

export interface Actor {
  type: ActorType;
  id: string | null;
  name?: string;
}

export interface ExecContext {
  tenantId: string;
  actor: Actor;
  causation: CausationEntry[];
  scopes?: readonly Scope[];
  isTest?: boolean;
}

export class MissingTenantContextError extends Error {
  constructor() {
    super('Tenant context is required for this query');
    this.name = 'MissingTenantContextError';
  }
}

const storage = new AsyncLocalStorage<ExecContext>();

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

export function runInContext<T>(ctx: ExecContext, fn: () => T): T {
  return storage.run(ctx, () => {
    const result = fn();
    if (!isThenable(result)) return result;
    return new Promise((resolve, reject) => {
      result.then(resolve, reject);
    }) as T;
  });
}

export function currentContext(): ExecContext | undefined {
  return storage.getStore();
}

export function requireContext(): ExecContext {
  const ctx = storage.getStore();
  if (ctx === undefined) throw new MissingTenantContextError();
  return ctx;
}

export function requireTenantId(): string {
  return requireContext().tenantId;
}

export function systemActor(): Actor {
  return { type: 'system', id: null };
}

export function asTenant<T>(tenantId: string, fn: () => T, actor: Actor = systemActor()): T {
  return runInContext({ tenantId, actor, causation: [] }, fn);
}
