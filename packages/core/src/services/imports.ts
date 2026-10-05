import Papa from 'papaparse';
import type { ImportCreate, ImportJobDto } from '@bop/contracts';
import type { CoreDeps } from '../deps';
import { requireContext, runInContext } from '../context';
import { DomainError, notFound } from '../errors';
import type { ImportJob } from '../generated/prisma/client';
import { iso, isoRequired } from '../util/json';
import type { CompaniesService } from './companies';
import type { ContactsService } from './contacts';

const COMPANY_COLUMNS = ['name', 'domain', 'industry', 'size', 'tags'];

function jobDto(j: ImportJob): ImportJobDto {
  return {
    id: j.id,
    entity: j.entity,
    status: j.status as ImportJobDto['status'],
    fileName: j.fileName,
    total: j.total,
    processed: j.processed,
    created: j.created,
    updated: j.updated,
    failed: j.failed,
    errors: (j.errors ?? []) as ImportJobDto['errors'],
    createdAt: isoRequired(j.createdAt),
    finishedAt: iso(j.finishedAt),
  };
}

function normalizeHeader(h: string): string {
  const key = h
    .trim()
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  const aliases: Record<string, string> = {
    firstname: 'firstName',
    first: 'firstName',
    lastname: 'lastName',
    last: 'lastName',
    surname: 'lastName',
    email: 'email',
    emailaddress: 'email',
    phone: 'phone',
    title: 'title',
    jobtitle: 'title',
    status: 'status',
    company: 'company',
    companyname: 'company',
    name: 'name',
    domain: 'domain',
    website: 'domain',
    industry: 'industry',
    size: 'size',
    employees: 'size',
    tags: 'tags',
  };
  return aliases[key] ?? h.trim();
}

export class ImportsService {
  constructor(
    private readonly deps: CoreDeps,
    private readonly companies: CompaniesService,
    private readonly contacts: ContactsService,
  ) {}

  async create(input: ImportCreate): Promise<ImportJobDto> {
    const ctx = requireContext();
    const job = await this.deps.db.scoped.importJob.create({
      data: {
        tenantId: ctx.tenantId,
        entity: input.entity,
        fileName: input.fileName,
        csv: input.csv,
        mapping: (input.mapping ?? {}) as never,
        mode: input.mode,
        createdBy: ctx.actor.type === 'user' ? ctx.actor.id : null,
      },
    });
    await this.deps.queues.imports.add(
      'import',
      { jobId: job.id, tenantId: ctx.tenantId, actor: ctx.actor },
      { removeOnComplete: true, removeOnFail: 100 },
    );
    return jobDto(job);
  }

  async get(id: string): Promise<ImportJobDto> {
    const job = await this.deps.db.scoped.importJob.findFirst({ where: { id } });
    if (job === null) throw notFound('Import');
    return jobDto(job);
  }

  async list(): Promise<ImportJobDto[]> {
    const rows = await this.deps.db.scoped.importJob.findMany({ orderBy: { createdAt: 'desc' }, take: 50 });
    return rows.map(jobDto);
  }

