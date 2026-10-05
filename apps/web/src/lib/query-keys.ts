export type RecordEntity = 'company' | 'contact' | 'deal' | 'invoice' | 'task';

export const ENTITY_PATH: Record<RecordEntity, string> = {
  company: 'companies',
  contact: 'contacts',
  deal: 'deals',
  invoice: 'invoices',
  task: 'tasks',
};

const entityKeys = <E extends RecordEntity>(entity: E) => ({
  all: [entity] as const,
  lists: () => [entity, 'list'] as const,
  list: (params: Record<string, unknown>) => [entity, 'list', params] as const,
  detail: (id: string) => [entity, 'detail', id] as const,
  timeline: (id: string) => [entity, 'timeline', id] as const,
});

export const keys = {
  me: ['me'] as const,
  members: ['members'] as const,
  customFields: ['custom-fields'] as const,
  pipelines: ['pipelines'] as const,
  company: entityKeys('company'),
  contact: entityKeys('contact'),
  deal: {
    ...entityKeys('deal'),
    board: (pipelineId: string | undefined) => ['deal', 'board', pipelineId ?? 'default'] as const,
    forecast: (pipelineId: string | undefined) => ['deal', 'forecast', pipelineId ?? 'default'] as const,
  },
  invoice: {
    ...entityKeys('invoice'),
    preview: (id: string, version: number) => ['invoice', 'preview', id, version] as const,
  },
  task: {
    ...entityKeys('task'),
    my: ['task', 'my'] as const,
  },
  recordTasks: (entity: RecordEntity, id: string) => ['record-tasks', entity, id] as const,
  recordEmails: (entity: RecordEntity, id: string) => ['record-emails', entity, id] as const,
  related: (entity: RecordEntity, id: string, target: string) => ['related', entity, id, target] as const,
  comments: (entity: RecordEntity, id: string) => ['comments', entity, id] as const,
  notifications: ['notifications'] as const,
  search: (q: string) => ['search', q] as const,
  duplicates: (entity: RecordEntity) => ['duplicates', entity] as const,
  importJob: (id: string) => ['import', id] as const,
  approvals: {
    all: ['approvals'] as const,
    list: (params: Record<string, unknown>) => ['approvals', 'list', params] as const,
    count: ['approvals', 'count'] as const,
  },
  workflows: {
    all: ['workflows'] as const,
    list: ['workflows', 'list'] as const,
    detail: (id: string) => ['workflows', 'detail', id] as const,
    templates: ['workflows', 'templates'] as const,
    diff: (id: string) => ['workflows', 'diff', id] as const,
  },
  runs: {
    all: ['runs'] as const,
    list: (params: Record<string, unknown>) => ['runs', 'list', params] as const,
    detail: (id: string) => ['runs', 'detail', id] as const,
  },
  reports: (name: string, params: Record<string, unknown>) => ['reports', name, params] as const,
  emailTemplates: ['email-templates'] as const,
  secrets: ['secrets'] as const,
  apiTokens: ['api-tokens'] as const,
};
