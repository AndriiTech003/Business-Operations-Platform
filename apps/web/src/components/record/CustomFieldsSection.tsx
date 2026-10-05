import type { CustomFieldDefDto } from '@bop/contracts';
import { Card, CardContent, CardHeader, CardTitle } from '@bop/ui';
import { Settings2 } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import { customFieldSpecs } from '../../lib/table';
import { InlineField } from './InlineField';

export function CustomFieldsSection({
  defs,
  values,
  onSave,
  readOnly,
}: {
  defs: CustomFieldDefDto[];
  values: Record<string, unknown>;
  onSave(key: string, value: unknown): void;
  readOnly?: boolean;
}) {
  const specs = customFieldSpecs(defs);
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Custom fields</CardTitle>
        <Link
          to="/settings"
          search={{ tab: 'fields' }}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <Settings2 className="size-3" /> Manage
        </Link>
      </CardHeader>
      <CardContent className="grid gap-1">
        {specs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No custom fields defined for this record type.</p>
        ) : null}
        {specs.map((s, i) => {
          const def = defs[i];
          return (
            <InlineField
              key={s.key}
              layout="row"
              spec={{ ...s, label: `${s.label}${def?.required ? ' *' : ''}` }}
              value={values[s.key.slice(7)]}
              readOnly={readOnly}
              onSave={(v) => onSave(s.key.slice(7), v)}
            />
          );
        })}
      </CardContent>
    </Card>
  );
}
