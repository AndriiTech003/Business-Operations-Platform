import { useState } from 'react';
import type { FilterChip, FilterOp } from '@bop/contracts';
import { Button, NativeSelect, Popover, PopoverContent, PopoverTrigger, cn } from '@bop/ui';
import { ListFilter, Plus, X } from 'lucide-react';
import { useMemberMap } from '../../lib/data';
import { fmtDate, money } from '../../lib/format';
import { OPS_BY_TYPE, opLabel, opNeedsValue, type FieldSpec } from '../../lib/table';
import { FieldInput } from '../FieldInput';

function useValueLabel() {
  const members = useMemberMap();
  return (spec: FieldSpec | undefined, value: FilterChip['value']): string => {
    if (value === undefined || value === null) return '';
    if (Array.isArray(value)) return value.map((v) => spec?.optionLabels?.[String(v)] ?? String(v)).join(', ');
    if (spec?.optionLabels !== undefined && typeof value === 'string') return spec.optionLabels[value] ?? value;
    if (spec?.type === 'money' && typeof value === 'number') return money(value, spec.currency ?? 'USD');
    if (spec?.type === 'date' && typeof value === 'string') return fmtDate(value);
    if (spec?.type === 'user' && typeof value === 'string') return members.get(value)?.name ?? 'user';
    if (spec?.type === 'relation' && typeof value === 'string') return `${value.slice(0, 8)}…`;
    return String(value);
  };
}

function ChipEditor({
  fields,
  initial,
  onSubmit,
  submitLabel,
}: {
  fields: FieldSpec[];
  initial: FilterChip | null;
  onSubmit(chip: FilterChip): void;
  submitLabel: string;
}) {
  const filterable = fields.filter((f) => f.filterable !== false);
  const [field, setField] = useState(initial?.field ?? filterable[0]?.key ?? '');
  const spec = filterable.find((f) => f.key === field);
  const ops = spec === undefined ? [] : OPS_BY_TYPE[spec.type];
  const [op, setOp] = useState<FilterOp>(initial?.op ?? ops[0] ?? 'eq');
  const [value, setValue] = useState<unknown>(initial?.value ?? null);
  const effectiveOp = ops.includes(op) ? op : (ops[0] ?? 'eq');
  const needsValue = opNeedsValue(effectiveOp);
  const valueSpec: FieldSpec | undefined =
    spec === undefined
      ? undefined
      : effectiveOp === 'contains' && spec.type === 'multi_select'
        ? { ...spec, type: 'select' }
        : spec;
  const canSubmit =
    spec !== undefined &&
    (!needsValue ||
      (value !== null && value !== undefined && value !== '' && !(Array.isArray(value) && value.length === 0)));

  return (
    <form
      className="grid gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSubmit) return;
        let v = value;
        if (effectiveOp === 'in' && typeof v === 'string') v = [v];
        onSubmit(needsValue ? { field, op: effectiveOp, value: v as FilterChip['value'] } : { field, op: effectiveOp });
      }}
    >
      <NativeSelect
        aria-label="Field"
        data-testid="filter-field"
        value={field}
        onChange={(e) => {
          setField(e.target.value);
          setValue(null);
        }}
      >
        {filterable.map((f) => (
          <option key={f.key} value={f.key}>
            {f.label}
          </option>
        ))}
      </NativeSelect>
      <NativeSelect
        aria-label="Operator"
        data-testid="filter-op"
        value={effectiveOp}
        onChange={(e) => setOp(e.target.value as FilterOp)}
      >
        {ops.map((o) => (
          <option key={o} value={o}>
            {opLabel(o, spec?.type ?? 'text')}
          </option>
        ))}
      </NativeSelect>
      {needsValue && valueSpec !== undefined ? (
        <FieldInput
          spec={
            valueSpec.type === 'multi_select'
              ? { ...valueSpec, type: 'select' }
              : effectiveOp === 'in' && valueSpec.type === 'select'
                ? { ...valueSpec, type: 'multi_select' }
                : valueSpec
          }
          value={value}
          onChange={setValue}
          testId="filter-value"
        />
      ) : null}
      <Button type="submit" size="sm" disabled={!canSubmit} data-testid="filter-apply">
        {submitLabel}
      </Button>
    </form>
  );
}

export function FilterChips({
  fields,
  value,
  onChange,
}: {
  fields: FieldSpec[];
  value: FilterChip[];
  onChange(next: FilterChip[]): void;
}) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const label = useValueLabel();
  const byKey = new Map(fields.map((f) => [f.key, f]));

  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="filter-chips">
      {value.map((chip, i) => {
        const spec = byKey.get(chip.field);
        return (
          <Popover key={`${chip.field}-${i}`} open={editing === i} onOpenChange={(o) => setEditing(o ? i : null)}>
            <span
              data-testid="filter-chip"
              className={cn('inline-flex h-7 items-center gap-1 rounded-full border bg-accent/60 pl-2.5 pr-1 text-xs')}
            >
              <PopoverTrigger asChild>
                <button type="button" className="cursor-pointer">
                  <span className="font-medium">{spec?.label ?? chip.field}</span>{' '}
                  <span className="text-muted-foreground">{opLabel(chip.op, spec?.type ?? 'text')}</span>{' '}
                  {opNeedsValue(chip.op) ? <span className="font-medium">{label(spec, chip.value)}</span> : null}
                </button>
              </PopoverTrigger>
              <button
                type="button"
                aria-label={`Remove filter ${spec?.label ?? chip.field}`}
                className="cursor-pointer rounded-full p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
                onClick={() => onChange(value.filter((_, j) => j !== i))}
              >
                <X className="size-3" />
              </button>
            </span>
            <PopoverContent className="w-64">
              <ChipEditor
                fields={fields}
                initial={chip}
                submitLabel="Update filter"
                onSubmit={(next) => {
                  onChange(value.map((c, j) => (j === i ? next : c)));
                  setEditing(null);
                }}
              />
            </PopoverContent>
          </Popover>
        );
      })}
      <Popover open={adding} onOpenChange={setAdding}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="xs" className="rounded-full border-dashed" data-testid="filter-add">
            {value.length === 0 ? <ListFilter /> : <Plus />}
            {value.length === 0 ? 'Filter' : 'Add'}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-64">
          <ChipEditor
            fields={fields}
            initial={null}
            submitLabel="Add filter"
            onSubmit={(chip) => {
              onChange([...value, chip]);
              setAdding(false);
            }}
          />
        </PopoverContent>
      </Popover>
      {value.length > 1 ? (
        <Button variant="ghost" size="xs" onClick={() => onChange([])}>
          Clear all
        </Button>
      ) : null}
    </div>
  );
}
