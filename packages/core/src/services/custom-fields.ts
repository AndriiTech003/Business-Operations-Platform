import { createHash } from 'node:crypto';
import { z, type ZodType } from 'zod';
import type { CustomFieldCreate, CustomFieldDefDto, CustomFieldEntity, CustomFieldUpdate } from '@bop/contracts';
import type { CustomFieldMap } from '@bop/workflow-core';
import type { CoreDeps } from '../deps';
import { requireTenantId } from '../context';
import { conflict, notFound, validationFailed } from '../errors';
import { writeAudit } from '../events/outbox';
import type { CustomFieldDef } from '../generated/prisma/client';
import { CustomFieldIndexRepository } from '../raw/custom-field-index.repository';

const MAX_INDEXED_PER_ENTITY = 5;
const schemaCache = new Map<string, ZodType<Record<string, unknown>>>();

function toDto(d: CustomFieldDef): CustomFieldDefDto {
  return {
    id: d.id,
    entity: d.entity as CustomFieldEntity,
    key: d.key,
    label: d.label,
    type: d.type as CustomFieldDefDto['type'],
    options: (d.options ?? null) as CustomFieldDefDto['options'],
    required: d.required,
    indexed: d.indexed,
    position: d.position,
  };
}

function valueSchema(def: CustomFieldDefDto): ZodType<unknown> {
  const choices = def.options?.choices ?? [];
  switch (def.type) {
    case 'text':
      return z.string().max(5000);
    case 'number':
      return z.number().finite();
    case 'money':
      return z.number().int();
    case 'date':
      return z.iso.date().or(z.iso.datetime({ offset: true }));
    case 'select':
      return choices.length > 0 ? z.enum(choices as [string, ...string[]]) : z.string();
    case 'multi_select':
      return z.array(choices.length > 0 ? z.enum(choices as [string, ...string[]]) : z.string()).max(50);
    case 'user':
    case 'relation':
      return z.uuid();
  }
}

export function buildCustomSchema(defs: CustomFieldDefDto[], partial: boolean): ZodType<Record<string, unknown>> {
  const shape: Record<string, ZodType<unknown>> = {};
  for (const def of defs) {
    const base = valueSchema(def);
    shape[def.key] = def.required && !partial ? base : base.nullish();
  }
  return z.strictObject(shape) as unknown as ZodType<Record<string, unknown>>;
}

export class CustomFieldsService {
  private readonly indexes: CustomFieldIndexRepository;

  constructor(private readonly deps: CoreDeps) {
    this.indexes = new CustomFieldIndexRepository(deps.db.system);
  }

  async list(entity?: CustomFieldEntity): Promise<CustomFieldDefDto[]> {
    const rows = await this.deps.db.scoped.customFieldDef.findMany({
      where: entity === undefined ? {} : { entity },
      orderBy: [{ entity: 'asc' }, { position: 'asc' }],
    });
    return rows.map(toDto);
  }

  async map(): Promise<CustomFieldMap> {
    const all = await this.list();
    const out: CustomFieldMap = {};
    for (const d of all) (out[d.entity] ??= []).push(d);
    return out;
  }

  async typesFor(entity: CustomFieldEntity): Promise<Record<string, string>> {
    const defs = await this.list(entity);
    return Object.fromEntries(defs.map((d) => [d.key, d.type]));
  }

