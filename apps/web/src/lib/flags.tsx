import { useEffect, useState, type ReactNode } from 'react';
import { FlagsProvider, useFlag, type FlagsClientLike } from '@ashamrai/flags-react';
import { createClient } from '@ashamrai/flags-web';

export const FLAG_DEFAULTS = {
  'workflow-ai-step': true,
  'workflow-builder-v2': true,
} as const;

export type FlagKey = keyof typeof FLAG_DEFAULTS;

const silent = { warn: () => undefined, error: () => undefined };

export function AppFlagsProvider({ userId, children }: { userId: string | null; children: ReactNode }) {
  const [client, setClient] = useState<FlagsClientLike | undefined>(undefined);

  useEffect(() => {
    const clientKey = import.meta.env.VITE_FLAGS_CLIENT_KEY;
    const baseUrl = import.meta.env.VITE_FLAGS_RELAY_URL;
    if (!clientKey || !baseUrl || userId === null) return undefined;
    let created: ReturnType<typeof createClient> | null = null;
    try {
      created = createClient({
        clientKey,
        baseUrl,
        context: { kind: 'user', key: userId },
        logger: silent,
        sendEvents: false,
      });
      setClient(created);
    } catch {
      created = null;
    }
    return () => {
      setClient(undefined);
      if (created !== null) void created.close().catch(() => undefined);
    };
  }, [userId]);

  return <FlagsProvider client={client}>{children}</FlagsProvider>;
}

export function useAppFlag(key: FlagKey): boolean {
  const value = useFlag<boolean>(key, FLAG_DEFAULTS[key]);
  return typeof value === 'boolean' ? value : FLAG_DEFAULTS[key];
}
