import { NODE_TYPES, type NodeType } from '@bop/contracts';
import { NODE_REGISTRY, type NodeCategory } from '@bop/workflow-core';
import { Input, Tooltip, cn } from '@bop/ui';
import { Search } from 'lucide-react';
import { useState } from 'react';
import { useAppFlag } from '../../../lib/flags';
import { DND_MIME } from './Canvas';
import { CATEGORY_TONE, nodeIcon } from './nodes';

const CATEGORY_LABEL: Record<NodeCategory, string> = {
  logic: 'Logic',
  action: 'Actions',
  wait: 'Waits',
  human: 'People',
  integration: 'Integrations',
  flow: 'Flow',
};

const ORDER: NodeCategory[] = ['logic', 'action', 'human', 'wait', 'integration', 'flow'];

export function Palette({ onAdd, disabled }: { onAdd(type: NodeType): void; disabled?: boolean }) {
  const aiEnabled = useAppFlag('workflow-ai-step');
  const [q, setQ] = useState('');
  const lower = q.trim().toLowerCase();
  const types = NODE_TYPES.filter(
    (t) =>
      (t !== 'ai_step' || aiEnabled) &&
      (lower === '' || NODE_REGISTRY[t].label.toLowerCase().includes(lower) || t.includes(lower)),
  );
  return (
    <aside
      className="flex h-full w-56 shrink-0 flex-col border-r bg-card"
      aria-label="Node palette"
      data-testid="wf-palette"
    >
      <div className="border-b p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-2 size-3.5 text-muted-foreground" />
          <Input
            className="h-7 pl-7 text-xs"
            placeholder="Find a node…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Find a node"
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {ORDER.map((cat) => {
          const items = types.filter((t) => NODE_REGISTRY[t].category === cat);
          if (items.length === 0) return null;
          return (
            <div key={cat} className="mb-3">
              <p className="px-1 pb-1 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
                {CATEGORY_LABEL[cat]}
              </p>
              <ul className="grid gap-1">
                {items.map((t) => {
                  const spec = NODE_REGISTRY[t];
                  const Icon = nodeIcon(t);
                  return (
                    <li key={t}>
                      <Tooltip content={spec.description} side="right">
                        <button
                          type="button"
                          draggable={!disabled}
                          disabled={disabled}
                          data-testid={`palette-${t}`}
                          onDragStart={(e) => {
                            e.dataTransfer.setData(DND_MIME, t);
                            e.dataTransfer.effectAllowed = 'copy';
                          }}
                          onClick={() => onAdd(t)}
                          className={cn(
                            'flex w-full cursor-grab items-center gap-2 rounded-md border bg-card px-2 py-1.5 text-left text-xs font-medium transition-colors hover:border-primary/40 hover:bg-accent active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-50',
                          )}
                        >
                          <span className={cn('flex size-6 items-center justify-center rounded', CATEGORY_TONE[cat])}>
                            <Icon className="size-3.5" />
                          </span>
                          {spec.label}
                        </button>
                      </Tooltip>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
      <p className="border-t p-2 text-[10.5px] text-muted-foreground">Drag onto the canvas or click to add.</p>
    </aside>
  );
}
