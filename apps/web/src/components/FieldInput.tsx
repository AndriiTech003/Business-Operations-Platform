import { useEffect, useState, type KeyboardEvent } from 'react';
import { Input, NativeSelect, Switch, cn } from '@bop/ui';
import { centsFromInput, centsToInput, fromDateInput, toIsoDateInput } from '../lib/format';
import type { RecordEntity } from '../lib/query-keys';
import type { FieldSpec } from '../lib/table';
import { RecordPicker, UserPicker } from './pickers';

export function MoneyInput({
  value,
  onChange,
  id,
  testId,
  autoFocus,
  onKeyDown,
  className,
  placeholder = '0.00',
  disabled,
  onBlur,
}: {
  value: number | null | undefined;
  onChange(cents: number | null): void;
  id?: string;
  testId?: string;
  autoFocus?: boolean;
  onKeyDown?(e: KeyboardEvent<HTMLInputElement>): void;
  className?: string;
  placeholder?: string;
  disabled?: boolean;
  onBlur?(): void;
}) {
  const [text, setText] = useState(centsToInput(value));
  useEffect(() => {
    setText((prev) => (centsFromInput(prev) === (value ?? null) ? prev : centsToInput(value)));
  }, [value]);
  return (
    <Input
      id={id}
      data-testid={testId}
      inputMode="decimal"
      autoFocus={autoFocus}
      disabled={disabled}
      className={cn('text-right tabular-nums', className)}
      placeholder={placeholder}
      value={text}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
      onChange={(e) => {
        setText(e.target.value);
        onChange(centsFromInput(e.target.value));
      }}
    />
  );
}

export interface FieldInputProps {
  spec: Pick<FieldSpec, 'type' | 'options' | 'relationEntity' | 'label' | 'key' | 'optionLabels'>;
  value: unknown;
  onChange(value: unknown): void;
  id?: string;
  testId?: string;
  autoFocus?: boolean;
  onKeyDown?(e: KeyboardEvent<HTMLElement>): void;
  onBlur?(): void;
  className?: string;
  disabled?: boolean;
}

export function FieldInput({
  spec,
  value,
  onChange,
  id,
  testId,
  autoFocus,
  onKeyDown,
  onBlur,
  className,
  disabled,
}: FieldInputProps) {
  switch (spec.type) {
    case 'number':
      return (
        <Input
          id={id}
          data-testid={testId}
          type="number"
          autoFocus={autoFocus}
          disabled={disabled}
          className={className}
          value={typeof value === 'number' ? String(value) : ''}
          onKeyDown={onKeyDown}
          onBlur={onBlur}
          onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        />
      );
    case 'money':
      return (
        <MoneyInput
          id={id}
          testId={testId}
          autoFocus={autoFocus}
          disabled={disabled}
          className={className}
          value={typeof value === 'number' ? value : null}
          onKeyDown={onKeyDown}
          onBlur={onBlur}
          onChange={onChange}
        />
      );
    case 'date':
      return (
        <Input
          id={id}
          data-testid={testId}
          type="date"
          autoFocus={autoFocus}
          disabled={disabled}
          className={className}
          value={typeof value === 'string' ? toIsoDateInput(value) : ''}
          onKeyDown={onKeyDown}
          onBlur={onBlur}
          onChange={(e) => onChange(fromDateInput(e.target.value))}
        />
      );
    case 'select':
      return (
        <NativeSelect
          id={id}
          data-testid={testId}
          autoFocus={autoFocus}
          disabled={disabled}
          className={className}
          value={typeof value === 'string' ? value : ''}
          onKeyDown={onKeyDown}
          onBlur={onBlur}
          onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
        >
          <option value="">—</option>
          {(spec.options ?? []).map((o) => (
            <option key={o} value={o}>
              {spec.optionLabels?.[o] ?? o}
            </option>
          ))}
        </NativeSelect>
      );
    case 'multi_select': {
      const selected = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div
          id={id}
          data-testid={testId}
          className={cn('flex flex-wrap gap-1', className)}
          role="group"
          aria-label={spec.label}
        >
          {(spec.options ?? []).map((o) => {
            const on = selected.includes(o);
            return (
              <button
                key={o}
                type="button"
                aria-pressed={on}
                disabled={disabled}
                onClick={() => onChange(on ? selected.filter((s) => s !== o) : [...selected, o])}
                className={cn(
                  'cursor-pointer rounded-full border px-2 py-0.5 text-xs',
                  on ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted',
                )}
              >
                {spec.optionLabels?.[o] ?? o}
              </button>
            );
          })}
        </div>
      );
    }
    case 'user':
      return (
        <UserPicker
          id={id}
          testId={testId}
          disabled={disabled}
          className={className}
          value={typeof value === 'string' ? value : null}
          onChange={onChange}
        />
      );
    case 'relation':
      return (
        <RecordPicker
          entity={(spec.relationEntity ?? 'company') as RecordEntity}
          testId={testId}
          disabled={disabled}
          className={className}
          value={typeof value === 'string' ? value : null}
          onChange={(nextId) => onChange(nextId)}
        />
      );
    case 'bool':
      return (
        <Switch
          id={id}
          data-testid={testId}
          disabled={disabled}
          checked={value === true}
          onCheckedChange={(v) => onChange(v)}
        />
      );
    default:
      return (
        <Input
          id={id}
          data-testid={testId}
          autoFocus={autoFocus}
          disabled={disabled}
          className={className}
          value={typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value)}
          onKeyDown={onKeyDown}
          onBlur={onBlur}
          onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
        />
      );
  }
}
