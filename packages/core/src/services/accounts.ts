import {
  ROLE_SCOPES,
  SCOPES,
  type ApiTokenCreate,
  type ApiTokenDto,
  type MeDto,
  type MemberDto,
  type Role,
  type Scope,
  type SecretDto,
  type TenantSettings,
} from '@bop/contracts';
import type { CoreDeps } from '../deps';
import { requireTenantId, runInContext, type Actor, type ExecContext } from '../context';
import { conflict, forbidden, notFound, unauthorized, validationFailed } from '../errors';
import { writeAudit } from '../events/outbox';
import type { ApiToken } from '../generated/prisma/client';
import {
  decryptSecret,
  encryptSecret,
  hashPassword,
  randomToken,
  sha256,
  signJwt,
  verifyJwt,
  verifyPassword,
} from '../util/crypto';
import { iso, isoRequired } from '../util/json';
import type { DealsService } from './deals';
import type { EmailsService } from './emails';

export const ACCESS_TTL_SEC = 15 * 60;
export const REFRESH_TTL_SEC = 30 * 24 * 3600;
export const API_TOKEN_PREFIX = 'bop_pat_';

const AUTH_CACHE_MS = 5000;

export const DEFAULT_SETTINGS: TenantSettings = {
  timezone: 'UTC',
  currency: 'USD',
  invoicePrefix: 'INV',
  emailsPerMinute: 120,
  maxConcurrentSteps: 8,
};

export interface Principal {
  userId: string;
  tenantId: string;
  role: Role;
  scopes: Scope[];
  actor: Actor;
  tokenId: string | null;
}

export const DEFAULT_STAGES = [
  { name: 'Lead', probability: 10, kind: 'open' as const },
  { name: 'Qualified', probability: 25, kind: 'open' as const },
  { name: 'Proposal', probability: 50, kind: 'open' as const },
  { name: 'Negotiation', probability: 75, kind: 'open' as const },
  { name: 'Won', probability: 100, kind: 'won' as const },
  { name: 'Lost', probability: 0, kind: 'lost' as const },
];

function tokenDto(t: ApiToken): ApiTokenDto {
  return {
    id: t.id,
    name: t.name,
    prefix: t.prefix,
    scopes: t.scopes as Scope[],
    actorType: t.actorType as 'user' | 'agent',
    expiresAt: iso(t.expiresAt),
    lastUsedAt: iso(t.lastUsedAt),
    revokedAt: iso(t.revokedAt),
    createdAt: isoRequired(t.createdAt),
  };
}

export class AccountsService {
  constructor(
    private readonly deps: CoreDeps,
    private readonly deals: DealsService,
    private readonly emails: EmailsService,
  ) {}

  async createUser(email: string, name: string, password: string): Promise<string> {
    const existing = await this.deps.db.system.user.findUnique({ where: { email: email.toLowerCase() } });
    if (existing !== null) return existing.id;
    const user = await this.deps.db.system.user.create({
      data: { email: email.toLowerCase(), name, passwordHash: await hashPassword(password) },
    });
    return user.id;
  }

  async createTenant(input: {
    slug: string;
    name: string;
    ownerId: string;
    settings?: Partial<TenantSettings>;
  }): Promise<string> {
    const exists = await this.deps.db.system.tenant.findUnique({ where: { slug: input.slug } });
    if (exists !== null) throw conflict(`Workspace '${input.slug}' already exists`);
    const tenant = await this.deps.db.system.tenant.create({
      data: { slug: input.slug, name: input.name, settings: { ...DEFAULT_SETTINGS, ...input.settings } as never },
    });
    const ctx: ExecContext = { tenantId: tenant.id, actor: { type: 'user', id: input.ownerId }, causation: [] };
    await runInContext(ctx, async () => {
      await this.deps.db.scoped.membership.create({
        data: { tenantId: tenant.id, userId: input.ownerId, role: 'owner' },
      });
      await this.deals.createPipeline({ name: 'Sales', isDefault: true, stages: DEFAULT_STAGES });
      await this.deps.db.scoped.$transaction((tx) => this.emails.seedDefaults(tx));
    });
    return tenant.id;
  }

