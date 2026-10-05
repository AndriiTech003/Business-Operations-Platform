import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  useReactFlow,
  type Connection,
  type Edge,
  type NodeChange,
  type EdgeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { TRIGGER_NODE_ID, type NodeType, type StepStatus, type WorkflowDefinition } from '@bop/contracts';
import { edgeId, outcomeOfEdge, positionsOf, type Positions } from './definition';
import { nodeTypes, type AnyFlowNode } from './nodes';

export const DND_MIME = 'application/x-bop-node';

export interface IssueCount {
  total: number;
  errors: number;
}

export interface CanvasProps {
  definition: WorkflowDefinition;
  statuses?: Record<string, StepStatus>;
  traversed?: Set<string>;
  issues?: Map<string, IssueCount>;
  selectedId: string | null;
  onSelect(id: string | null): void;
  onSelectionChange?(ids: string[]): void;
  readOnly?: boolean;
  vertical?: boolean;
  onMoveNodes?(positions: Positions): void;
  onConnect?(from: string, to: string, handle: string | null): void;
  onDeleteNodes?(ids: string[]): void;
  onDeleteEdges?(ids: string[]): void;
  onDropType?(type: NodeType, position: { x: number; y: number }): void;
  fitKey?: string | number;
}

const EDGE_COLORS: Record<string, string> = {
  true: 'var(--success)',
  approved: 'var(--success)',
  false: 'var(--muted-foreground)',
  rejected: 'var(--destructive)',
  error: 'var(--destructive)',
  timeout: 'var(--warning)',
};

