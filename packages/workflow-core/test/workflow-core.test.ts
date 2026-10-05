import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { WorkflowDefinition } from '@bop/contracts';
import {
  NODE_REGISTRY,
  WORKFLOW_TEMPLATES,
  DEFAULT_EMAIL_TEMPLATES,
  backoffDelay,
  buildGraph,
  classifyHttpStatus,
  computeAdvance,
  diffDefinitions,
  dominators,
  findCycle,
  isEmptyDiff,
  isValidCron,
  nodeTypeContext,
  reachable,
  sinkOutputs,
  sqlFieldResolver,
  stableStringify,
  traversedEdges,
  validateDefinition,
  type CustomFieldMap,
  type NodeProgress,
  type ValidationEnv,
} from '../src';

const custom: CustomFieldMap = {
  deal: [{ key: 'region', label: 'Region', type: 'select', options: { choices: ['EU', 'US'] } }],
  company: [{ key: 'score', label: 'Score', type: 'number', options: null }],
};

const env: ValidationEnv = {
  custom,
  emailTemplates: DEFAULT_EMAIL_TEMPLATES.map((t) => t.key),
  secrets: ['slack_webhook_url', 'api_base_url', 'reports_api_token'],
};

const def = (
  nodes: WorkflowDefinition['nodes'],
  edges: WorkflowDefinition['edges'],
  trigger: WorkflowDefinition['trigger'] = { type: 'manual' },
): WorkflowDefinition => ({ name: 't', trigger, nodes, edges });

const diamond = def(
  [
    { id: 'c', type: 'condition', config: { expr: 'true' } },
    { id: 'a', type: 'end', config: {} },
    { id: 'b', type: 'create_task', config: { title: 'x' } },
    { id: 'd', type: 'create_task', config: { title: 'y' } },
    { id: 'j', type: 'create_task', config: { title: 'join' } },
  ],
  [
    { from: '$trigger', to: 'c' },
    { from: 'c', to: 'b', label: 'true' },
    { from: 'c', to: 'd', label: 'true' },
    { from: 'c', to: 'a', label: 'false' },
    { from: 'b', to: 'j' },
    { from: 'd', to: 'j' },
  ],
);

const done = (outcome: string): NodeProgress => ({ status: 'done', outcome });

describe('graph analysis', () => {
  it('builds adjacency and reachability', () => {
    const g = buildGraph(diamond);
    expect(g.out.get('$trigger')?.map((e) => e.to)).toEqual(['c']);
    expect(
      g.in
        .get('j')
        ?.map((e) => e.from)
        .sort(),
    ).toEqual(['b', 'd']);
    expect([...reachable(g)].sort()).toEqual(['$trigger', 'a', 'b', 'c', 'd', 'j']);
  });

  it('detects cycles', () => {
    const g = buildGraph(
      def(
        [
          { id: 'x', type: 'create_task', config: {} },
          { id: 'y', type: 'create_task', config: {} },
        ],
        [
          { from: '$trigger', to: 'x' },
          { from: 'x', to: 'y' },
          { from: 'y', to: 'x' },
        ],
      ),
    );
    expect(findCycle(g)).toEqual(['x', 'y', 'x']);
    expect(findCycle(buildGraph(diamond))).toBeNull();
  });

  it('computes dominators: the condition dominates the join, branches do not', () => {
    const dom = dominators(buildGraph(diamond));
    expect([...(dom.get('j') ?? [])].sort()).toEqual(['$trigger', 'c', 'j']);
    expect([...(dom.get('b') ?? [])].sort()).toEqual(['$trigger', 'b', 'c']);
  });

  it('computes for_each bodies', () => {
    const g = buildGraph(
      def(
        [
          { id: 'loop', type: 'for_each', config: { items: '[1]' } },
          { id: 'x', type: 'create_task', config: {} },
          { id: 'y', type: 'create_task', config: {} },
          { id: 'after', type: 'end', config: {} },
        ],
        [
          { from: '$trigger', to: 'loop' },
          { from: 'loop', to: 'x', label: 'item' },
          { from: 'x', to: 'y' },
          { from: 'loop', to: 'after', label: 'done' },
        ],
      ),
    );
    expect([...(g.bodies.get('loop') ?? [])].sort()).toEqual(['x', 'y']);
    expect(g.bodyOf.get('after')).toBeUndefined();
  });
});

