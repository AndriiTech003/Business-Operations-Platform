import { API_ROUTES } from '@bop/contracts';
import { z, type ZodType } from 'zod';

function schemaOf(t: ZodType | undefined, io: 'input' | 'output'): Record<string, unknown> | undefined {
  if (t === undefined) return undefined;
  try {
    return z.toJSONSchema(t, { io, unrepresentable: 'any' }) as Record<string, unknown>;
  } catch {
    return { type: 'object' };
  }
}

export function buildOpenApi(serverUrl: string): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of API_ROUTES) {
    const path = route.path.replace(/:([A-Za-z]+)/g, '{$1}');
    const params = [...route.path.matchAll(/:([A-Za-z]+)/g)].map((m) => ({
      name: m[1],
      in: 'path',
      required: true,
      schema: { type: 'string' },
    }));
    const headers: Array<Record<string, unknown>> = [];
    if (route.idempotent === true)
      headers.push({ name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string' } });
    if (route.ifMatch === true)
      headers.push({ name: 'If-Match', in: 'header', required: false, schema: { type: 'string', example: 'W/"3"' } });
    const query = schemaOf(route.query, 'input');
    const queryParams =
      query !== undefined && typeof query['properties'] === 'object'
        ? Object.entries(query['properties'] as Record<string, unknown>).map(([name, schema]) => ({
            name,
            in: 'query',
            required: false,
            schema,
          }))
        : [];
    const op: Record<string, unknown> = {
      summary: route.summary,
      tags: [route.tag],
      operationId: `${route.method.toLowerCase()}_${route.path.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '')}`,
      parameters: [...params, ...headers, ...queryParams],
      responses: {
        '200': { description: route.response ?? 'OK' },
        '4XX': {
          description: 'Problem details',
          content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } },
        },
      },
    };
    if (route.auth !== 'public') op['security'] = [{ bearer: [] }];
    if (route.scope !== undefined) op['x-required-scope'] = route.scope;
    const body = schemaOf(route.body, 'input');
    if (body !== undefined) op['requestBody'] = { required: true, content: { 'application/json': { schema: body } } };
    paths[path] = { ...(paths[path] ?? {}), [route.method.toLowerCase()]: op };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Business Operations Platform API',
      version: '1.0.0',
      description: 'CRM, invoices, tasks and a durable workflow engine. Errors are application/problem+json.',
    },
    servers: [{ url: serverUrl }],
    components: {
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer', description: 'JWT access token or personal API token (bop_pat_…)' },
      },
      schemas: {
        Problem: {
          type: 'object',
          properties: {
            type: { type: 'string' },
            title: { type: 'string' },
            status: { type: 'integer' },
            detail: { type: 'string' },
            code: { type: 'string' },
            errors: { type: 'array', items: { type: 'object' } },
            current: {},
          },
        },
      },
    },
    paths,
  };
}
