import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FUNCTIONS, T } from '@ashamrai/expr';
import type { EmailTemplateDto } from '@bop/contracts';
import { entityType } from '@bop/workflow-core';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ConfirmDialog,
  EmptyState,
  Field,
  Input,
  NativeSelect,
  Skeleton,
  cn,
  toast,
} from '@bop/ui';
import { Mail, Plus, Save, Trash2 } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { useCustomFieldMap, useEmailTemplates } from '../../lib/data';
import { useDebounced } from '../../lib/hooks';
import { ENTITY_PATH, keys, type RecordEntity } from '../../lib/query-keys';
import { ExpressionEditor } from '../../lib/expr-editor';
import { RecordPicker } from '../../components/pickers';
import { useAuth } from '../../app/auth';

interface Draft {
  key: string;
  name: string;
  subject: string;
  body: string;
  isNew: boolean;
}

const PREVIEW_ENTITIES: RecordEntity[] = ['invoice', 'deal', 'contact', 'company'];

export function EmailTemplatesSettings() {
  const { can } = useAuth();
  const admin = can('admin');
  const qc = useQueryClient();
  const custom = useCustomFieldMap();
  const { data: templates, isLoading } = useEmailTemplates();
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [previewEntity, setPreviewEntity] = useState<RecordEntity>('invoice');
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    if (draft !== null || !templates || templates.length === 0) return;
    const first = templates.find((t) => t.key === selected) ?? templates[0];
    if (first) {
      setSelected(first.key);
      setDraft({ key: first.key, name: first.name, subject: first.subject, body: first.body, isNew: false });
    }
  }, [templates, draft, selected]);

  const ctx = useMemo(
    () => ({
      vars: {
        invoice: entityType('invoice', custom),
        deal: entityType('deal', custom),
        contact: entityType('contact', custom),
        company: entityType('company', custom),
        tenant: T.object({ id: { type: T.string }, name: { type: T.string }, slug: { type: T.string } }, 'tenant'),
      },
    }),
    [custom],
  );

  const sample = useQuery({
    queryKey: ['template-sample', previewEntity],
    queryFn: async () =>
      (await api.get<{ items: Array<{ id: string }> }>(`/v1/${ENTITY_PATH[previewEntity]}`, { query: { limit: 1 } }))
        .items[0]?.id ?? null,
    staleTime: 300_000,
  });
  const effectiveId = previewId ?? sample.data ?? null;
  const debounced = useDebounced(
    JSON.stringify({ subject: draft?.subject ?? '', body: draft?.body ?? '', entity: previewEntity, id: effectiveId }),
    400,
  );
  const preview = useQuery({
    queryKey: ['email-template-preview', debounced],
    queryFn: () => {
      const p = JSON.parse(debounced) as { subject: string; body: string; entity: string; id: string | null };
      return api.post<{ subject: string; html: string }>('/v1/email-templates/preview', {
        subject: p.subject,
        body: p.body,
        ...(p.id ? { entity: p.entity, id: p.id } : {}),
      });
    },
    enabled: draft !== null && (draft.subject !== '' || draft.body !== ''),
    retry: false,
    placeholderData: (prev) => prev,
  });

  const save = useMutation({
    mutationFn: (d: Draft) =>
      api.put<EmailTemplateDto>(`/v1/email-templates/${encodeURIComponent(d.key)}`, {
        name: d.name,
        subject: d.subject,
        body: d.body,
      }),
    onSuccess: (_r, d) => {
      toast.success(`Template “${d.name}” saved`);
      setDraft({ ...d, isNew: false });
      setSelected(d.key);
      void qc.invalidateQueries({ queryKey: keys.emailTemplates });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (key: string) => api.del(`/v1/email-templates/${encodeURIComponent(key)}`),
    onSuccess: () => {
      toast.success('Template deleted');
      setDraft(null);
      setSelected(null);
      void qc.invalidateQueries({ queryKey: keys.emailTemplates });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const keyValid = draft !== null && /^[a-z][a-z0-9_]*$/.test(draft.key);

  return (
    <div className="grid gap-4 lg:grid-cols-[240px_1fr]">
      <Card className="self-start">
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>Templates</CardTitle>
          <Button
            size="icon-xs"
            variant="outline"
            aria-label="New template"
            disabled={!admin}
            onClick={() => {
              setSelected(null);
              setDraft({
                key: 'new_template',
                name: 'New template',
                subject: 'Hello {{ contact.firstName }}',
                body: '<p>Hi {{ contact.firstName }},</p>\n<p>…</p>',
                isNew: true,
              });
            }}
          >
            <Plus />
          </Button>
        </CardHeader>
        <CardContent className="p-2">
          {isLoading ? (
            <Skeleton className="h-32" />
          ) : (
            <ul className="grid gap-0.5">
              {templates?.map((t) => (
                <li key={t.key}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelected(t.key);
                      setDraft({ key: t.key, name: t.name, subject: t.subject, body: t.body, isNew: false });
                    }}
                    className={cn(
                      'grid w-full cursor-pointer rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted',
                      selected === t.key && 'bg-accent',
                    )}
                  >
                    <span className="font-medium">{t.name}</span>
                    <span className="font-mono text-[11px] text-muted-foreground">{t.key}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      {draft === null ? (
        <EmptyState icon={<Mail />} title="No template selected" />
      ) : (
        <div className="grid gap-4 2xl:grid-cols-2">
          <Card>
            <CardHeader className="flex-row items-center gap-2">
              <div className="flex-1">
                <CardTitle>{draft.isNew ? 'New template' : draft.name}</CardTitle>
                <CardDescription>
                  Use {'{{ expressions }}'} — type a variable and a dot for field suggestions.
                </CardDescription>
              </div>
              {!draft.isNew ? (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Delete template"
                  disabled={!admin}
                  onClick={() => setConfirm(true)}
                >
                  <Trash2 />
                </Button>
              ) : null}
              <Button
                size="sm"
                disabled={!admin || !keyValid || draft.name.trim() === ''}
                loading={save.isPending}
                onClick={() => save.mutate(draft)}
                data-testid="save-template"
              >
                <Save /> Save
              </Button>
            </CardHeader>
            <CardContent className="grid gap-3">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Key" htmlFor="tpl-key" error={keyValid ? null : 'lowercase letters, digits and _'}>
                  <Input
                    id="tpl-key"
                    className="font-mono"
                    disabled={!draft.isNew || !admin}
                    value={draft.key}
                    onChange={(e) => setDraft({ ...draft, key: e.target.value })}
                  />
                </Field>
                <Field label="Name" htmlFor="tpl-name">
                  <Input
                    id="tpl-name"
                    disabled={!admin}
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  />
                </Field>
              </div>
              <Field label="Subject">
                <ExpressionEditor
                  template
                  value={draft.subject}
                  onChange={(v) => setDraft({ ...draft, subject: v })}
                  context={ctx}
                  testId="expr-subject"
                  ariaLabel="Subject"
                  readOnly={!admin}
                />
              </Field>
              <Field label="Body (HTML)">
                <ExpressionEditor
                  template
                  multiline
                  value={draft.body}
                  onChange={(v) => setDraft({ ...draft, body: v })}
                  context={ctx}
                  testId="expr-body"
                  ariaLabel="Body"
                  readOnly={!admin}
                  className="[&_.cm-content]:min-h-48"
                />
              </Field>
              <details className="rounded-lg border bg-muted/30 p-3 text-xs">
                <summary className="cursor-pointer font-medium">Variables & functions</summary>
                <p className="mt-2 text-muted-foreground">
                  Records: <code>invoice</code>, <code>deal</code>, <code>contact</code>, <code>company</code>{' '}
                  (whichever the email is about), <code>tenant</code>. Related records:{' '}
                  <code>invoice.company.name</code>, <code>invoice.contact?.firstName</code>.
                </p>
                <ul className="mt-2 grid gap-0.5 font-mono">
                  {FUNCTIONS.map((f) => (
                    <li key={f.name} title={f.description}>
                      {f.signature}
                    </li>
                  ))}
                </ul>
              </details>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Live preview</CardTitle>
              <div className="mt-2 grid grid-cols-[120px_1fr] gap-2">
                <NativeSelect
                  aria-label="Preview record type"
                  className="h-9"
                  value={previewEntity}
                  onChange={(e) => {
                    setPreviewEntity(e.target.value as RecordEntity);
                    setPreviewId(null);
                  }}
                >
                  {PREVIEW_ENTITIES.map((e) => (
                    <option key={e} value={e}>
                      {e}
                    </option>
                  ))}
                </NativeSelect>
                <RecordPicker
                  entity={previewEntity}
                  value={effectiveId}
                  onChange={(id) => setPreviewId(id)}
                  placeholder="Render against a record…"
                />
              </div>
            </CardHeader>
            <CardContent>
              {preview.isError ? (
                <p className="text-sm text-destructive">{errorMessage(preview.error)}</p>
              ) : preview.data ? (
                <div className="overflow-hidden rounded-lg border" data-testid="template-preview">
                  <p className="border-b bg-muted/40 px-3 py-2 text-sm font-medium">{preview.data.subject}</p>
                  <iframe
                    title="Template preview"
                    sandbox=""
                    srcDoc={preview.data.html}
                    className="h-96 w-full bg-white"
                  />
                </div>
              ) : (
                <Skeleton className="h-96" />
              )}
            </CardContent>
          </Card>
        </div>
      )}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Delete template ${draft?.key ?? ''}?`}
        description="Workflows that send this template will fail validation."
        destructive
        confirmLabel="Delete"
        onConfirm={() => draft && remove.mutate(draft.key)}
      />
    </div>
  );
}
