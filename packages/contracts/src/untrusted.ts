export const EXTERNAL_SOURCES: readonly string[] = ['web_form', 'webhook', 'inbound_email'];
export const EXTERNAL_TAGS: readonly string[] = ['web-form', 'web_form'];
export const UNTRUSTED_CONTACT_FIELDS: readonly string[] = ['firstName', 'lastName', 'name', 'title', 'custom'];
export const UNTRUSTED_COMPANY_FIELDS: readonly string[] = ['name', 'industry', 'custom'];
export const UNTRUSTED_REF_FIELDS: readonly string[] = ['name'];
export const UNTRUSTED_ACTIVITY_FIELDS: readonly string[] = ['data.body', 'data.subject', 'data.from'];

export function isExternalSource(source: string | null | undefined): boolean {
  return typeof source === 'string' && EXTERNAL_SOURCES.includes(source);
}

export function isExternalCompany(c: { source?: string | null; tags?: readonly string[] | null }): boolean {
  return isExternalSource(c.source) || (c.tags ?? []).some((t) => EXTERNAL_TAGS.includes(t));
}

export function contactUntrustedFields(c: { source?: string | null }): string[] {
  return isExternalSource(c.source) ? [...UNTRUSTED_CONTACT_FIELDS] : [];
}

export function companyUntrustedFields(c: { source?: string | null; tags?: readonly string[] | null }): string[] {
  return isExternalCompany(c) ? [...UNTRUSTED_COMPANY_FIELDS] : [];
}

function joinPath(prefix: string, key: string | number): string {
  if (typeof key === 'number') return `${prefix}[${key}]`;
  return prefix === '' ? key : `${prefix}.${key}`;
}

function hasPath(value: Record<string, unknown>, path: string): boolean {
  let cur: unknown = value;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || !(part in (cur as Record<string, unknown>))) return false;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur !== null && cur !== undefined;
}

function ownUntrusted(o: Record<string, unknown>): string[] {
  const out = new Set<string>();
  if (Array.isArray(o['untrusted'])) for (const p of o['untrusted']) if (typeof p === 'string') out.add(p);
  const contactLike = 'firstName' in o || 'lastName' in o;
  if (contactLike && isExternalSource(o['source'] as string | null | undefined))
    for (const f of UNTRUSTED_CONTACT_FIELDS) if (f in o) out.add(f);
  if (
    !contactLike &&
    typeof o['name'] === 'string' &&
    isExternalCompany({
      source: o['source'] as string | null | undefined,
      tags: Array.isArray(o['tags']) ? (o['tags'] as string[]) : null,
    })
  )
    for (const f of UNTRUSTED_COMPANY_FIELDS) if (f in o) out.add(f);
  const data = o['data'];
  if (data !== null && typeof data === 'object' && (data as Record<string, unknown>)['external'] === true)
    for (const f of UNTRUSTED_ACTIVITY_FIELDS) if (hasPath(o, f)) out.add(f);
  if (o['external'] === true)
    for (const f of ['body', 'subject', 'from', 'title', 'subtitle']) if (typeof o[f] === 'string') out.add(f);
  return [...out].filter((p) => hasPath(o, p));
}

export function untrustedPaths(value: unknown, prefix = ''): string[] {
  const out = new Set<string>();
  const visit = (v: unknown, path: string): void => {
    if (Array.isArray(v)) {
      v.forEach((item, i) => visit(item, joinPath(path, i)));
      return;
    }
    if (v === null || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    for (const p of ownUntrusted(o)) out.add(path === '' ? p : `${path}.${p}`);
    for (const [k, child] of Object.entries(o)) {
      if (k === 'untrusted') continue;
      visit(child, joinPath(path, k));
    }
  };
  visit(value, prefix);
  return [...out].sort();
}
