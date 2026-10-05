import { Button, Checkbox, Popover, PopoverContent, PopoverTrigger } from '@bop/ui';
import { Columns3, RotateCcw } from 'lucide-react';
import type { FieldSpec } from '../../lib/table';

export function ColumnChooser({
  columns,
  visible,
  defaultColumns,
  onChange,
}: {
  columns: FieldSpec[];
  visible: string[];
  defaultColumns: string[];
  onChange(cols: string[] | undefined): void;
}) {
  const set = new Set(visible);
  const toggle = (key: string, on: boolean) => {
    const next = on
      ? columns.map((c) => c.key).filter((k) => set.has(k) || k === key)
      : visible.filter((k) => k !== key);
    onChange(next.length === 0 ? undefined : next);
  };
  const base = columns.filter((c) => c.custom !== true);
  const custom = columns.filter((c) => c.custom === true);
  const renderList = (list: FieldSpec[]) =>
    list.map((c) => (
      <label key={c.key} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-muted">
        <Checkbox
          checked={set.has(c.key)}
          onCheckedChange={(v) => toggle(c.key, v === true)}
          data-testid={`col-${c.key}`}
        />
        {c.label}
      </label>
    ));
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" data-testid="column-chooser">
          <Columns3 /> Columns
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-60 p-2">
        <div className="max-h-80 overflow-y-auto">
          <p className="px-1.5 py-1 text-xs font-medium text-muted-foreground">Fields</p>
          {renderList(base)}
          {custom.length > 0 ? (
            <>
              <p className="mt-2 px-1.5 py-1 text-xs font-medium text-muted-foreground">Custom fields</p>
              {renderList(custom)}
            </>
          ) : null}
        </div>
        <Button
          variant="ghost"
          size="xs"
          className="mt-1 w-full"
          onClick={() => onChange(undefined)}
          disabled={visible.join() === defaultColumns.join()}
        >
          <RotateCcw /> Reset to default
        </Button>
      </PopoverContent>
    </Popover>
  );
}
