import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export class Metrics {
  readonly registry = new Registry();
  readonly runsTotal: Counter<'status'>;
  readonly stepDuration: Histogram<'type' | 'result'>;
  readonly stepQueueLag: Histogram;
  readonly timerLag: Histogram;
  readonly leaseExpired: Counter;
  readonly tenantThrottled: Counter<'tenant'>;
  readonly runsRateLimited: Counter<'tenant'>;
  readonly runsDeferred: Counter<'tenant'>;
  readonly lostNudges: Counter;
  readonly httpDuration: Histogram<'method' | 'route' | 'status'>;
  readonly outboxLag: Histogram;
  readonly emailsSent: Counter<'result'>;
  readonly activeLeader: Gauge;
  readonly dbQueries: Counter;

  constructor(service: string, defaults = true) {
    this.registry.setDefaultLabels({ service });
    if (defaults) collectDefaultMetrics({ register: this.registry });
    const r = [this.registry];
    this.runsTotal = new Counter({
      name: 'workflow_runs_total',
      help: 'Workflow runs by final status',
      labelNames: ['status'],
      registers: r,
    });
    this.stepDuration = new Histogram({
      name: 'workflow_step_duration_seconds',
      help: 'Step handler duration',
      labelNames: ['type', 'result'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
      registers: r,
    });
    this.stepQueueLag = new Histogram({
      name: 'workflow_step_queue_lag_seconds',
      help: 'From scheduled_for (or creation) to claim',
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
      registers: r,
    });
    this.timerLag = new Histogram({
      name: 'workflow_timer_lag_seconds',
      help: 'How late a timer fired',
      buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
      registers: r,
    });
    this.leaseExpired = new Counter({
      name: 'workflow_lease_expired_total',
      help: 'Steps whose lease expired (worker died)',
      registers: r,
    });
    this.tenantThrottled = new Counter({
      name: 'workflow_tenant_throttled_total',
      help: 'Steps deferred by the tenant semaphore',
      labelNames: ['tenant'],
      registers: r,
    });
    this.runsRateLimited = new Counter({
      name: 'workflow_runs_rate_limited_total',
      help: 'Run creations refused by the per-tenant rate limit (429)',
      labelNames: ['tenant'],
      registers: r,
    });
    this.runsDeferred = new Counter({
      name: 'workflow_runs_deferred_total',
      help: 'Runs paced (API, webhook) or with deferred first steps (triggers) by the per-tenant rate limit',
      labelNames: ['tenant'],
      registers: r,
    });
    this.lostNudges = new Counter({
      name: 'workflow_lost_nudges_total',
      help: 'Pending steps re-nudged by the sweeper',
      registers: r,
    });
    this.httpDuration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request duration',
      labelNames: ['method', 'route', 'status'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: r,
    });
    this.outboxLag = new Histogram({
      name: 'outbox_publish_lag_seconds',
      help: 'Outbox row age when relayed',
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 5, 30],
      registers: r,
    });
    this.emailsSent = new Counter({
      name: 'emails_sent_total',
      help: 'Emails delivered to SMTP',
      labelNames: ['result'],
      registers: r,
    });
    this.dbQueries = new Counter({
      name: 'db_queries_total',
      help: 'SQL statements sent by Prisma (only when DB_COUNT_QUERIES=1)',
      registers: r,
    });
    this.activeLeader = new Gauge({
      name: 'scheduler_is_leader',
      help: '1 when this scheduler instance holds the lock',
      registers: r,
    });
  }
}
