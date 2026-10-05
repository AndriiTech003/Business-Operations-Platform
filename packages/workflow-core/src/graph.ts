import { TRIGGER_NODE_ID, type WorkflowDefinition, type WorkflowEdge, type WorkflowNode } from '@bop/contracts';
import { edgeOutcome } from './registry';

export interface Graph {
  nodes: Map<string, WorkflowNode>;
  out: Map<string, WorkflowEdge[]>;
  in: Map<string, WorkflowEdge[]>;
  bodyOf: Map<string, string>;
  bodies: Map<string, Set<string>>;
}

export function buildGraph(def: Pick<WorkflowDefinition, 'nodes' | 'edges'>): Graph {
  const nodes = new Map<string, WorkflowNode>();
  for (const node of def.nodes) nodes.set(node.id, node);
  const out = new Map<string, WorkflowEdge[]>();
  const inc = new Map<string, WorkflowEdge[]>();
  for (const id of [TRIGGER_NODE_ID, ...nodes.keys()]) {
    out.set(id, []);
    inc.set(id, []);
  }
  for (const edge of def.edges) {
    out.get(edge.from)?.push(edge);
    inc.get(edge.to)?.push(edge);
  }
  const bodyOf = new Map<string, string>();
  const bodies = new Map<string, Set<string>>();
  const walk = (starts: string[], stop: string): Set<string> => {
    const seen = new Set<string>();
    const stack = [...starts];
    while (stack.length > 0) {
      const id = stack.pop() as string;
      if (id === stop || seen.has(id) || !nodes.has(id)) continue;
      seen.add(id);
      for (const e of out.get(id) ?? []) stack.push(e.to);
    }
    return seen;
  };
  for (const node of def.nodes) {
    if (node.type !== 'for_each') continue;
    const loopOut = out.get(node.id) ?? [];
    const afterLoop = walk(
      loopOut.filter((e) => e.label !== 'item').map((e) => e.to),
      node.id,
    );
    const body = new Set(
      [
        ...walk(
          loopOut.filter((e) => e.label === 'item').map((e) => e.to),
          node.id,
        ),
      ].filter((id) => !afterLoop.has(id)),
    );
    bodies.set(node.id, body);
    for (const id of body) if (!bodyOf.has(id)) bodyOf.set(id, node.id);
  }
  return { nodes, out, in: inc, bodyOf, bodies };
}

export function outcomeOf(graph: Graph, edge: WorkflowEdge): string {
  const source = edge.from === TRIGGER_NODE_ID ? null : (graph.nodes.get(edge.from) ?? null);
  return edgeOutcome(source, edge.label);
}

export function reachable(graph: Graph): Set<string> {
  const seen = new Set<string>([TRIGGER_NODE_ID]);
  const stack = [TRIGGER_NODE_ID];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    for (const e of graph.out.get(id) ?? []) {
      if (!seen.has(e.to)) {
        seen.add(e.to);
        stack.push(e.to);
      }
    }
  }
  return seen;
}

export function findCycle(graph: Graph): string[] | null {
  const color = new Map<string, number>();
  const path: string[] = [];
  const visit = (id: string): string[] | null => {
    color.set(id, 1);
    path.push(id);
    for (const e of graph.out.get(id) ?? []) {
      const c = color.get(e.to) ?? 0;
      if (c === 1) return [...path.slice(path.indexOf(e.to)), e.to];
      if (c === 0 && graph.out.has(e.to)) {
        const found = visit(e.to);
        if (found !== null) return found;
      }
    }
    path.pop();
    color.set(id, 2);
    return null;
  };
  for (const id of graph.out.keys()) {
    if ((color.get(id) ?? 0) === 0) {
      const found = visit(id);
      if (found !== null) return found;
    }
  }
  return null;
}

export function topoOrder(graph: Graph): string[] {
  const indeg = new Map<string, number>();
  for (const id of graph.out.keys()) indeg.set(id, 0);
  for (const edges of graph.out.values()) for (const e of edges) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  const queue = [...indeg.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    order.push(id);
    for (const e of graph.out.get(id) ?? []) {
      const d = (indeg.get(e.to) ?? 0) - 1;
      indeg.set(e.to, d);
      if (d === 0) queue.push(e.to);
    }
  }
  return order;
}

const dominatorCache = new WeakMap<Graph, Map<string, Set<string>>>();

export function dominators(graph: Graph): Map<string, Set<string>> {
  const cached = dominatorCache.get(graph);
  if (cached !== undefined) return cached;
  const reach = reachable(graph);
  const order = topoOrder(graph).filter((id) => reach.has(id));
  const dom = new Map<string, Set<string>>();
  for (const id of order) {
    if (id === TRIGGER_NODE_ID) {
      dom.set(id, new Set([id]));
      continue;
    }
    const preds = (graph.in.get(id) ?? []).map((e) => e.from).filter((p) => reach.has(p) && dom.has(p));
    let acc: Set<string> | null = null;
    for (const p of preds) {
      const pd = dom.get(p) as Set<string>;
      if (acc === null) acc = new Set(pd);
      else for (const x of [...acc]) if (!pd.has(x)) acc.delete(x);
    }
    const result = acc ?? new Set<string>();
    result.add(id);
    dom.set(id, result);
  }
  dominatorCache.set(graph, dom);
  return dom;
}

export function strictDominators(graph: Graph, nodeId: string): string[] {
  const dom = dominators(graph).get(nodeId);
  if (dom === undefined) return [];
  return [...dom].filter((id) => id !== nodeId && id !== TRIGGER_NODE_ID);
}

export function traversedEdges(
  graph: Graph,
  completed: Map<string, string | null>,
): Array<{ from: string; to: string; label: string | null }> {
  const result: Array<{ from: string; to: string; label: string | null }> = [];
  for (const edges of graph.out.values()) {
    for (const e of edges) {
      const outcome = e.from === TRIGGER_NODE_ID ? 'next' : completed.get(e.from);
      if (outcome === undefined || outcome === null) continue;
      if (outcomeOf(graph, e) === outcome && completed.has(e.to))
        result.push({ from: e.from, to: e.to, label: e.label ?? null });
    }
  }
  return result;
}
