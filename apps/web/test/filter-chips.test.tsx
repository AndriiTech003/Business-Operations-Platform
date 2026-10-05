import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FilterChip } from '@bop/contracts';
import { FilterChips } from '../src/components/data-table/FilterChips';
import { filterParam, listParams, nextSort, tableSearchSchema, toQueryString, type FieldSpec } from '../src/lib/table';
import { renderWithProviders } from './helpers';

const FIELDS: FieldSpec[] = [
  { key: 'name', label: 'Name', type: 'text' },
  { key: 'size', label: 'Employees', type: 'number' },
  { key: 'custom.region', label: 'Region', type: 'select', options: ['NA', 'EMEA', 'APAC'], custom: true },
];

function Harness({ onSeen }: { onSeen(chips: FilterChip[]): void }) {
  const [chips, setChips] = useState<FilterChip[]>([]);
  return (
    <>
      <FilterChips
        fields={FIELDS}
        value={chips}
        onChange={(next) => {
          setChips(next);
          onSeen(next);
        }}
      />
      <output data-testid="query">{toQueryString({ filter: chips })}</output>
    </>
  );
}

describe('DataTable filter chips', () => {
  it('adds a chip through the UI and serializes it into the filter query param', async () => {
    const user = userEvent.setup();
    let last: FilterChip[] = [];
    renderWithProviders(<Harness onSeen={(c) => (last = c)} />);

    await user.click(screen.getByTestId('filter-add'));
    await user.selectOptions(screen.getByTestId('filter-field'), 'size');
    await user.selectOptions(screen.getByTestId('filter-op'), 'gte');
    await user.type(screen.getByTestId('filter-value'), '100');
    await user.click(screen.getByTestId('filter-apply'));

    expect(last).toEqual([{ field: 'size', op: 'gte', value: 100 }]);
    const chip = screen.getByTestId('filter-chip');
    expect(within(chip).getByText('Employees')).toBeInTheDocument();
    expect(within(chip).getByText('≥')).toBeInTheDocument();

    const params = new URLSearchParams(screen.getByTestId('query').textContent ?? '');
    expect(JSON.parse(params.get('filter') ?? 'null')).toEqual([{ field: 'size', op: 'gte', value: 100 }]);
  });

  it('adds a custom select field chip and removes it again', async () => {
    const user = userEvent.setup();
    let last: FilterChip[] = [];
    renderWithProviders(<Harness onSeen={(c) => (last = c)} />);
    await user.click(screen.getByTestId('filter-add'));
    await user.selectOptions(screen.getByTestId('filter-field'), 'custom.region');
    await user.selectOptions(screen.getByTestId('filter-value'), 'EMEA');
    await user.click(screen.getByTestId('filter-apply'));
    expect(last).toEqual([{ field: 'custom.region', op: 'eq', value: 'EMEA' }]);
    await user.click(screen.getByRole('button', { name: 'Remove filter Region' }));
    expect(last).toEqual([]);
    expect(screen.queryByTestId('filter-chip')).not.toBeInTheDocument();
  });

  it('builds list params and drops incomplete chips', () => {
    expect(filterParam([{ field: 'name', op: 'contains', value: '' }])).toBeUndefined();
    expect(filterParam([{ field: 'domain', op: 'empty' }])).toBe('[{"field":"domain","op":"empty"}]');
    expect(listParams({ q: 'acme', sort: '-size', filter: [{ field: 'name', op: 'contains', value: 'co' }] })).toEqual({
      q: 'acme',
      sort: '-size',
      filter: '[{"field":"name","op":"contains","value":"co"}]',
    });
  });

  it('validates URL search state with zod and cycles sorting', () => {
    const parsed = tableSearchSchema.parse({
      q: 'x',
      filter: [
        { field: 'size', op: 'gt', value: 5 },
        { field: 'bad', op: 'nope' },
      ],
      cols: ['name'],
    });
    expect(parsed.q).toBe('x');
    expect(parsed.filter).toBeUndefined();
    expect(parsed.cols).toEqual(['name']);
    expect(nextSort(undefined, 'name')).toBe('name');
    expect(nextSort('name', 'name')).toBe('-name');
    expect(nextSort('-name', 'name')).toBeUndefined();
  });
});