  async addMember(
    email: string,
    name: string,
    role: Role,
    password?: string,
  ): Promise<{ user: MemberDto; temporaryPassword: string | null }> {
    const tenantId = requireTenantId();
    let user = await this.deps.db.system.user.findUnique({ where: { email: email.toLowerCase() } });
    let temporaryPassword: string | null = null;
    if (user === null) {
      temporaryPassword = password ?? randomToken(9);
      user = await this.deps.db.system.user.create({
        data: { email: email.toLowerCase(), name, passwordHash: await hashPassword(temporaryPassword) },
      });
    }
    const existing = await this.deps.db.scoped.membership.findFirst({ where: { userId: user.id } });
    if (existing !== null) throw conflict(`${email} is already a member`);
    await this.deps.db.scoped.membership.create({ data: { tenantId, userId: user.id, role } });
    await writeAudit(this.deps.db.scoped, 'member.added', 'member', user.id, { role });
    return { user: { id: user.id, name: user.name, email: user.email, role }, temporaryPassword };
  }

  async setRole(userId: string, role: Role): Promise<void> {
    const m = await this.deps.db.scoped.membership.findFirst({ where: { userId } });
    if (m === null) throw notFound('Member');
    if (m.role === 'owner') throw forbidden('The owner role cannot be changed');
    await this.deps.db.scoped.membership.updateMany({ where: { userId }, data: { role } });
    this.forgetAuth();
    await writeAudit(this.deps.db.scoped, 'member.role_changed', 'member', userId, { from: m.role, to: role });
  }

  async removeMember(userId: string): Promise<void> {
    const m = await this.deps.db.scoped.membership.findFirst({ where: { userId } });
    if (m === null) throw notFound('Member');
    if (m.role === 'owner') throw forbidden('The owner cannot be removed');
    await this.deps.db.scoped.membership.deleteMany({ where: { userId } });
    await this.deps.db.scoped.apiToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    this.forgetAuth();
  }

