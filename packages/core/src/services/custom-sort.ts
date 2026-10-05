import type { CoreDeps } from '../deps';
import { requireTenantId } from '../context';
import { RecordsQueryRepository } from '../raw/records-query.repository';
import type { ListPlan } from './query';

export async function orderedIdsByCustom(
  deps: CoreDeps,
  entity: 'company' | 'contact' | 'deal',
  plan: ListPlan,
  limit: number,
): Promise<string[]> {
  if (plan.customSort === null) return [];
  const delegate = (entity === 'company'
    ? deps.db.scoped.company
    : entity === 'contact'
      ? deps.db.scoped.contact
      : deps.db.scoped.deal) as unknown as {
    findMany(args: unknown): Promise<Array<{ id: string }>>;
  };
  const matching = await delegate.findMany({ where: plan.where, select: { id: true }, take: 10_000 });
  const defs = await deps.db.scoped.customFieldDef.findFirst({ where: { entity, key: plan.customSort.key } });
  const numeric = defs?.type === 'number' || defs?.type === 'money';
  return new RecordsQueryRepository(deps.db.system).orderByCustom(
    requireTenantId(),
    entity,
    matching.map((m) => m.id),
    plan.customSort.key,
    numeric,
    plan.customSort.direction,
    limit + 1,
    plan.offset ?? 0,
  );
}
