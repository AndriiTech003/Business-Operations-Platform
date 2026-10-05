import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SCOPES, type ApiTokenDto, type SecretDto } from '@bop/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Field,
  Input,
  NativeSelect,
  SkeletonRows,
  Textarea,
  toast,
} from '@bop/ui';
import { Copy, KeyRound, Lock, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { api, asList, errorMessage } from '../../lib/api';
import { fmtDate, fromDateInput, relative } from '../../lib/format';
import { keys } from '../../lib/query-keys';
import { useAuth, useMe } from '../../app/auth';

function OnceValue({ value, label }: { value: string; label: string }) {
  return (
    <Alert variant="warning" icon={<Lock />} title={`Copy the ${label} now — it will not be shown again`}>
      <div className="mt-2 flex items-center gap-2">
        <code className="flex-1 break-all rounded bg-card px-2 py-1 font-mono text-xs" data-testid="once-value">
          {value}
        </code>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            void navigator.clipboard?.writeText(value).then(
              () => toast.success('Copied'),
              () => toast.error('Copy failed'),
            )
          }
          data-testid="copy-once-value"
        >
          <Copy /> Copy
        </Button>
      </div>
    </Alert>
  );
}

export function ApiTokensSettings() {
  const me = useMe();
  const { can } = useAuth();
  const qc = useQueryClient();
  const tokens = useQuery({
    queryKey: keys.apiTokens,
    queryFn: async () => asList<ApiTokenDto>(await api.get('/v1/api-tokens')),
    enabled: can('admin'),
  });
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(['records:read']);
  const [actorType, setActorType] = useState<'user' | 'agent'>('user');
  const [expires, setExpires] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<ApiTokenDto | null>(null);
  const create = useMutation({
    mutationFn: () =>
      api.post<{ token: string; info: ApiTokenDto }>('/v1/api-tokens', {
        name,
        scopes,
        actorType,
        expiresAt: expires ? fromDateInput(expires) : null,
      }),
    onSuccess: (res) => {
      setCreated(res.token);
      void qc.invalidateQueries({ queryKey: keys.apiTokens });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.del(`/v1/api-tokens/${id}`),
    onSuccess: () => {
      toast.success('Token revoked');
      void qc.invalidateQueries({ queryKey: keys.apiTokens });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const close = () => {
    setOpen(false);
    setCreated(null);
    setName('');
    setScopes(['records:read']);
  };
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <div>
          <CardTitle>API tokens</CardTitle>
          <CardDescription>
            Personal tokens for the REST API, the MCP server and the AI agent. Scopes cannot exceed your role ({me.role}
            ).
          </CardDescription>
        </div>
        <Button size="sm" onClick={() => setOpen(true)} data-testid="create-token">
          <Plus /> New token
        </Button>
      </CardHeader>
      <CardContent>
        {!can('admin') ? (
          <p className="text-sm text-muted-foreground">Only admins can list tokens.</p>
        ) : tokens.isLoading ? (
          <SkeletonRows rows={3} />
        ) : (tokens.data?.length ?? 0) === 0 ? (
          <EmptyState icon={<KeyRound />} title="No tokens" />
        ) : (
          <ul className="divide-y" data-testid="tokens-list">
            {tokens.data?.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-3 py-2.5">
                <KeyRound className="size-4 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {t.name} <span className="font-mono text-xs text-muted-foreground">{t.prefix}…</span>
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {t.scopes.map((s) => (
                      <Badge key={s} variant="muted" className="font-mono">
                        {s}
                      </Badge>
                    ))}
                  </div>
                </div>
                <Badge variant={t.actorType === 'agent' ? 'info' : 'secondary'}>{t.actorType}</Badge>
                <span className="text-xs text-muted-foreground">
                  {t.lastUsedAt ? `used ${relative(t.lastUsedAt)}` : 'never used'}
                  {t.expiresAt ? ` · expires ${fmtDate(t.expiresAt)}` : ''}
                </span>
                {t.revokedAt ? (
                  <Badge variant="destructive">revoked</Badge>
                ) : (
                  <Button size="xs" variant="outline" onClick={() => setRevoking(t)}>
                    Revoke
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <Dialog open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New API token</DialogTitle>
            <DialogDescription>The value is shown once after creation.</DialogDescription>
          </DialogHeader>
          {created ? (
            <>
              <OnceValue value={created} label="token" />
              <DialogFooter>
                <Button onClick={close}>Done</Button>
              </DialogFooter>
            </>
          ) : (
            <form
              className="grid gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                create.mutate();
              }}
            >
              <Field label="Name" htmlFor="tok-name" required>
                <Input
                  id="tok-name"
                  data-testid="field-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Claude Desktop"
                  required
                />
              </Field>
              <Field label="Scopes">
                <div className="grid grid-cols-2 gap-1.5">
                  {SCOPES.map((s) => (
                    <label
                      key={s}
                      className={`flex items-center gap-2 text-xs ${me.scopes.includes(s) ? '' : 'opacity-40'}`}
                    >
                      <Checkbox
                        disabled={!me.scopes.includes(s)}
                        checked={scopes.includes(s)}
                        onCheckedChange={(v) => setScopes(v === true ? [...scopes, s] : scopes.filter((x) => x !== s))}
                      />
                      <span className="font-mono">{s}</span>
                    </label>
                  ))}
                </div>
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field
                  label="Acts as"
                  htmlFor="tok-actor"
                  hint="Agent tokens mark their changes as made by the AI agent"
                >
                  <NativeSelect
                    id="tok-actor"
                    value={actorType}
                    onChange={(e) => setActorType(e.target.value as 'user' | 'agent')}
                  >
                    <option value="user">user</option>
                    <option value="agent">agent</option>
                  </NativeSelect>
                </Field>
                <Field label="Expires" htmlFor="tok-exp">
                  <Input id="tok-exp" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
                </Field>
              </div>
              <DialogFooter>
                <Button
                  type="submit"
                  data-testid="dialog-submit"
                  disabled={name.trim() === '' || scopes.length === 0}
                  loading={create.isPending}
                >
                  Create token
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(o) => (o ? undefined : setRevoking(null))}
        title={`Revoke “${revoking?.name ?? ''}”?`}
        description="Clients using this token stop working immediately."
        destructive
        confirmLabel="Revoke"
        onConfirm={() => revoking && revoke.mutate(revoking.id)}
      />
    </Card>
  );
}

export function SecretsSettings() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const admin = can('admin');
  const secrets = useQuery({
    queryKey: keys.secrets,
    queryFn: async () => asList<SecretDto>(await api.get('/v1/secrets')),
    enabled: admin,
  });
  const [open, setOpen] = useState<{ name: string; replacing: boolean } | null>(null);
  const [value, setValue] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);
  const nameValid = open !== null && /^[a-zA-Z][a-zA-Z0-9_]*$/.test(open.name);
  const upsert = useMutation({
    mutationFn: () => api.put(`/v1/secrets/${encodeURIComponent(open?.name ?? '')}`, { value }),
    onSuccess: () => {
      toast.success(`Secret ${open?.name} saved`);
      setValue('');
      setOpen(null);
      void qc.invalidateQueries({ queryKey: keys.secrets });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (name: string) => api.del(`/v1/secrets/${encodeURIComponent(name)}`),
    onSuccess: () => {
      toast.success('Secret deleted');
      void qc.invalidateQueries({ queryKey: keys.secrets });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <div>
          <CardTitle>Secrets</CardTitle>
          <CardDescription>
            Encrypted values for HTTP request nodes, referenced as <code className="font-mono">secret('NAME')</code>.
            Values are write-only and never sent back to the browser.
          </CardDescription>
        </div>
        <Button
          size="sm"
          disabled={!admin}
          onClick={() => setOpen({ name: '', replacing: false })}
          data-testid="create-secret"
        >
          <Plus /> New secret
        </Button>
      </CardHeader>
      <CardContent>
        {!admin ? (
          <p className="text-sm text-muted-foreground">Only admins can manage secrets.</p>
        ) : secrets.isLoading ? (
          <SkeletonRows rows={2} />
        ) : (secrets.data?.length ?? 0) === 0 ? (
          <EmptyState
            icon={<ShieldCheck />}
            title="No secrets"
            description="Add e.g. SLACK_WEBHOOK_URL for the “Invoice paid → Slack” template."
          />
        ) : (
          <ul className="divide-y" data-testid="secrets-list">
            {secrets.data?.map((s) => (
              <li key={s.id} className="flex items-center gap-3 py-2.5">
                <Lock className="size-4 text-muted-foreground" />
                <span className="flex-1 font-mono text-sm">{s.name}</span>
                <span className="font-mono text-xs tracking-widest text-muted-foreground">••••••••</span>
                <span className="text-xs text-muted-foreground">updated {relative(s.updatedAt)}</span>
                <Button size="xs" variant="outline" onClick={() => setOpen({ name: s.name, replacing: true })}>
                  Replace
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Delete ${s.name}`}
                  onClick={() => setDeleting(s.name)}
                >
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <Dialog open={open !== null} onOpenChange={(o) => (o ? undefined : setOpen(null))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{open?.replacing ? `Replace ${open.name}` : 'New secret'}</DialogTitle>
            <DialogDescription>The value is encrypted at rest and cannot be viewed again.</DialogDescription>
          </DialogHeader>
          {open ? (
            <form
              className="grid gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                upsert.mutate();
              }}
            >
              <Field
                label="Name"
                htmlFor="sec-name"
                error={open.name === '' || nameValid ? null : 'Letters, digits and _; start with a letter'}
              >
                <Input
                  id="sec-name"
                  data-testid="field-name"
                  className="font-mono"
                  disabled={open.replacing}
                  value={open.name}
                  onChange={(e) => setOpen({ ...open, name: e.target.value })}
                />
              </Field>
              <Field label="Value" htmlFor="sec-value">
                <Textarea
                  id="sec-value"
                  data-testid="field-value"
                  className="font-mono text-xs"
                  autoComplete="off"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                />
              </Field>
              <DialogFooter>
                <Button
                  type="submit"
                  data-testid="dialog-submit"
                  disabled={!nameValid || value === ''}
                  loading={upsert.isPending}
                >
                  Save secret
                </Button>
              </DialogFooter>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => (o ? undefined : setDeleting(null))}
        title={`Delete secret ${deleting ?? ''}?`}
        description="Workflows using it will fail."
        destructive
        confirmLabel="Delete"
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </Card>
  );
}