describe('advancement (dead-path elimination and joins)', () => {
  const g = buildGraph(diamond);

  it('starts with the node after the trigger', () => {
    expect(computeAdvance(g, null, new Map())).toEqual({ create: ['c'], skip: [] });
  });

  it('true branch: creates both branches and skips the false path', () => {
    const r = computeAdvance(g, null, new Map([['c', done('true')]]));
    expect(r.create.sort()).toEqual(['b', 'd']);
    expect(r.skip).toEqual(['a']);
  });

  it('join waits for all activated incoming branches', () => {
    const p = new Map<string, NodeProgress>([
      ['c', done('true')],
      ['a', { status: 'skipped' }],
      ['b', done('next')],
      ['d', { status: 'active' }],
    ]);
    expect(computeAdvance(g, null, p).create).toEqual([]);
    p.set('d', done('next'));
    expect(computeAdvance(g, null, p).create).toEqual(['j']);
  });

  it('false branch skips the whole true subgraph including the join', () => {
    const r = computeAdvance(g, null, new Map([['c', done('false')]]));
    expect(r.create).toEqual(['a']);
    expect(r.skip.sort()).toEqual(['b', 'd', 'j']);
  });

  it('join runs when one branch was dead and the other completed', () => {
    const half = def(
      [
        { id: 's', type: 'switch', config: { cases: [{ name: 'x', when: 'true' }] } },
        { id: 'x', type: 'create_task', config: {} },
        { id: 'j', type: 'end', config: {} },
      ],
      [
        { from: '$trigger', to: 's' },
        { from: 's', to: 'x', label: 'case:x' },
        { from: 's', to: 'j', label: 'default' },
        { from: 'x', to: 'j' },
      ],
    );
    const hg = buildGraph(half);
    expect(computeAdvance(hg, null, new Map([['s', done('case:x')]])).create).toEqual(['x']);
    expect(
      computeAdvance(
        hg,
        null,
        new Map([
          ['s', done('case:x')],
          ['x', done('next')],
        ]),
      ).create,
    ).toEqual(['j']);
  });

  it('property: every node is eventually created or skipped exactly once for any branch outcomes', () => {
    fc.assert(
      fc.property(fc.array(fc.boolean(), { minLength: 1, maxLength: 1 }), ([pick]) => {
        const progress = new Map<string, NodeProgress>();
        const seen = new Set<string>();
        for (let i = 0; i < 10; i += 1) {
          const { create, skip } = computeAdvance(g, null, progress);
          for (const id of [...create, ...skip]) {
            expect(seen.has(id)).toBe(false);
            seen.add(id);
          }
          for (const id of skip) progress.set(id, { status: 'skipped' });
          for (const id of create) progress.set(id, done(id === 'c' ? (pick ? 'true' : 'false') : 'next'));
          if (create.length === 0 && skip.length === 0) break;
        }
        expect([...seen].sort()).toEqual(['a', 'b', 'c', 'd', 'j']);
      }),
    );
  });

  it('collects loop sink outputs and marks traversed edges', () => {
    const lg = buildGraph(
      def(
        [
          { id: 'loop', type: 'for_each', config: { items: '[1]' } },
          { id: 'x', type: 'create_task', config: {} },
          { id: 'y', type: 'create_task', config: {} },
        ],
        [
          { from: '$trigger', to: 'loop' },
          { from: 'loop', to: 'x', label: 'item' },
          { from: 'x', to: 'y' },
        ],
      ),
    );
    expect(
      sinkOutputs(
        lg,
        'loop',
        new Map([
          ['x', done('next')],
          ['y', done('next')],
        ]),
      ),
    ).toEqual(['y']);
    const t = traversedEdges(
      g,
      new Map([
        ['c', 'true'],
        ['b', 'next'],
        ['d', 'next'],
        ['j', null],
      ]),
    );
    expect(t.map((e) => `${e.from}>${e.to}`).sort()).toEqual(['$trigger>c', 'b>j', 'c>b', 'c>d', 'd>j']);
  });
});

