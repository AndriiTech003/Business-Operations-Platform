import { randomUUID } from 'node:crypto';
import type { DomainEvent, DomainEventType } from '@bop/contracts';
import { requireContext } from '../context';
import type { Scoped } from '../db/tenancy';
import { jsonSafe } from '../util/json';

export interface EmitInput {
  type: DomainEventType;
  entity: string;
  entityId: string;
  payload?: Record<string, unknown>;
}

export async function emitEvent(tx: Scoped, input: EmitInput): Promise<DomainEvent> {
  const ctx = requireContext();
  const event: DomainEvent = {
    id: randomUUID(),
    tenantId: ctx.tenantId,
    type: input.type,
    entity: input.entity,
    entityId: input.entityId,
    actor: { type: ctx.actor.type, id: ctx.actor.id },
    causation: ctx.causation,
    payload: (jsonSafe(input.payload ?? {}) ?? {}) as Record<string, unknown>,
    occurredAt: new Date().toISOString(),
  };
  if (ctx.isTest === true) return event;
  await tx.outbox.create({ data: { id: event.id, tenantId: ctx.tenantId, type: event.type, payload: event as never } });
  return event;
}

export async function writeAudit(
  tx: Scoped,
  action: string,
  entity: string,
  entityId: string,
  diff: Record<string, unknown>,
): Promise<void> {
  const ctx = requireContext();
  if (ctx.isTest === true) return;
  await tx.auditLog.create({
    data: {
      tenantId: ctx.tenantId,
      actorType: ctx.actor.type,
      actorId: ctx.actor.id,
      action,
      entity,
      entityId,
      diff: jsonSafe(diff) as never,
    },
  });
}
