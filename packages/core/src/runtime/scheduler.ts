import { createServer, type Server } from 'node:http';
import type { Core } from '../core';
import { LeaderLock } from '../engine/primitives';

export interface SchedulerOptions {
  id?: string;
  metricsPort?: number;
}

export class SchedulerRuntime {
  private readonly lock: LeaderLock;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private lastScan = 0;
  private server: Server | null = null;
  readonly stats = { ticks: 0, leaseRecovered: 0, timersFired: 0, nudged: 0, schedules: 0, scans: 0, overdue: 0 };

  constructor(
    private readonly core: Core,
    private readonly options: SchedulerOptions = {},
  ) {
    const { config, redis, logger, metrics } = core.deps;
    this.lock = new LeaderLock(
      redis,
      `${config.redisPrefix}:scheduler:leader`,
      options.id ?? `scheduler-${process.pid}`,
      config.engine.leaderTtlMs,
      logger,
      (l) => metrics.activeLeader.set(l ? 1 : 0),
    );
  }

  get isLeader(): boolean {
    return this.lock.isLeader;
  }

  async start(): Promise<void> {
    await this.core.start();
    this.lock.start();
    const loop = async () => {
      if (this.stopped) return;
      if (this.lock.isLeader)
        await this.tick().catch((error: unknown) => this.core.logger.error({ err: error }, 'scheduler tick failed'));
      if (!this.stopped) this.timer = setTimeout(() => void loop(), this.core.config.engine.sweepIntervalMs);
    };
    void loop();
    if (this.options.metricsPort !== undefined) {
      this.server = createServer((req, res) => {
        if (req.url === '/metrics') {
          void this.core.deps.metrics.registry.metrics().then((body) => {
            res.writeHead(200, { 'content-type': this.core.deps.metrics.registry.contentType });
            res.end(body);
          });
          return;
        }
        res.writeHead(req.url === '/health' ? 200 : 404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', leader: this.lock.isLeader, stats: this.stats }));
      });
      await new Promise<void>((resolve) => this.server?.listen(this.options.metricsPort, '127.0.0.1', resolve));
    }
    this.core.logger.info('scheduler started');
  }

  async tick(): Promise<void> {
    const engine = this.core.engine;
    const now = new Date();
    this.stats.ticks += 1;
    this.stats.leaseRecovered += await engine.sweepExpiredLeases();
    this.stats.timersFired += await engine.fireDueTimers();
    this.stats.nudged += await engine.renudgeLost();
    this.stats.nudged += await engine.unparkStalled();
    await engine.expireAgentApprovals();
    this.stats.schedules += await this.core.runs.fireSchedules(now);
    if (Date.now() - this.lastScan >= this.core.config.engine.scanIntervalMs) {
      this.lastScan = Date.now();
      this.stats.overdue += await this.core.invoices.markOverdue(now);
      this.stats.scans += await this.core.runs.scanConditions(now);
      await this.core.runs.taskReminders(now);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    await this.lock.stop();
    if (this.server !== null) await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    await this.core.close();
  }
}
