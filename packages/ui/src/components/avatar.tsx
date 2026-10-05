import * as React from 'react';
import { cn } from '../lib/cn';

const PALETTE = [
  'bg-indigo-500',
  'bg-emerald-500',
  'bg-amber-500',
  'bg-rose-500',
  'bg-sky-500',
  'bg-violet-500',
  'bg-teal-500',
  'bg-orange-500',
];

export function initialsOf(name: string | null | undefined): string {
  const parts = (name ?? '?').trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '?';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

export function colorFor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length] ?? 'bg-indigo-500';
}

export interface AvatarProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'id'> {
  name: string | null | undefined;
  id?: string | null;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  ring?: boolean;
}

const SIZES = {
  xs: 'size-5 text-[9px]',
  sm: 'size-6 text-[10px]',
  md: 'size-8 text-xs',
  lg: 'size-10 text-sm',
} as const;

export function Avatar({ name, id, size = 'sm', ring = false, className, ...props }: AvatarProps) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold text-white',
        SIZES[size],
        colorFor(id ?? name ?? '?'),
        ring && 'ring-2 ring-card',
        className,
      )}
      title={name ?? undefined}
      aria-label={name ?? undefined}
      {...props}
    >
      {initialsOf(name)}
    </span>
  );
}

export function AvatarStack({
  people,
  max = 4,
  size = 'sm',
}: {
  people: Array<{ id: string; name: string }>;
  max?: number;
  size?: AvatarProps['size'];
}) {
  const shown = people.slice(0, max);
  const rest = people.length - shown.length;
  return (
    <div className="flex -space-x-1.5">
      {shown.map((p) => (
        <Avatar key={p.id} id={p.id} name={p.name} size={size} ring />
      ))}
      {rest > 0 ? (
        <span
          className={cn(
            'inline-flex items-center justify-center rounded-full bg-muted font-medium text-muted-foreground ring-2 ring-card',
            SIZES[size ?? 'sm'],
          )}
        >
          +{rest}
        </span>
      ) : null}
    </div>
  );
}
