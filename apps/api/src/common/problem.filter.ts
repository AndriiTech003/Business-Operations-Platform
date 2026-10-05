import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { CrossTenantWriteError, DomainError, MissingTenantContextError, isUniqueViolation } from '@bop/core';
import type { Logger } from 'pino';
import type { Request, Response } from 'express';

interface ProblemBody {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  code: string;
  errors?: unknown;
  current?: unknown;
  [key: string]: unknown;
}

export function toProblem(exception: unknown, path: string): ProblemBody {
  if (exception instanceof DomainError) {
    const body: ProblemBody = {
      type: `https://bop.dev/problems/${exception.code}`,
      title: exception.message,
      status: exception.status,
      code: exception.code,
      instance: path,
    };
    if (exception.details.errors !== undefined) body.errors = exception.details.errors;
    if (exception.details.current !== undefined) body.current = exception.details.current;
    if (exception.details.extra !== undefined) Object.assign(body, exception.details.extra);
    return body;
  }
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const res = exception.getResponse();
    const message =
      typeof res === 'string'
        ? res
        : (((res as { message?: unknown }).message as string | undefined) ?? exception.message);
    return {
      type: `https://bop.dev/problems/http_${status}`,
      title: Array.isArray(message) ? message.join(', ') : String(message),
      status,
      code: status === 404 ? 'not_found' : `http_${status}`,
      instance: path,
    };
  }
  if (exception instanceof MissingTenantContextError || exception instanceof CrossTenantWriteError) {
    return {
      type: 'https://bop.dev/problems/tenant_context',
      title: exception.message,
      status: 500,
      code: 'tenant_context',
      instance: path,
    };
  }
  if (isUniqueViolation(exception))
    return {
      type: 'https://bop.dev/problems/conflict',
      title: 'A record with the same unique value already exists',
      status: 409,
      code: 'conflict',
      instance: path,
    };
  const driver = exception as { code?: string; meta?: { driverAdapterError?: { cause?: { originalCode?: string } } } };
  if (driver?.code === 'P2007' || driver?.meta?.driverAdapterError?.cause?.originalCode === '22P02')
    return {
      type: 'https://bop.dev/problems/invalid_id',
      title: 'Malformed identifier or value',
      status: 400,
      code: 'invalid_id',
      instance: path,
    };
  const e = exception as { type?: string; status?: number; message?: string };
  if (e?.type === 'entity.too.large')
    return {
      type: 'https://bop.dev/problems/payload_too_large',
      title: 'Payload too large',
      status: 413,
      code: 'payload_too_large',
      instance: path,
    };
  if (e?.type === 'entity.parse.failed')
    return {
      type: 'https://bop.dev/problems/bad_json',
      title: 'Malformed JSON body',
      status: 400,
      code: 'bad_json',
      instance: path,
    };
  return {
    type: 'https://bop.dev/problems/internal',
    title: 'Internal server error',
    status: 500,
    code: 'internal',
    instance: path,
  };
}

@Catch()
export class ProblemFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    if (res.headersSent) return;
    const body = toProblem(exception, req.path);
    if (body.status >= 500) this.logger.error({ err: exception, path: req.path, method: req.method }, 'request failed');
    if (body.status === 429 && typeof body['retryAfterMs'] === 'number')
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil(body['retryAfterMs'] / 1000))));
    res.status(body.status).type('application/problem+json').json(body);
  }
}
