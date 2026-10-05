import type { Role, UserSummary } from '@bop/contracts';
import type { CoreDeps } from '../deps';

export interface Member extends UserSummary {
  role: Role;
}

export class Directory {
  constructor(private readonly deps: CoreDeps) {}

  async members(): Promise<Member[]> {
    const memberships = await this.deps.db.scoped.membership.findMany({ where: {} });
    if (memberships.length === 0) return [];
    const users = await this.deps.db.system.user.findMany({
      where: { id: { in: memberships.map((m) => m.userId) } },
      select: { id: true, name: true, email: true },
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    return memberships
      .map((m) => {
        const u = byId.get(m.userId);
        return u === undefined ? null : { id: u.id, name: u.name, email: u.email, role: m.role as Role };
      })
      .filter((m): m is Member => m !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async usersById(ids: Array<string | null | undefined>): Promise<Map<string, UserSummary>> {
    const unique = [
      ...new Set(ids.filter((id): id is string => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id))),
    ];
    if (unique.length === 0) return new Map();
    const memberships = await this.deps.db.scoped.membership.findMany({
      where: { userId: { in: unique } },
      select: { userId: true },
    });
    const allowed = memberships.map((m) => m.userId);
    if (allowed.length === 0) return new Map();
    const users = await this.deps.db.system.user.findMany({
      where: { id: { in: allowed } },
      select: { id: true, name: true, email: true },
    });
    return new Map(users.map((u) => [u.id, u]));
  }

  async isMember(userId: string): Promise<boolean> {
    return (await this.deps.db.scoped.membership.count({ where: { userId } })) > 0;
  }

  async byRole(role: string): Promise<Member[]> {
    const order: Role[] = ['viewer', 'member', 'manager', 'admin', 'owner'];
    const min = order.indexOf(role as Role);
    const all = await this.members();
    if (min < 0) return [];
    if (role === 'member') return all.filter((m) => m.role === 'member' || m.role === 'manager');
    return all.filter((m) => order.indexOf(m.role) >= min);
  }
}