describe('definition validation', () => {
  it('accepts all six gallery templates', () => {
    expect(WORKFLOW_TEMPLATES).toHaveLength(6);
    for (const t of WORKFLOW_TEMPLATES) {
      const r = validateDefinition(t.definition, env);
      expect(
        r.issues.filter((i) => i.severity === 'error'),
        t.key,
      ).toEqual([]);
    }
  });

  const cases: Array<[string, unknown, string]> = [
    [
      'two trigger edges',
      def(
        [
          { id: 'a', type: 'end', config: {} },
          { id: 'b', type: 'end', config: {} },
        ],
        [
          { from: '$trigger', to: 'a' },
          { from: '$trigger', to: 'b' },
        ],
      ),
      'trigger_edges',
    ],
    [
      'unreachable node',
      def(
        [
          { id: 'a', type: 'end', config: {} },
          { id: 'b', type: 'end', config: {} },
        ],
        [{ from: '$trigger', to: 'a' }],
      ),
      'unreachable',
    ],
    [
      'cycle',
      def(
        [
          { id: 'a', type: 'create_task', config: { title: 'x' } },
          { id: 'b', type: 'create_task', config: { title: 'y' } },
        ],
        [
          { from: '$trigger', to: 'a' },
          { from: 'a', to: 'b' },
          { from: 'b', to: 'a' },
        ],
      ),
      'cycle',
    ],
    [
      'invalid edge label',
      def(
        [
          { id: 'a', type: 'create_task', config: { title: 'x' } },
          { id: 'b', type: 'end', config: {} },
        ],
        [
          { from: '$trigger', to: 'a' },
          { from: 'a', to: 'b', label: 'approved' },
        ],
      ),
      'invalid_label',
    ],
    [
      'condition needs a label',
      def(
        [
          { id: 'c', type: 'condition', config: { expr: 'true' } },
          { id: 'b', type: 'end', config: {} },
        ],
        [
          { from: '$trigger', to: 'c' },
          { from: 'c', to: 'b' },
        ],
      ),
      'label_required',
    ],
    [
      'condition without branches',
      def([{ id: 'c', type: 'condition', config: { expr: 'true' } }], [{ from: '$trigger', to: 'c' }]),
      'no_branch',
    ],
    [
      'missing required field',
      def(
        [
          { id: 'c', type: 'condition', config: {} },
          { id: 'e', type: 'end', config: {} },
        ],
        [
          { from: '$trigger', to: 'c' },
          { from: 'c', to: 'e', label: 'true' },
        ],
      ),
      'required',
    ],
    [
      'type error in condition',
      def(
        [
          { id: 'c', type: 'condition', config: { expr: "'text'" } },
          { id: 'e', type: 'end', config: {} },
        ],
        [
          { from: '$trigger', to: 'c' },
          { from: 'c', to: 'e', label: 'true' },
        ],
      ),
      'type_mismatch',
    ],
    [
      'unknown email template',
      def(
        [{ id: 'm', type: 'send_email', config: { to: "'a@b.c'", template: 'nope' } }],
        [{ from: '$trigger', to: 'm' }],
      ),
      'unknown_template',
    ],
    [
      'secret outside http_request',
      def(
        [{ id: 't', type: 'create_task', config: { title: "{{ secret('api_base_url') }}" } }],
        [{ from: '$trigger', to: 't' }],
      ),
      'secret_not_allowed',
    ],
    [
      'bad cron',
      {
        name: 't',
        trigger: { type: 'schedule', cron: 'every day' },
        nodes: [{ id: 'e', type: 'end', config: {} }],
        edges: [{ from: '$trigger', to: 'e' }],
      },
      'invalid_cron',
    ],
    [
      'scanner condition too complex',
      {
        name: 't',
        trigger: { type: 'record_condition', entity: 'invoice', condition: "lower(invoice.number) == 'x'" },
        nodes: [{ id: 'e', type: 'end', config: {} }],
        edges: [{ from: '$trigger', to: 'e' }],
      },
      'sql_unsupported',
    ],
    [
      'update of unknown field',
      {
        name: 't',
        trigger: { type: 'manual', entity: 'deal' },
        nodes: [{ id: 'u', type: 'update_record', config: { record: 'deal', fields: { password: "'x'" } } }],
        edges: [{ from: '$trigger', to: 'u' }],
      },
      'unknown_field',
    ],
    [
      'loop body escaping',
      def(
        [
          { id: 'l', type: 'for_each', config: { items: '[1]' } },
          { id: 'x', type: 'create_task', config: { title: 'x' } },
          { id: 'out', type: 'end', config: {} },
        ],
        [
          { from: '$trigger', to: 'l' },
          { from: 'l', to: 'x', label: 'item' },
          { from: 'x', to: 'out' },
          { from: 'l', to: 'out', label: 'done' },
        ],
      ),
      'body_escape',
    ],
    ['schema violation', { name: '', trigger: { type: 'manual' }, nodes: [], edges: [] }, 'schema'],
  ];

  it.each(cases)('rejects: %s', (_name, definition, code) => {
    const r = validateDefinition(definition, env);
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.code)).toContain(code);
  });

  it('steps.X.output is only available when X dominates the node', () => {
    const notDominating = def(
      [
        { id: 'c', type: 'condition', config: { expr: 'true' } },
        { id: 'call', type: 'http_request', config: { url: 'https://x.test' } },
        { id: 'use', type: 'create_task', config: { title: '{{ steps.call.output.status }}' } },
      ],
      [
        { from: '$trigger', to: 'c' },
        { from: 'c', to: 'call', label: 'true' },
        { from: 'c', to: 'use', label: 'false' },
      ],
    );
    expect(validateDefinition(notDominating, env).issues.map((i) => i.code)).toContain('unknown_field');
    const dominating = def(
      [
        { id: 'call', type: 'http_request', config: { url: 'https://x.test' } },
        { id: 'use', type: 'create_task', config: { title: '{{ steps.call.output.status }}' } },
      ],
      [
        { from: '$trigger', to: 'call' },
        { from: 'call', to: 'use' },
      ],
    );
    expect(validateDefinition(dominating, env).ok).toBe(true);
  });

  it('issues carry node id and line:col of the expression error', () => {
    const r = validateDefinition(
      {
        name: 't',
        trigger: { type: 'manual', entity: 'invoice' },
        nodes: [
          { id: 'c', type: 'condition', config: { expr: 'invoice.totlCents > 1' } },
          { id: 'e', type: 'end', config: {} },
        ],
        edges: [
          { from: '$trigger', to: 'c' },
          { from: 'c', to: 'e', label: 'true' },
        ],
      },
      env,
    );
    const issue = r.issues.find((i) => i.code === 'unknown_field');
    expect(issue?.nodeId).toBe('c');
    expect(issue?.field).toBe('expr');
    expect(issue?.start).toEqual({ line: 1, col: 9 });
    expect(issue?.message).toMatch(/totalCents/);
  });

  it('builds node type contexts with custom fields and 1-level relations', () => {
    const d: WorkflowDefinition = {
      name: 't',
      trigger: { type: 'manual', entity: 'deal' },
      nodes: [{ id: 'e', type: 'end', config: {} }],
      edges: [{ from: '$trigger', to: 'e' }],
    };
    const ctx = nodeTypeContext(d, buildGraph(d), 'e', { custom: env.custom });
    const deal = ctx.vars['deal'];
    expect(deal?.kind).toBe('object');
    const fields = deal?.kind === 'object' ? deal.fields : {};
    expect(fields['custom']?.type.kind).toBe('object');
    const company = fields['company']?.type;
    expect(company?.kind).toBe('nullable');
  });

  it('cron validation and registry sanity', () => {
    expect(isValidCron('0 9 * * 1')).toBe(true);
    expect(isValidCron('*/5 * * * *')).toBe(true);
    expect(isValidCron('nope')).toBe(false);
    for (const spec of Object.values(NODE_REGISTRY)) {
      if (spec.defaultOutput !== null) expect(spec.outputs({})).toContain(spec.defaultOutput);
      if (spec.errorEdge) expect(spec.outputs({})).toContain('error');
    }
  });
});

