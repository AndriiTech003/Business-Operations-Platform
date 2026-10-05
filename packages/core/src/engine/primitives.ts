import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

const ACQUIRE_OR_PARK = `
local sem = KEYS[1]
local parked = KEYS[2]
local tenants = KEYS[3]
local now = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local holder = ARGV[4]
local park = ARGV[5]
local tenant = ARGV[6]
redis.call('ZREMRANGEBYSCORE', sem, '-inf', now)
if redis.call('ZSCORE', sem, holder) then
  redis.call('ZADD', sem, now + ttl, holder)
  redis.call('ZREM', parked, holder)
  return 1
end
if redis.call('ZCARD', sem) < limit then
  redis.call('ZADD', sem, now + ttl, holder)
  redis.call('PEXPIRE', sem, ttl * 2)
  redis.call('ZREM', parked, holder)
  return 1
end
if park == '1' then
  redis.call('ZADD', parked, 'NX', now, holder)
  redis.call('SADD', tenants, tenant)
end
return 0
`;

const RELEASE_AND_UNPARK = `
local sem = KEYS[1]
local parked = KEYS[2]
local now = tonumber(ARGV[1])
local holder = ARGV[2]
local limit = tonumber(ARGV[3])
redis.call('ZREM', sem, holder)
redis.call('ZREMRANGEBYSCORE', sem, '-inf', now)
local free = limit - redis.call('ZCARD', sem)
if free <= 0 then
  return {}
end
local popped = redis.call('ZPOPMIN', parked, free)
local out = {}
for i = 1, #popped, 2 do
  out[#out + 1] = popped[i]
end
return out
`;

export class TenantSemaphore {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
    private readonly ttlMs: number,
  ) {}

  private key(tenantId: string): string {
    return `${this.prefix}:sem:${tenantId}`;
  }

  parkedKey(tenantId: string): string {
    return `${this.prefix}:parked:${tenantId}`;
  }

  private tenantsKey(): string {
    return `${this.prefix}:parked-tenants`;
  }

  async acquire(tenantId: string, holder: string, limit: number, park = false): Promise<boolean> {
    const result = await this.redis.eval(
      ACQUIRE_OR_PARK,
      3,
      this.key(tenantId),
      this.parkedKey(tenantId),
      this.tenantsKey(),
      Date.now(),
      this.ttlMs,
      limit,
      holder,
      park ? '1' : '0',
      tenantId,
    );
    return Number(result) === 1;
  }

  async extend(tenantId: string, holder: string): Promise<void> {
    await this.redis.zadd(this.key(tenantId), 'XX', Date.now() + this.ttlMs, holder);
  }

  async release(tenantId: string, holder: string, limit = 0): Promise<string[]> {
    const out = await this.redis.eval(
      RELEASE_AND_UNPARK,
      2,
      this.key(tenantId),
      this.parkedKey(tenantId),
      Date.now(),
      holder,
      limit,
    );
    return Array.isArray(out) ? out.map(String) : [];
  }

  async unparkFree(tenantId: string, limit: number): Promise<string[]> {
    return this.release(tenantId, '', limit);
  }

  async parkedCount(tenantId: string): Promise<number> {
    return this.redis.zcard(this.parkedKey(tenantId));
  }

  async parkedTenants(): Promise<string[]> {
    return this.redis.smembers(this.tenantsKey());
  }

  async forgetTenantIfEmpty(tenantId: string): Promise<void> {
    if ((await this.parkedCount(tenantId)) === 0) await this.redis.srem(this.tenantsKey(), tenantId);
  }

  async isParked(tenantId: string, ids: string[]): Promise<boolean[]> {
    if (ids.length === 0) return [];
    const scores = await this.redis.zmscore(this.parkedKey(tenantId), ...ids);
    return scores.map((v) => v !== null);
  }

  async holders(tenantId: string): Promise<number> {
    await this.redis.zremrangebyscore(this.key(tenantId), '-inf', Date.now());
    return this.redis.zcard(this.key(tenantId));
  }
}

const TOKEN_BUCKET = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local burst = tonumber(ARGV[3])
local mode = ARGV[4]
local maxDelay = tonumber(ARGV[5])
local state = redis.call('HMGET', key, 't', 'ts')
local tokens = tonumber(state[1])
local ts = tonumber(state[2])
if tokens == nil then tokens = burst end
if ts == nil then ts = now end
if now > ts then tokens = math.min(burst, tokens + (now - ts) * rate / 1000) end
local wait = 0
local ok = 1
if tokens >= 1 then
  tokens = tokens - 1
