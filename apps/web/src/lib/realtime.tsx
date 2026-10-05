import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  RealtimeClient,
  type Channel,
  type ChannelMessage,
  type JsonValue,
  type PresenceMember,
} from '@ashamrai/realtime-client';
import { api, isApiError } from './api';

export type RealtimeStatus = 'idle' | 'connecting' | 'open' | 'unavailable' | 'closed';

interface Registry {
  acquire(name: string): Channel | null;
  release(name: string): void;
}

interface RealtimeValue {
  status: RealtimeStatus;
  client: RealtimeClient | null;
  registry: Registry;
}

const noopRegistry: Registry = { acquire: () => null, release: () => undefined };
const RealtimeContext = createContext<RealtimeValue>({ status: 'idle', client: null, registry: noopRegistry });

interface TicketResponse {
  ticket: string;
  url: string;
}

export function RealtimeProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const [client, setClient] = useState<RealtimeClient | null>(null);
  const [status, setStatus] = useState<RealtimeStatus>('idle');
  const counts = useRef(new Map<string, number>());

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    let created: RealtimeClient | null = null;
    const countMap = counts.current;
    setStatus('connecting');
    void (async () => {
      let first: TicketResponse;
      try {
        first = await api.post<TicketResponse>('/v1/realtime/ticket', {});
      } catch (e) {
        if (!cancelled) setStatus(isApiError(e) && e.status === 503 ? 'unavailable' : 'unavailable');
        return;
      }
      if (cancelled || typeof first.url !== 'string' || typeof first.ticket !== 'string') {
        if (!cancelled) setStatus('unavailable');
        return;
      }
      let spare: string | null = first.ticket;
      created = new RealtimeClient({
        url: first.url,
        codec: 'json',
        getTicket: async () => {
          if (spare !== null) {
            const t = spare;
            spare = null;
            return t;
          }
          const next = await api.post<TicketResponse>('/v1/realtime/ticket', {});
          return next.ticket;
        },
      });
      created.on('state', ({ state }) => {
        if (cancelled) return;
        setStatus(state === 'open' ? 'open' : state === 'closed' ? 'closed' : 'connecting');
      });
      setClient(created);
    })();
    return () => {
      cancelled = true;
      created?.close();
      countMap.clear();
      setClient(null);
      setStatus('idle');
    };
  }, [enabled]);

  const registry = useMemo<Registry>(
    () =>
      client === null
        ? noopRegistry
        : {
            acquire(name) {
              counts.current.set(name, (counts.current.get(name) ?? 0) + 1);
              return client.subscribe(name, { presence: true });
            },
            release(name) {
              const n = (counts.current.get(name) ?? 1) - 1;
              if (n <= 0) {
                counts.current.delete(name);
                client.channel(name)?.unsubscribe();
              } else counts.current.set(name, n);
            },
          },
    [client],
  );

  const value = useMemo(() => ({ status, client, registry }), [status, client, registry]);
  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtimeStatus(): RealtimeStatus {
  return useContext(RealtimeContext).status;
}

export function useLive(): boolean {
  return useContext(RealtimeContext).status === 'open';
}

export function usePollInterval(ms: number): number | false {
  return useLive() ? false : ms;
}

export interface ChannelHandlers {
  onMessage?(data: Record<string, unknown>, raw: ChannelMessage): void;
  onPresence?(members: PresenceMember[]): void;
  onEphemeral?(data: Record<string, unknown>, from: string): void;
}

function asRecord(d: JsonValue): Record<string, unknown> {
  return d !== null && typeof d === 'object' && !Array.isArray(d) ? (d as Record<string, unknown>) : { value: d };
}

export function useChannel(name: string | null, handlers: ChannelHandlers, presenceMeta?: JsonValue): Channel | null {
  const { registry, status } = useContext(RealtimeContext);
  const ref = useRef(handlers);
  const metaRef = useRef(presenceMeta);
  const [channel, setChannel] = useState<Channel | null>(null);

  useEffect(() => {
    ref.current = handlers;
    metaRef.current = presenceMeta;
  });

  useEffect(() => {
    if (name === null) return undefined;
    const ch = registry.acquire(name);
    if (ch === null) return undefined;
    setChannel(ch);
    const offs = [
      ch.on('message', (m) => ref.current.onMessage?.(asRecord(m.d), m)),
      ch.on('presence', (members) => ref.current.onPresence?.(members)),
      ch.on('ephemeral', (e) => ref.current.onEphemeral?.(asRecord(e.d), e.from)),
      ch.on('subscribed', () => {
        ref.current.onPresence?.(ch.memberList());
        if (metaRef.current !== undefined) void ch.setPresence(metaRef.current).catch(() => undefined);
      }),
    ];
    if (ch.state === 'subscribed') {
      ref.current.onPresence?.(ch.memberList());
      if (metaRef.current !== undefined) void ch.setPresence(metaRef.current).catch(() => undefined);
    }
    return () => {
      for (const off of offs) off();
      registry.release(name);
      setChannel(null);
    };
  }, [name, registry]);

  useEffect(() => {
    if (channel !== null && status === 'open' && presenceMeta !== undefined && channel.state === 'subscribed') {
      void channel.setPresence(presenceMeta).catch(() => undefined);
    }
  }, [channel, status, presenceMeta]);

  return channel;
}

export function useEphemeral(channel: Channel | null): (data: Record<string, JsonValue>) => void {
  return useCallback(
    (data) => {
      if (channel !== null && channel.state === 'subscribed') channel.sendEphemeral(data);
    },
    [channel],
  );
}

export const channels = {
  deals: (tenantId: string) => `room:t.${tenantId}.deals`,
  record: (tenantId: string, entity: string, id: string) => `room:t.${tenantId}.rec.${entity}.${id}`,
  approvals: (tenantId: string) => `room:t.${tenantId}.approvals`,
  run: (tenantId: string, runId: string) => `room:t.${tenantId}.run.${runId}`,
  user: (userId: string) => `user:${userId}`,
};
