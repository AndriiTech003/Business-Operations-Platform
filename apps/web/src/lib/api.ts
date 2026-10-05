import type { LoginResponse, MeDto, Problem } from '@bop/contracts';

export const API_URL = (import.meta.env.VITE_API_URL ?? 'http://127.0.0.1:4500').replace(/\/+$/, '');

export class ApiError extends Error {
  readonly status: number;
  readonly problem: Problem;

  constructor(status: number, problem: Problem) {
    super(problem.detail ?? problem.title ?? `Request failed with ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.problem = problem;
  }

  get code(): string | undefined {
    return this.problem.code;
  }

  fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const e of this.problem.errors ?? []) if (out[e.path] === undefined) out[e.path] = e.message;
    return out;
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const first = e.problem.errors?.[0];
    if (first !== undefined && (e.problem.detail === undefined || e.problem.detail === ''))
      return `${e.problem.title}: ${first.path} ${first.message}`;
    return e.problem.detail ?? e.problem.title;
  }
  if (e instanceof Error) return e.message;
  return 'Something went wrong';
}

type SessionListener = (me: MeDto | null) => void;

let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;
const sessionListeners = new Set<SessionListener>();

export function getAccessToken(): string | null {
  return accessToken;
}

export function setSession(res: LoginResponse | null): void {
  accessToken = res?.accessToken ?? null;
  for (const l of sessionListeners) l(res?.me ?? null);
}

export function onSessionChange(listener: SessionListener): () => void {
  sessionListeners.add(listener);
  return () => sessionListeners.delete(listener);
}

export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

export type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions {
  query?: Record<string, QueryValue>;
  body?: unknown;
  ifMatch?: number | string;
  idempotencyKey?: string;
  signal?: AbortSignal;
  auth?: boolean;
  raw?: boolean;
  headers?: Record<string, string>;
}

export function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  const url = new URL(path.startsWith('http') ? path : `${API_URL}${path}`);
  if (query !== undefined) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

async function parseProblem(res: Response): Promise<Problem> {
  const text = await res.text().catch(() => '');
  if (text !== '') {
    try {
      const body = JSON.parse(text) as Partial<Problem> & { message?: string | string[] };
      const message = Array.isArray(body.message) ? body.message.join(', ') : body.message;
      return {
        type: body.type ?? 'about:blank',
        title: body.title ?? message ?? res.statusText ?? 'Error',
        status: body.status ?? res.status,
        detail: body.detail ?? message,
        code: body.code,
        errors: body.errors,
        current: body.current,
      };
    } catch {
      return { type: 'about:blank', title: res.statusText || 'Error', status: res.status, detail: text.slice(0, 300) };
    }
  }
  return { type: 'about:blank', title: res.statusText || 'Error', status: res.status };
}

export async function refreshSession(): Promise<boolean> {
  if (refreshing !== null) return refreshing;
  refreshing = (async () => {
    try {
      const res = await fetch(`${API_URL}/v1/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { accept: 'application/json' },
      });
      if (!res.ok) {
        setSession(null);
        return false;
      }
      setSession((await res.json()) as LoginResponse);
      return true;
    } catch {
      return false;
    } finally {
      setTimeout(() => {
        refreshing = null;
      }, 0);
    }
  })();
  return refreshing;
}

async function send(method: string, path: string, opts: RequestOptions, retried: boolean): Promise<Response> {
  const headers: Record<string, string> = { accept: 'application/json', ...(opts.headers ?? {}) };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.auth !== false && accessToken !== null) headers['authorization'] = `Bearer ${accessToken}`;
  if (opts.ifMatch !== undefined) headers['if-match'] = `W/"${opts.ifMatch}"`;
  if (opts.idempotencyKey !== undefined) headers['idempotency-key'] = opts.idempotencyKey;
  const res = await fetch(buildUrl(path, opts.query), {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    credentials: 'include',
    signal: opts.signal,
  });
  if (res.status === 401 && opts.auth !== false && !retried && !path.startsWith('/v1/auth/')) {
    const ok = await refreshSession();
    if (ok) return send(method, path, opts, true);
  }
  return res;
}

export async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const res = await send(method, path, opts, false);
  if (!res.ok) throw new ApiError(res.status, await parseProblem(res));
  if (opts.raw === true) return res as unknown as T;
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (text === '') return undefined as T;
  const type = res.headers.get('content-type') ?? '';
  if (type.includes('json')) return JSON.parse(text) as T;
  return text as unknown as T;
}

export const api = {
  get: <T>(path: string, opts?: RequestOptions) => request<T>('GET', path, opts),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) =>
    request<T>('POST', path, { ...opts, body: body ?? {} }),
  put: <T>(path: string, body?: unknown, opts?: RequestOptions) =>
    request<T>('PUT', path, { ...opts, body: body ?? {} }),
  patch: <T>(path: string, body?: unknown, opts?: RequestOptions) =>
    request<T>('PATCH', path, { ...opts, body: body ?? {} }),
  del: <T>(path: string, opts?: RequestOptions) => request<T>('DELETE', path, opts),
  text: async (path: string, opts?: RequestOptions): Promise<string> => {
    const res = await request<Response>('GET', path, { ...opts, raw: true, headers: { accept: 'text/html, */*' } });
    return res.text();
  },
  blob: async (path: string, opts?: RequestOptions): Promise<Blob> => {
    const res = await request<Response>('GET', path, { ...opts, raw: true, headers: { accept: '*/*' } });
    return res.blob();
  },
};

export async function login(email: string, password: string): Promise<LoginResponse> {
  const res = await request<LoginResponse>('POST', '/v1/auth/login', { body: { email, password }, auth: false });
  setSession(res);
  return res;
}

export async function logout(): Promise<void> {
  try {
    await request('POST', '/v1/auth/logout', { body: {}, auth: false });
  } finally {
    setSession(null);
  }
}

export async function switchTenant(tenantId: string): Promise<LoginResponse> {
  const res = await api.post<LoginResponse>('/v1/auth/switch-tenant', { tenantId });
  setSession(res);
  return res;
}

export async function downloadFile(path: string, fileName: string): Promise<void> {
  const blob = await api.blob(path);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function asPage<T>(value: unknown): { items: T[]; nextCursor: string | null } {
  if (Array.isArray(value)) return { items: value as T[], nextCursor: null };
  if (value !== null && typeof value === 'object' && Array.isArray((value as { items?: unknown }).items)) {
    const v = value as { items: T[]; nextCursor?: string | null };
    return { items: v.items, nextCursor: v.nextCursor ?? null };
  }
  return { items: [], nextCursor: null };
}

export function asList<T>(value: unknown): T[] {
  return asPage<T>(value).items;
}
