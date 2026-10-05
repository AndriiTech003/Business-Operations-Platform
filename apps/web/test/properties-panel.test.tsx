import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WorkflowDefinition } from '@bop/contracts';
import { NODE_REGISTRY, WORKFLOW_TEMPLATES, validateDefinition } from '@bop/workflow-core';
import { PropertiesPanel } from '../src/features/workflows/builder/PropertiesPanel';
import { renderWithProviders } from './helpers';

const base = WORKFLOW_TEMPLATES.find((t) => t.key === 'overdue_invoice')?.definition as WorkflowDefinition;

function withNode(def: WorkflowDefinition, id: string, config: Record<string, unknown>): WorkflowDefinition {
  return { ...def, nodes: def.nodes.map((n) => (n.id === id ? { ...n, config } : n)) };
}

describe('node properties panel', () => {
  it('renders one control per registry field of the node type', () => {
    const node = base.nodes.find((n) => n.id === 'remind');
    if (node === undefined) throw new Error('missing node');
    renderWithProviders(
      <PropertiesPanel
        definition={base}
        node={node}
        custom={{}}
        emailTemplates={['invoice_reminder', 'invoice_final_notice']}
        issues={[]}
        onChange={() => undefined}
        onRename={() => undefined}
        onDelete={() => undefined}
      />,
    );
    const panel = screen.getByTestId('properties-panel');
    for (const field of NODE_REGISTRY.send_email.fields)
      expect(within(panel).getByText(field.label)).toBeInTheDocument();
    expect(screen.getByTestId('expr-to')).toBeInTheDocument();
    expect(screen.getByTestId('expr-subject')).toBeInTheDocument();
    expect((screen.getByTestId('field-template') as HTMLSelectElement).value).toBe('invoice_reminder');
    expect(screen.getByTestId('expr-to').textContent).toContain('invoice.contact?.email');
    expect(within(panel).getByText('next')).toBeInTheDocument();
    expect(within(panel).getByText('error')).toBeInTheDocument();
  });

  it('shows validation issues from validateDefinition under the right fields', () => {
    const def = withNode(base, 'big', { expr: 'invoice.number' });
    const broken = withNode(def, 'remind', { to: 'invoice.contact?.email', template: 'missing_template' });
    const result = validateDefinition(broken, {
      custom: {},
      emailTemplates: ['invoice_reminder', 'invoice_final_notice'],
    });
    const bigIssues = result.issues.filter((i) => i.nodeId === 'big');
    const node = broken.nodes.find((n) => n.id === 'big');
    if (node === undefined) throw new Error('missing node');
    renderWithProviders(
      <PropertiesPanel
        definition={broken}
        node={node}
        custom={{}}
        emailTemplates={[]}
        issues={bigIssues}
        onChange={() => undefined}
        onRename={() => undefined}
        onDelete={() => undefined}
      />,
    );
    const row = document.getElementById('prop-expr') as HTMLElement;
    expect(within(row).getByTestId('field-issues')).toHaveTextContent('Expected bool | bool?, got string');
    expect(within(row).getByTestId('field-issues')).toHaveTextContent('(1:1)');
    expect(result.issues.some((i) => i.nodeId === 'remind' && i.code === 'unknown_template')).toBe(true);
  });

  it('edits non-expression fields and reports the change', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const node = { id: 'call', type: 'http_request' as const, config: { method: 'POST', url: 'https://example.test' } };
    const def: WorkflowDefinition = {
      ...base,
      nodes: [...base.nodes, node],
      edges: [...base.edges, { from: 'final', to: 'call' }],
    };
    renderWithProviders(
      <PropertiesPanel
        definition={def}
        node={node}
        custom={{}}
        emailTemplates={[]}
        issues={[]}
        onChange={onChange}
        onRename={() => undefined}
        onDelete={() => undefined}
      />,
    );
    await user.selectOptions(screen.getByTestId('field-method'), 'PUT');
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ config: expect.objectContaining({ method: 'PUT' }) }),
      'config.method',
    );
  });
});
