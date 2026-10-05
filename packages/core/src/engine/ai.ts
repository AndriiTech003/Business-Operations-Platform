import Anthropic from '@anthropic-ai/sdk';
import { classifyHttpStatus } from '@bop/workflow-core';
import { z } from 'zod';
import { StepError } from './errors';

export interface AiResult {
  label: string | null;
  summary: string | null;
  confidence: number;
}

export interface AiCallMeta {
  idempotencyKey: string;
  tenantId: string;
  workflowId: string;
  runId: string;
  nodeId: string;
  timeoutMs: number;
}

export interface AiProvider {
  readonly name: string;
  classify(text: string, labels: string[], signal: AbortSignal, meta?: AiCallMeta): Promise<AiResult>;
  summarize(text: string, signal: AbortSignal, meta?: AiCallMeta): Promise<AiResult>;
}

export class FakeAiProvider implements AiProvider {
  readonly name = 'fake';

  async classify(text: string, labels: string[]): Promise<AiResult> {
    const lower = text.toLowerCase();
    const scored = labels.map((label) => {
      const words = label
        .toLowerCase()
        .split(/[\s_-]+/)
        .filter(Boolean);
      return { label, hits: words.filter((w) => lower.includes(w)).length };
    });
    scored.sort((a, b) => b.hits - a.hits);
    const best = scored[0];
    if (best === undefined) return { label: null, summary: null, confidence: 0 };
    return { label: best.label, summary: null, confidence: best.hits > 0 ? 0.9 : 0.34 };
  }

  async summarize(text: string): Promise<AiResult> {
    const clean = text.replace(/\s+/g, ' ').trim();
    const firstSentence = clean.split(/(?<=[.!?])\s/)[0] ?? clean;
    return { label: null, summary: firstSentence.slice(0, 280), confidence: 1 };
  }
}

export class AnthropicAiProvider implements AiProvider {
  readonly name = 'anthropic';
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    private readonly model: string,
  ) {
    this.client = new Anthropic({ apiKey, maxRetries: 0 });
  }

  private async complete(system: string, text: string, signal: AbortSignal): Promise<string> {
    try {
      const params = {
        model: this.model,
        max_tokens: 1024,
        system,
        output_config: { effort: 'low' },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        messages: [{ role: 'user', content: text }],
      };
      const response = await this.client.beta.messages.create(params as never, { signal });
      if (response.stop_reason === 'refusal') throw new StepError('The model declined this input', false, 'ai_refusal');
      let out = '';
      for (const block of response.content) if (block.type === 'text') out += block.text;
      return out.trim();
    } catch (error) {
      if (error instanceof StepError) throw error;
      if (error instanceof Anthropic.RateLimitError)
        throw new StepError('AI provider rate limited', true, 'rate_limited');
      if (error instanceof Anthropic.APIError)
        throw new StepError(`AI provider error ${String(error.status)}`, (error.status ?? 500) >= 500, 'ai_error');
      if (error instanceof Anthropic.APIConnectionError)
        throw new StepError('AI provider unreachable', true, 'network');
      throw error;
    }
  }

  async classify(text: string, labels: string[], signal: AbortSignal): Promise<AiResult> {
    const answer = await this.complete(
      `Classify the user's text into exactly one of these labels: ${labels.join(', ')}. Reply with the label only.`,
      text,
      signal,
    );
    const label = labels.find((l) => answer.toLowerCase().includes(l.toLowerCase())) ?? null;
    return { label, summary: null, confidence: label === null ? 0 : 0.8 };
  }

  async summarize(text: string, signal: AbortSignal): Promise<AiResult> {
    const summary = await this.complete(
      'Summarize the user text in at most two sentences. Reply with the summary only.',
      text,
      signal,
    );
    return { label: null, summary, confidence: 1 };
  }
}

const operatorResponseSchema = z.object({
  label: z.string().max(200).nullish(),
  summary: z.string().max(5000).nullish(),
  confidence: z.number().min(0).max(1).optional(),
});

export class OperatorAiProvider implements AiProvider {
  readonly name = 'operator';

  constructor(
    private readonly url: string,
    private readonly token: string | null,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call(
    task: 'classify' | 'summarize',
    text: string,
    labels: string[],
    signal: AbortSignal,
    meta: AiCallMeta | undefined,
  ): Promise<AiResult> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': 'bop-workflow/1.0',
    };
    if (meta !== undefined) headers['idempotency-key'] = meta.idempotencyKey;
    if (this.token !== null) headers['authorization'] = `Bearer ${this.token}`;
    const body = {
      task,
      input: text,
      labels: task === 'classify' ? labels : [],
      context:
        meta === undefined
          ? null
          : { tenantId: meta.tenantId, workflowId: meta.workflowId, runId: meta.runId, nodeId: meta.nodeId },
    };
    const timeout = AbortSignal.timeout(meta?.timeoutMs ?? 15_000);
    const res = await this.fetchImpl(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.any([signal, timeout]),
    });
    const raw = (await res.text()).slice(0, 64 * 1024);
    if (!res.ok) {
      const cls = classifyHttpStatus(res.status);
      throw new StepError(
        `Operator returned HTTP ${res.status}`,
        cls === 'retryable',
        res.status === 429 ? 'rate_limited' : `operator_${res.status}`,
      );
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new StepError('Operator returned a response that is not JSON', false, 'operator_invalid_response');
    }
    const parsed = operatorResponseSchema.safeParse(json);
    if (!parsed.success)
      throw new StepError('Operator response has an unexpected shape', false, 'operator_invalid_response');
    const label = parsed.data.label ?? null;
    if (task === 'classify') {
      const known = labels.find((l) => l.toLowerCase() === label?.toLowerCase()) ?? null;
      return { label: known, summary: null, confidence: known === null ? 0 : (parsed.data.confidence ?? 1) };
    }
    return { label: null, summary: parsed.data.summary ?? null, confidence: parsed.data.confidence ?? 1 };
  }

  classify(text: string, labels: string[], signal: AbortSignal, meta?: AiCallMeta): Promise<AiResult> {
    return this.call('classify', text, labels, signal, meta);
  }

  summarize(text: string, signal: AbortSignal, meta?: AiCallMeta): Promise<AiResult> {
    return this.call('summarize', text, [], signal, meta);
  }
}

export interface AiConfig {
  provider: 'fake' | 'anthropic' | 'operator';
  apiKey: string | null;
  model: string;
  operatorUrl: string | null;
  operatorToken: string | null;
}

export function createAiProvider(config: AiConfig): AiProvider {
  if (config.provider === 'operator' && config.operatorUrl !== null)
    return new OperatorAiProvider(config.operatorUrl, config.operatorToken);
  if (config.provider === 'anthropic' && config.apiKey !== null)
    return new AnthropicAiProvider(config.apiKey, config.model);
  return new FakeAiProvider();
}