  async validate(
    entity: CustomFieldEntity,
    values: Record<string, unknown> | undefined,
    partial: boolean,
  ): Promise<Record<string, unknown>> {
    const defs = await this.list(entity);
    const version = createHash('sha1').update(JSON.stringify(defs)).digest('hex');
    const cacheKey = `${requireTenantId()}:${entity}:${partial ? 'p' : 'f'}:${version}`;
    let schema = schemaCache.get(cacheKey);
    if (schema === undefined) {
      schema = buildCustomSchema(defs, partial);
      schemaCache.set(cacheKey, schema);
      if (schemaCache.size > 500) schemaCache.delete(schemaCache.keys().next().value as string);
    }
    const result = schema.safeParse(values ?? {});
    if (!result.success) {
      throw validationFailed(
        'Custom field validation failed',
        result.error.issues.map((i) => ({ path: ['custom', ...i.path.map(String)].join('.'), message: i.message })),
      );
    }
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(result.data)) if (v !== undefined) clean[k] = v;
    return clean;
  }

  async create(input: CustomFieldCreate): Promise<CustomFieldDefDto> {
    const tenantId = requireTenantId();
    const existing = await this.deps.db.scoped.customFieldDef.findFirst({
      where: { entity: input.entity, key: input.key },
    });
    if (existing !== null) throw conflict(`Custom field '${input.key}' already exists on ${input.entity}`);
    if (input.indexed) await this.assertIndexBudget(input.entity, null);
    const count = await this.deps.db.scoped.customFieldDef.count({ where: { entity: input.entity } });
    const row = await this.deps.db.scoped.$transaction(async (tx) => {
      const created = await tx.customFieldDef.create({
        data: {
          tenantId,
          entity: input.entity,
          key: input.key,
          label: input.label,
          type: input.type,
          options: (input.options ?? undefined) as never,
          required: input.required,
          indexed: input.indexed,
          position: input.position ?? count,
        },
      });
      await writeAudit(tx, 'custom_field.created', 'custom_field', created.id, { after: created });
      return created;
    });
    if (row.indexed) return toDto(await this.ensureIndex(row));
    return toDto(row);
  }

  async update(id: string, input: CustomFieldUpdate): Promise<CustomFieldDefDto> {
    const current = await this.deps.db.scoped.customFieldDef.findFirst({ where: { id } });
    if (current === null) throw notFound('Custom field');
    if (input.indexed === true && !current.indexed) await this.assertIndexBudget(current.entity, id);
    const row = await this.deps.db.scoped.customFieldDef.update({
      where: { id },
      data: {
        label: input.label,
        options: input.options === undefined ? undefined : ((input.options ?? null) as never),
        required: input.required,
        indexed: input.indexed,
        position: input.position,
      },
    });
    if (row.indexed && !current.indexed) return toDto(await this.ensureIndex(row));
    if (!row.indexed && current.indexed && current.indexName !== null) {
      await this.indexes.dropIndex(current.indexName);
      return toDto(await this.deps.db.scoped.customFieldDef.update({ where: { id }, data: { indexName: null } }));
    }
    return toDto(row);
  }

  async reorder(ids: string[]): Promise<CustomFieldDefDto[]> {
    await this.deps.db.scoped.$transaction(async (tx) => {
      for (const [position, id] of ids.entries())
        await tx.customFieldDef.updateMany({ where: { id }, data: { position } });
    });
    return this.list();
  }

  async remove(id: string): Promise<void> {
    const current = await this.deps.db.scoped.customFieldDef.findFirst({ where: { id } });
    if (current === null) throw notFound('Custom field');
    if (current.indexName !== null) await this.indexes.dropIndex(current.indexName);
    await this.deps.db.scoped.customFieldDef.delete({ where: { id } });
  }

  private async assertIndexBudget(entity: string, exceptId: string | null): Promise<void> {
    const indexed = await this.deps.db.scoped.customFieldDef.count({
      where: { entity, indexed: true, ...(exceptId === null ? {} : { NOT: { id: exceptId } }) },
    });
    if (indexed >= MAX_INDEXED_PER_ENTITY)
      throw validationFailed(`At most ${MAX_INDEXED_PER_ENTITY} indexed custom fields per entity`, [
        { path: 'indexed', message: 'limit reached' },
      ]);
  }

  private async ensureIndex(row: CustomFieldDef): Promise<CustomFieldDef> {
    const name = await this.indexes.createIndex(row.tenantId, row.entity, row.key, row.type);
    return this.deps.db.scoped.customFieldDef.update({ where: { id: row.id }, data: { indexName: name } });
  }
}
