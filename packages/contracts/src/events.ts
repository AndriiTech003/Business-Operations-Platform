import type { ActorType } from './common';

export const DOMAIN_EVENTS = [
  'company.created',
  'company.updated',
  'company.deleted',
  'contact.created',
  'contact.updated',
  'contact.deleted',
  'deal.created',
  'deal.updated',
  'deal.stage_changed',
  'deal.won',
  'deal.lost',
  'deal.deleted',
  'invoice.created',
  'invoice.updated',
  'invoice.sent',
  'invoice.partially_paid',
  'invoice.paid',
  'invoice.overdue',
  'invoice.voided',
  'payment.created',
  'task.created',
  'task.updated',
  'task.completed',
  'note.added',
  'comment.created',
  'approval.requested',
  'approval.decided',
  'email.sent',
  'workflow.run_finished',
] as const;
export type DomainEventType = (typeof DOMAIN_EVENTS)[number];

export interface CausationEntry {
  runId: string;
  workflowId: string;
}

export interface EventActor {
  type: ActorType;
  id: string | null;
}

export interface DomainEvent<P = Record<string, unknown>> {
  id: string;
  tenantId: string;
  type: DomainEventType;
  entity: string;
  entityId: string;
  actor: EventActor;
  causation: CausationEntry[];
  payload: P;
  occurredAt: string;
}

export const ENTITY_EVENTS: Record<string, DomainEventType[]> = {
  company: ['company.created', 'company.updated', 'company.deleted'],
  contact: ['contact.created', 'contact.updated', 'contact.deleted'],
  deal: ['deal.created', 'deal.updated', 'deal.stage_changed', 'deal.won', 'deal.lost', 'deal.deleted'],
  invoice: [
    'invoice.created',
    'invoice.updated',
    'invoice.sent',
    'invoice.partially_paid',
    'invoice.paid',
    'invoice.overdue',
    'invoice.voided',
  ],
  task: ['task.created', 'task.updated', 'task.completed'],
};

export function eventEntity(type: DomainEventType): string {
  return type.split('.')[0] ?? type;
}
