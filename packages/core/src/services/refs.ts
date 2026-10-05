import { UNTRUSTED_REF_FIELDS, isExternalCompany, isExternalSource, type RecordRef } from '@bop/contracts';

export const COMPANY_REF_SELECT = { id: true, name: true, source: true, tags: true } as const;
export const CONTACT_REF_SELECT = { id: true, firstName: true, lastName: true, source: true } as const;

export function companyRef(c: { id: string; name: string; source: string | null; tags: string[] }): RecordRef {
  return isExternalCompany(c)
    ? { id: c.id, name: c.name, untrusted: [...UNTRUSTED_REF_FIELDS] }
    : { id: c.id, name: c.name };
}

export function contactRef(c: { id: string; firstName: string; lastName: string; source: string | null }): RecordRef {
  const name = `${c.firstName} ${c.lastName}`.trim();
  return isExternalSource(c.source) ? { id: c.id, name, untrusted: [...UNTRUSTED_REF_FIELDS] } : { id: c.id, name };
}