describe('diff, checksum input, SQL field resolver, retry helpers', () => {
  it('diffs definitions', () => {
    const next: WorkflowDefinition = {
      ...diamond,
      nodes: [...diamond.nodes.filter((n) => n.id !== 'a'), { id: 'n', type: 'end' as const, config: {} }].map((n) =>
        n.id === 'b' ? { ...n, config: { title: 'changed' } } : n,
      ),
      edges: diamond.edges.filter((e) => e.to !== 'a'),
    };
    const d = diffDefinitions(diamond, next);
    expect(d.addedNodes).toEqual(['n']);
    expect(d.removedNodes).toEqual(['a']);
    expect(d.changedNodes).toEqual([{ id: 'b', fields: ['config.title'] }]);
    expect(d.removedEdges).toHaveLength(1);
    expect(isEmptyDiff(diffDefinitions(diamond, diamond))).toBe(true);
  });

  it('stable stringify ignores key order', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: [1, { y: 1, x: 2 }] } })).toBe(
      stableStringify({ a: { c: [1, { x: 2, y: 1 }], d: 2 }, b: 1 }),
    );
  });

  it('resolves SQL columns for entity and custom fields', () => {
    const r = sqlFieldResolver('invoice', env.custom);
    expect(r(['invoice', 'dueDate'])?.sql).toBe('t."due_date"');
    expect(r(['invoice', 'balanceCents'])?.sql).toBe('(t."total_cents" - t."paid_cents")');
    expect(r(['invoice', 'status'])?.sql).toBe('t."status"::text');
    expect(r(['invoice', 'company', 'name'])).toBeNull();
    const c = sqlFieldResolver('company', env.custom);
    expect(c(['company', 'custom', 'score'])?.sql).toBe('((t."custom"->>\'score\'))::numeric');
  });

  it('backoff grows exponentially with jitter and caps', () => {
    const p = { maxAttempts: 5, backoff: 'exponential' as const, initialMs: 1000, maxMs: 5000 };
    expect(backoffDelay(p, 1, () => 0.5)).toBe(1000);
    expect(backoffDelay(p, 2, () => 0.5)).toBe(2000);
    expect(backoffDelay(p, 3, () => 0.5)).toBe(4000);
    expect(backoffDelay(p, 6, () => 0.5)).toBe(5000);
    expect(backoffDelay(p, 2, () => 1)).toBe(2400);
    expect(backoffDelay(p, 2, () => 0)).toBe(1600);
    expect(classifyHttpStatus(503)).toBe('retryable');
    expect(classifyHttpStatus(429)).toBe('retryable');
    expect(classifyHttpStatus(404)).toBe('permanent');
  });
});
