import pino, { type Logger } from 'pino';
import { loadConfig, type CoreConfig } from './config';
import type { CoreDeps } from './deps';
import { Db } from './db/client';
import { createAiProvider } from './engine/ai';
import { WorkflowsService } from './engine/definitions';
import { Effects } from './engine/effects';
import { Engine } from './engine/engine';
import { RecordLoader } from './engine/records';
import { RunsService } from './engine/runs';
import type { EngineServices } from './engine/types';
import { EventConsumer, OutboxRelay } from './events/consumer';
import { FlagsGateway } from './flags/flags';
import { Metrics } from './metrics';
import { InvoiceDocuments } from './pdf/invoice-pdf';
import { Queues, createRedis } from './queues';
import { RealtimePublisher } from './realtime/publisher';
import { AccountsService, SecretsService } from './services/accounts';
import { ActivityService, NotificationsService } from './services/activity';
import { ApprovalsService } from './services/approvals';
import { CompaniesService } from './services/companies';
import { ContactsService } from './services/contacts';
import { CustomFieldsService } from './services/custom-fields';
import { DealsService } from './services/deals';
import { Directory } from './services/directory';
import { EmailsService } from './services/emails';
import { IdempotencyService } from './services/idempotency';
import { ImportsService } from './services/imports';
import { InvoicesService } from './services/invoices';
import { ReportsService, SearchService } from './services/reports';
import { TasksService } from './services/tasks';
import { ObjectStorage } from './storage/s3';

export interface CoreOptions {
  service: string;
  config?: Partial<CoreConfig>;
  logger?: Logger;
}

export class Core {
  readonly deps: CoreDeps;
  readonly directory: Directory;
  readonly customFields: CustomFieldsService;
  readonly companies: CompaniesService;
  readonly contacts: ContactsService;
  readonly deals: DealsService;
  readonly records: RecordLoader;
  readonly emails: EmailsService;
  readonly invoices: InvoicesService;
  readonly documents: InvoiceDocuments;
  readonly tasks: TasksService;
  readonly activity: ActivityService;
  readonly notifications: NotificationsService;
  readonly approvals: ApprovalsService;
  readonly accounts: AccountsService;
  readonly secrets: SecretsService;
  readonly reports: ReportsService;
  readonly search: SearchService;
  readonly imports: ImportsService;
  readonly idempotency: IdempotencyService;
  readonly workflows: WorkflowsService;
  readonly effects: Effects;
  readonly engine: Engine;
  readonly runs: RunsService;
  readonly consumer: EventConsumer;
  readonly relay: OutboxRelay;

  constructor(options: CoreOptions) {
    const config = { ...loadConfig(), ...options.config } as CoreConfig;
    const logger = options.logger ?? pino({ level: config.logLevel, base: { service: options.service } });
    const redis = createRedis(config.redisUrl);
    redis.on('error', (error: Error) => logger.warn({ err: error.message }, 'redis error'));
    const metrics = new Metrics(options.service);
    const db = new Db(
      config.databaseUrl,
      config.dbPoolSize,
      process.env['DB_COUNT_QUERIES'] === '1' ? () => metrics.dbQueries.inc() : undefined,
    );
    const queues = new Queues(config.redisUrl, config.redisPrefix, config.engine.fairScheduling);
    queues.connection.on('error', (error: Error) => logger.warn({ err: error.message }, 'redis (queues) error'));
    const deps: CoreDeps = {
      config,
      db,
      redis,
      queues,
      logger,
      storage: new ObjectStorage(config.s3),
      realtime: new RealtimePublisher({ ...config.realtime, redisPrefix: config.redisPrefix }, redis, logger),
      flags: new FlagsGateway(config.flags.relayUrl, config.flags.sdkKey, logger),
      metrics,
    };
    this.deps = deps;
    this.directory = new Directory(deps);
    this.customFields = new CustomFieldsService(deps);
    this.companies = new CompaniesService(deps, this.directory, this.customFields);
    this.contacts = new ContactsService(deps, this.directory, this.customFields);
    this.deals = new DealsService(deps, this.directory, this.customFields);
    this.records = new RecordLoader(deps, this.directory);
    this.emails = new EmailsService(deps, this.records, this.customFields);
    this.invoices = new InvoicesService(deps, this.emails);
    this.documents = new InvoiceDocuments(deps, this.invoices);
    this.tasks = new TasksService(deps, this.directory);
    this.activity = new ActivityService(deps, this.directory);
    this.notifications = new NotificationsService(deps);
    this.approvals = new ApprovalsService(deps, this.directory, this.notifications);
    this.accounts = new AccountsService(deps, this.deals, this.emails);
    this.secrets = new SecretsService(deps);
    this.reports = new ReportsService(deps, this.directory);
    this.search = new SearchService(deps);
    this.imports = new ImportsService(deps, this.companies, this.contacts);
    this.idempotency = new IdempotencyService(deps);
    this.workflows = new WorkflowsService(deps, this.customFields, this.emails, this.secrets);
    this.effects = new Effects(deps);
    const engineServices: EngineServices = {
      deps,
      directory: this.directory,
      tasks: this.tasks,
      deals: this.deals,
      companies: this.companies,
      contacts: this.contacts,
      invoices: this.invoices,
      emails: this.emails,
      notifications: this.notifications,
      approvals: this.approvals,
      records: this.records,
      customFields: this.customFields,
      secrets: this.secrets,
      workflows: this.workflows,
      effects: this.effects,
      ai: createAiProvider(config.ai),
    };
    this.engine = new Engine(engineServices);
    this.runs = new RunsService(engineServices, this.engine);
    this.consumer = new EventConsumer(
      deps,
      this.search,
      this.activity,
      this.notifications,
      this.approvals,
      this.runs,
      this.engine,
    );
    this.relay = new OutboxRelay(deps);
  }

  get config(): CoreConfig {
    return this.deps.config;
  }

  get logger(): Logger {
    return this.deps.logger;
  }

  async start(): Promise<void> {
    await this.deps.flags.start();
  }

  async close(): Promise<void> {
    await this.relay.stop();
    await this.engine.cancels.stop();
    await this.deps.flags.close();
    await this.deps.queues.close().catch(() => undefined);
    this.deps.redis.disconnect();
    this.deps.storage.close();
    await this.deps.db.close();
  }
}
