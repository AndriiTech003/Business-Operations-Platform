import { randomBytes } from 'node:crypto';
import { API, ROOT, WEB, run, startProcess, waitHttp, writeState } from './stack';

export default async function globalSetup(): Promise<void> {
  const id = randomBytes(4).toString('hex');
  const pgBase = process.env['E2E_PG_URL'] ?? 'postgres://127.0.0.1:5432';
  const databaseUrl = `${pgBase}/bop_test_e2e_${id}`;
  const redisUrl = process.env['E2E_REDIS_URL'] ?? 'redis://127.0.0.1:6379/5';
  const redisPrefix = `bop_e2e_${id}`;
  const env: Record<string, string> = {
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    REDIS_PREFIX: redisPrefix,
    API_PORT: '4560',
    PUBLIC_API_URL: API,
    PUBLIC_WEB_URL: WEB,
    REALTIME_URL: 'http://127.0.0.1:4562',
    REALTIME_SERVER_KEY: `e2e-key-${id}`,
    REALTIME_JWT_SECRET: `e2e-jwt-${id}`,
    S3_PREFIX: `e2e/${id}/`,
    SCAN_INTERVAL_MS: '2000',
    SWEEP_INTERVAL_MS: '500',
    OUTBOX_POLL_MS: '100',
    EMAIL_POLL_MS: '300',
    LOG_LEVEL: 'warn',
    OPERATOR_EMBED_URL: 'http://127.0.0.1:4565/embed/ask-operator.js',
    OPERATOR_AGENT_URL: 'http://127.0.0.1:4566',
  };
  run(
    'pnpm',
    [
      'turbo',
      'run',
      'build',
      '--filter=@bop/api',
      '--filter=@bop/worker',
      '--filter=@bop/scheduler',
      '--filter=@bop/realtime',
      '--output-logs=errors-only',
    ],
    env,
  );
  run(process.execPath, ['packages/core/dist/cli/seed.js'], env);
  run(
    'pnpm',
    ['exec', 'vite', 'build', '--outDir', 'dist-e2e', '--emptyOutDir'],
    { ...env, VITE_API_URL: API },
    `${ROOT}/apps/web`,
  );
  const pids = [
    startProcess(
      [process.execPath, 'apps/realtime/dist/main.js'],
      {
        ...env,
        PORT: '4562',
        HOST: '127.0.0.1',
        REDIS_PREFIX: `${redisPrefix}:rt:`,
        JWT_SECRET: env['REALTIME_JWT_SECRET'] as string,
        SERVER_API_KEY: env['REALTIME_SERVER_KEY'] as string,
        ALLOWED_ORIGINS: WEB,
      },
      'realtime',
    ),
    startProcess([process.execPath, 'apps/api/dist/main.js'], env, 'api'),
    startProcess(
      [process.execPath, 'apps/worker/dist/main.js'],
      { ...env, WORKER_ID: 'e2e-worker', WORKER_METRICS_PORT: '4563' },
      'worker',
    ),
    startProcess(
      [process.execPath, 'apps/scheduler/dist/main.js'],
      { ...env, SCHEDULER_METRICS_PORT: '4564' },
      'scheduler',
    ),
    startProcess(
      [
        'pnpm',
        'exec',
        'vite',
        'preview',
        '--outDir',
        'dist-e2e',
        '--port',
        '4561',
        '--host',
        '127.0.0.1',
        '--strictPort',
      ],
      env,
      'web',
      `${ROOT}/apps/web`,
    ),
  ];
  writeState({ id, databaseUrl, redisUrl, redisPrefix, pids });
  await waitHttp(`${API}/health`);
  await waitHttp('http://127.0.0.1:4562/health/live');
  await waitHttp('http://127.0.0.1:4563/health');
  await waitHttp(`${WEB}/`);
}
