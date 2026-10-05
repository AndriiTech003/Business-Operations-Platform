import { describe, expect, it } from 'vitest';
import { TOOLS, annotationsFor, collectUntrusted } from '../../src/tools';

const SPEC_RISK: Record<string, string> = {
  search_records: 'read',
  get_company: 'read',
  get_contact: 'read',
  get_deal: 'read',
  get_invoice: 'read',
  list_contacts: 'read',
  list_deals: 'read',
  list_invoices: 'read',
  get_report: 'read',
  create_task: 'write_reversible',
  add_note: 'write_reversible',
  update_deal: 'write_reversible',
  draft_email: 'write_reversible',
  send_email: 'external',
  send_invoice: 'external',
  void_invoice: 'irreversible',
};

describe('ops-mcp tool catalogue (SPEC §5)', () => {
  it('exposes exactly the tools of the spec with their risk levels', () => {
    expect(Object.fromEntries(TOOLS.map((t) => [t.name, t.risk]))).toEqual(SPEC_RISK);
  });

  it('every write tool accepts idempotencyKey and dryRun; read tools do not', () => {
    for (const t of TOOLS) {
      const keys = Object.keys(t.input);
      if (t.risk === 'read') expect(keys).not.toContain('dryRun');
      else expect(keys).toEqual(expect.arrayContaining(['idempotencyKey', 'dryRun']));
    }
  });

  it('maps risk to MCP annotations plus x-risk', () => {
    expect(annotationsFor('read')).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      'x-risk': 'read',
    });
    expect(annotationsFor('irreversible')).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      'x-risk': 'irreversible',
    });
    expect(annotationsFor('external')).toMatchObject({ openWorldHint: true, 'x-risk': 'external' });
  });
});

describe('untrusted markers', () => {
  it('collects outsider-written fields anywhere in a result', () => {
    const result = {
      invoice: {
        contact: { id: 'c1', name: 'Ann Lee', untrusted: ['name'] },
        company: { id: 'k1', name: 'Initrode', untrusted: ['name'] },
      },
      contact: {
        firstName: 'Ann',
        lastName: 'Lee',
        name: 'Ann Lee',
        title: 'CEO',
        source: 'web_form',
        email: 'a@x.test',
      },
      company: { name: 'Initrode', industry: 'Retail', tags: ['web-form'] },
      trusted: { name: 'Globex', tags: ['key-account'], source: 'manual' },
      activities: [
        { kind: 'email', data: { body: 'hello', external: true } },
        { kind: 'note', data: { body: 'ours' } },
      ],
      groups: [
        { hits: [{ entity: 'contact', id: '1', title: 'Ann', subtitle: 'CEO', score: 1, untrusted: ['subtitle'] }] },
      ],
    };
    expect(collectUntrusted({ result, untrusted: ['invoice.notes'] })).toEqual(
      [
        'activities[0].data.body',
        'company.industry',
        'company.name',
        'contact.firstName',
        'contact.lastName',
        'contact.name',
        'contact.title',
        'groups[0].hits[0].subtitle',
        'invoice.company.name',
        'invoice.contact.name',
        'invoice.notes',
      ].sort(),
    );
  });

  it('list tools accept a cursor', () => {
    for (const t of TOOLS.filter((x) => x.name.startsWith('list_'))) expect(Object.keys(t.input)).toContain('cursor');
  });
});
