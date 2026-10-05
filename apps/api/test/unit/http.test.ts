import { describe, expect, it } from 'vitest';
import { API_ROUTES } from '@bop/contracts';
import { DomainError, MissingTenantContextError } from '@bop/core';
import { buildOpenApi } from '../../src/openapi';
import { toProblem } from '../../src/common/problem.filter';
import { ifMatch } from '../../src/common/http';
import { routeSpec } from '../../src/common/auth';

const req = (h: Record<string, string>) => ({ header: (k: string) => h[k.toLowerCase()] }) as never;

describe('http helpers', () => {
  it('parses If-Match ETags', () => {
    expect(ifMatch(req({ 'if-match': 'W/"7"' }))).toBe(7);
    expect(ifMatch(req({ 'if-match': '"3"' }))).toBe(3);
    expect(ifMatch(req({}))).toBeUndefined();
    expect(() => ifMatch(req({ 'if-match': 'abc' }))).toThrow(DomainError);
  });

  it('maps errors to problem+json without leaking internals', () => {
    expect(
      toProblem(new DomainError(412, 'precondition_failed', 'changed', { current: { v: 2 } }), '/x'),
    ).toMatchObject({ status: 412, code: 'precondition_failed', current: { v: 2 } });
    expect(toProblem(new MissingTenantContextError(), '/x')).toMatchObject({ status: 500, code: 'tenant_context' });
    expect(toProblem({ code: 'P2002' }, '/x')).toMatchObject({ status: 409 });
    expect(toProblem(new Error('secret stack detail'), '/x')).toEqual({
      type: 'https://bop.dev/problems/internal',
      title: 'Internal server error',
      status: 500,
      code: 'internal',
      instance: '/x',
    });
  });

  it('resolves route specs used by the scope guard', () => {
    expect(routeSpec('post', '/v1/invoices/:id/void')?.scope).toBe('invoices:void');
    expect(routeSpec('GET', '/p/invoices/:token')?.auth).toBe('public');
    expect(routeSpec('GET', '/v1/unknown')).toBeUndefined();
  });

  it('builds an OpenAPI document covering every route', () => {
    const doc = buildOpenApi('http://127.0.0.1:4500') as {
      paths: Record<string, Record<string, { security?: unknown; requestBody?: unknown }>>;
    };
    const count = Object.values(doc.paths).reduce((a, ops) => a + Object.keys(ops).length, 0);
    expect(count).toBe(API_ROUTES.length);
    expect(doc.paths['/v1/invoices']?.['post']?.requestBody).toBeDefined();
    expect(doc.paths['/health']?.['get']?.security).toBeUndefined();
    expect(doc.paths['/v1/companies']?.['get']?.security).toEqual([{ bearer: [] }]);
  });
});