  async login(
    email: string,
    password: string,
    tenantSlug?: string,
  ): Promise<{ accessToken: string; refreshToken: string; me: MeDto }> {
    const user = await this.deps.db.system.user.findUnique({ where: { email: email.toLowerCase() } });
    if (user === null || !(await verifyPassword(password, user.passwordHash)))
      throw unauthorized('Invalid email or password');
    const memberships = await this.deps.db.system.membership.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'asc' },
    });
    if (memberships.length === 0) throw forbidden('No workspace access');
    let tenantId = memberships[0]?.tenantId as string;
    if (tenantSlug !== undefined) {
      const tenant = await this.deps.db.system.tenant.findUnique({ where: { slug: tenantSlug } });
      if (tenant === null || !memberships.some((m) => m.tenantId === tenant.id))
        throw forbidden('No access to this workspace');
      tenantId = tenant.id;
    }
    const refreshToken = randomToken(32);
    await this.deps.db.system.session.create({
      data: {
        userId: user.id,
        tokenHash: sha256(refreshToken),
        expiresAt: new Date(Date.now() + REFRESH_TTL_SEC * 1000),
      },
    });
    return { ...(await this.issue(user.id, tenantId)), refreshToken };
  }

  async issue(userId: string, tenantId: string): Promise<{ accessToken: string; me: MeDto }> {
    const me = await this.me(userId, tenantId);
    const accessToken = signJwt(
      { sub: userId, tid: tenantId, role: me.role, name: me.user.name, typ: 'access' },
      this.deps.config.jwtSecret,
      ACCESS_TTL_SEC,
    );
    return { accessToken, me };
  }

  async refresh(refreshToken: string, tenantId?: string): Promise<{ accessToken: string; me: MeDto }> {
    const session = await this.deps.db.system.session.findUnique({ where: { tokenHash: sha256(refreshToken) } });
    if (session === null || session.expiresAt < new Date()) throw unauthorized('Session expired');
    const memberships = await this.deps.db.system.membership.findMany({
      where: { userId: session.userId },
      orderBy: { createdAt: 'asc' },
    });
    const target =
      tenantId !== undefined && memberships.some((m) => m.tenantId === tenantId) ? tenantId : memberships[0]?.tenantId;
    if (target === undefined) throw forbidden('No workspace access');
    return this.issue(session.userId, target);
  }

  async logout(refreshToken: string): Promise<void> {
    await this.deps.db.system.session.deleteMany({ where: { tokenHash: sha256(refreshToken) } });
  }

  async me(userId: string, tenantId: string): Promise<MeDto> {
    const [user, memberships] = await Promise.all([
      this.deps.db.system.user.findUnique({ where: { id: userId } }),
      this.deps.db.system.membership.findMany({ where: { userId } }),
    ]);
    if (user === null) throw unauthorized();
    const tenants = await this.deps.db.system.tenant.findMany({
      where: { id: { in: memberships.map((m) => m.tenantId) } },
    });
    const current = memberships.find((m) => m.tenantId === tenantId);
    const tenant = tenants.find((t) => t.id === tenantId);
    if (current === undefined || tenant === undefined) throw forbidden('No access to this workspace');
    return {
      user: { id: user.id, name: user.name, email: user.email },
      tenant: {
        id: tenant.id,
        slug: tenant.slug,
        name: tenant.name,
        settings: { ...DEFAULT_SETTINGS, ...((tenant.settings ?? {}) as Partial<TenantSettings>) },
      },
      role: current.role as Role,
      scopes: [...ROLE_SCOPES[current.role as Role]],
      tenants: memberships.map((m) => {
        const t = tenants.find((x) => x.id === m.tenantId);
        return { id: m.tenantId, slug: t?.slug ?? '', name: t?.name ?? '', role: m.role as Role };
      }),
    };
  }

  private readonly authCache = new Map<string, { at: number; value: unknown }>();

  private async cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.authCache.get(key);
    if (hit !== undefined && Date.now() - hit.at < AUTH_CACHE_MS) return hit.value as T;
    const value = await load();
    if (this.authCache.size > 5000) this.authCache.clear();
    this.authCache.set(key, { at: Date.now(), value });
    return value;
  }

  forgetAuth(): void {
    this.authCache.clear();
  }

  async authenticate(bearer: string): Promise<Principal> {
    if (bearer.startsWith(API_TOKEN_PREFIX)) return this.authenticateApiToken(bearer);
    const claims = verifyJwt(bearer, this.deps.config.jwtSecret);
    if (claims === null || claims.typ !== 'access' || typeof claims.tid !== 'string')
      throw unauthorized('Invalid or expired token');
    const tid = claims.tid;
    const membership = await this.cached(`m:${tid}:${claims.sub}`, () =>
      this.deps.db.system.membership.findUnique({
        where: { tenantId_userId: { tenantId: tid, userId: claims.sub } },
      }),
    );
    if (membership === null) throw unauthorized('Membership revoked');
    const role = membership.role as Role;
    return {
      userId: claims.sub,
      tenantId: claims.tid,
      role,
      scopes: [...ROLE_SCOPES[role]],
      actor: { type: 'user', id: claims.sub, name: claims.name as string | undefined },
      tokenId: null,
    };
  }

  private async authenticateApiToken(raw: string): Promise<Principal> {
    const hash = sha256(raw);
    const token = await this.cached(`t:${hash}`, () =>
      this.deps.db.system.apiToken.findUnique({ where: { tokenHash: hash } }),
    );
    if (token === null || token.revokedAt !== null || (token.expiresAt !== null && token.expiresAt < new Date()))
      throw unauthorized('Invalid API token');
    const membership = await this.cached(`m:${token.tenantId}:${token.userId}`, () =>
      this.deps.db.system.membership.findUnique({
        where: { tenantId_userId: { tenantId: token.tenantId, userId: token.userId } },
      }),
    );
    if (membership === null) throw unauthorized('Token owner is no longer a member');
    const role = membership.role as Role;
    const allowed = new Set(ROLE_SCOPES[role]);
    const scopes = (token.scopes as Scope[]).filter((s) => allowed.has(s));
    if (token.lastUsedAt === null || Date.now() - token.lastUsedAt.getTime() > 60_000) {
      token.lastUsedAt = new Date();
      await this.deps.db.system.apiToken.update({ where: { id: token.id }, data: { lastUsedAt: token.lastUsedAt } });
    }
    return {
      userId: token.userId,
      tenantId: token.tenantId,
      role,
      scopes,
      actor: {
        type: token.actorType === 'agent' ? 'agent' : 'user',
        id: token.actorType === 'agent' ? `token:${token.id}` : token.userId,
      },
      tokenId: token.id,
    };
  }

  async createApiToken(
    userId: string,
    role: Role,
    input: ApiTokenCreate,
  ): Promise<{ token: string; info: ApiTokenDto }> {
    const unknown = input.scopes.filter((s) => !(SCOPES as readonly string[]).includes(s));
    if (unknown.length > 0)
      throw validationFailed(
        'Unknown scopes',
        unknown.map((s) => ({ path: 'scopes', message: s })),
      );
    const allowed = new Set<string>(ROLE_SCOPES[role]);
    const denied = input.scopes.filter((s) => !allowed.has(s));
    if (denied.length > 0) throw forbidden(`Your role cannot grant: ${denied.join(', ')}`);
    const secret = `${API_TOKEN_PREFIX}${randomToken(30)}`;
    const row = await this.deps.db.scoped.apiToken.create({
      data: {
        tenantId: requireTenantId(),
        userId,
        name: input.name,
        prefix: secret.slice(0, API_TOKEN_PREFIX.length + 6),
        tokenHash: sha256(secret),
        scopes: input.scopes,
        actorType: input.actorType,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      },
    });
    await writeAudit(this.deps.db.scoped, 'api_token.created', 'api_token', row.id, {
      name: input.name,
      scopes: input.scopes,
    });
    return { token: secret, info: tokenDto(row) };
  }

  async listApiTokens(): Promise<ApiTokenDto[]> {
    const rows = await this.deps.db.scoped.apiToken.findMany({ orderBy: { createdAt: 'desc' } });
    return rows.map(tokenDto);
  }

  async revokeApiToken(id: string): Promise<void> {
    const res = await this.deps.db.scoped.apiToken.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (res.count === 0) throw notFound('API token');
    this.forgetAuth();
    await writeAudit(this.deps.db.scoped, 'api_token.revoked', 'api_token', id, {});
  }

  async updateSettings(patch: Partial<TenantSettings>): Promise<TenantSettings> {
    const tenantId = requireTenantId();
    const tenant = await this.deps.db.system.tenant.findUnique({ where: { id: tenantId } });
    if (tenant === null) throw notFound('Tenant');
    if (patch.timezone !== undefined) {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: patch.timezone });
      } catch {
        throw validationFailed('Unknown time zone', [{ path: 'timezone', message: patch.timezone }]);
      }
    }
    const settings = { ...DEFAULT_SETTINGS, ...((tenant.settings ?? {}) as object), ...patch } as TenantSettings;
    await this.deps.db.system.tenant.update({ where: { id: tenantId }, data: { settings: settings as never } });
    await writeAudit(this.deps.db.scoped, 'settings.updated', 'tenant', tenantId, patch as Record<string, unknown>);
    return settings;
  }
}

