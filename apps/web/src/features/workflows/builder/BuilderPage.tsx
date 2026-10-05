import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';
import {
  TRIGGER_NODE_ID,
  type NodeType,
  type RunDetailDto,
  type RunDto,
  type SecretDto,
  type ValidationIssue,
  type WorkflowDefinition,
  type WorkflowDetailDto,
} from '@bop/contracts';
import { validateDefinition } from '@bop/workflow-core';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  EmptyState,
  Input,
  Kbd,
  Skeleton,
  Spinner,
  Tooltip,
  toast,
} from '@bop/ui';
import {
  ChevronLeft,
  CircleCheck,
  CircleDashed,
  CircleX,
  Cloud,
  FlaskConical,
  Keyboard,
  LayoutDashboard,
  MousePointerClick,
  Pause,
  Play,
  Redo2,
  Rocket,
  Undo2,
  Workflow,
} from 'lucide-react';
import { useAuth, useMe } from '../../../app/auth';
import { api, asList, errorMessage } from '../../../lib/api';
import { useCustomFieldMap, useEmailTemplates } from '../../../lib/data';
import { useAppFlag } from '../../../lib/flags';
import { isTypingTarget } from '../../../lib/hooks';
import { relative } from '../../../lib/format';
import { keys } from '../../../lib/query-keys';
import { channels, useChannel } from '../../../lib/realtime';
import { PanelBoundary } from '../../../components/PanelBoundary';
import { isTerminal, nodeStatuses, traversedSet } from '../runs/run-utils';
import { Canvas, type IssueCount } from './Canvas';
import {
  addNode,
  blankDefinition,
  isVerticalLayout,
  connect,
  copySelection,
  pasteClipboard,
  positionsOf,
  removeEdges,
  removeNodes,
  renameNode,
  updateNode,
  type Clipboard,
  type Positions,
} from './definition';
import { useDefinitionHistory } from './history';
import { IssuesPanel } from './IssuesPanel';
import { Palette } from './Palette';
import { PropertiesPanel, type FocusRequest } from './PropertiesPanel';
import { PublishDialog } from './PublishDialog';
import { TestRunPanel, type TestRunRequest } from './TestRunPanel';
import { TriggerPanel } from './TriggerPanel';

const route = getRouteApi('/app/workflows/$id');

type SaveState = 'saved' | 'saving' | 'unsaved' | 'error';

const SHORTCUTS: Array<[string, string]> = [
  ['⌘/Ctrl + Z', 'Undo'],
  ['⌘/Ctrl + Shift + Z', 'Redo'],
  ['⌘/Ctrl + C / V', 'Copy / paste selected nodes'],
  ['Delete / Backspace', 'Delete selected nodes or edges'],
  ['Shift / ⌘ + click', 'Select several nodes'],
  ['⌘/Ctrl + S', 'Save draft now'],
  ['Ctrl + Space', 'Autocomplete in an expression'],
  ['?', 'Show this help'],
];

