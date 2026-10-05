import type { WorkflowTemplateDto } from '@bop/contracts';

export const WORKFLOW_TEMPLATES: WorkflowTemplateDto[] = [
  {
    key: 'overdue_invoice',
    name: 'Overdue invoice follow-up',
    description:
      'When an invoice is overdue: notify the owner and create a task for big invoices, send a reminder, wait for payment, ask a manager before the final notice.',
    definition: {
      name: 'Overdue invoice follow-up',
      trigger: {
        type: 'record_condition',
        entity: 'invoice',
        condition: "invoice.status in ['sent', 'partially_paid', 'overdue'] and invoice.dueDate < now() - days(1)",
        dedupe: 'invoice.id',
      },
      nodes: [
        { id: 'big', type: 'condition', config: { expr: 'invoice.totalCents > 100000' } },
        {
          id: 'notify',
          type: 'notify',
          config: {
            to: 'invoice.company.owner',
            message:
              'Invoice {{ invoice.number }} is overdue ({{ formatMoney(invoice.totalCents, invoice.currency) }})',
          },
        },
        {
          id: 'task',
          type: 'create_task',
          config: {
            title: 'Call {{ invoice.company.name }} about {{ invoice.number }}',
            assignee: 'invoice.company.owner',
            dueAt: 'now() + days(1)',
            relatedTo: 'invoice',
          },
        },
        {
          id: 'remind',
          type: 'send_email',
          config: { template: 'invoice_reminder', to: 'invoice.contact?.email', attachInvoice: true },
          retry: { maxAttempts: 5, backoff: 'exponential', initialMs: 30000 },
        },
        {
          id: 'wait_paid',
          type: 'wait_for_event',
          config: { entity: 'invoice', id: 'invoice.id', event: 'invoice.paid', timeout: 'days(3)' },
        },
        {
          id: 'escalate',
          type: 'approval',
          config: {
            assignees: "role('manager')",
            title: 'Send final notice for {{ invoice.number }}?',
            timeout: 'days(2)',
          },
        },
        { id: 'final', type: 'send_email', config: { template: 'invoice_final_notice', to: 'invoice.contact?.email' } },
      ],
      edges: [
        { from: '$trigger', to: 'big' },
        { from: 'big', to: 'notify', label: 'true' },
        { from: 'big', to: 'task', label: 'true' },
        { from: 'big', to: 'remind', label: 'false' },
        { from: 'notify', to: 'remind' },
        { from: 'task', to: 'remind' },
        { from: 'remind', to: 'wait_paid' },
        { from: 'wait_paid', to: 'escalate', label: 'timeout' },
        { from: 'escalate', to: 'final', label: 'approved' },
      ],
    },
  },
  {
    key: 'new_lead_round_robin',
    name: 'New lead → round-robin owner',
    description: 'Assign new leads to team members in turn and create a welcome task.',
    definition: {
      name: 'New lead → round-robin owner',
      trigger: {
        type: 'record_event',
        entity: 'contact',
        event: 'contact.created',
        filter: "contact.status == 'lead' and contact.ownerId == null",
      },
      nodes: [
        {
          id: 'assign',
          type: 'update_record',
          config: { record: 'contact', fields: { ownerId: "role('member')[run.number % len(role('member'))]?.id" } },
        },
        {
          id: 'welcome',
          type: 'create_task',
          config: {
            title: 'Welcome call with {{ contact.name }}',
            assignee: "role('member')[run.number % len(role('member'))]",
            dueAt: 'now() + days(1)',
            relatedTo: 'contact',
          },
        },
      ],
      edges: [
        { from: '$trigger', to: 'assign' },
        { from: 'assign', to: 'welcome' },
      ],
    },
  },
  {
    key: 'stale_deal_nudge',
    name: 'Stale deal nudge',
    description: 'A deal without activity for 14 days: notify the owner, and a manager 7 days later.',
    definition: {
      name: 'Stale deal nudge',
      trigger: {
        type: 'record_condition',
        entity: 'deal',
        condition: 'deal.closedAt == null and deal.lastActivityAt < now() - days(14)',
        dedupe: "deal.id + ':' + formatDate(deal.lastActivityAt, 'YYYY-MM-DD')",
      },
      nodes: [
        {
          id: 'nudge_owner',
          type: 'notify',
          config: { to: 'deal.owner', message: 'No activity on {{ deal.title }} for 14 days' },
        },
        { id: 'wait_week', type: 'wait_duration', config: { duration: 'days(7)' } },
        {
          id: 'nudge_manager',
          type: 'notify',
          config: {
            to: "role('manager')",
            message: '{{ deal.title }} ({{ formatMoney(deal.amountCents) }}) is still stale',
          },
        },
      ],
      edges: [
        { from: '$trigger', to: 'nudge_owner' },
        { from: 'nudge_owner', to: 'wait_week' },
        { from: 'wait_week', to: 'nudge_manager' },
      ],
    },
  },
  {
    key: 'deal_won',
    name: 'Deal won → onboarding',
    description: 'Create onboarding tasks and a draft invoice when a deal is won.',
    definition: {
      name: 'Deal won → onboarding',
      trigger: { type: 'record_event', entity: 'deal', event: 'deal.won' },
      nodes: [
        { id: 'has_company', type: 'condition', config: { expr: 'deal.company != null' } },
        {
          id: 'kickoff',
          type: 'create_task',
          config: {
            title: 'Kickoff call: {{ deal.title }}',
            assignee: 'deal.owner',
            dueAt: 'now() + days(2)',
            relatedTo: 'deal',
          },
        },
        {
          id: 'welcome_pack',
          type: 'create_task',
          config: {
            title: 'Send welcome pack to {{ deal.company?.name }}',
            assignee: 'deal.owner',
            dueAt: 'now() + days(3)',
            relatedTo: 'deal',
          },
        },
        {
          id: 'invoice',
          type: 'create_invoice',
          config: {
            company: 'deal.company',
            contact: 'deal.contact',
            deal: 'deal',
            description: '{{ deal.title }}',
            amount: 'deal.amountCents',
            dueIn: 'days(14)',
          },
        },
        {
          id: 'note',
          type: 'add_note',
          config: { subject: 'deal', body: 'Onboarding started: 2 tasks and a draft invoice were created.' },
        },
      ],
      edges: [
        { from: '$trigger', to: 'has_company' },
        { from: 'has_company', to: 'kickoff', label: 'true' },
        { from: 'has_company', to: 'welcome_pack', label: 'true' },
        { from: 'has_company', to: 'invoice', label: 'true' },
        { from: 'kickoff', to: 'note' },
        { from: 'welcome_pack', to: 'note' },
        { from: 'invoice', to: 'note' },
      ],
    },
  },
  {
    key: 'invoice_paid_thanks',
    name: 'Invoice paid → thank you + Slack',
    description: 'Send a thank-you email and post to Slack when an invoice is paid.',
    definition: {
      name: 'Invoice paid → thank you + Slack',
      trigger: { type: 'record_event', entity: 'invoice', event: 'invoice.paid' },
      nodes: [
        { id: 'thanks', type: 'send_email', config: { template: 'invoice_thanks', to: 'invoice.contact?.email' } },
        {
          id: 'slack',
          type: 'http_request',
          config: {
            method: 'POST',
            url: "{{ secret('slack_webhook_url') }}",
            headers: { 'content-type': 'application/json' },
            body: '{"text": "Invoice {{ invoice.number }} from {{ invoice.company.name }} paid: {{ formatMoney(invoice.totalCents) }}"}',
          },
        },
      ],
      edges: [
        { from: '$trigger', to: 'thanks' },
        { from: 'thanks', to: 'slack' },
      ],
    },
  },
  {
    key: 'weekly_pipeline_digest',
    name: 'Weekly pipeline digest',
    description: 'Every Monday at 09:00 (tenant time zone) email managers a pipeline summary.',
    definition: {
      name: 'Weekly pipeline digest',
      trigger: { type: 'schedule', cron: '0 9 * * 1' },
      nodes: [
        {
          id: 'report',
          type: 'http_request',
          config: {
            method: 'GET',
            url: "{{ secret('api_base_url') }}/v1/reports/pipeline",
            headers: { authorization: "Bearer {{ secret('reports_api_token') }}" },
          },
        },
        {
          id: 'digest',
          type: 'send_email',
          config: {
            to: "role('manager')",
            subject: 'Weekly pipeline digest',
            body: "Open pipeline: {{ formatMoney(steps.report.output.body.summary.openCents, 'USD') }} in {{ steps.report.output.body.summary.openDeals }} deals. Won this week: {{ formatMoney(steps.report.output.body.summary.wonLast7DaysCents, 'USD') }}.",
          },
        },
      ],
      edges: [
        { from: '$trigger', to: 'report' },
        { from: 'report', to: 'digest' },
      ],
    },
  },
];

