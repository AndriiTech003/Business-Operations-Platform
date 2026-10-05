import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { dealCreateSchema, type DealDto, type PipelineDto } from '@bop/contracts';
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  NativeSelect,
  toast,
} from '@bop/ui';
import { api, errorMessage, isApiError } from '../../lib/api';
import { useCustomFieldsFor } from '../../lib/data';
import { fromDateInput } from '../../lib/format';
import { keys } from '../../lib/query-keys';
import { customFieldSpecs } from '../../lib/table';
import { FieldInput, MoneyInput } from '../../components/FieldInput';
import { RecordPicker, UserPicker } from '../../components/pickers';
import { useMe } from '../../app/auth';

type FormIn = z.input<typeof dealCreateSchema>;
type FormOut = z.output<typeof dealCreateSchema>;

export function CreateDealDialog({
  open,
  onOpenChange,
  pipeline,
  stageId,
  companyId,
}: {
  open: boolean;
  onOpenChange(o: boolean): void;
  pipeline: PipelineDto | undefined;
  stageId?: string;
  companyId?: string;
}) {
  const me = useMe();
  const qc = useQueryClient();
  const defs = useCustomFieldsFor('deal');
  const [serverError, setServerError] = useState<string | null>(null);
  const form = useForm<FormIn, unknown, FormOut>({
    resolver: zodResolver(dealCreateSchema),
    defaultValues: {
      title: '',
      amountCents: 0,
      currency: me.tenant.settings.currency,
      ownerId: me.user.id,
      companyId: companyId ?? null,
      stageId,
      pipelineId: pipeline?.id,
      custom: {},
    },
  });
  useEffect(() => {
    if (open) {
      form.setValue('stageId', stageId ?? pipeline?.stages[0]?.id);
      form.setValue('pipelineId', pipeline?.id);
    }
  }, [open, stageId, pipeline, form]);
  const create = useMutation({
    mutationFn: (v: FormOut) => api.post<DealDto>('/v1/deals', v),
    onSuccess: (d) => {
      toast.success(`Deal “${d.title}” created`);
      void qc.invalidateQueries({ queryKey: keys.deal.all });
      onOpenChange(false);
      form.reset();
    },
    onError: (e) => {
      if (isApiError(e))
        for (const [path, message] of Object.entries(e.fieldErrors())) form.setError(path as keyof FormIn, { message });
      setServerError(errorMessage(e));
    },
  });
  const errors = form.formState.errors;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New deal</DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={form.handleSubmit((v) => {
            setServerError(null);
            create.mutate(v);
          })}
        >
          <Field label="Title" htmlFor="deal-title" error={errors.title?.message} required>
            <Input id="deal-title" data-testid="field-title" autoFocus {...form.register('title')} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Amount" error={errors.amountCents?.message}>
              <Controller
                control={form.control}
                name="amountCents"
                render={({ field }) => (
                  <MoneyInput
                    value={field.value ?? 0}
                    onChange={(c) => field.onChange(c ?? 0)}
                    testId="field-amountCents"
                  />
                )}
              />
            </Field>
            <Field label="Currency" htmlFor="deal-currency" error={errors.currency?.message}>
              <Input
                id="deal-currency"
                data-testid="field-currency"
                maxLength={3}
                {...form.register('currency', { setValueAs: (v: string) => v.toUpperCase() })}
              />
            </Field>
            <Field label="Stage" htmlFor="deal-stage">
              <NativeSelect id="deal-stage" data-testid="field-stageId" {...form.register('stageId')}>
                {(pipeline?.stages ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Expected close" htmlFor="deal-close">
              <Input
                id="deal-close"
                type="date"
                data-testid="field-expectedCloseAt"
                {...form.register('expectedCloseAt', { setValueAs: (v: string) => (v ? fromDateInput(v) : null) })}
              />
            </Field>
            <Field label="Company">
              <Controller
                control={form.control}
                name="companyId"
                render={({ field }) => (
                  <RecordPicker
                    entity="company"
                    value={field.value}
                    onChange={(v) => field.onChange(v)}
                    testId="field-companyId"
                  />
                )}
              />
            </Field>
            <Field label="Contact">
              <Controller
                control={form.control}
                name="contactId"
                render={({ field }) => (
                  <RecordPicker
                    entity="contact"
                    value={field.value}
                    onChange={(v) => field.onChange(v)}
                    testId="field-contactId"
                  />
                )}
              />
            </Field>
            <Field label="Owner">
              <Controller
                control={form.control}
                name="ownerId"
                render={({ field }) => (
                  <UserPicker value={field.value} onChange={field.onChange} testId="field-ownerId" />
                )}
              />
            </Field>
          </div>
          {customFieldSpecs(defs).map((s) => (
            <Field key={s.key} label={s.label}>
              <Controller
                control={form.control}
                name="custom"
                render={({ field }) => (
                  <FieldInput
                    spec={s}
                    testId={`field-${s.key}`}
                    value={(field.value ?? {})[s.key.slice(7)]}
                    onChange={(v) => field.onChange({ ...(field.value ?? {}), [s.key.slice(7)]: v })}
                  />
                )}
              />
            </Field>
          ))}
          {serverError ? <p className="text-sm text-destructive">{serverError}</p> : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" data-testid="dialog-submit" loading={create.isPending}>
              Create deal
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