function Builder({ workflow, initialRunId }: { workflow: WorkflowDetailDto; initialRunId?: string }) {
  const me = useMe();
  const { can } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const writable = can('workflows:write');
  const v2 = useAppFlag('workflow-builder-v2');
  const initial = useMemo<WorkflowDefinition>(() => {
    const base = workflow.draft?.definition ?? workflow.active?.definition ?? blankDefinition(workflow.name);
    return { ...base, layout: positionsOf(base) };
  }, [workflow]);
  const history = useDefinitionHistory(initial);
  const { definition, set, undo, redo, revision } = history;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selection, setSelection] = useState<string[]>([]);
  const [focus, setFocus] = useState<FocusRequest | null>(null);
  const [vertical, setVertical] = useState(() => isVerticalLayout(initial));
  const [fitKey, setFitKey] = useState(0);
  const clipboard = useRef<Clipboard | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [savedAt, setSavedAt] = useState<string | null>(workflow.draft?.updatedAt ?? null);
  const [serverIssues, setServerIssues] = useState<ValidationIssue[] | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishReady, setPublishReady] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [testing, setTesting] = useState(initialRunId !== undefined);
  const [runId, setRunId] = useState<string | undefined>(initialRunId);
  const [testError, setTestError] = useState<string | null>(null);

  const custom = useCustomFieldMap();
  const templates = useEmailTemplates();
  const secrets = useQuery({
    queryKey: keys.secrets,
    queryFn: async () => asList<SecretDto>(await api.get('/v1/secrets')),
    enabled: can('admin'),
    staleTime: 60_000,
  });
  const templateKeys = useMemo(() => (templates.data ?? []).map((t) => t.key), [templates.data]);
  const env = useMemo(
    () => ({
      custom,
      emailTemplates: templates.data ? templateKeys : undefined,
      secrets: secrets.data ? secrets.data.map((s) => s.name) : undefined,
    }),
    [custom, templates.data, templateKeys, secrets.data],
  );
  const deferred = useDeferredValue(definition);
  const validation = useMemo(() => {
    try {
      return validateDefinition(deferred, env);
    } catch (e) {
      return {
        ok: false,
        definition: null,
        issues: [
          {
            nodeId: null,
            field: null,
            code: 'internal',
            message: e instanceof Error ? e.message : 'Validation failed',
            severity: 'error' as const,
          },
        ],
      };
    }
  }, [deferred, env]);
  const issues = validation.issues;
  const errorCount = issues.filter((i) => i.severity === 'error').length;
  const issueMap = useMemo(() => {
    const m = new Map<string, IssueCount>();
    for (const i of issues) {
      const key = i.nodeId ?? (i.field?.startsWith('trigger') ? TRIGGER_NODE_ID : null);
      if (key === null) continue;
      const c = m.get(key) ?? { total: 0, errors: 0 };
      c.total += 1;
      if (i.severity === 'error') c.errors += 1;
      m.set(key, c);
    }
    return m;
  }, [issues]);

  const saveMutation = useMutation({
    mutationFn: (def: WorkflowDefinition) =>
      api.put<{ updatedAt: string; issues: ValidationIssue[] }>(`/v1/workflows/${workflow.id}/draft`, {
        definition: def,
      }),
  });
  const savingRev = useRef(0);
  const savedRev = useRef(0);
  const latestDef = useRef(definition);
  useEffect(() => {
    latestDef.current = definition;
  });

  const flush = useCallback(async (): Promise<boolean> => {
    if (!writable) return true;
    const rev = revision;
    if (savedRev.current === rev) return true;
    savingRev.current = rev;
    setSaveState('saving');
    try {
      const res = await saveMutation.mutateAsync(latestDef.current);
      savedRev.current = rev;
      setSavedAt(res?.updatedAt ?? new Date().toISOString());
      setServerIssues(Array.isArray(res?.issues) ? res.issues : null);
      setSaveState(savingRev.current === rev ? 'saved' : 'unsaved');
      void qc.invalidateQueries({ queryKey: keys.workflows.diff(workflow.id) });
      return true;
    } catch (e) {
      setSaveState('error');
      toast.error(`Draft not saved: ${errorMessage(e)}`);
      return false;
    }
  }, [revision, writable, saveMutation, workflow.id, qc]);

  useEffect(() => {
    if (revision === 0 || !writable) return undefined;
    setSaveState('unsaved');
    const t = setTimeout(() => void flush(), 800);
    return () => clearTimeout(t);
  }, [revision, writable, flush]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (savedRev.current !== revision && writable) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [revision, writable]);

  const publish = useMutation({
    mutationFn: () => api.post<WorkflowDetailDto>(`/v1/workflows/${workflow.id}/publish`, {}),
    onSuccess: (wf) => {
      qc.setQueryData(keys.workflows.detail(workflow.id), wf);
      void qc.invalidateQueries({ queryKey: keys.workflows.all });
      toast.success(`Published version ${wf.activeVersion ?? ''}`);
      setPublishOpen(false);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const setStatus = useMutation({
    mutationFn: (status: 'active' | 'paused') =>
      api.patch<WorkflowDetailDto>(`/v1/workflows/${workflow.id}`, { status }),
    onSuccess: (wf) => {
      qc.setQueryData(keys.workflows.detail(workflow.id), wf);
      void qc.invalidateQueries({ queryKey: keys.workflows.list });
      toast.success(wf.status === 'active' ? 'Workflow activated' : 'Workflow paused');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const runQuery = useQuery({
    queryKey: keys.runs.detail(runId ?? 'none'),
    queryFn: () => api.get<RunDetailDto>(`/v1/workflow-runs/${runId}`),
    enabled: runId !== undefined,
    refetchInterval: (q) => (isTerminal(q.state.data?.status) ? false : 1000),
  });
  useChannel(runId ? channels.run(me.tenant.id, runId) : null, {
    onMessage: () => void qc.invalidateQueries({ queryKey: keys.runs.detail(runId ?? 'none') }),
  });
  const startTest = useMutation({
    mutationFn: (req: TestRunRequest) =>
      api.post<RunDto>(`/v1/workflows/${workflow.id}/test-runs`, { definition, ...req }),
    onMutate: () => setTestError(null),
    onSuccess: (run) => {
      setRunId(run.id);
      void navigate({ to: '/workflows/$id', params: { id: workflow.id }, search: { runId: run.id }, replace: true });
    },
    onError: (e) => setTestError(errorMessage(e)),
  });

  const run = runId ? runQuery.data : undefined;
  const statuses = useMemo(() => (run ? nodeStatuses(run.steps) : undefined), [run]);
  const traversed = useMemo(() => (run ? traversedSet(run) : undefined), [run]);

  const selectedNode =
    selectedId && selectedId !== TRIGGER_NODE_ID ? (definition.nodes.find((n) => n.id === selectedId) ?? null) : null;

  const onSelectIssue = (i: ValidationIssue) => {
    const target = i.nodeId ?? (i.field?.startsWith('trigger') ? TRIGGER_NODE_ID : null);
    if (target !== null) setSelectedId(target);
    setTesting(false);
    setFocus({ field: i.field, offset: i.span?.start, nonce: Date.now() });
  };

  const addAt = useCallback(
    (type: NodeType, position?: { x: number; y: number }) => {
      const pos =
        position ??
        (() => {
          const all = Object.values(positionsOf(definition));
          const maxX = Math.max(0, ...all.map((p) => p.x));
          return { x: maxX + 320, y: 0 };
        })();
      const res = addNode(definition, type, pos);
      set(res.def, { tag: 'add' });
      setSelectedId(res.id);
      setTesting(false);
    },
    [definition, set],
  );

  const autoLayout = async (direction: 'RIGHT' | 'DOWN') => {
    try {
      const { elkLayout } = await import('./layout');
      const positions = await elkLayout(definition, direction);
      setVertical(direction === 'DOWN');
      set({ ...definition, layout: positions }, { tag: 'layout' });
      setFitKey((k) => k + 1);
    } catch (e) {
      toast.error(`Auto-layout failed: ${errorMessage(e)}`);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void flush();
        return;
      }
      if (isTypingTarget(e.target)) return;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      } else if (mod && e.key.toLowerCase() === 'c') {
        const ids = new Set(selection.length > 0 ? selection : selectedId ? [selectedId] : []);
        ids.delete(TRIGGER_NODE_ID);
        const clip = copySelection(definition, ids);
        if (clip) {
          clipboard.current = clip;
          toast.success(`Copied ${clip.nodes.length} node${clip.nodes.length === 1 ? '' : 's'}`);
        }
      } else if (mod && e.key.toLowerCase() === 'v' && clipboard.current && writable) {
        e.preventDefault();
        const res = pasteClipboard(definition, clipboard.current);
        set(res.def, { tag: 'paste' });
        setSelectedId(res.ids[0] ?? null);
        clipboard.current = {
          ...clipboard.current,
          positions: Object.fromEntries(
            Object.entries(clipboard.current.positions).map(([k, p]) => [k, { x: p.x + 40, y: p.y + 40 }]),
          ),
        };
      } else if (e.key === '?') {
        setShortcutsOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [definition, selection, selectedId, undo, redo, set, flush, writable]);

  const SaveIcon =
    saveState === 'saved'
      ? CircleCheck
      : saveState === 'saving'
        ? Spinner
        : saveState === 'error'
          ? CircleX
          : CircleDashed;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="wf-builder">
      <div className="flex flex-wrap items-center gap-2 border-b bg-card px-3 py-2">
        <Link
          to="/workflows"
          className="rounded p-1 text-muted-foreground hover:bg-muted"
          aria-label="Back to workflows"
        >
          <ChevronLeft className="size-4" />
        </Link>
        <Workflow className="size-4 text-primary" />
        <Input
          aria-label="Workflow name"
          data-testid="wf-name"
          className="h-8 w-72 border-transparent bg-transparent font-semibold shadow-none hover:border-input"
          value={definition.name}
          disabled={!writable}
          onChange={(e) => set({ ...definition, name: e.target.value }, { tag: 'name' })}
        />
        <Badge
          variant={workflow.status === 'active' ? 'success' : workflow.status === 'paused' ? 'warning' : 'muted'}
          data-testid="wf-status"
        >
          {workflow.status}
        </Badge>
        {workflow.activeVersion ? <Badge variant="outline">v{workflow.activeVersion} live</Badge> : null}
        <span
          className="inline-flex items-center gap-1 text-xs text-muted-foreground"
          data-testid="wf-save-state"
          data-state={saveState}
        >
          <SaveIcon className="size-3.5" />
          {saveState === 'saved'
            ? `Saved${savedAt ? ` ${relative(savedAt)}` : ''}`
            : saveState === 'saving'
              ? 'Saving…'
              : saveState === 'error'
                ? 'Not saved'
                : 'Unsaved changes'}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Tooltip content="Undo (⌘Z)">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Undo"
              disabled={!history.canUndo}
              onClick={undo}
              data-testid="wf-undo"
            >
              <Undo2 />
            </Button>
          </Tooltip>
          <Tooltip content="Redo (⇧⌘Z)">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Redo"
              disabled={!history.canRedo}
              onClick={redo}
              data-testid="wf-redo"
            >
              <Redo2 />
            </Button>
          </Tooltip>
          {v2 ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="ghost" data-testid="wf-autolayout" disabled={!writable}>
                  <LayoutDashboard /> Auto-layout
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>Direction</DropdownMenuLabel>
                <DropdownMenuItem onSelect={() => void autoLayout('RIGHT')}>Left → right</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void autoLayout('DOWN')}>Top → bottom</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          <Tooltip content="Keyboard shortcuts (?)">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Keyboard shortcuts"
              onClick={() => setShortcutsOpen(true)}
            >
              <Keyboard />
            </Button>
          </Tooltip>
          {workflow.activeVersion ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={!writable}
              loading={setStatus.isPending}
              onClick={() => setStatus.mutate(workflow.status === 'active' ? 'paused' : 'active')}
              data-testid="wf-toggle-status"
            >
              {workflow.status === 'active' ? <Pause /> : <Play />}
              {workflow.status === 'active' ? 'Pause' : 'Activate'}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant={testing ? 'secondary' : 'outline'}
            onClick={() => setTesting((t) => !t)}
            disabled={!writable}
            data-testid="wf-test-run"
          >
            <FlaskConical /> Test run
          </Button>
          <Button
            size="sm"
            data-testid="wf-publish"
            disabled={!writable}
            onClick={() => {
              setPublishReady(false);
              setPublishOpen(true);
              void flush().then((ok) => setPublishReady(ok));
            }}
          >
            <Rocket /> Publish
          </Button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        {writable ? <Palette onAdd={(t) => addAt(t)} /> : null}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="relative min-h-0 flex-1">
            <PanelBoundary title="The canvas crashed">
              <Canvas
                definition={definition}
                statuses={statuses}
                traversed={traversed}
                issues={issueMap}
                selectedId={selectedId}
                onSelect={(id) => {
                  setSelectedId(id);
                  setFocus(null);
                }}
                onSelectionChange={setSelection}
                readOnly={!writable}
                vertical={vertical}
                fitKey={fitKey}
                onMoveNodes={(positions: Positions) =>
                  set({ ...definition, layout: { ...positionsOf(definition), ...positions } }, { tag: 'move' })
                }
                onConnect={(from, to, handle) => set(connect(definition, from, to, handle), { tag: 'connect' })}
                onDeleteNodes={(ids) => {
                  if (ids.length === 0) return;
                  set(removeNodes(definition, new Set(ids)), { tag: 'delete' });
                  if (selectedId !== null && ids.includes(selectedId)) setSelectedId(null);
                }}
                onDeleteEdges={(ids) => set(removeEdges(definition, new Set(ids)), { tag: 'delete-edge' })}
                onDropType={(type, position) => addAt(type, position)}
              />
            </PanelBoundary>
            {run ? (
              <div className="absolute left-3 top-3 flex items-center gap-2 rounded-full border bg-card px-3 py-1 text-xs shadow-sm">
                <FlaskConical className="size-3.5 text-info" /> Showing test run ·{' '}
                <span className="font-medium">{run.status}</span>
                <button
                  type="button"
                  className="cursor-pointer text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    setRunId(undefined);
                    void navigate({ to: '/workflows/$id', params: { id: workflow.id }, search: {}, replace: true });
                  }}
                >
                  Clear
                </button>
              </div>
            ) : null}
          </div>
          <IssuesPanel issues={issues} onSelect={onSelectIssue} />
          {serverIssues !== null && serverIssues.length !== issues.length && saveState === 'saved' ? (
            <p className="border-t bg-muted/40 px-3 py-1 text-[11px] text-muted-foreground">
              Server validation reports {serverIssues.length} issue(s) for the saved draft.
            </p>
          ) : null}
        </div>
        <aside className="w-[400px] shrink-0 overflow-y-auto border-l bg-card p-4" aria-label="Properties">
          <PanelBoundary resetKey={`${selectedId}-${testing}`}>
            {testing ? (
              <TestRunPanel
                trigger={definition.trigger}
                run={run}
                starting={startTest.isPending}
                error={testError}
                selectedNodeId={selectedId}
                onStart={(req) => startTest.mutate(req)}
                onClose={() => setTesting(false)}
              />
            ) : selectedId === TRIGGER_NODE_ID ? (
              <TriggerPanel
                definition={definition}
                custom={custom}
                issues={issues.filter((i) => i.nodeId === null && (i.field?.startsWith('trigger') ?? false))}
                webhookUrl={workflow.webhookUrl}
                focus={focus}
                readOnly={!writable}
                timezone={me.tenant.settings.timezone}
                onChange={(trigger, tag) => set({ ...definition, trigger }, { tag })}
              />
            ) : selectedNode ? (
              <PropertiesPanel
                key={selectedNode.id}
                definition={definition}
                node={selectedNode}
                custom={custom}
                emailTemplates={templateKeys}
                issues={issues.filter((i) => i.nodeId === selectedNode.id)}
                focus={focus}
                readOnly={!writable}
                onChange={(node, tag) =>
                  set(
                    updateNode(definition, selectedNode.id, () => node),
                    { tag: `${selectedNode.id}:${tag}` },
                  )
                }
                onRename={(from, to) => {
                  set(renameNode(definition, from, to), { tag: 'rename' });
                  setSelectedId(to);
                }}
                onDelete={() => {
                  set(removeNodes(definition, new Set([selectedNode.id])), { tag: 'delete' });
                  setSelectedId(null);
                }}
              />
            ) : (
              <EmptyState
                icon={<MousePointerClick />}
                title="Select a node"
                description="Click the trigger or a node to edit its properties. Drag nodes from the palette, connect handles to build branches."
                className="border-0"
              />
            )}
          </PanelBoundary>
        </aside>
      </div>
      <PublishDialog
        open={publishOpen}
        onOpenChange={setPublishOpen}
        workflow={workflow}
        definition={definition}
        errors={errorCount}
        ready={publishReady}
        publishing={publish.isPending}
        onConfirm={() => publish.mutate()}
      />
      <Dialog open={shortcutsOpen} onOpenChange={setShortcutsOpen}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Keyboard shortcuts</DialogTitle>
          </DialogHeader>
          <ul className="grid gap-2 text-sm">
            {SHORTCUTS.map(([k, d]) => (
              <li key={k} className="flex items-center justify-between gap-3">
                <span>{d}</span>
                <Kbd className="px-1.5">{k}</Kbd>
              </li>
            ))}
          </ul>
          <ExpressionHint />
        </DialogContent>
      </Dialog>
      {saveState === 'error' ? (
        <div className="pointer-events-none fixed bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-destructive px-3 py-1 text-xs text-white shadow-lg">
          <Cloud className="mr-1 inline size-3" /> Draft could not be saved — retrying on next change
        </div>
      ) : null}
    </div>
  );
}

function ExpressionHint() {
  return (
    <p className="text-[11px] text-muted-foreground">
      Expressions: type a variable name and a dot to see fields with their types.
    </p>
  );
}

export function BuilderPage() {
  const { id } = route.useParams();
  const search = route.useSearch();
  const query = useQuery({
    queryKey: keys.workflows.detail(id),
    queryFn: () => api.get<WorkflowDetailDto>(`/v1/workflows/${id}`),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  if (query.isLoading) {
    return (
      <div className="flex h-full gap-0">
        <Skeleton className="h-full w-56 rounded-none" />
        <Skeleton className="m-4 flex-1" />
        <Skeleton className="h-full w-[400px] rounded-none" />
      </div>
    );
  }
  if (query.isError || query.data === undefined) {
    return (
      <EmptyState
        className="m-6"
        icon={<Workflow />}
        title="Workflow not found"
        description={query.error ? errorMessage(query.error) : undefined}
      />
    );
  }
  return (
    <ReactFlowProvider>
      <Builder key={query.data.id} workflow={query.data} initialRunId={search.runId} />
    </ReactFlowProvider>
  );
}
