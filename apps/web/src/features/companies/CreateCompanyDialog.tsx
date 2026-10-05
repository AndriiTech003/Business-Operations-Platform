import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { companyCreateSchema, type CompanyDto } from '@bop/contracts';
import { Button, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, Field, Input, toast } from '@bop/ui';
import { api, errorMessage, isApiError } from '../../lib/api';
import { useCustomFieldsFor } from '../../lib/data';
import { keys } from '../../lib/query-keys';
import { customFieldSpecs } from '../../lib/table';
import { FieldInput } from '../../components/FieldInput';
import { UserPicker } from '../../components/pickers';
import { useMe } from '../../app/auth';

type FormIn = z.input<typeof companyCreateSchema>;
type FormOut = z.output<typeof companyCreateSchema>;

export function CreateCompanyDialog({ open, onOpenChange }: { open: boolean; onOpenChange(o: boolean): void }) {
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const defs = useCustomFieldsFor('company');
  const [serverError, setServerError] = useState<string | null>(null);
  const form = useForm<FormIn, unknown, FormOut>({
    resolver: zodResolver(companyCreateSchema),
    defaultValues: { name: '', domain: '', industry: '', ownerId: me.user.id, custom: {} },
  });
  const create = useMutation({
    mutationFn: (v: FormOut) =>
      api.post<CompanyDto>('/v1/companies', { ...v, domain: v.domain || null, industry: v.industry || null }),
    onSuccess: (c) => {
      toast.success(`Company “${c.name}” created`);
      void qc.invalidateQueries({ queryKey: keys.company.lists() });
      onOpenChange(false);
      form.reset();
      void navigate({ to: '/companies/$id', params: { id: c.id } });
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
          <DialogTitle>New company</DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={form.handleSubmit((v) => {
            setServerError(null);
            create.mutate(v);
          })}
        >
          <Field label="Name" htmlFor="company-name" error={errors.name?.message} required>
            <Input
              id="company-name"
              data-testid="field-name"
              autoFocus
              aria-invalid={errors.name !== undefined}
              {...form.register('name')}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Domain" htmlFor="company-domain" error={errors.domain?.message}>
              <Input
                id="company-domain"
                data-testid="field-domain"
                placeholder="acme.com"
                {...form.register('domain')}
              />
            </Field>
            <Field label="Industry" htmlFor="company-industry">
              <Input id="company-industry" data-testid="field-industry" {...form.register('industry')} />
            </Field>
            <Field label="Employees" htmlFor="company-size" error={errors.size?.message}>
              <Input
                id="company-size"
                type="number"
                data-testid="field-size"
                {...form.register('size', {
                  setValueAs: (v: string) => (v === '' || v === undefined ? null : Number(v)),
                })}
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
            <Field key={s.key} label={s.label} required={defs.find((d) => `custom.${d.key}` === s.key)?.required}>
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
              Create company
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
