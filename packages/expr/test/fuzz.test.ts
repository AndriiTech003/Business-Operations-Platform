import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ExprError,
  FUNCTIONS,
  analyze,
  complete,
  evaluate,
  parse,
  parseTemplate,
  renderTemplate,
  tokenize,
  tokenizeTemplate,
} from '../src/index';
import { astArb, randomSourceArb } from './arbitraries';
import { ctx, makeEnv, varTypes } from './fixtures';

const RUNS = 2000;

describe('fuzzing: tooling never throws', () => {
  it('parse', () => {
    fc.assert(
      fc.property(randomSourceArb, (src) => {
        const r = parse(src);
        expect(r.ast === null || r.diagnostics.every((d) => d.severity === 'warning')).toBe(true);
      }),
      { numRuns: RUNS },
    );
  });

  it('parseTemplate', () => {
    fc.assert(
      fc.property(randomSourceArb, (src) => {
        parseTemplate(src);
      }),
      { numRuns: RUNS },
    );
  });

  it('tokenize (tolerant) and tokenizeTemplate', () => {
    fc.assert(
      fc.property(randomSourceArb, (src) => {
        const tokens = tokenize(src, { tolerant: true });
        expect(tokens[tokens.length - 1]?.kind).toBe('eof');
        for (const t of tokens) expect(t.span.end).toBeLessThanOrEqual(src.length);
        tokenizeTemplate(src);
      }),
      { numRuns: RUNS },
    );
  });

  it('complete', () => {
    fc.assert(
      fc.property(randomSourceArb, fc.nat(), fc.boolean(), (src, pos, template) => {
        const offset = src.length === 0 ? 0 : pos % (src.length + 1);
        const r = complete(src, offset, ctx, { template });
        expect(r.from).toBeLessThanOrEqual(r.to);
      }),
      { numRuns: RUNS },
    );
  });

  it('analyze', () => {
    fc.assert(
      fc.property(randomSourceArb, fc.boolean(), (src, template) => {
        analyze(src, ctx, { template });
      }),
      { numRuns: RUNS },
    );
  });
});

const names = Object.keys(varTypes);
const evalAst = astArb({
  idents: fc.oneof(fc.constantFrom(...names), fc.constantFrom('missing', 'x')),
  callees: fc.oneof(fc.constantFrom(...FUNCTIONS.map((f) => f.name)), fc.constant('unknownFn')),
  props: fc.constantFrom(
    'company',
    'owner',
    'name',
    'email',
    'tags',
    'total',
    'dueDate',
    'custom',
    'region',
    'contact',
    'output',
    'remind',
    'messageId',
    'x',
    'a',
    'b',
    'length',
    'cents',
    'ms',
    'getTime',
    'toString',
    'valueOf',
    'and',
  ),
  strings: fc.constantFrom(
    '',
    'a',
    'USD',
    'EUR',
    '2024-05-01',
    'YYYY-MM-DD',
    'manager',
    'u1',
    'token',
    'number',
    '__proto__',
    'constructor',
    'toString',
  ),
});

describe('fuzzing: evaluation fails only with ExprError', () => {
  it('random ASTs either evaluate or throw ExprError (never an internal error)', () => {
    fc.assert(
      fc.property(evalAst, (ast) => {
        try {
          evaluate(ast, makeEnv());
        } catch (e) {
          expect(e).toBeInstanceOf(ExprError);
          expect((e as ExprError).code).not.toBe('internal_error');
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('random templates render or throw ExprError', () => {
    fc.assert(
      fc.property(randomSourceArb, (src) => {
        try {
          renderTemplate(src, makeEnv());
        } catch (e) {
          expect(e).toBeInstanceOf(ExprError);
          expect((e as ExprError).code).not.toBe('internal_error');
        }
      }),
      { numRuns: RUNS },
    );
  });
});
