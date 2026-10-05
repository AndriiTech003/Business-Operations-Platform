import {
  TRIGGER_NODE_ID,
  type NodeType,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
} from '@bop/contracts';
import { NODE_REGISTRY, edgeOutcome } from '@bop/workflow-core';

export const NODE_W = 230;
export const NODE_H = 72;

export type Positions = Record<string, { x: number; y: number }>;

export function outcomeOfEdge(def: WorkflowDefinition, e: WorkflowEdge): string {
  if (e.from === TRIGGER_NODE_ID) return 'next';
  const node = def.nodes.find((n) => n.id === e.from) ?? null;
  return edgeOutcome(node, e.label);
}

export function edgeId(e: WorkflowEdge): string {
  return `${e.from}->${e.to}:${e.label ?? ''}`;
}

export function handlesFor(node: WorkflowNode): string[] {
  return NODE_REGISTRY[node.type].outputs(node.config);
}

export function defaultConfig(type: NodeType): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const f of NODE_REGISTRY[type].fields) if (f.default !== undefined) config[f.key] = f.default;
  if (type === 'switch') config['cases'] = [{ name: 'a', when: '' }];
  return config;
}

export function nextNodeId(def: WorkflowDefinition, type: NodeType): string {
  const base = type.replace(/[^a-zA-Z0-9_]/g, '_');
  const used = new Set(def.nodes.map((n) => n.id));
  let i = 1;
  while (used.has(`${base}_${i}`)) i++;
  return `${base}_${i}`;
}

export function autoPositions(def: WorkflowDefinition, direction: 'RIGHT' | 'DOWN' = 'RIGHT'): Positions {
  const level = new Map<string, number>([[TRIGGER_NODE_ID, 0]]);
  const queue = [TRIGGER_NODE_ID];
  const out = new Map<string, string[]>();
  for (const e of def.edges) out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
  let guard = 0;
  while (queue.length > 0 && guard++ < 5000) {
    const id = queue.shift() as string;
    const l = level.get(id) ?? 0;
    for (const to of out.get(id) ?? []) {
      if ((level.get(to) ?? -1) < l + 1 && l + 1 < def.nodes.length + 2) {
        level.set(to, l + 1);
        queue.push(to);
      }
    }
  }
  let maxLevel = Math.max(0, ...level.values());
  for (const n of def.nodes) if (!level.has(n.id)) level.set(n.id, ++maxLevel);
  const rows = new Map<number, number>();
  const pos: Positions = {};
  for (const id of [TRIGGER_NODE_ID, ...def.nodes.map((n) => n.id)]) {
    const l = level.get(id) ?? 0;
    const r = rows.get(l) ?? 0;
    rows.set(l, r + 1);
    pos[id] =
      direction === 'RIGHT'
        ? { x: l * (NODE_W + 90), y: r * (NODE_H + 50) }
        : { x: r * (NODE_W + 50), y: l * (NODE_H + 80) };
  }
  return pos;
}

export function positionsOf(def: WorkflowDefinition): Positions {
  const layout = def.layout ?? {};
  const missing = [TRIGGER_NODE_ID, ...def.nodes.map((n) => n.id)].some((id) => layout[id] === undefined);
  if (!missing) return layout;
  const auto = autoPositions(def, 'DOWN');
  return { ...auto, ...layout };
}

export function addNode(
  def: WorkflowDefinition,
  type: NodeType,
  position: { x: number; y: number },
): { def: WorkflowDefinition; id: string } {
  const id = nextNodeId(def, type);
  const node: WorkflowNode = { id, type, config: defaultConfig(type) };
  return { def: { ...def, nodes: [...def.nodes, node], layout: { ...positionsOf(def), [id]: position } }, id };
}

export function removeNodes(def: WorkflowDefinition, ids: Set<string>): WorkflowDefinition {
  const layout = { ...(def.layout ?? {}) };
  for (const id of ids) delete layout[id];
  return {
    ...def,
    nodes: def.nodes.filter((n) => !ids.has(n.id)),
    edges: def.edges.filter((e) => !ids.has(e.from) && !ids.has(e.to)),
    layout,
  };
}

