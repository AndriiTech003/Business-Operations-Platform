import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { JsonValue } from '@ashamrai/realtime-client';
import { AvatarStack, Tooltip } from '@bop/ui';
import { Eye, Lock } from 'lucide-react';
import { useMe } from '../../app/auth';
import { humanize } from '../../lib/format';
import { channels, useChannel, useEphemeral } from '../../lib/realtime';
import { keys, type RecordEntity } from '../../lib/query-keys';

export interface Viewer {
  id: string;
  name: string;
}

export interface SoftLock {
  uid: string;
  name: string;
  field: string;
  at: number;
}

interface PresenceValue {
  viewers: Viewer[];
  locks: Record<string, SoftLock>;
  setEditing(field: string | null): void;
}

const PresenceContext = createContext<PresenceValue>({ viewers: [], locks: {}, setEditing: () => undefined });

export function RecordPresenceProvider({
  entity,
  id,
  children,
}: {
  entity: RecordEntity;
  id: string;
  children: ReactNode;
}) {
  const me = useMe();
  const qc = useQueryClient();
  const [viewers, setViewers] = useState<Viewer[]>([]);
  const [locks, setLocks] = useState<Record<string, SoftLock>>({});
  const meta = useMemo<JsonValue>(() => ({ name: me.user.name }), [me.user.name]);
  const channel = useChannel(
    channels.record(me.tenant.id, entity, id),
    {
      onPresence: (members) => {
        setViewers(
          members
            .filter((m) => m.uid !== me.user.id)
            .map((m) => {
              const name =
                m.meta !== null &&
                typeof m.meta === 'object' &&
                !Array.isArray(m.meta) &&
                typeof m.meta['name'] === 'string'
                  ? m.meta['name']
                  : 'Someone';
              return { id: m.uid, name };
            }),
        );
      },
      onEphemeral: (d, from) => {
        if (from === me.user.id) return;
        const name = typeof d['name'] === 'string' ? d['name'] : 'Someone';
        setLocks((prev) => {
          const next: Record<string, SoftLock> = {};
          for (const [field, lock] of Object.entries(prev)) if (lock.uid !== from) next[field] = lock;
          if (typeof d['editing'] === 'string' && d['editing'] !== '')
            next[d['editing']] = { uid: from, name, field: d['editing'], at: Date.now() };
          return next;
        });
      },
      onMessage: (d) => {
        if (d['type'] !== 'record.updated') return;
        void qc.invalidateQueries({ queryKey: keys[entity].detail(id) });
        void qc.invalidateQueries({ queryKey: keys[entity].timeline(id) });
        void qc.invalidateQueries({ queryKey: keys.comments(entity, id) });
        void qc.invalidateQueries({ queryKey: keys.recordTasks(entity, id) });
      },
    },
    meta,
  );
  const send = useEphemeral(channel);
  const editingRef = useRef<string | null>(null);

  useEffect(() => {
    const t = setInterval(() => {
      if (editingRef.current !== null) send({ editing: editingRef.current, name: me.user.name });
      setLocks((prev) => {
        const now = Date.now();
        const entries = Object.entries(prev).filter(([, l]) => now - l.at < 9000);
        return entries.length === Object.keys(prev).length ? prev : Object.fromEntries(entries);
      });
    }, 4000);
    return () => clearInterval(t);
  }, [send, me.user.name]);

  useEffect(
    () => () => {
      if (editingRef.current !== null) send({ editing: null, name: me.user.name });
    },
    [send, me.user.name],
  );

  const setEditing = useCallback(
    (field: string | null) => {
      if (editingRef.current === field) return;
      editingRef.current = field;
      send({ editing: field, name: me.user.name });
    },
    [send, me.user.name],
  );

  const value = useMemo(() => ({ viewers, locks, setEditing }), [viewers, locks, setEditing]);
  return <PresenceContext.Provider value={value}>{children}</PresenceContext.Provider>;
}

export function usePresence(): PresenceValue {
  return useContext(PresenceContext);
}

export function PresenceAvatars() {
  const { viewers } = usePresence();
  if (viewers.length === 0) return null;
  const unique = [...new Map(viewers.map((v) => [v.id, v])).values()];
  return (
    <Tooltip content={`Also viewing: ${unique.map((v) => v.name).join(', ')}`}>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="presence-avatars">
        <Eye className="size-3.5" />
        <AvatarStack people={unique} size="sm" />
      </div>
    </Tooltip>
  );
}

export function LockBanner() {
  const { locks } = usePresence();
  const list = Object.values(locks);
  if (list.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2" data-testid="soft-locks">
      {list.map((l) => (
        <span
          key={`${l.uid}-${l.field}`}
          className="inline-flex items-center gap-1 rounded-full bg-warning/15 px-2 py-0.5 text-xs"
        >
          <Lock className="size-3" /> {l.name} is editing {humanize(l.field).toLowerCase()}
        </span>
      ))}
    </div>
  );
}
