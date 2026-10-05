import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { T } from '@ashamrai/expr';
import { WORKFLOW_TEMPLATES, buildGraph, nodeTypeContext } from '@bop/workflow-core';
import { classifyTokens, createCompletionSource, diagnoseExpression } from '../src/lib/expr-editor/language';

const overdue = WORKFLOW_TEMPLATES.find((t) => t.key === 'overdue_invoice');
if (overdue === undefined) throw new Error('template missing');
const def = overdue.definition;
const custom = {
  company: [{ key: 'region', label: 'Region', type: 'select' as const, options: { choices: ['NA', 'EMEA'] } }],
};
const ctxFor = (nodeId: string) => nodeTypeContext(def, buildGraph(def), nodeId, { custom });

function run(doc: string, pos: number, nodeId: string, template = false, explicit = false): CompletionResult | null {
  const state = EditorState.create({ doc });
  const source = createCompletionSource(() => ctxFor(nodeId), template);
  return source(new CompletionContext(state, pos, explicit)) as CompletionResult | null;
}

describe('expression editor completion source', () => {
  it('suggests typed fields after a dot', () => {
    const res = run('invoice.', 8, 'big');
    expect(res).not.toBeNull();
    const labels = res?.options.map((o) => o.label) ?? [];
    expect(labels).toEqual(expect.arrayContaining(['number', 'totalCents', 'dueDate', 'company', 'contact']));
    const total = res?.options.find((o) => o.label === 'totalCents');
    expect(total?.type).toBe('property');
    expect(total?.detail).toBe('money');
    expect(res?.from).toBe(8);
  });

  it('completes nested relations and custom fields with a typed prefix', () => {
    const res = run('invoice.company.custom.re', 25, 'big');
    expect(res?.options.map((o) => o.label)).toEqual(['region']);
    expect(res?.from).toBe(23);
  });

  it('offers variables, functions and dominating step outputs', () => {
    const res = run('', 0, 'remind', false, true);
    const labels = res?.options.map((o) => o.label) ?? [];
    expect(labels).toEqual(expect.arrayContaining(['invoice', 'steps', 'now', 'days', 'formatMoney']));
    const steps = run('steps.', 6, 'wait_paid');
    expect(steps?.options.map((o) => o.label)).toEqual(expect.arrayContaining(['big', 'remind']));
    expect(steps?.options.map((o) => o.label)).not.toContain('task');
  });

  it('completes inside {{ }} of templates only', () => {
    const doc = 'Invoice {{ invoice.nu';
    const inside = run(doc, doc.length, 'notify', true);
    expect(inside?.options.map((o) => o.label)).toEqual(['number']);
    expect(run('Invoice inv', 11, 'notify', true)).toBeNull();
  });

  it('does not pop up without a dot or a typed word unless explicit', () => {
    expect(run('invoice.totalCents > ', 21, 'big')).toBeNull();
  });
});

describe('expression diagnostics and highlighting', () => {
  it('reports unknown fields with a suggestion and type mismatches against expected types', () => {
    const ctx = ctxFor('big');
    const unknown = diagnoseExpression("invoice.numbr == 'x'", ctx, { expected: [T.bool] });
    expect(unknown[0]?.message).toMatch(/Did you mean 'number'/);
    expect(unknown[0]?.from).toBe(8);
    const mismatch = diagnoseExpression('invoice.number', ctx, { expected: [T.bool, T.nullable(T.bool)] });
    expect(mismatch).toEqual([expect.objectContaining({ code: 'type_mismatch', severity: 'error' })]);
    expect(diagnoseExpression('invoice.totalCents > 100000', ctx, { expected: [T.bool] })).toEqual([]);
  });

  it('classifies tokens for syntax highlighting', () => {
    const classes = classifyTokens("lower(invoice.number) == 'x' and true", false).map((t) => t.cls);
    expect(classes).toEqual(['fn', 'punct', 'var', 'op', 'field', 'punct', 'op', 'string', 'keyword', 'keyword']);
    const tpl = classifyTokens('Hi {{ contact.name }}', true).map((t) => t.cls);
    expect(tpl).toEqual(['tpl', 'var', 'op', 'field', 'tpl']);
  });
});
