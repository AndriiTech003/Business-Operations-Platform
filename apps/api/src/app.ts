import 'reflect-metadata';
import { Module, type DynamicModule } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Core, type CoreConfig } from '@bop/core';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import { authMiddleware, ScopeGuard } from './common/auth';
import { CORE } from './common/http';
import { ProblemFilter } from './common/problem.filter';
import { AdminController } from './controllers/admin.controller';
import { AuthController } from './controllers/auth.controller';
import { DealsController } from './controllers/deals.controller';
import { InvoicesController } from './controllers/invoices.controller';
import { CompaniesController, ContactsController } from './controllers/records.controller';
import { SystemController } from './controllers/system.controller';
import { TasksController } from './controllers/tasks.controller';
import { ApprovalsController, WorkflowsController } from './controllers/workflows.controller';

export const CONTROLLERS = [
  SystemController,
  AuthController,
  CompaniesController,
  ContactsController,
  DealsController,
  InvoicesController,
  TasksController,
  AdminController,
  ApprovalsController,
  WorkflowsController,
];

@Module({})
export class AppModule {
  static forRoot(core: Core): DynamicModule {
    return {
      module: AppModule,
      controllers: CONTROLLERS,
      providers: [
        { provide: CORE, useValue: core },
        { provide: APP_GUARD, useFactory: () => new ScopeGuard(core) },
      ],
    };
  }
}

export interface ApiOptions {
  port?: number;
  host?: string;
  config?: Partial<CoreConfig>;
  listen?: boolean;
  corsOrigins?: string[];
}

export interface RunningApi {
  app: NestExpressApplication;
  core: Core;
  url: string;
  close(): Promise<void>;
}

export async function createApi(options: ApiOptions = {}): Promise<RunningApi> {
  const core = new Core({ service: 'api', config: options.config });
  await core.start();
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(core), {
    logger: ['error', 'warn'],
    bodyParser: false,
  });
  const origins = new Set([
    core.config.publicWebUrl,
    'http://127.0.0.1:4510',
    'http://localhost:4510',
    'http://127.0.0.1:4511',
    'http://localhost:4511',
    ...(options.corsOrigins ?? []),
    ...(process.env['CORS_ORIGINS'] ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  ]);
  app.enableCors({
    origin: (origin, cb) =>
      cb(
        null,
        origin === undefined || origins.has(origin) || /^http:\/\/(127\.0\.0\.1|localhost):45\d\d$/.test(origin),
      ),
    credentials: true,
    exposedHeaders: ['ETag', 'Idempotent-Replayed'],
  });
  app.useBodyParser('json', { limit: '12mb' });
  app.use(cookieParser());
  app.use((req: Request, res: Response, next: NextFunction) => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const route = (req.route as { path?: string } | undefined)?.path ?? 'unmatched';
      core.deps.metrics.httpDuration.observe(
        { method: req.method, route, status: String(res.statusCode) },
        Number(process.hrtime.bigint() - started) / 1e9,
      );
    });
    next();
  });
  app.use(authMiddleware(core));
  app.useGlobalFilters(new ProblemFilter(core.logger));
  app.enableShutdownHooks();
  let url = '';
  if (options.listen !== false) {
    const port = options.port ?? Number(process.env['API_PORT'] ?? 4500);
    const host = options.host ?? process.env['API_HOST'] ?? '127.0.0.1';
    await app.listen(port, host);
    const address = app.getHttpServer().address();
    url = `http://${host}:${typeof address === 'object' && address !== null ? address.port : port}`;
  }
  return {
    app,
    core,
    url,
    async close() {
      await app.close();
      await core.close();
    },
  };
}
