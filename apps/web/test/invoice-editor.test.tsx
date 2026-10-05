import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InvoiceLinesEditor, newLine, totalsOf, type EditableLine } from '../src/features/invoices/InvoiceLinesEditor';

function Harness({ initial }: { initial: EditableLine[] }) {
  const [lines, setLines] = useState(initial);
  return <InvoiceLinesEditor lines={lines} onChange={setLines} currency="USD" />;
}

describe('invoice editor', () => {
  it('recalculates subtotal, tax and total in integer cents while typing', async () => {
    const user = userEvent.setup();
    render(
      <Harness initial={[newLine({ description: 'Licence', quantity: 1, unitPriceCents: 100000, taxRate: 20 })]} />,
    );
    expect(screen.getByTestId('invoice-subtotal')).toHaveTextContent('$1,000.00');
    expect(screen.getByTestId('invoice-tax')).toHaveTextContent('$200.00');
    expect(screen.getByTestId('invoice-total')).toHaveTextContent('$1,200.00');

    await user.click(screen.getByTestId('add-line'));
    await user.type(screen.getByTestId('line-description-1'), 'Workshop');
    const qty = screen.getByTestId('line-quantity-1');
    await user.clear(qty);
    await user.type(qty, '3');
    const price = screen.getByTestId('line-price-1');
    await user.clear(price);
    await user.type(price, '333.33');
    const tax = screen.getByTestId('line-tax-1');
    await user.clear(tax);
    await user.type(tax, '7.5');

    expect(screen.getByTestId('line-amount-1')).toHaveTextContent('$999.99');
    expect(screen.getByTestId('invoice-subtotal')).toHaveTextContent('$1,999.99');
    expect(screen.getByTestId('invoice-tax')).toHaveTextContent('$275.00');
    expect(screen.getByTestId('invoice-total')).toHaveTextContent('$2,274.99');

    await user.click(screen.getByTestId('remove-line-0'));
    expect(screen.getByTestId('invoice-total')).toHaveTextContent('$1,074.99');
  });

  it('uses the shared integer-cent helpers', () => {
    const totals = totalsOf([
      newLine({ quantity: 0.5, unitPriceCents: 333, taxRate: 10 }),
      newLine({ quantity: 2, unitPriceCents: 1999, taxRate: 0 }),
    ]);
    expect(totals).toEqual({ subtotalCents: 167 + 3998, taxCents: 17, totalCents: 4182 });
    expect(Number.isInteger(totals.totalCents)).toBe(true);
  });
});
