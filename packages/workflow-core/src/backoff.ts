import type { RetryPolicy } from '@bop/contracts';

export function backoffDelay(policy: RetryPolicy, attempt: number, random: () => number = Math.random): number {
  const base = policy.backoff === 'fixed' ? policy.initialMs : policy.initialMs * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(base, policy.maxMs ?? 3_600_000);
  const jitter = capped * 0.2 * (random() * 2 - 1);
  return Math.max(0, Math.round(capped + jitter));
}

export type ErrorClass = 'retryable' | 'permanent';

export function classifyHttpStatus(status: number): ErrorClass {
  if (status === 429 || status === 408 || status >= 500) return 'retryable';
  return 'permanent';
}
