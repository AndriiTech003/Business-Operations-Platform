import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parse, print, stripSpans } from '../src/index';
import { astArb } from './arbitraries';

const unlimited = { maxExpressionLength: 1e7, maxAstNodes: 1e7, maxListLength: 1e7 };

describe('print/parse round-trip', () => {
  it('parse(print(ast)) equals ast modulo spans for random valid ASTs', () => {
    fc.assert(
      fc.property(astArb(), (ast) => {
        const printed = print(ast);
        const result = parse(printed, unlimited);
        expect(result.diagnostics).toEqual([]);
        expect(result.ast).not.toBeNull();
        if (result.ast !== null) expect(stripSpans(result.ast)).toEqual(stripSpans(ast));
      }),
      { numRuns: 1500 },
    );
  });

  it('printing is idempotent', () => {
    fc.assert(
      fc.property(astArb(), (ast) => {
        const once = print(ast);
        const reparsed = parse(once, unlimited).ast;
        expect(reparsed === null ? null : print(reparsed)).toBe(once);
      }),
      { numRuns: 1000 },
    );
  });
});