export function findTemplate(key: string): WorkflowTemplateDto | undefined {
  return WORKFLOW_TEMPLATES.find((t) => t.key === key);
}

export const DEFAULT_EMAIL_TEMPLATES = [
  {
    key: 'invoice_reminder',
    name: 'Invoice reminder',
    subject: 'Reminder: invoice {{ invoice.number }} is overdue',
    body: "<p>Hello {{ coalesce(invoice.contact?.firstName, 'there') }},</p><p>Invoice <b>{{ invoice.number }}</b> for {{ formatMoney(invoice.balanceCents) }} was due on {{ formatDate(invoice.dueDate, 'MMM D, YYYY') }}.</p><p>You can view and pay it here: <a href=\"{{ invoice.publicUrl }}\">{{ invoice.publicUrl }}</a></p>",
  },
  {
    key: 'invoice_final_notice',
    name: 'Invoice final notice',
    subject: 'Final notice: invoice {{ invoice.number }}',
    body: '<p>Hello {{ coalesce(invoice.contact?.firstName, \'there\') }},</p><p>This is the final notice for invoice <b>{{ invoice.number }}</b> ({{ formatMoney(invoice.balanceCents) }}). Please pay it within 7 days.</p><p><a href="{{ invoice.publicUrl }}">View invoice</a></p>',
  },
  {
    key: 'invoice_thanks',
    name: 'Payment received',
    subject: 'Thank you for your payment ({{ invoice.number }})',
    body: '<p>We received your payment for invoice <b>{{ invoice.number }}</b>. Thank you!</p>',
  },
  {
    key: 'invoice_sent',
    name: 'Invoice sent',
    subject: 'Invoice {{ invoice.number }} from {{ tenant.name }}',
    body: '<p>Hello,</p><p>Please find invoice <b>{{ invoice.number }}</b> for {{ formatMoney(invoice.totalCents) }} attached, due {{ formatDate(invoice.dueDate, \'MMM D, YYYY\') }}.</p><p><a href="{{ invoice.publicUrl }}">View online</a></p>',
  },
  {
    key: 'welcome',
    name: 'Welcome',
    subject: 'Welcome, {{ contact.firstName }}',
    body: '<p>Hi {{ contact.firstName }}, thanks for your interest!</p>',
  },
] as const;