else
  wait = math.ceil((1 - tokens) * 1000 / rate)
  if mode == 'reserve' and (maxDelay < 0 or wait <= maxDelay) then
    tokens = tokens - 1
  else
    ok = 0
    if maxDelay > 0 then wait = math.max(1, wait - maxDelay) end
  end
end
redis.call('HSET', key, 't', tostring(tokens), 'ts', tostring(math.max(now, ts)))
local deficit = 0
if tokens < 0 then deficit = -tokens end
redis.call('PEXPIRE', key, math.ceil((burst + deficit) * 1000 / rate) + 60000)
return {ok, wait}
`;

export interface RateDecision {
  allowed: boolean;
  delayMs: number;
}

export class RunRateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
    readonly ratePerSecond: number,
    readonly burst: number,
  ) {}

  get enabled(): boolean {
    return this.ratePerSecond > 0;
  }

  private key(tenantId: string): string {
    return `${this.prefix}:runrate:${tenantId}`;
  }

  async take(
    tenantId: string,
    mode: 'strict' | 'reserve',
    override: { ratePerSecond?: number; burst?: number } = {},
    maxDelayMs = -1,
  ): Promise<RateDecision> {
    const rate = override.ratePerSecond ?? this.ratePerSecond;
    if (rate <= 0) return { allowed: true, delayMs: 0 };
    const out = (await this.redis.eval(
      TOKEN_BUCKET,
      1,
      this.key(tenantId),
      Date.now(),
      rate,
      Math.max(1, override.burst ?? this.burst),
      mode === 'reserve' ? 'reserve' : 'take',
      mode === 'reserve' ? maxDelayMs : 0,
    )) as [number, number];
    return { allowed: Number(out[0]) === 1, delayMs: Number(out[1]) };
  }
}

const RENEW = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

const RELEASE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

export class LeaderLock {
  private leader = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly redis: Redis,
    private readonly key: string,
    private readonly id: string,
    private readonly ttlMs: number,
    private readonly logger: Logger,
    private readonly onChange: (leader: boolean) => void = () => undefined,
  ) {}

  get isLeader(): boolean {
    return this.leader;
  }

  async tick(): Promise<boolean> {
    try {
      if (this.leader) {
        const renewed = Number(await this.redis.eval(RENEW, 1, this.key, this.id, this.ttlMs));
        if (renewed !== 1) this.set(false);
      }
      if (!this.leader) {
        const ok = await this.redis.set(this.key, this.id, 'PX', this.ttlMs, 'NX');
        if (ok === 'OK') this.set(true);
      }
    } catch (error) {
      this.logger.warn({ err: (error as Error).message }, 'leader election failed');
      this.set(false);
    }
    return this.leader;
  }

  private set(value: boolean): void {
    if (value !== this.leader) {
      this.leader = value;
      this.logger.info({ leader: value, id: this.id }, value ? 'became scheduler leader' : 'lost scheduler leadership');
      this.onChange(value);
    }
  }

  start(): void {
    const loop = async () => {
      await this.tick();
      this.timer = setTimeout(() => void loop(), Math.max(200, Math.floor(this.ttlMs / 3)));
    };
    void loop();
  }

  async stop(): Promise<void> {
    if (this.timer !== null) clearTimeout(this.timer);
    if (this.leader) await this.redis.eval(RELEASE, 1, this.key, this.id).catch(() => 0);
    this.leader = false;
  }
}

export class CancellationRegistry {
  private readonly controllers = new Map<string, Set<AbortController>>();
  private subscriber: Redis | null = null;

  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
  ) {}

  channel(runId: string): string {
    return `${this.prefix}:wf:cancel:${runId}`;
  }

  async start(): Promise<void> {
    this.subscriber = this.redis.duplicate();
    await this.subscriber.psubscribe(`${this.prefix}:wf:cancel:*`);
    this.subscriber.on('pmessage', (_pattern, channel) => {
      const runId = channel.slice(`${this.prefix}:wf:cancel:`.length);
      for (const c of this.controllers.get(runId) ?? []) c.abort(new Error('run cancelled'));
    });
  }

  register(runId: string, controller: AbortController): () => void {
    const set = this.controllers.get(runId) ?? new Set();
    set.add(controller);
    this.controllers.set(runId, set);
    return () => {
      set.delete(controller);
      if (set.size === 0) this.controllers.delete(runId);
    };
  }

  async broadcast(runId: string): Promise<void> {
    await this.redis.publish(this.channel(runId), 'cancel');
  }

  async stop(): Promise<void> {
    if (this.subscriber !== null) {
      this.subscriber.disconnect();
      this.subscriber = null;
    }
  }
}