export function removeEdges(def: WorkflowDefinition, ids: Set<string>): WorkflowDefinition {
  return { ...def, edges: def.edges.filter((e) => !ids.has(edgeId(e))) };
}

export function connect(def: WorkflowDefinition, from: string, to: string, handle: string | null): WorkflowDefinition {
  if (from === to) return def;
  let label: string | undefined;
  if (from !== TRIGGER_NODE_ID) {
    const node = def.nodes.find((n) => n.id === from);
    if (node === undefined) return def;
    const spec = NODE_REGISTRY[node.type];
    const outcome = handle ?? spec.defaultOutput ?? 'next';
    label = outcome === spec.defaultOutput ? undefined : outcome;
  } else if (def.edges.some((e) => e.from === TRIGGER_NODE_ID)) {
    return { ...def, edges: [...def.edges.filter((e) => e.from !== TRIGGER_NODE_ID), { from, to }] };
  }
  const edge: WorkflowEdge = label === undefined ? { from, to } : { from, to, label };
  if (def.edges.some((e) => edgeId(e) === edgeId(edge))) return def;
  return { ...def, edges: [...def.edges, edge] };
}

export function updateNode(
  def: WorkflowDefinition,
  id: string,
  patch: (n: WorkflowNode) => WorkflowNode,
): WorkflowDefinition {
  return { ...def, nodes: def.nodes.map((n) => (n.id === id ? patch(n) : n)) };
}

export function renameNode(def: WorkflowDefinition, from: string, to: string): WorkflowDefinition {
  if (from === to || def.nodes.some((n) => n.id === to)) return def;
  const layout = { ...(def.layout ?? {}) };
  if (layout[from] !== undefined) {
    layout[to] = layout[from] as { x: number; y: number };
    delete layout[from];
  }
  return {
    ...def,
    nodes: def.nodes.map((n) => (n.id === from ? { ...n, id: to } : n)),
    edges: def.edges.map((e) => ({ ...e, from: e.from === from ? to : e.from, to: e.to === from ? to : e.to })),
    layout,
  };
}

export interface Clipboard {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  positions: Positions;
}

export function copySelection(def: WorkflowDefinition, ids: Set<string>): Clipboard | null {
  const nodes = def.nodes.filter((n) => ids.has(n.id));
  if (nodes.length === 0) return null;
  const pos = positionsOf(def);
  return {
    nodes: structuredClone(nodes),
    edges: def.edges.filter((e) => ids.has(e.from) && ids.has(e.to)),
    positions: Object.fromEntries(nodes.map((n) => [n.id, pos[n.id] ?? { x: 0, y: 0 }])),
  };
}

export function pasteClipboard(
  def: WorkflowDefinition,
  clip: Clipboard,
  offset = 40,
): { def: WorkflowDefinition; ids: string[] } {
  let next = { ...def, layout: positionsOf(def) };
  const mapping = new Map<string, string>();
  for (const n of clip.nodes) {
    const id = nextNodeId(next, n.type);
    mapping.set(n.id, id);
    const p = clip.positions[n.id] ?? { x: 0, y: 0 };
    next = {
      ...next,
      nodes: [...next.nodes, { ...structuredClone(n), id }],
      layout: { ...next.layout, [id]: { x: p.x + offset, y: p.y + offset } },
    };
  }
  const edges = clip.edges.map((e) => ({ ...e, from: mapping.get(e.from) ?? e.from, to: mapping.get(e.to) ?? e.to }));
  return { def: { ...next, edges: [...next.edges, ...edges] }, ids: [...mapping.values()] };
}

export function blankDefinition(name: string): WorkflowDefinition {
  return { name, trigger: { type: 'manual' }, nodes: [], edges: [], layout: { [TRIGGER_NODE_ID]: { x: 0, y: 0 } } };
}

export function isVerticalLayout(def: WorkflowDefinition): boolean {
  const pos = positionsOf(def);
  const t = pos[TRIGGER_NODE_ID];
  const first = def.edges.find((e) => e.from === TRIGGER_NODE_ID);
  const c = first ? pos[first.to] : undefined;
  if (t === undefined || c === undefined) return true;
  return c.y - t.y > c.x - t.x;
}
