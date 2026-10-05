import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ROLE_SCOPES, SCOPES, type MemberDto, type Role } from '@bop/contracts';
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  NativeSelect,
  SkeletonRows,
  toast,
} from '@bop/ui';
import { Check, Copy, Minus, Trash2, UserPlus } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { useMembers } from '../../lib/data';
import { keys } from '../../lib/query-keys';
import { useAuth, useMe } from '../../app/auth';

const ASSIGNABLE = ['admin', 'manager', 'member', 'viewer'] as const;
const ROLES_ORDER: Role[] = ['owner', 'admin', 'manager', 'member', 'viewer'];

export function TeamSettings() {
  const me = useMe();
  const { can } = useAuth();
  const qc = useQueryClient();
  const { data: members, isLoading } = useMembers();
  const [inviting, setInviting] = useState(false);
  const [form, setForm] = useState({ email: '', name: '', role: 'member' as (typeof ASSIGNABLE)[number] });
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const [removing, setRemoving] = useState<MemberDto | null>(null);
  const admin = can('admin');
  const invite = useMutation({
    mutationFn: () => api.post<{ user: MemberDto; temporaryPassword: string | null }>('/v1/members', form),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: keys.members });
      toast.success(`${form.name} added`);
      setTempPassword(res?.temporaryPassword ?? null);
      setForm({ email: '', name: '', role: 'member' });
      if (!res?.temporaryPassword) setInviting(false);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const setRole = useMutation({
    mutationFn: ({ id, role }: { id: string; role: string }) => api.patch(`/v1/members/${id}`, { role }),
    onMutate: ({ id, role }) => {
      const prev = qc.getQueryData<MemberDto[]>(keys.members);
      qc.setQueryData<MemberDto[]>(keys.members, (m) =>
        m?.map((x) => (x.id === id ? { ...x, role: role as Role } : x)),
      );
      return { prev };
    },
    onError: (e, _v, ctx) => {
      qc.setQueryData(keys.members, ctx?.prev);
      toast.error(errorMessage(e));
    },
    onSuccess: () => toast.success('Role updated'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/v1/members/${id}`),
    onSuccess: () => {
      toast.success('Member removed');
      void qc.invalidateQueries({ queryKey: keys.members });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <div>
            <CardTitle>Members</CardTitle>
            <CardDescription>People in {me.tenant.name} and their roles</CardDescription>
          </div>
          <Button size="sm" disabled={!admin} onClick={() => setInviting(true)} data-testid="invite-member">
            <UserPlus /> Add member
          </Button>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <SkeletonRows rows={4} />
          ) : (
            <ul className="divide-y" data-testid="members-list">
              {members?.map((m) => (
                <li key={m.id} className="flex items-center gap-3 py-2.5">
                  <Avatar id={m.id} name={m.name} size="md" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">
                      {m.name}{' '}
                      {m.id === me.user.id ? <span className="text-xs text-muted-foreground">(you)</span> : null}
                    </p>
                    <p className="text-xs text-muted-foreground">{m.email}</p>
                  </div>
                  {m.role === 'owner' || !admin || m.id === me.user.id ? (
                    <Badge variant="secondary" className="capitalize">
                      {m.role}
                    </Badge>
                  ) : (
                    <NativeSelect
                      aria-label={`Role of ${m.name}`}
                      className="h-8 w-32"
                      value={m.role}
                      onChange={(e) => setRole.mutate({ id: m.id, role: e.target.value })}
                    >
                      {ASSIGNABLE.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </NativeSelect>
                  )}
                  {admin && m.role !== 'owner' && m.id !== me.user.id ? (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Remove ${m.name}`}
                      onClick={() => setRemoving(m)}
                    >
                      <Trash2 />
                    </Button>
                  ) : (
                    <span className="w-8" />
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      <Dialog
        open={inviting}
        onOpenChange={(o) => {
          setInviting(o);
          if (!o) setTempPassword(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add a member</DialogTitle>
          </DialogHeader>
          {tempPassword ? (
            <Alert variant="info" title="Share this temporary password once">
              <div className="mt-1 flex items-center gap-2">
                <code className="rounded bg-muted px-2 py-1 font-mono text-sm">{tempPassword}</code>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Copy password"
                  onClick={() => void navigator.clipboard?.writeText(tempPassword)}
                >
                  <Copy />
                </Button>
              </div>
            </Alert>
          ) : (
            <form
              className="grid gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                invite.mutate();
              }}
            >
              <Field label="Name" htmlFor="inv-name" required>
                <Input
                  id="inv-name"
                  data-testid="field-name"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  required
                />
              </Field>
              <Field label="Email" htmlFor="inv-email" required>
                <Input
                  id="inv-email"
                  type="email"
                  data-testid="field-email"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  required
                />
              </Field>
              <Field label="Role" htmlFor="inv-role">
                <NativeSelect
                  id="inv-role"
                  data-testid="field-role"
                  value={form.role}
                  onChange={(e) => setForm({ ...form, role: e.target.value as (typeof ASSIGNABLE)[number] })}
                >
                  {ASSIGNABLE.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <DialogFooter>
                <Button type="submit" data-testid="dialog-submit" loading={invite.isPending}>
                  Add member
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => (o ? undefined : setRemoving(null))}
        title={`Remove ${removing?.name ?? ''}?`}
        description="They lose access to this workspace immediately."
        destructive
        confirmLabel="Remove"
        onConfirm={() => removing && remove.mutate(removing.id)}
      />
    </div>
  );
}

export function RolesOverview() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Roles & permissions</CardTitle>
        <CardDescription>
          Scopes granted to each role. API tokens can be limited to a subset of the creator's scopes.
        </CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <table className="w-full text-sm" data-testid="roles-table">
          <thead>
            <tr className="border-b text-xs text-muted-foreground">
              <th className="py-2 text-left font-medium">Scope</th>
              {ROLES_ORDER.map((r) => (
                <th key={r} className="py-2 text-center font-medium capitalize">
                  {r}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {SCOPES.map((s) => (
              <tr key={s} className="border-b last:border-0">
                <td className="py-1.5 font-mono text-xs">{s}</td>
                {ROLES_ORDER.map((r) => (
                  <td key={r} className="py-1.5 text-center">
                    {ROLE_SCOPES[r].includes(s) ? (
                      <Check className="mx-auto size-4 text-success" aria-label="granted" />
                    ) : (
                      <Minus className="mx-auto size-4 text-muted-foreground/40" aria-label="not granted" />
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
