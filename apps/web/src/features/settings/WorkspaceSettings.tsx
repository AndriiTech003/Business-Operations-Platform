import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { TenantSettings } from '@bop/contracts';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input, toast } from '@bop/ui';
import { Save } from 'lucide-react';
import { api, errorMessage, refreshSession } from '../../lib/api';
import { useAuth, useMe } from '../../app/auth';

const TIMEZONES =
  typeof Intl.supportedValuesOf === 'function'
    ? Intl.supportedValuesOf('timeZone')
    : ['UTC', 'Europe/Berlin', 'Europe/London', 'America/New_York'];

export function WorkspaceSettings() {
  const me = useMe();
  const { can } = useAuth();
  const admin = can('admin');
  const [s, setS] = useState<TenantSettings>(me.tenant.settings);
  const save = useMutation({
    mutationFn: () =>
      api.patch<TenantSettings>('/v1/settings', {
        timezone: s.timezone,
        currency: s.currency,
        invoicePrefix: s.invoicePrefix,
        emailsPerMinute: s.emailsPerMinute,
        maxConcurrentSteps: s.maxConcurrentSteps,
      }),
    onSuccess: async () => {
      await refreshSession();
      toast.success('Workspace settings saved');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle>Workspace</CardTitle>
        <CardDescription>
          {me.tenant.name} · <span className="font-mono">{me.tenant.slug}</span>
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <div className="grid grid-cols-2 gap-3">
            <Field label="Time zone" htmlFor="ws-tz" hint="Used for schedules and reports">
              <Input
                id="ws-tz"
                list="ws-tz-list"
                data-testid="field-timezone"
                disabled={!admin}
                value={s.timezone}
                onChange={(e) => setS({ ...s, timezone: e.target.value })}
              />
              <datalist id="ws-tz-list">
                {TIMEZONES.map((tz) => (
                  <option key={tz} value={tz} />
                ))}
              </datalist>
            </Field>
            <Field label="Default currency" htmlFor="ws-cur">
              <Input
                id="ws-cur"
                data-testid="field-currency"
                maxLength={3}
                disabled={!admin}
                value={s.currency}
                onChange={(e) => setS({ ...s, currency: e.target.value.toUpperCase() })}
              />
            </Field>
            <Field
              label="Invoice number prefix"
              htmlFor="ws-prefix"
              hint={`Next invoices look like ${s.invoicePrefix}-${new Date().getFullYear()}-0042`}
            >
              <Input
                id="ws-prefix"
                data-testid="field-invoicePrefix"
                disabled={!admin}
                value={s.invoicePrefix}
                onChange={(e) => setS({ ...s, invoicePrefix: e.target.value })}
              />
            </Field>
            <Field label="Emails per minute" htmlFor="ws-epm" hint="Rate limit for outgoing workflow emails">
              <Input
                id="ws-epm"
                type="number"
                disabled={!admin}
                value={s.emailsPerMinute}
                onChange={(e) => setS({ ...s, emailsPerMinute: Number(e.target.value) })}
              />
            </Field>
            <Field label="Concurrent workflow steps" htmlFor="ws-steps" hint="Per-tenant semaphore in the engine">
              <Input
                id="ws-steps"
                type="number"
                disabled={!admin}
                value={s.maxConcurrentSteps}
                onChange={(e) => setS({ ...s, maxConcurrentSteps: Number(e.target.value) })}
              />
            </Field>
          </div>
          <div>
            <Button type="submit" disabled={!admin} loading={save.isPending} data-testid="save-workspace">
              <Save /> Save
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
