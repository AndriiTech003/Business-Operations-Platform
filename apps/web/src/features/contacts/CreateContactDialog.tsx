import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { CONTACT_STATUSES, contactCreateSchema, type ContactDto } from '@bop/contracts';
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
import { keys } from '../../lib/query-keys';
import { customFieldSpecs } from '../../lib/table';
import { FieldInput } from '../../components/FieldInput';
import { RecordPicker, UserPicker } from '../../components/pickers';
import { useMe } from '../../app/auth';

type FormIn = z.input<typeof contactCreateSchema>;
type FormOut = z.output<typeof contactCreateSchema>;

export function CreateContactDialog({
  open,
  onOpenChange,
  companyId,
}: {
  open: boolean;
  onOpenChange(o: boolean): void;
  companyId?: string;
}) {
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const defs = useCustomFieldsFor('contact');
  const [serverError, setServerError] = useState<string | null>(null);
  const form = useForm<FormIn, unknown, FormOut>({
    resolver: zodResolver(contactCreateSchema),
    defaultValues: {
      firstName: '',
      lastName: '',
      email: '',
      phone: '',
      title: '',
      status: 'lead',
      ownerId: me.user.id,
      companyId: companyId ?? null,
      custom: {},
    },
  });
  const create = useMutation({
    mutationFn: (v: FormOut) =>
      api.post<ContactDto>('/v1/contacts', {
        ...v,
        email: v.email || null,
        phone: v.phone || null,
        title: v.title || null,
      }),
    onSuccess: (c) => {
      toast.success(`Contact “${c.name}” created`);
      void qc.invalidateQueries({ queryKey: keys.contact.lists() });
      onOpenChange(false);
      form.reset();
      void navigate({ to: '/contacts/$id', params: { id: c.id } });
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
          <DialogTitle>New contact</DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={form.handleSubmit((v) => {
            setServerError(null);
            create.mutate(v);
          })}
        >
          <div className="grid grid-cols-2 gap-3">
            <Field label="First name" htmlFor="contact-first" error={errors.firstName?.message} required>
              <Input id="contact-first" data-testid="field-firstName" autoFocus {...form.register('firstName')} />
            </Field>
            <Field label="Last name" htmlFor="contact-last">
              <Input id="contact-last" data-testid="field-lastName" {...form.register('lastName')} />
            </Field>
            <Field label="Email" htmlFor="contact-email" error={errors.email?.message}>
              <Input
                id="contact-email"
                type="email"
                data-testid="field-email"
                {...form.register('email', { setValueAs: (v: string) => (v === '' ? null : v) })}
              />
            </Field>
            <Field label="Phone" htmlFor="contact-phone">
              <Input id="contact-phone" data-testid="field-phone" {...form.register('phone')} />
            </Field>
            <Field label="Job title" htmlFor="contact-title">
              <Input id="contact-title" data-testid="field-title" {...form.register('title')} />
            </Field>
            <Field label="Status" htmlFor="contact-status">
              <NativeSelect id="contact-status" data-testid="field-status" {...form.register('status')}>
                {CONTACT_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </NativeSelect>
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
              Create contact
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
