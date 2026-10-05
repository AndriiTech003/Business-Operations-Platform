export interface CoreConfig {
  databaseUrl: string;
  dbPoolSize: number;
  redisUrl: string;
  redisPrefix: string;
  publicApiUrl: string;
  publicWebUrl: string;
  jwtSecret: string;
  secretsKey: string;
  smtpUrl: string;
  mailFrom: string;
  s3: {
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    prefix: string;
  };
  realtime: { url: string | null; serverKey: string; jwtSecret: string };
  flags: { relayUrl: string | null; sdkKey: string | null };
  engine: EngineConfig;
  ai: {
    provider: 'fake' | 'anthropic' | 'operator';
    apiKey: string | null;
    model: string;
    operatorUrl: string | null;
    operatorToken: string | null;
  };
  operatorEmbed: { scriptUrl: string | null; agentUrl: string | null; consoleUrl: string | null };
  logLevel: string;
}

export interface EngineConfig {
  workerId: string;
  stepConcurrency: number;
  leaseMs: number;
  heartbeatMs: number;
  tenantMaxConcurrentSteps: number;
  tenantRunRate: number;
  tenantRunBurst: number;
  tenantRunMaxWaitMs: number;
  throttleRetryMs: number;
  sweepIntervalMs: number;
  lostNudgeAfterMs: number;
  scanIntervalMs: number;
  leaderTtlMs: number;
  maxStepsPerRun: number;
  maxActiveRunsPerTenant: number;
  maxCausationDepth: number;
  emailsPerMinute: number;
  outboxPollMs: number;
  emailPollMs: number;
  emailLeaseMs: number;
  testEffectDelayMs: number;
  testEffectDelayNode: string | null;
  fairScheduling: boolean;
  httpTimeoutMs: number;
  envCacheMs: number;
}

function aiProvider(env: NodeJS.ProcessEnv): 'fake' | 'anthropic' | 'operator' {
  const explicit = env['AI_PROVIDER'];
  if (explicit === 'anthropic' || explicit === 'operator' || explicit === 'fake') return explicit;
  return env['OPERATOR_URL'] !== undefined && env['OPERATOR_URL'] !== '' ? 'operator' : 'fake';
}

function int(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${key} must be a number`);
  return n;
}

function str(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const raw = env[key];
  return raw === undefined || raw === '' ? fallback : raw;
}

function opt(env: NodeJS.ProcessEnv, key: string): string | null {
  const raw = env[key];
  return raw === undefined || raw === '' ? null : raw;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CoreConfig {
  return {
    databaseUrl: str(env, 'DATABASE_URL', 'postgres://127.0.0.1:5432/bop'),
    dbPoolSize: int(env, 'DB_POOL_SIZE', 10),
    redisUrl: str(env, 'REDIS_URL', 'redis://127.0.0.1:6379/5'),
    redisPrefix: str(env, 'REDIS_PREFIX', 'bop'),
    publicApiUrl: str(env, 'PUBLIC_API_URL', 'http://127.0.0.1:4500'),
    publicWebUrl: str(env, 'PUBLIC_WEB_URL', 'http://127.0.0.1:4510'),
    jwtSecret: str(env, 'JWT_SECRET', 'dev-only-jwt-secret-change-me'),
    secretsKey: str(env, 'SECRETS_KEY', 'dev-only-secrets-key-change-me-32b'),
    smtpUrl: str(env, 'SMTP_URL', 'smtp://127.0.0.1:1025'),
    mailFrom: str(env, 'MAIL_FROM', 'Business Ops <no-reply@bop.local>'),
    s3: {
      endpoint: str(env, 'S3_ENDPOINT', 'http://127.0.0.1:9002'),
      region: str(env, 'S3_REGION', 'us-east-1'),
      bucket: str(env, 'S3_BUCKET', 'bop'),
      accessKeyId: str(env, 'S3_ACCESS_KEY', 'minioadmin'),
      secretAccessKey: str(env, 'S3_SECRET_KEY', 'minioadmin'),
      prefix: str(env, 'S3_PREFIX', ''),
    },
    realtime: {
      url: opt(env, 'REALTIME_URL'),
      serverKey: str(env, 'REALTIME_SERVER_KEY', 'dev-realtime-server-key'),
      jwtSecret: str(env, 'REALTIME_JWT_SECRET', 'dev-realtime-jwt-secret'),
    },
    flags: { relayUrl: opt(env, 'FLAGS_RELAY_URL'), sdkKey: opt(env, 'FLAGS_SDK_KEY') },
    engine: {
      workerId: str(env, 'WORKER_ID', `worker-${process.pid}`),
      stepConcurrency: int(env, 'STEP_CONCURRENCY', 16),
      leaseMs: int(env, 'LEASE_MS', 30_000),
      heartbeatMs: int(env, 'HEARTBEAT_MS', 10_000),
      tenantMaxConcurrentSteps: int(env, 'TENANT_MAX_CONCURRENT_STEPS', 8),
      tenantRunRate: int(env, 'TENANT_RUN_RATE', 50),
      tenantRunBurst: int(env, 'TENANT_RUN_BURST', 500),
      tenantRunMaxWaitMs: int(env, 'TENANT_RUN_MAX_WAIT_MS', 2000),
      throttleRetryMs: int(env, 'THROTTLE_RETRY_MS', 1000),
      sweepIntervalMs: int(env, 'SWEEP_INTERVAL_MS', 5000),
      lostNudgeAfterMs: int(env, 'LOST_NUDGE_AFTER_MS', 30_000),
      scanIntervalMs: int(env, 'SCAN_INTERVAL_MS', 60_000),
      leaderTtlMs: int(env, 'LEADER_TTL_MS', 15_000),
      maxStepsPerRun: int(env, 'MAX_STEPS_PER_RUN', 200),
      maxActiveRunsPerTenant: int(env, 'MAX_ACTIVE_RUNS_PER_TENANT', 50_000),
      maxCausationDepth: int(env, 'MAX_CAUSATION_DEPTH', 5),
      emailsPerMinute: int(env, 'EMAILS_PER_MINUTE', 120),
      outboxPollMs: int(env, 'OUTBOX_POLL_MS', 200),
      emailPollMs: int(env, 'EMAIL_POLL_MS', 500),
      emailLeaseMs: int(env, 'EMAIL_LEASE_MS', 30_000),
      testEffectDelayMs: int(env, 'TEST_EFFECT_DELAY_MS', 0),
      testEffectDelayNode: opt(env, 'TEST_EFFECT_DELAY_NODE'),
      fairScheduling: str(env, 'FAIR_SCHEDULING', '1') === '1',
      httpTimeoutMs: int(env, 'HTTP_TIMEOUT_MS', 15_000),
      envCacheMs: int(env, 'ENV_CACHE_MS', 5000),
    },
    ai: {
      provider: aiProvider(env),
      apiKey: opt(env, 'ANTHROPIC_API_KEY'),
      model: str(env, 'AI_MODEL', 'claude-opus-5-5'),
      operatorUrl: opt(env, 'OPERATOR_URL'),
      operatorToken: opt(env, 'OPERATOR_TOKEN'),
    },
    operatorEmbed: {
      scriptUrl: opt(env, 'OPERATOR_EMBED_URL'),
      agentUrl: opt(env, 'OPERATOR_AGENT_URL'),
      consoleUrl: opt(env, 'OPERATOR_CONSOLE_URL'),
    },
    logLevel: str(env, 'LOG_LEVEL', 'info'),
  };
}
