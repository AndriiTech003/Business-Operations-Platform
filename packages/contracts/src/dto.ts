import type { ActorType, CustomFieldEntity, CustomFieldType, Role, Scope, SubjectType } from './common';

export interface UserSummary {
  id: string;
  name: string;
  email: string;
}

export interface MemberDto extends UserSummary {
  role: Role;
}

export interface TenantSummary {
  id: string;
  slug: string;
  name: string;
  role: Role;
}

export interface MeDto {
  user: UserSummary;
  tenant: { id: string; slug: string; name: string; settings: TenantSettings };
  role: Role;
  scopes: Scope[];
  tenants: TenantSummary[];
}

export interface TenantSettings {
  timezone: string;
  currency: string;
  invoicePrefix: string;
  emailsPerMinute: number;
  maxConcurrentSteps: number;
  runsPerSecond?: number;
  runBurst?: number;
}

export interface LoginResponse {
  accessToken: string;
  expiresIn: number;
  me: MeDto;
}

export interface CompanyDto {
  id: string;
  name: string;
  domain: string | null;
  industry: string | null;
  size: number | null;
  ownerId: string | null;
  owner: UserSummary | null;
  custom: Record<string, unknown>;
  tags: string[];
  source: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  stats?: { contacts: number; openDeals: number; openDealsCents: number; unpaidInvoicesCents: number };
  untrusted?: string[];
}

export interface RecordRef {
  id: string;
  name: string;
  untrusted?: string[];
}

export interface ContactDto {
  id: string;
  firstName: string;
  lastName: string;
  name: string;
  email: string | null;
  phone: string | null;
  title: string | null;
  companyId: string | null;
  company: RecordRef | null;
  ownerId: string | null;
  owner: UserSummary | null;
  status: 'lead' | 'active' | 'customer' | 'churned';
  source: string | null;
  lastContactedAt: string | null;
  custom: Record<string, unknown>;
  tags: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
  untrusted?: string[];
}

export interface StageDto {
  id: string;
  name: string;
  position: number;
  probability: number;
  kind: 'open' | 'won' | 'lost';
}

export interface PipelineDto {
  id: string;
  name: string;
  isDefault: boolean;
  stages: StageDto[];
}

