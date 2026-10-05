import { TRIGGER_NODE_ID } from '@bop/contracts';
import { outcomeOf, type Graph } from './graph';

export type NodeProgress = { status: 'done'; outcome: string } | { status: 'skipped' } | { status: 'active' };

export interface AdvanceResult {
  create: string[];
  skip: string[];
}

export function scopeNodes(graph: Graph, scope: string | null): string[] {
  if (scope === null) return [...graph.nodes.keys()].filter((id) => !graph.bodyOf.has(id));
  return [...(graph.bodies.get(scope) ?? [])].filter((id) => graph.bodyOf.get(id) === scope);
}

type EdgeState = 'activated' | 'dead' | 'unresolved';

export function computeAdvance(
  graph: Graph,
  scope: string | null,
  progress: ReadonlyMap<string, NodeProgress>,
): AdvanceResult {
  const state = new Map(progress);
  const nodes = scopeNodes(graph, scope);
  const inScope = new Set(nodes);
  const create: string[] = [];
  const skip: string[] = [];
  const edgeState = (from: string, outcome: string): EdgeState => {
    if (scope === null && from === TRIGGER_NODE_ID) return outcome === 'next' ? 'activated' : 'dead';
    if (scope !== null && from === scope) return outcome === 'item' ? 'activated' : 'dead';
    if (!inScope.has(from)) return 'dead';
    const p = state.get(from);
    if (p === undefined || p.status === 'active') return 'unresolved';
    if (p.status === 'skipped') return 'dead';
    return p.outcome === outcome ? 'activated' : 'dead';
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of nodes) {
      if (state.has(id)) continue;
      const incoming = graph.in.get(id) ?? [];
      if (incoming.length === 0) continue;
      let activated = 0;
      let unresolved = 0;
      for (const e of incoming) {
        const s = edgeState(e.from, outcomeOf(graph, e));
        if (s === 'activated') activated += 1;
        else if (s === 'unresolved') unresolved += 1;
      }
      if (unresolved > 0) continue;
      if (activated > 0) {
        create.push(id);
        state.set(id, { status: 'active' });
      } else {
        skip.push(id);
        state.set(id, { status: 'skipped' });
      }
      changed = true;
    }
  }
  return { create, skip };
}

export function scopeSettled(graph: Graph, scope: string | null, progress: ReadonlyMap<string, NodeProgress>): boolean {
  const { create } = computeAdvance(graph, scope, progress);
  if (create.length > 0) return false;
  for (const [id, p] of progress) {
    if (p.status === 'active' && (scope === null ? !graph.bodyOf.has(id) : graph.bodyOf.get(id) === scope))
      return false;
  }
  return true;
}

export function sinkOutputs(graph: Graph, scope: string, progress: ReadonlyMap<string, NodeProgress>): string[] {
  const nodes = scopeNodes(graph, scope);
  return nodes.filter((id) => {
    const p = progress.get(id);
    if (p === undefined || p.status !== 'done') return false;
    const next = (graph.out.get(id) ?? []).filter((e) => graph.bodyOf.get(e.to) === scope);
    return next.every((e) => {
      const q = progress.get(e.to);
      return q === undefined || q.status === 'skipped';
    });
  });
}
