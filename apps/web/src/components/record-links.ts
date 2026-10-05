import type { RecordEntity } from '../lib/query-keys';

export type RecordHref =
  | { to: '/companies/$id'; params: { id: string } }
  | { to: '/contacts/$id'; params: { id: string } }
  | { to: '/deals/$id'; params: { id: string } }
  | { to: '/invoices/$id'; params: { id: string } }
  | { to: '/tasks'; params: Record<string, never> };

export function recordHref(entity: RecordEntity | string, id: string): RecordHref {
  switch (entity) {
    case 'company':
      return { to: '/companies/$id', params: { id } };
    case 'contact':
      return { to: '/contacts/$id', params: { id } };
    case 'deal':
      return { to: '/deals/$id', params: { id } };
    case 'invoice':
      return { to: '/invoices/$id', params: { id } };
    default:
      return { to: '/tasks', params: {} };
  }
}

export const ENTITY_LABEL: Record<string, string> = {
  company: 'Company',
  contact: 'Contact',
  deal: 'Deal',
  invoice: 'Invoice',
  task: 'Task',
};
