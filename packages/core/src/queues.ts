import { Queue, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';

export const QUEUE_NAMES = {
  events: 'events',
  steps: 'steps',
  emails: 'emails',
  pdf: 'pdf',
  imports: 'imports',
  callbacks: 'callbacks',
} as const;
export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export function createRedis(url: string, forWorker = false): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: forWorker ? null : 3,
    enableReadyCheck: true,
    lazyConnect: false,
  });
}

export interface StepJob {
  stepRunId: string;
  tenantId: string;
}

export interface EventJob {
  outboxId: string;
}

const MAX_PRIORITY = 2_097_151;

export class Queues {
  readonly connection: Redis;
  readonly prefix: string;
  readonly events: Queue;
  readonly steps: Queue;
  readonly emails: Queue;
  readonly pdf: Queue;
  readonly imports: Queue;
  readonly callbacks: Queue;

  constructor(
    redisUrl: string,
    readonly redisPrefix: string,
    readonly fairScheduling = true,
  ) {
    this.connection = createRedis(redisUrl, true);
    this.prefix = `${redisPrefix}:bull`;
    const make = (name: string) => new Queue(name, { connection: this.connection, prefix: this.prefix });
    this.events = make(QUEUE_NAMES.events);
    this.steps = make(QUEUE_NAMES.steps);
    this.emails = make(QUEUE_NAMES.emails);
    this.pdf = make(QUEUE_NAMES.pdf);
    this.imports = make(QUEUE_NAMES.imports);
    this.callbacks = make(QUEUE_NAMES.callbacks);
  }

  backlogKey(tenantId: string): string {
    return `${this.redisPrefix}:backlog:${tenantId}`;
  }

  parkedKey(tenantId: string): string {
    return `${this.redisPrefix}:parked:${tenantId}`;
  }

  async nudgeSteps(jobs: StepJob[], delayMs = 0): Promise<void> {
    if (jobs.length === 0) return;
    const priorities = new Map<string, number>();
    if (this.fairScheduling) {
      const pipeline = this.connection.pipeline();
      for (const job of jobs) {
        pipeline.incr(this.backlogKey(job.tenantId));
        pipeline.pexpire(this.backlogKey(job.tenantId), 600_000);
        pipeline.zcard(this.parkedKey(job.tenantId));
      }
      const results = (await pipeline.exec()) ?? [];
      jobs.forEach((job, i) => {
        const value = Number(results[i * 3]?.[1] ?? 1) + Number(results[i * 3 + 2]?.[1] ?? 0);
        priorities.set(job.stepRunId, Math.min(MAX_PRIORITY, Math.max(1, value)));
      });
    }
    await this.steps.addBulk(
      jobs.map((job) => {
        const opts: JobsOptions = {
          removeOnComplete: true,
          removeOnFail: 1000,
          priority: priorities.get(job.stepRunId) ?? 1,
        };
        if (delayMs > 0) opts.delay = delayMs;
        return { name: 'step', data: job, opts };
      }),
    );
  }

  async stepStarted(tenantId: string): Promise<void> {
    if (!this.fairScheduling) return;
    const key = this.backlogKey(tenantId);
    const value = await this.connection.decr(key);
    if (value < 0) await this.connection.set(key, '0', 'PX', 600_000);
  }

  async enqueueEvent(outboxId: string): Promise<void> {
    await this.events.add('event', { outboxId } satisfies EventJob, {
      jobId: outboxId,
      removeOnComplete: { age: 3600 },
      removeOnFail: 1000,
      attempts: 5,
      backoff: { type: 'exponential', delay: 1000 },
    });
  }

  async close(): Promise<void> {
    await Promise.all(
      [this.events, this.steps, this.emails, this.pdf, this.imports, this.callbacks].map((q) => q.close()),
    );
    this.connection.disconnect();
  }
}
