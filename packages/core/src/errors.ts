export interface IssueDetail {
  path: string;
  message: string;
  nodeId?: string;
}

export class DomainError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: { errors?: IssueDetail[]; current?: unknown; extra?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export const notFound = (what: string): DomainError => new DomainError(404, 'not_found', `${what} not found`);
export const badRequest = (message: string, errors?: IssueDetail[]): DomainError =>
  new DomainError(400, 'bad_request', message, errors === undefined ? {} : { errors });
export const validationFailed = (message: string, errors: IssueDetail[]): DomainError =>
  new DomainError(422, 'validation_failed', message, { errors });
export const conflict = (message: string, current?: unknown): DomainError =>
  new DomainError(409, 'conflict', message, current === undefined ? {} : { current });
export const preconditionFailed = (current: unknown): DomainError =>
  new DomainError(412, 'precondition_failed', 'The record was changed by someone else', { current });
export const forbidden = (message = 'Forbidden'): DomainError => new DomainError(403, 'forbidden', message);
export const unauthorized = (message = 'Unauthorized'): DomainError => new DomainError(401, 'unauthorized', message);
export const tooMany = (message: string): DomainError => new DomainError(429, 'rate_limited', message);
export const unprocessable = (code: string, message: string): DomainError => new DomainError(422, code, message);

export function isUniqueViolation(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const e = error as { code?: unknown; cause?: unknown; meta?: unknown; message?: unknown };
  if (e.code === 'P2002' || e.code === '23505') return true;
  if (typeof e.message === 'string' && e.message.includes('Unique constraint failed')) return true;
  return e.cause !== undefined && e.cause !== error && isUniqueViolation(e.cause);
}
