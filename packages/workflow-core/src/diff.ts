import type { WorkflowDefinition, WorkflowEdge } from '@bop/contracts';

export interface DefinitionDiff {
  addedNodes: string[];
  removedNodes: string[];
  changedNodes: Array<{ id: string; fields: string[] }>;
  addedEdges: WorkflowEdge[];
  removedEdges: WorkflowEdge[];
  triggerChanged: boolean;
  nameChanged: boolean;
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

const edgeKey = (e: WorkflowEdge): string => `${e.from}->${e.to}:${e.label ?? ''}`;

export function diffDefinitions(before: WorkflowDefinition | null, after: WorkflowDefinition): DefinitionDiff {
  const prevNodes = new Map((before?.nodes ?? []).map((n) => [n.id, n]));
  const nextNodes = new Map(after.nodes.map((n) => [n.id, n]));
  const addedNodes = [...nextNodes.keys()].filter((id) => !prevNodes.has(id));
  const removedNodes = [...prevNodes.keys()].filter((id) => !nextNodes.has(id));
  const changedNodes: Array<{ id: string; fields: string[] }> = [];
  for (const [id, node] of nextNodes) {
    const prev = prevNodes.get(id);
    if (prev === undefined) continue;
    const fields: string[] = [];
    if (prev.type !== node.type) fields.push('type');
    if ((prev.name ?? '') !== (node.name ?? '')) fields.push('name');
    const keys = new Set([...Object.keys(prev.config), ...Object.keys(node.config)]);
    for (const k of keys)
      if (stableStringify(prev.config[k]) !== stableStringify(node.config[k])) fields.push(`config.${k}`);
    if (stableStringify(prev.retry) !== stableStringify(node.retry)) fields.push('retry');
    if (prev.timeoutMs !== node.timeoutMs) fields.push('timeoutMs');
    if (fields.length > 0) changedNodes.push({ id, fields });
  }
  const prevEdges = new Map((before?.edges ?? []).map((e) => [edgeKey(e), e]));
  const nextEdges = new Map(after.edges.map((e) => [edgeKey(e), e]));
  return {
    addedNodes,
    removedNodes,
    changedNodes,
    addedEdges: [...nextEdges].filter(([k]) => !prevEdges.has(k)).map(([, e]) => e),
    removedEdges: [...prevEdges].filter(([k]) => !nextEdges.has(k)).map(([, e]) => e),
    triggerChanged: stableStringify(before?.trigger ?? null) !== stableStringify(after.trigger),
    nameChanged: (before?.name ?? null) !== after.name,
  };
}

export function isEmptyDiff(diff: DefinitionDiff): boolean {
  return (
    diff.addedNodes.length === 0 &&
    diff.removedNodes.length === 0 &&
    diff.changedNodes.length === 0 &&
    diff.addedEdges.length === 0 &&
    diff.removedEdges.length === 0 &&
    !diff.triggerChanged
  );
}
