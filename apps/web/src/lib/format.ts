import { formatCents } from '@bop/contracts';
import { differenceInCalendarDays, format, formatDistanceToNowStrict, isValid, parseISO } from 'date-fns';

export function money(cents: number | null | undefined, currency = 'USD'): string {
  if (cents === null || cents === undefined || Number.isNaN(cents)) return '—';
  try {
    return formatCents(cents, currency);
  } catch {
    return formatCents(cents, 'USD');
  }
}

export function compactMoney(cents: number, currency = 'USD'): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(cents / 100);
  } catch {
    return money(cents, currency);
  }
}

export function toDate(value: string | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? value : parseISO(value);
  return isValid(d) ? d : null;
}

export function fmtDate(value: string | Date | null | undefined, pattern = 'MMM d, yyyy'): string {
  const d = toDate(value);
  return d === null ? '—' : format(d, pattern);
}

export function fmtDateTime(value: string | Date | null | undefined): string {
  return fmtDate(value, 'MMM d, yyyy HH:mm');
}

export function relative(value: string | Date | null | undefined): string {
  const d = toDate(value);
  if (d === null) return '—';
  const diff = Date.now() - d.getTime();
  if (Math.abs(diff) < 45_000) return 'just now';
  return diff > 0 ? `${formatDistanceToNowStrict(d)} ago` : `in ${formatDistanceToNowStrict(d)}`;
}

export function daysSince(value: string | Date | null | undefined, now: Date = new Date()): number {
  const d = toDate(value);
  return d === null ? 0 : Math.max(0, differenceInCalendarDays(now, d));
}

export function countdown(target: string | Date | null | undefined, now: Date = new Date()): string {
  const d = toDate(target);
  if (d === null) return '';
  let ms = d.getTime() - now.getTime();
  const past = ms < 0;
  ms = Math.abs(ms);
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  let text: string;
  if (days > 0) text = `${days}d ${hours}h`;
  else if (hours > 0) text = `${hours}h ${minutes}m`;
  else if (minutes > 0) text = `${minutes}m ${seconds}s`;
  else text = `${seconds}s`;
  return past ? `${text} ago` : text;
}

export function durationMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ${Math.round((ms % 3_600_000) / 60_000)}m`;
  return `${Math.floor(ms / 86_400_000)}d ${Math.round((ms % 86_400_000) / 3_600_000)}h`;
}

export function centsFromInput(value: string): number | null {
  const cleaned = value.replace(/[^0-9.,-]/g, '').replace(/,/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

export function centsToInput(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '';
  return (cents / 100).toFixed(2);
}

export function humanize(key: string): string {
  const spaced = key
    .replace(/^custom\./, '')
    .replace(/[._]/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function toIsoDateInput(value: string | null | undefined): string {
  const d = toDate(value);
  return d === null ? '' : format(d, 'yyyy-MM-dd');
}

export function fromDateInput(value: string): string | null {
  if (value === '') return null;
  return new Date(`${value}T00:00:00.000Z`).toISOString();
}

export function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}
