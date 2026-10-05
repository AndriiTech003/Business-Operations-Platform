import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';

const run = promisify(execFile);

export function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

export function databaseName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
}

async function adminQuery(adminUrl: string, sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

export async function createDatabase(adminUrl: string, name: string): Promise<void> {
  await adminQuery(adminUrl, `CREATE DATABASE ${quoteIdent(name)}`);
}

export async function ensureDatabase(databaseUrl: string): Promise<boolean> {
  const name = databaseName(databaseUrl);
  const adminUrl = withDatabase(databaseUrl, 'postgres');
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const found = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (found.rowCount === 0) {
      await client.query(`CREATE DATABASE ${quoteIdent(name)}`);
      return true;
    }
    return false;
  } finally {
    await client.end();
  }
}

export async function dropDatabase(adminUrl: string, name: string): Promise<void> {
  await adminQuery(adminUrl, `DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
}

export function corePackageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(join(dir, 'prisma', 'schema.prisma'))) return dir;
    dir = resolve(dir, '..');
  }
  throw new Error('Cannot locate packages/core (prisma/schema.prisma)');
}

export function withUser(url: string): string {
  const u = new URL(url);
  if (u.username === '') u.username = process.env['PGUSER'] ?? process.env['USER'] ?? 'postgres';
  return u.toString();
}

export async function migrateDatabase(databaseUrl: string): Promise<void> {
  const root = corePackageRoot();
  const bin = join(root, 'node_modules', '.bin', 'prisma');
  await run(bin, ['migrate', 'deploy'], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: withUser(databaseUrl), PRISMA_HIDE_UPDATE_MESSAGE: '1' },
    maxBuffer: 10 * 1024 * 1024,
  });
}
