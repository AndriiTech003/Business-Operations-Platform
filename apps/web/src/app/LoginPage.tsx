import { useEffect, useState } from 'react';
import { getRouteApi, useRouter } from '@tanstack/react-router';
import { Alert, Button, Card, Field, Input, Spinner } from '@bop/ui';
import { LogIn, TriangleAlert, Workflow } from 'lucide-react';
import { errorMessage, login } from '../lib/api';
import { useAuth } from './auth';

const route = getRouteApi('/login');

const DEMO_USERS = [
  { email: 'demo@demo.dev', role: 'Owner' },
  { email: 'manager@demo.dev', role: 'Manager' },
  { email: 'anna@demo.dev', role: 'Member' },
  { email: 'viewer@demo.dev', role: 'Viewer' },
];

function safeRedirect(target: string | undefined): string {
  if (target === undefined || !target.startsWith('/') || target.startsWith('//') || target.startsWith('/login'))
    return '/deals';
  return target;
}

export function LoginPage() {
  const { status } = useAuth();
  const search = route.useSearch();
  const router = useRouter();
  const [email, setEmail] = useState('demo@demo.dev');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const target = safeRedirect(search.redirect);
  useEffect(() => {
    if (status === 'authenticated') router.history.replace(target);
  }, [status, router, target]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      await login(email.trim(), password);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center bg-gradient-to-br from-primary/5 via-background to-info/10 p-6">
      <div className="grid w-full max-w-sm gap-6">
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-md">
            <Workflow className="size-6" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight">Ops Platform</h1>
          <p className="text-sm text-muted-foreground">CRM, deals, invoices and durable workflows</p>
        </div>
        <Card className="p-5">
          {status === 'loading' ? (
            <div className="flex justify-center py-6">
              <Spinner />
            </div>
          ) : (
            <form className="grid gap-4" onSubmit={(e) => void submit(e)} aria-label="Sign in">
              <Field label="Email" htmlFor="login-email">
                <Input
                  id="login-email"
                  data-testid="login-email"
                  type="email"
                  autoComplete="username"
                  autoFocus
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </Field>
              <Field label="Password" htmlFor="login-password">
                <Input
                  id="login-password"
                  data-testid="login-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </Field>
              {error ? (
                <Alert variant="destructive" icon={<TriangleAlert />} title="Sign in failed">
                  {error}
                </Alert>
              ) : null}
              <Button type="submit" data-testid="login-submit" loading={pending}>
                <LogIn /> Sign in
              </Button>
            </form>
          )}
        </Card>
        <div className="grid gap-2 rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
          <p>
            Demo accounts (password <code className="rounded bg-muted px-1">demo1234</code>):
          </p>
          <div className="flex flex-wrap gap-1.5">
            {DEMO_USERS.map((u) => (
              <button
                key={u.email}
                type="button"
                className="cursor-pointer rounded-full border bg-card px-2 py-0.5 hover:bg-accent"
                onClick={() => {
                  setEmail(u.email);
                  setPassword('demo1234');
                }}
              >
                {u.role}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