export interface DealDto {
  id: string;
  title: string;
  pipelineId: string;
  stageId: string;
  stage: StageDto | null;
  companyId: string | null;
  company: RecordRef | null;
  contactId: string | null;
  contact: RecordRef | null;
  amountCents: number;
  currency: string;
  expectedCloseAt: string | null;
  ownerId: string | null;
  owner: UserSummary | null;
  position: number;
  custom: Record<string, unknown>;
  tags: string[];
  stageChangedAt: string;
  lastActivityAt: string;
  closedAt: string | null;
  lostReason: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ForecastDto {
  currency: string;
  months: Array<{ month: string; totalCents: number; weightedCents: number; deals: number }>;
  byStage: Array<{
    stageId: string;
    name: string;
    probability: number;
    totalCents: number;
    weightedCents: number;
    deals: number;
  }>;
  totalCents: number;
  weightedCents: number;
}

export type InvoiceStatus = 'draft' | 'sent' | 'partially_paid' | 'paid' | 'overdue' | 'void';

export interface InvoiceLineDto {
  id: string;
  position: number;
  description: string;
  quantity: number;
  unitPriceCents: number;
  taxRate: number;
  amountCents: number;
  taxCents: number;
}

export interface PaymentDto {
  id: string;
  amountCents: number;
  method: string;
  paidAt: string;
  reference: string | null;
}

export interface InvoiceDto {
  id: string;
  number: string;
  status: InvoiceStatus;
  companyId: string;
  company: RecordRef | null;
  contactId: string | null;
  contact: (RecordRef & { email: string | null }) | null;
  dealId: string | null;
  currency: string;
  issueDate: string;
  dueDate: string;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  paidCents: number;
  balanceCents: number;
  notes: string | null;
  publicToken: string;
  publicUrl: string;
  sentAt: string | null;
  paidAt: string | null;
  createdByType: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  lines?: InvoiceLineDto[];
  payments?: PaymentDto[];
}

export interface PublicInvoiceDto {
  number: string;
  status: InvoiceStatus;
  currency: string;
  issueDate: string;
  dueDate: string;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  paidCents: number;
  balanceCents: number;
  seller: string;
  buyer: string;
  lines: InvoiceLineDto[];
  notes: string | null;
}

export interface TaskDto {
  id: string;
  title: string;
  description: string | null;
  assigneeId: string | null;
  assignee: UserSummary | null;
  dueAt: string | null;
  status: 'open' | 'in_progress' | 'done' | 'cancelled';
  priority: number;
  relatedType: SubjectType | null;
  relatedId: string | null;
  related: { type: SubjectType; id: string; title: string } | null;
  createdByType: ActorType;
  createdById: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ActivityDto {
  id: string;
  subjectType: SubjectType;
  subjectId: string;
  kind: string;
  actorType: ActorType;
  actorId: string | null;
  actorName: string | null;
  data: Record<string, unknown>;
  untrusted?: string[];
  createdAt: string;
}

export interface CommentDto {
  id: string;
  subjectType: SubjectType;
  subjectId: string;
  authorId: string;
  author: UserSummary | null;
  body: string;
  mentions: string[];
  createdAt: string;
}

export interface NotificationDto {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

export interface CustomFieldDefDto {
  id: string;
  entity: CustomFieldEntity;
  key: string;
  label: string;
  type: CustomFieldType;
  options: { choices?: string[]; currency?: string; relationEntity?: string } | null;
  required: boolean;
  indexed: boolean;
  position: number;
}

export interface AuditLogDto {
  id: string;
  actorType: ActorType;
  actorId: string | null;
  actorName: string | null;
  action: string;
  entity: string;
  entityId: string;
  diff: Record<string, unknown>;
  createdAt: string;
}

export interface ApiTokenDto {
  id: string;
  name: string;
  prefix: string;
  scopes: Scope[];
  actorType: 'user' | 'agent';
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface ApprovalDto {
  id: string;
  source: 'workflow' | 'agent';
  sourceRef: Record<string, unknown>;
  title: string;
  details: Record<string, unknown>;
  assigneeIds: string[];
  assignees: UserSummary[];
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled';
  expiresAt: string | null;
  requestedBy: string | null;
  callbackUrl: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  comment: string | null;
  createdAt: string;
}

export interface SearchHit {
  entity: SubjectType;
  id: string;
  title: string;
  subtitle: string | null;
  score: number;
  untrusted?: string[];
}

export interface SearchResult {
  query: string;
  groups: Array<{ entity: SubjectType; hits: SearchHit[] }>;
}

export interface ImportJobDto {
  id: string;
  entity: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  fileName: string;
  total: number;
  processed: number;
  created: number;
  updated: number;
  failed: number;
  errors: Array<{ row: number; message: string }>;
  createdAt: string;
  finishedAt: string | null;
}

export interface EmailTemplateDto {
  id: string;
  key: string;
  name: string;
  subject: string;
  body: string;
  updatedAt: string;
}

export interface EmailMessageDto {
  id: string;
  status: 'draft' | 'queued' | 'sending' | 'sent' | 'failed';
  to: string[];
  subject: string;
  html: string;
  relatedType: string | null;
  relatedId: string | null;
  actorType: string;
  sentAt: string | null;
  createdAt: string;
}

export interface SecretDto {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface PipelineReportDto {
  stages: Array<{
    stageId: string;
    name: string;
    kind: string;
    deals: number;
    totalCents: number;
    weightedCents: number;
    avgDaysInStage: number;
    conversionToNext: number | null;
    reached: number;
  }>;
}

export interface RevenueReportDto {
  currency: string;
  months: Array<{ month: string; wonCents: number; invoicedCents: number; paidCents: number }>;
}

export interface ArAgingReportDto {
  currency: string;
  buckets: Array<{ bucket: '0-30' | '31-60' | '61-90' | '90+'; invoices: number; balanceCents: number }>;
  rows: Array<{
    invoiceId: string;
    number: string;
    company: string;
    dueDate: string;
    daysOverdue: number;
    balanceCents: number;
    bucket: string;
  }>;
}

export interface ActivityReportDto {
  users: Array<{
    userId: string | null;
    name: string;
    activities: number;
    tasksCompleted: number;
    dealsWon: number;
    notes: number;
  }>;
  byActorType: Array<{ actorType: string; count: number }>;
}

export interface AppConfigDto {
  operator: { scriptUrl: string; agentUrl: string | null; consoleUrl: string | null } | null;
}
