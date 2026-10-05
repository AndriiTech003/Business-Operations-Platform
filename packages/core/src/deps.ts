import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { CoreConfig } from './config';
import type { Db } from './db/client';
import type { FlagsGateway } from './flags/flags';
import type { Metrics } from './metrics';
import type { Queues } from './queues';
import type { RealtimePublisher } from './realtime/publisher';
import type { ObjectStorage } from './storage/s3';

export interface CoreDeps {
  config: CoreConfig;
  db: Db;
  redis: Redis;
  queues: Queues;
  logger: Logger;
  storage: ObjectStorage;
  realtime: RealtimePublisher;
  flags: FlagsGateway;
  metrics: Metrics;
}
