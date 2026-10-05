export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  idempotencyKey?: string;
  dryRun?: boolean;
}

export class OpsApiClient {
  constructor(
    readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const url = new URL(path, this.baseUrl);
    for (const [k, v] of Object.entries(options.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    if (options.dryRun === true) url.searchParams.set('dryRun', '1');
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}`, accept: 'application/json' };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (options.idempotencyKey !== undefined) headers['idempotency-key'] = options.idempotencyKey;
    const res = await this.fetchImpl(url, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    const json: unknown = text === '' ? null : JSON.parse(text);
    if (!res.ok) {
      const p = (json ?? {}) as { title?: string; code?: string; errors?: Array<{ path: string; message: string }> };
      const details = p.errors?.map((e) => `${e.path}: ${e.message}`).join('; ');
      throw new ApiError(
        res.status,
        p.code ?? `http_${res.status}`,
        `${p.title ?? res.statusText}${details ? ` (${details})` : ''}`,
        json,
      );
    }
    return json as T;
  }

  get<T>(path: string, query?: RequestOptions['query']): Promise<T> {
    return this.request<T>('GET', path, { query });
  }
}