export function Canvas({
  definition,
  statuses,
  traversed,
  issues,
  selectedId,
  onSelect,
  onSelectionChange,
  readOnly = false,
  vertical = false,
  onMoveNodes,
  onConnect,
  onDeleteNodes,
  onDeleteEdges,
  onDropType,
  fitKey,
}: CanvasProps) {
  const flow = useReactFlow();
  const [dragging, setDragging] = useState<Positions>({});
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [edgeSelection, setEdgeSelection] = useState<Set<string>>(new Set());
  const [measured, setMeasured] = useState<Record<string, { width: number; height: number }>>({});
  const basePositions = useMemo(() => positionsOf(definition), [definition]);

  const nodes = useMemo<AnyFlowNode[]>(() => {
    const pos = (id: string) => dragging[id] ?? basePositions[id] ?? { x: 0, y: 0 };
    const triggerIssues = issues?.get(TRIGGER_NODE_ID);
    const trigger: AnyFlowNode = {
      id: TRIGGER_NODE_ID,
      type: 'trigger',
      position: pos(TRIGGER_NODE_ID),
      measured: measured[TRIGGER_NODE_ID],
      data: {
        trigger: definition.trigger,
        issues: triggerIssues?.errors ?? 0,
        vertical,
        status: statuses ? 'succeeded' : undefined,
      },
      deletable: false,
      selected: selection.has(TRIGGER_NODE_ID) || (selection.size === 0 && selectedId === TRIGGER_NODE_ID),
      draggable: !readOnly,
    };
    return [
      trigger,
      ...definition.nodes.map((n): AnyFlowNode => ({
        id: n.id,
        type: 'wf',
        position: pos(n.id),
        measured: measured[n.id],
        data: {
          node: n,
          status: statuses?.[n.id],
          issues: issues?.get(n.id)?.total ?? 0,
          errorIssues: issues?.get(n.id)?.errors ?? 0,
          vertical,
          readOnly,
        },
        selected: selection.has(n.id) || (selection.size === 0 && selectedId === n.id),
        draggable: !readOnly,
        deletable: !readOnly,
      })),
    ];
  }, [definition, basePositions, dragging, statuses, issues, selectedId, selection, vertical, readOnly, measured]);

  const edges = useMemo<Edge[]>(
    () =>
      definition.edges.map((e) => {
        const outcome = outcomeOfEdge(definition, e);
        const key = `${e.from}->${e.to}`;
        const isTraversed = traversed?.has(key) ?? false;
        const dim = traversed !== undefined && !isTraversed;
        const color = isTraversed ? 'var(--success)' : (EDGE_COLORS[outcome] ?? 'var(--muted-foreground)');
        return {
          id: edgeId(e),
          source: e.from,
          target: e.to,
          sourceHandle: e.from === TRIGGER_NODE_ID ? 'next' : outcome,
          label: e.label ?? (outcome !== 'next' ? outcome : undefined),
          type: 'smoothstep',
          animated: isTraversed,
          deletable: !readOnly,
          selected: edgeSelection.has(edgeId(e)),
          style: {
            stroke: color,
            strokeWidth: isTraversed ? 2.5 : 1.5,
            opacity: dim ? 0.35 : 1,
            strokeDasharray: outcome === 'error' || outcome === 'timeout' ? '5 4' : undefined,
          },
          markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
          labelStyle: { fontSize: 10, fontWeight: 600, fill: color },
          labelBgStyle: { fill: 'var(--card)' },
          labelBgPadding: [4, 2] as [number, number],
          labelBgBorderRadius: 4,
          data: { outcome },
        };
      }),
    [definition, traversed, readOnly, edgeSelection],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<AnyFlowNode>[]) => {
      const moving: Positions = {};
      let finished = false;
      const selects = changes.filter(
        (c): c is Extract<NodeChange<AnyFlowNode>, { type: 'select' }> => c.type === 'select',
      );
      if (selects.length > 0) {
        setSelection((prev) => {
          const next = new Set(prev);
          for (const c of selects) {
            if (c.selected) next.add(c.id);
            else next.delete(c.id);
          }
          onSelectionChange?.([...next]);
          return next;
        });
      }
      const dims = changes.filter(
        (c): c is Extract<NodeChange<AnyFlowNode>, { type: 'dimensions' }> =>
          c.type === 'dimensions' && c.dimensions !== undefined,
      );
      if (dims.length > 0) {
        setMeasured((prev) => {
          const next = { ...prev };
          for (const c of dims)
            if (c.dimensions) next[c.id] = { width: c.dimensions.width, height: c.dimensions.height };
          return next;
        });
      }
      for (const c of changes) {
        if (c.type === 'position' && c.position) {
          moving[c.id] = { x: Math.round(c.position.x), y: Math.round(c.position.y) };
          if (c.dragging === false) finished = true;
        }
        if (c.type === 'position' && c.dragging === false) finished = true;
      }
      if (Object.keys(moving).length > 0) setDragging((d) => ({ ...d, ...moving }));
      if (finished) {
        setDragging((d) => {
          const all = { ...d, ...moving };
          if (Object.keys(all).length > 0) onMoveNodes?.(all);
          return {};
        });
      }
    },
    [onMoveNodes, onSelectionChange],
  );

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    const selects = changes.filter((c): c is Extract<EdgeChange, { type: 'select' }> => c.type === 'select');
    if (selects.length === 0) return;
    setEdgeSelection((prev) => {
      const next = new Set(prev);
      for (const c of selects) {
        if (c.selected) next.add(c.id);
        else next.delete(c.id);
      }
      return next;
    });
  }, []);

  const handleConnect = useCallback(
    (c: Connection) => onConnect?.(c.source, c.target, c.sourceHandle ?? null),
    [onConnect],
  );

  const onDragOver = (e: DragEvent) => {
    if (readOnly) return;
    if (e.dataTransfer.types.includes(DND_MIME)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  };

  const onDrop = (e: DragEvent) => {
    if (readOnly) return;
    const type = e.dataTransfer.getData(DND_MIME) as NodeType;
    if (!type) return;
    e.preventDefault();
    const p = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    onDropType?.(type, { x: Math.round(p.x - 115), y: Math.round(p.y - 30) });
  };

  const fitted = useRef<string | number | undefined>(undefined);
  useEffect(() => {
    if (fitKey === undefined || fitted.current === fitKey) return;
    fitted.current = fitKey;
    const t = setTimeout(() => void flow.fitView({ padding: 0.2, duration: 300, maxZoom: 1.1 }), 60);
    return () => clearTimeout(t);
  }, [fitKey, flow]);

  return (
    <div className="h-full w-full" data-testid="wf-canvas" onDragOver={onDragOver} onDrop={onDrop}>
      <ReactFlow<AnyFlowNode>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={handleConnect}
        onNodesDelete={(ns) => onDeleteNodes?.(ns.map((n) => n.id).filter((id) => id !== TRIGGER_NODE_ID))}
        onEdgesDelete={(es) => onDeleteEdges?.(es.map((e) => e.id))}
        onNodeClick={(_e, n) => onSelect(n.id)}
        onPaneClick={() => onSelect(null)}
        nodesConnectable={!readOnly}
        elementsSelectable
        deleteKeyCode={readOnly ? null : ['Backspace', 'Delete']}
        multiSelectionKeyCode={['Meta', 'Control', 'Shift']}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1.1 }}
        minZoom={0.2}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={{ type: 'smoothstep' }}
        snapToGrid
        snapGrid={[10, 10]}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
        <Controls showInteractive={false} position="bottom-left" />
        <MiniMap
          pannable
          zoomable
          position="bottom-right"
          className="!rounded-lg !border"
          nodeStrokeWidth={3}
          nodeColor={(n) => (n.type === 'trigger' ? '#4f46e5' : '#94a3b8')}
        />
      </ReactFlow>
    </div>
  );
}
