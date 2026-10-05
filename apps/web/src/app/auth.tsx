import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { MeDto, Scope } from '@bop/contracts';
import { onSessionChange, refreshSession } from '../lib/api';

type Status = 'loading' | 'authenticated' | 'anonymous';

interface AuthValue {
  status: Status;
  me: MeDto | null;
  can(scope: Scope): boolean;
}

const AuthContext = createContext<AuthValue>({ status: 'loading', me: null, can: () => false });

export function AuthProvider({ children, initial }: { children: ReactNode; initial?: MeDto | null }) {
  const [me, setMe] = useState<MeDto | null>(initial ?? null);
  const [status, setStatus] = useState<Status>(initial ? 'authenticated' : 'loading');

  useEffect(() => {
    const off = onSessionChange((next) => {
      setMe(next);
      setStatus(next === null ? 'anonymous' : 'authenticated');
    });
    if (initial === undefined) {
      void refreshSession().then((ok) => {
        if (!ok) setStatus((s) => (s === 'loading' ? 'anonymous' : s));
      });
    }
    return off;
  }, [initial]);

  const value = useMemo<AuthValue>(
    () => ({ status, me, can: (scope) => me?.scopes.includes(scope) ?? false }),
    [status, me],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  return useContext(AuthContext);
}

export function useMe(): MeDto {
  const { me } = useContext(AuthContext);
  if (me === null) throw new Error('useMe() outside an authenticated area');
  return me;
}
