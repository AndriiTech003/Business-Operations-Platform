import { invoiceTotals, lineTotals } from '@bop/contracts';
import { Button, Input, cn } from '@bop/ui';
import { Plus, Trash2 } from 'lucide-react';
import { MoneyInput } from '../../components/FieldInput';
import { money } from '../../lib/format';

export interface EditableLine {
  key: string;
  description: string;
  quantity: number;
  unitPriceCents: number;
  taxRate: number;
}

let seq = 0;
export function newLine(partial?: Partial<EditableLine>): EditableLine {
  seq += 1;
  return {
    key: `l${Date.now().toString(36)}${seq}`,
    description: '',
    quantity: 1,
    unitPriceCents: 0,
    taxRate: 0,
    ...partial,
  };
}

export function totalsOf(lines: EditableLine[]) {
  return invoiceTotals(
    lines.map((l) => ({
      quantity: Number.isFinite(l.quantity) ? l.quantity : 0,
      unitPriceCents: l.unitPriceCents,
      taxRate: Number.isFinite(l.taxRate) ? l.taxRate : 0,
    })),
  );
}

function num(value: string): number {
  const n = Number(value.replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

export function InvoiceLinesEditor({
  lines,
  onChange,
  currency,
  readOnly = false,
}: {
  lines: EditableLine[];
  onChange(lines: EditableLine[]): void;
  currency: string;
  readOnly?: boolean;
}) {
  const totals = totalsOf(lines);
  const update = (key: string, patch: Partial<EditableLine>) =>
    onChange(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  return (
    <div className="grid gap-3" data-testid="invoice-lines">
      <div className="overflow-hidden rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs text-muted-foreground">
            <tr>
              <th className="min-w-40 px-2 py-2 text-left font-medium">Description</th>
              <th className="w-16 px-2 py-2 text-right font-medium">Qty</th>
              <th className="w-28 px-2 py-2 text-right font-medium">Unit price</th>
              <th className="w-16 px-2 py-2 text-right font-medium">Tax %</th>
              <th className="w-28 px-2 py-2 text-right font-medium">Amount</th>
              {readOnly ? null : <th className="w-10" />}
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const t = lineTotals(l.quantity, l.unitPriceCents, l.taxRate);
              return (
                <tr key={l.key} className="border-t align-top">
                  <td className="p-1.5">
                    {readOnly ? (
                      <span className="block px-1.5 py-1">{l.description}</span>
                    ) : (
                      <Input
                        aria-label={`Line ${i + 1} description`}
                        data-testid={`line-description-${i}`}
                        className="h-8"
                        value={l.description}
                        placeholder="What are you billing for?"
                        onChange={(e) => update(l.key, { description: e.target.value })}
                      />
                    )}
                  </td>
                  <td className="p-1.5">
                    {readOnly ? (
                      <span className="block px-1.5 py-1 text-right tabular-nums">{l.quantity}</span>
                    ) : (
                      <Input
                        aria-label={`Line ${i + 1} quantity`}
                        data-testid={`line-quantity-${i}`}
                        inputMode="decimal"
                        className="h-8 text-right tabular-nums"
                        defaultValue={String(l.quantity)}
                        onChange={(e) => update(l.key, { quantity: num(e.target.value) })}
                      />
                    )}
                  </td>
                  <td className="p-1.5">
                    {readOnly ? (
                      <span className="block px-1.5 py-1 text-right tabular-nums">
                        {money(l.unitPriceCents, currency)}
                      </span>
                    ) : (
                      <MoneyInput
                        className="h-8"
                        testId={`line-price-${i}`}
                        value={l.unitPriceCents}
                        onChange={(c) => update(l.key, { unitPriceCents: c ?? 0 })}
                      />
                    )}
                  </td>
                  <td className="p-1.5">
                    {readOnly ? (
                      <span className="block px-1.5 py-1 text-right tabular-nums">{l.taxRate}%</span>
                    ) : (
                      <Input
                        aria-label={`Line ${i + 1} tax rate`}
                        data-testid={`line-tax-${i}`}
                        inputMode="decimal"
                        className="h-8 text-right tabular-nums"
                        defaultValue={String(l.taxRate)}
                        onChange={(e) => update(l.key, { taxRate: num(e.target.value) })}
                      />
                    )}
                  </td>
                  <td className="px-2 py-2.5 text-right tabular-nums" data-testid={`line-amount-${i}`}>
                    {money(t.amountCents, currency)}
                  </td>
                  {readOnly ? null : (
                    <td className="p-1.5">
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Remove line ${i + 1}`}
                        data-testid={`remove-line-${i}`}
                        onClick={() => onChange(lines.filter((x) => x.key !== l.key))}
                      >
                        <Trash2 />
                      </Button>
                    </td>
                  )}
                </tr>
              );
            })}
            {lines.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-xs text-muted-foreground">
                  No line items yet
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <div className="flex items-start justify-between gap-4">
        {readOnly ? (
          <span />
        ) : (
          <Button variant="outline" size="sm" onClick={() => onChange([...lines, newLine()])} data-testid="add-line">
            <Plus /> Add line
          </Button>
        )}
        <dl className="grid w-64 gap-1 text-sm">
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Subtotal</dt>
            <dd className="tabular-nums" data-testid="invoice-subtotal">
              {money(totals.subtotalCents, currency)}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Tax</dt>
            <dd className="tabular-nums" data-testid="invoice-tax">
              {money(totals.taxCents, currency)}
            </dd>
          </div>
          <div className={cn('flex justify-between border-t pt-1 text-base font-semibold')}>
            <dt>Total</dt>
            <dd className="tabular-nums" data-testid="invoice-total">
              {money(totals.totalCents, currency)}
            </dd>
          </div>
        </dl>
      </div>
    </div>
  );
}