  async run(jobId: string): Promise<void> {
    const job = await this.deps.db.scoped.importJob.findFirst({ where: { id: jobId } });
    if (job === null || job.status === 'completed') return;
    const parsed = Papa.parse<Record<string, string>>(job.csv, {
      header: true,
      skipEmptyLines: 'greedy',
      transformHeader: normalizeHeader,
    });
    const mapping = (job.mapping ?? {}) as Record<string, string>;
    const rows = parsed.data.map((r) => {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(r)) out[mapping[k] ?? k] = typeof v === 'string' ? v.trim() : '';
      return out;
    });
    await this.deps.db.scoped.importJob.update({
      where: { id: jobId },
      data: { status: 'running', total: rows.length },
    });
    const errors: Array<{ row: number; message: string }> = parsed.errors
      .slice(0, 50)
      .map((e) => ({ row: (e.row ?? 0) + 2, message: e.message }));
    let created = 0;
    let updated = 0;
    let failed = errors.length;
    const companyCache = new Map<string, string>();
    for (const [i, row] of rows.entries()) {
      try {
        const result =
          job.entity === 'company'
            ? await this.importCompany(row, job.mode)
            : await this.importContact(row, job.mode, companyCache);
        if (result === 'created') created += 1;
        else if (result === 'updated') updated += 1;
      } catch (error) {
        failed += 1;
        const message =
          error instanceof DomainError
            ? `${error.message}${error.details.errors ? `: ${error.details.errors.map((e) => `${e.path} ${e.message}`).join(', ')}` : ''}`
            : (error as Error).message;
        if (errors.length < 200) errors.push({ row: i + 2, message });
      }
      if ((i + 1) % 25 === 0 || i === rows.length - 1) {
        await this.deps.db.scoped.importJob.update({
          where: { id: jobId },
          data: { processed: i + 1, created, updated, failed, errors: errors as never },
        });
      }
    }
    await this.deps.db.scoped.importJob.update({
      where: { id: jobId },
      data: {
        status: 'completed',
        processed: rows.length,
        created,
        updated,
        failed,
        errors: errors as never,
        finishedAt: new Date(),
      },
    });
  }

  private async importCompany(row: Record<string, string>, mode: string): Promise<'created' | 'updated' | 'skipped'> {
    if (!row['name']) throw new Error('name is required');
    const custom = Object.fromEntries(
      Object.entries(row)
        .filter(([k, v]) => !COMPANY_COLUMNS.includes(k) && k.startsWith('custom.') && v !== '')
        .map(([k, v]) => [k.slice(7), v]),
    );
    const input = {
      name: row['name'],
      domain: row['domain'] || null,
      industry: row['industry'] || null,
      size: row['size'] ? Number(row['size']) : null,
      tags: row['tags']
        ? row['tags']
            .split(/[;,]/)
            .map((t) => t.trim())
            .filter(Boolean)
        : undefined,
      custom: Object.keys(custom).length > 0 ? custom : undefined,
    };
    const existing =
      mode === 'create'
        ? null
        : await this.deps.db.scoped.company.findFirst({
            where: {
              deletedAt: null,
              OR: [
                ...(input.domain ? [{ domain: input.domain }] : []),
                { name: { equals: input.name, mode: 'insensitive' } },
              ],
            },
          });
    if (existing !== null) {
      if (mode === 'skip') return 'skipped';
      await this.companies.update(
        existing.id,
        Object.fromEntries(Object.entries(input).filter(([, v]) => v !== null && v !== undefined)),
      );
      return 'updated';
    }
    await this.companies.create(input);
    return 'created';
  }

  private async importContact(
    row: Record<string, string>,
    mode: string,
    companyCache: Map<string, string>,
  ): Promise<'created' | 'updated' | 'skipped'> {
    if (!row['firstName'] && !row['email']) throw new Error('firstName or email is required');
    let companyId: string | undefined;
    const companyName = row['company'];
    if (companyName) {
      const cached = companyCache.get(companyName.toLowerCase());
      if (cached !== undefined) companyId = cached;
      else {
        const found = await this.deps.db.scoped.company.findFirst({
          where: { deletedAt: null, name: { equals: companyName, mode: 'insensitive' } },
        });
        companyId = found?.id ?? (await this.companies.create({ name: companyName })).id;
        companyCache.set(companyName.toLowerCase(), companyId);
      }
    }
    const status = ['lead', 'active', 'customer', 'churned'].includes(row['status'] ?? '')
      ? (row['status'] as 'lead')
      : undefined;
    const input = {
      firstName: row['firstName'] || (row['email'] ?? '').split('@')[0] || 'Unknown',
      lastName: row['lastName'] ?? '',
      email: row['email'] ? row['email'].toLowerCase() : null,
      phone: row['phone'] || null,
      title: row['title'] || null,
      status,
      companyId: companyId ?? null,
      source: 'import',
      tags: row['tags']
        ? row['tags']
            .split(/[;,]/)
            .map((t) => t.trim())
            .filter(Boolean)
        : undefined,
    };
    const existing =
      mode === 'create' || input.email === null
        ? null
        : await this.deps.db.scoped.contact.findFirst({ where: { email: input.email, deletedAt: null } });
    if (existing !== null) {
      if (mode === 'skip') return 'skipped';
      const patch = Object.fromEntries(
        Object.entries(input).filter(([k, v]) => v !== null && v !== undefined && v !== '' && k !== 'source'),
      );
      await this.contacts.update(existing.id, patch);
      return 'updated';
    }
    await this.contacts.create(input);
    return 'created';
  }

  async runJob(data: {
    jobId: string;
    tenantId: string;
    actor: { type: 'user' | 'agent' | 'system' | 'workflow'; id: string | null };
  }): Promise<void> {
    await runInContext({ tenantId: data.tenantId, actor: data.actor, causation: [] }, async () => {
      try {
        await this.run(data.jobId);
      } catch (error) {
        await this.deps.db.scoped.importJob.updateMany({
          where: { id: data.jobId },
          data: {
            status: 'failed',
            errors: [{ row: 0, message: (error as Error).message }] as never,
            finishedAt: new Date(),
          },
        });
      }
    });
  }
}
