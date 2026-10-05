import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { tenantExtension, type ScopedClient } from './tenancy';

export function utcConnectionString(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  const options = (url.searchParams.get('options') ?? '')
    .replace(/-c\s*timezone=\S+/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  url.searchParams.set('options', `${options} -c TimeZone=UTC`.trim());
  return url.toString();
}

export function createBaseClient(databaseUrl: string, poolSize = 10, onQuery?: () => void): PrismaClient {
  const adapter = new PrismaPg({ connectionString: utcConnectionString(databaseUrl), max: poolSize });
  if (onQuery === undefined) return new PrismaClient({ adapter });
  const client = new PrismaClient({ adapter, log: [{ emit: 'event', level: 'query' }] });
  (client as unknown as { $on(event: 'query', cb: () => void): void }).$on('query', onQuery);
  return client;
}

export class Db {
  readonly system: PrismaClient;
  readonly scoped: ScopedClient;

  constructor(databaseUrl: string, poolSize = 10, onQuery?: () => void) {
    this.system = createBaseClient(databaseUrl, poolSize, onQuery);
    this.scoped = tenantExtension(this.system);
  }

  async close(): Promise<void> {
    await this.system.$disconnect();
  }
}
