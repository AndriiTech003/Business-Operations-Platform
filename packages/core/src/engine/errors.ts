import { ExprError } from '@ashamrai/expr';
import { DomainError } from '../errors';

export class StepError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly code = 'step_error',
  ) {
    super(message);
    this.name = 'StepError';
  }
}

export interface ClassifiedError {
  message: string;
  retryable: boolean;
  code: string;
}

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

export function classifyError(error: unknown): ClassifiedError {
  if (error instanceof StepError) return { message: error.message, retryable: error.retryable, code: error.code };
  if (error instanceof ExprError)
    return { message: `Expression error: ${error.message}`, retryable: false, code: 'expression_error' };
  if (error instanceof DomainError)
    return {
      message: error.message,
      retryable: error.status === 429 || error.status === 412 || error.status >= 500,
      code: error.code,
    };
  const e = error as { name?: string; code?: string; message?: string; cause?: { code?: string } };
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError')
    return { message: e.message ?? 'timeout', retryable: true, code: 'timeout' };
  const code = e?.code ?? e?.cause?.code;
  if (code !== undefined && NETWORK_CODES.has(code))
    return { message: e.message ?? code, retryable: true, code: 'network' };
  return { message: e?.message ?? String(error), retryable: true, code: 'internal' };
}
