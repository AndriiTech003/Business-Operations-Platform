import { TRIGGER_NODE_ID, type WorkflowDefinition } from '@bop/contracts';
import { NODE_H, NODE_W, outcomeOfEdge, type Positions } from './definition';

export async function elkLayout(def: WorkflowDefinition, direction: 'RIGHT' | 'DOWN'): Promise<Positions> {
  const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
  const elk = new ELK();
  const ids = [TRIGGER_NODE_ID, ...def.nodes.map((n) => n.id)];
  const known = new Set(ids);
  const graph = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': direction,
      'elk.layered.spacing.nodeNodeBetweenLayers': '90',
      'elk.spacing.nodeNode': '40',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      'elk.layered.crossingMinimization.semiInteractive': 'true',
      'elk.edgeRouting': 'SPLINES',
    },
    children: ids.map((id) => ({ id, width: NODE_W, height: NODE_H })),
    edges: def.edges
      .filter((e) => known.has(e.from) && known.has(e.to))
      .map((e, i) => ({ id: `e${i}-${outcomeOfEdge(def, e)}`, sources: [e.from], targets: [e.to] })),
  });
  const out: Positions = {};
  for (const c of graph.children ?? []) out[c.id] = { x: Math.round(c.x ?? 0), y: Math.round(c.y ?? 0) };
  return out;
}