export class SecretsService {
  constructor(private readonly deps: CoreDeps) {}

  async list(): Promise<SecretDto[]> {
    const rows = await this.deps.db.scoped.secret.findMany({ orderBy: { name: 'asc' } });
    return rows.map((s) => ({
      id: s.id,
      name: s.name,
      createdAt: isoRequired(s.createdAt),
      updatedAt: isoRequired(s.updatedAt),
    }));
  }

  async names(): Promise<string[]> {
    return (await this.deps.db.scoped.secret.findMany({ select: { name: true } })).map((s) => s.name);
  }

  async upsert(name: string, value: string, userId: string | null): Promise<SecretDto> {
    const tenantId = requireTenantId();
    const ciphertext = encryptSecret(value, this.deps.config.secretsKey);
    const row = await this.deps.db.scoped.secret.upsert({
      where: { tenantId_name: { tenantId, name } },
      create: { tenantId, name, ciphertext, createdBy: userId },
      update: { ciphertext },
    });
    await writeAudit(this.deps.db.scoped, 'secret.saved', 'secret', row.id, { name });
    return { id: row.id, name: row.name, createdAt: isoRequired(row.createdAt), updatedAt: isoRequired(row.updatedAt) };
  }

  async remove(name: string): Promise<void> {
    await this.deps.db.scoped.secret.deleteMany({ where: { name } });
    await writeAudit(this.deps.db.scoped, 'secret.deleted', 'secret', name, { name });
  }

  async resolve(names: string[]): Promise<Map<string, string>> {
    if (names.length === 0) return new Map();
    const rows = await this.deps.db.scoped.secret.findMany({ where: { name: { in: names } } });
    return new Map(rows.map((r) => [r.name, decryptSecret(r.ciphertext, this.deps.config.secretsKey)]));
  }
}
