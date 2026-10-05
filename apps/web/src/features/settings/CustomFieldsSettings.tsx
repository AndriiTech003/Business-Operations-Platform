import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  CUSTOM_FIELD_TYPES,
  type CustomFieldDefDto,
  type CustomFieldEntity,
  type CustomFieldType,
} from '@bop/contracts';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Field,
  Input,
  NativeSelect,
  Segmented,
  SkeletonRows,
  toast,
} from '@bop/ui';
import { GripVertical, Pencil, Plus, SlidersHorizontal, Trash2, Zap } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { useCustomFields } from '../../lib/data';
import { keys } from '../../lib/query-keys';
import { useAuth } from '../../app/auth';

const TYPE_LABEL: Record<CustomFieldType, string> = {
  text: 'Text',
  number: 'Number',
  money: 'Money',
  date: 'Date',
  select: 'Select',
  multi_select: 'Multi-select',
  user: 'User',
  relation: 'Relation',
};

interface Draft {
  id?: string;
  key: string;
  label: string;
  type: CustomFieldType;
  choices: string;
  currency: string;
  relationEntity: 'company' | 'contact' | 'deal';
  required: boolean;
  indexed: boolean;
}

function toKey(label: string): string {
  const words = label
    .trim()
    .replace(/[^a-zA-Z0-9 ]/g, '')
    .split(/\s+/)
    .filter(Boolean);
  const k = words
    .map((w, i) => (i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join('');
  return /^[a-z]/.test(k) ? k.slice(0, 40) : `f${k}`.slice(0, 40);
}

function Row({
  def,
  onEdit,
  onDelete,
  disabled,
}: {
  def: CustomFieldDefDto;
  onEdit(): void;
  onDelete(): void;
  disabled: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: def.id,
    disabled,
  });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex items-center gap-3 border-b bg-card px-2 py-2 last:border-0 ${isDragging ? 'relative z-10 shadow-lg' : ''}`}
      data-testid="custom-field-row"
      data-key={def.key}
    >
      <button
        type="button"
        className="cursor-grab touch-none rounded p-1 text-muted-foreground hover:bg-muted active:cursor-grabbing"
        aria-label={`Reorder ${def.label}`}
        {...attributes}
        {...listeners}
      >
        <GripVertical className="size-4" />
      </button>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">
          {def.label} {def.required ? <span className="text-destructive">*</span> : null}
        </p>
        <p className="font-mono text-xs text-muted-foreground">custom.{def.key}</p>
      </div>
      <Badge variant="secondary">{TYPE_LABEL[def.type]}</Badge>
      {def.options?.choices ? (
        <span className="max-w-48 truncate text-xs text-muted-foreground">{def.options.choices.join(', ')}</span>
      ) : null}
      {def.indexed ? (
        <Badge variant="info" title="Has an expression index — fast filtering and sorting">
          <Zap /> indexed
        </Badge>
      ) : null}
      <Button size="icon-xs" variant="ghost" aria-label={`Edit ${def.label}`} disabled={disabled} onClick={onEdit}>
        <Pencil />
      </Button>
      <Button size="icon-xs" variant="ghost" aria-label={`Delete ${def.label}`} disabled={disabled} onClick={onDelete}>
        <Trash2 />
      </Button>
    </li>
  );
}

export function CustomFieldsSettings({
  entity,
  onEntityChange,
}: {
  entity: CustomFieldEntity;
  onEntityChange(e: CustomFieldEntity): void;
}) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const admin = can('admin');
  const { data, isLoading } = useCustomFields();
  const defs = (data ?? []).filter((d) => d.entity === entity).sort((a, b) => a.position - b.position);
  const [order, setOrder] = useState<string[]>([]);
  const defsKey = defs.map((d) => d.id).join(',');
  useEffect(() => setOrder(defsKey === '' ? [] : defsKey.split(',')), [defsKey]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<CustomFieldDefDto | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const indexedCount = defs.filter((d) => d.indexed).length;

  const reorder = useMutation({
    mutationFn: (ids: string[]) => api.post('/v1/custom-fields/reorder', { ids }),
    onError: (e) => {
      toast.error(errorMessage(e));
      setOrder(defs.map((d) => d.id));
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.customFields }),
  });
  const save = useMutation({
    mutationFn: (d: Draft) => {
      const options =
        d.type === 'select' || d.type === 'multi_select'
          ? {
              choices: d.choices
                .split(',')
                .map((c) => c.trim())
                .filter(Boolean),
            }
          : d.type === 'money'
            ? { currency: d.currency.toUpperCase() }
            : d.type === 'relation'
              ? { relationEntity: d.relationEntity }
              : null;
      if (d.id)
        return api.patch(`/v1/custom-fields/${d.id}`, {
          label: d.label,
          required: d.required,
          indexed: d.indexed,
          options,
        });
      return api.post('/v1/custom-fields', {
        entity,
        key: d.key,
        label: d.label,
        type: d.type,
        options,
        required: d.required,
        indexed: d.indexed,
      });
    },
    onSuccess: () => {
      toast.success('Custom field saved');
      setDraft(null);
      void qc.invalidateQueries({ queryKey: keys.customFields });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/v1/custom-fields/${id}`),
    onSuccess: () => {
      toast.success('Custom field deleted');
      void qc.invalidateQueries({ queryKey: keys.customFields });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const onDragEnd = (e: DragEndEvent) => {
    if (e.over === null || e.active.id === e.over.id) return;
    const next = arrayMove(order, order.indexOf(String(e.active.id)), order.indexOf(String(e.over.id)));
    setOrder(next);
    reorder.mutate(next);
  };
  const byId = new Map(defs.map((d) => [d.id, d]));
  const keyValid = draft === null || draft.id !== undefined || /^[a-z][a-zA-Z0-9_]*$/.test(draft.key);

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
        <div>
          <CardTitle>Custom fields</CardTitle>
          <CardDescription>
            Shown on records, in table columns and filters, and available in workflow expressions as {entity}
            .custom.&lt;key&gt;. Drag to reorder.
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <Segmented<CustomFieldEntity>
            ariaLabel="Record type"
            value={entity}
            onChange={onEntityChange}
            options={[
              { value: 'company', label: 'Companies' },
              { value: 'contact', label: 'Contacts' },
              { value: 'deal', label: 'Deals' },
            ]}
          />
          <Button
            size="sm"
            disabled={!admin}
            data-testid="create-custom-field"
            onClick={() =>
              setDraft({
                key: '',
                label: '',
                type: 'text',
                choices: '',
                currency: 'USD',
                relationEntity: 'company',
                required: false,
                indexed: false,
              })
            }
          >
            <Plus /> Add field
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <SkeletonRows rows={3} />
        ) : defs.length === 0 ? (
          <EmptyState
            icon={<SlidersHorizontal />}
            title="No custom fields"
            description="Add fields like Region, Tier or Lead source."
          />
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={order} strategy={verticalListSortingStrategy}>
              <ul className="overflow-hidden rounded-lg border" data-testid="custom-fields-list">
                {order.map((id) => {
                  const d = byId.get(id);
                  if (!d) return null;
                  return (
                    <Row
                      key={id}
                      def={d}
                      disabled={!admin}
                      onDelete={() => setDeleting(d)}
                      onEdit={() =>
                        setDraft({
                          id: d.id,
                          key: d.key,
                          label: d.label,
                          type: d.type,
                          choices: (d.options?.choices ?? []).join(', '),
                          currency: d.options?.currency ?? 'USD',
                          relationEntity: (d.options?.relationEntity as Draft['relationEntity']) ?? 'company',
                          required: d.required,
                          indexed: d.indexed,
                        })
                      }
                    />
                  );
                })}
              </ul>
            </SortableContext>
          </DndContext>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          {indexedCount}/5 indexed fields used for {entity}.
        </p>
      </CardContent>
      <Dialog open={draft !== null} onOpenChange={(o) => (o ? undefined : setDraft(null))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{draft?.id ? 'Edit custom field' : `New ${entity} field`}</DialogTitle>
          </DialogHeader>
          {draft ? (
            <form
              className="grid gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                save.mutate(draft);
              }}
            >
              <Field label="Label" htmlFor="cf-label" required>
                <Input
                  id="cf-label"
                  data-testid="field-label"
                  autoFocus
                  value={draft.label}
                  onChange={(e) =>
                    setDraft({ ...draft, label: e.target.value, key: draft.id ? draft.key : toKey(e.target.value) })
                  }
                  required
                />
              </Field>
              <Field
                label="Key"
                htmlFor="cf-key"
                error={keyValid ? null : 'Start with a lowercase letter; letters, digits and _ only'}
                hint="Used in expressions and the API. Cannot be changed later."
              >
                <Input
                  id="cf-key"
                  data-testid="field-key"
                  className="font-mono"
                  disabled={draft.id !== undefined}
                  value={draft.key}
                  onChange={(e) => setDraft({ ...draft, key: e.target.value })}
                />
              </Field>
              <Field label="Type" htmlFor="cf-type">
                <NativeSelect
                  id="cf-type"
                  data-testid="field-type"
                  disabled={draft.id !== undefined}
                  value={draft.type}
                  onChange={(e) => setDraft({ ...draft, type: e.target.value as CustomFieldType })}
                >
                  {CUSTOM_FIELD_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {TYPE_LABEL[t]}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              {draft.type === 'select' || draft.type === 'multi_select' ? (
                <Field label="Options" htmlFor="cf-choices" hint="Comma separated">
                  <Input
                    id="cf-choices"
                    data-testid="field-choices"
                    value={draft.choices}
                    onChange={(e) => setDraft({ ...draft, choices: e.target.value })}
                    placeholder="Gold, Silver, Bronze"
                  />
                </Field>
              ) : null}
              {draft.type === 'money' ? (
                <Field label="Currency" htmlFor="cf-currency">
                  <Input
                    id="cf-currency"
                    maxLength={3}
                    value={draft.currency}
                    onChange={(e) => setDraft({ ...draft, currency: e.target.value.toUpperCase() })}
                  />
                </Field>
              ) : null}
              {draft.type === 'relation' ? (
                <Field label="Links to" htmlFor="cf-rel">
                  <NativeSelect
                    id="cf-rel"
                    value={draft.relationEntity}
                    onChange={(e) => setDraft({ ...draft, relationEntity: e.target.value as Draft['relationEntity'] })}
                  >
                    <option value="company">Company</option>
                    <option value="contact">Contact</option>
                    <option value="deal">Deal</option>
                  </NativeSelect>
                </Field>
              ) : null}
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={draft.required}
                  onCheckedChange={(v) => setDraft({ ...draft, required: v === true })}
                  data-testid="field-required"
                />{' '}
                Required
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={draft.indexed}
                  disabled={!draft.indexed && indexedCount >= 5 && !byId.get(draft.id ?? '')?.indexed}
                  onCheckedChange={(v) => setDraft({ ...draft, indexed: v === true })}
                  data-testid="field-indexed"
                />
                Indexed (fast filter & sort, max 5 per record type)
              </label>
              <DialogFooter>
                <Button variant="outline" onClick={() => setDraft(null)}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  data-testid="dialog-submit"
                  disabled={!keyValid || draft.label.trim() === '' || draft.key === ''}
                  loading={save.isPending}
                >
                  Save field
                </Button>
              </DialogFooter>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => (o ? undefined : setDeleting(null))}
        title={`Delete “${deleting?.label ?? ''}”?`}
        description="Stored values stay in records but the field disappears from forms, tables and expressions. Workflows referencing it will fail validation."
        destructive
        confirmLabel="Delete"
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </Card>
  );
}
