import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CommentDto, MemberDto } from '@bop/contracts';
import { Avatar, Button, EmptyState, SkeletonRows, Textarea, cn, toast } from '@bop/ui';
import { AtSign, MessageSquare } from 'lucide-react';
import { useMe } from '../../app/auth';
import { api, asList, errorMessage } from '../../lib/api';
import { useMembers } from '../../lib/data';
import { relative } from '../../lib/format';
import { keys, type RecordEntity } from '../../lib/query-keys';

const MENTION_RE = /@\[([^\]]{1,100})\]\(([0-9a-zA-Z-]{1,64})\)/g;

export function renderWithMentions(body: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of body.matchAll(MENTION_RE)) {
    const start = m.index ?? 0;
    if (start > last) out.push(body.slice(last, start));
    out.push(
      <span
        key={`${start}-${m[2]}`}
        data-testid="mention-chip"
        data-user-id={m[2]}
        className="inline-flex items-center gap-0.5 rounded bg-primary/10 px-1 font-medium text-primary"
      >
        @{m[1]}
      </span>,
    );
    last = start + m[0].length;
  }
  if (last < body.length) out.push(body.slice(last));
  return out;
}

export function mentionQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = /(^|\s)@([\p{L}\p{N}_.-]{0,30})$/u.exec(before);
  if (m === null) return null;
  return { start: caret - (m[2]?.length ?? 0) - 1, query: m[2] ?? '' };
}

export function MentionTextarea({
  value,
  onChange,
  onSubmit,
  placeholder,
  testId,
}: {
  value: string;
  onChange(value: string): void;
  onSubmit?(): void;
  placeholder?: string;
  testId?: string;
}) {
  const { data: members } = useMembers();
  const ref = useRef<HTMLTextAreaElement>(null);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [active, setActive] = useState(0);
  const matches = useMemo(() => {
    if (mention === null) return [];
    const q = mention.query.toLowerCase();
    return (members ?? [])
      .filter((m) => m.name.toLowerCase().includes(q) || m.email.toLowerCase().startsWith(q))
      .slice(0, 6);
  }, [mention, members]);

  const refresh = (text: string, caret: number) => {
    setMention(mentionQueryAt(text, caret));
    setActive(0);
  };

  const pick = (m: MemberDto) => {
    if (mention === null) return;
    const caret = ref.current?.selectionStart ?? value.length;
    const token = `@[${m.name}](${m.id}) `;
    const next = value.slice(0, mention.start) + token + value.slice(caret);
    onChange(next);
    setMention(null);
    const pos = mention.start + token.length;
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(pos, pos);
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention !== null && matches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((a) => (a + 1) % matches.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((a) => (a - 1 + matches.length) % matches.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const m = matches[active];
        if (m !== undefined) pick(m);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMention(null);
        return;
      }
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onSubmit?.();
    }
  };

  return (
    <div className="relative">
      <Textarea
        ref={ref}
        value={value}
        data-testid={testId}
        placeholder={placeholder}
        aria-autocomplete="list"
        aria-expanded={mention !== null && matches.length > 0}
        onChange={(e) => {
          onChange(e.target.value);
          refresh(e.target.value, e.target.selectionStart);
        }}
        onKeyDown={onKeyDown}
        onClick={(e) => refresh(value, e.currentTarget.selectionStart)}
        onBlur={() => setTimeout(() => setMention(null), 150)}
      />
      {mention !== null && matches.length > 0 ? (
        <ul
          role="listbox"
          aria-label="Mention a teammate"
          className="absolute left-2 top-full z-30 mt-1 w-64 overflow-hidden rounded-lg border bg-popover p-1 shadow-lg"
          data-testid="mention-picker"
        >
          {matches.map((m, i) => (
            <li key={m.id} role="option" aria-selected={i === active}>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(m);
                }}
                className={cn(
                  'flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
                  i === active && 'bg-accent',
                )}
              >
                <Avatar id={m.id} name={m.name} size="xs" />
                <span className="flex-1 truncate">{m.name}</span>
                <span className="text-xs capitalize text-muted-foreground">{m.role}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function Comments({ entity, id }: { entity: RecordEntity; id: string }) {
  const me = useMe();
  const qc = useQueryClient();
  const [body, setBody] = useState('');
  const query = useQuery({
    queryKey: keys.comments(entity, id),
    queryFn: async () =>
      asList<CommentDto>(await api.get('/v1/comments', { query: { subjectType: entity, subjectId: id } })),
  });
  const add = useMutation({
    mutationFn: (text: string) =>
      api.post<CommentDto>('/v1/comments', { subjectType: entity, subjectId: id, body: text }),
    onMutate: async (text) => {
      await qc.cancelQueries({ queryKey: keys.comments(entity, id) });
      const previous = qc.getQueryData<CommentDto[]>(keys.comments(entity, id));
      const optimistic: CommentDto = {
        id: `tmp-${Date.now()}`,
        subjectType: entity,
        subjectId: id,
        authorId: me.user.id,
        author: me.user,
        body: text,
        mentions: [],
        createdAt: new Date().toISOString(),
      };
      qc.setQueryData<CommentDto[]>(keys.comments(entity, id), [...(previous ?? []), optimistic]);
      setBody('');
      return { previous, text };
    },
    onError: (e, _t, ctx) => {
      qc.setQueryData(keys.comments(entity, id), ctx?.previous);
      if (ctx !== undefined) setBody(ctx.text);
      toast.error(errorMessage(e));
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.comments(entity, id) }),
  });
  const submit = () => {
    if (body.trim() !== '') add.mutate(body.trim());
  };
  return (
    <div className="grid gap-4">
      {query.isLoading ? (
        <SkeletonRows rows={3} />
      ) : (query.data?.length ?? 0) === 0 ? (
        <EmptyState
          icon={<MessageSquare />}
          title="No comments yet"
          description="Start the discussion. Type @ to mention a teammate."
        />
      ) : (
        <ul className="grid gap-3" data-testid="comments">
          {query.data?.map((c) => (
            <li key={c.id} className={cn('flex gap-3', c.id.startsWith('tmp-') && 'opacity-60')} data-testid="comment">
              <Avatar id={c.authorId} name={c.author?.name ?? 'User'} size="md" />
              <div className="min-w-0 flex-1 rounded-lg border bg-card px-3 py-2">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-medium">{c.author?.name ?? 'User'}</span>
                  <span className="text-muted-foreground">{relative(c.createdAt)}</span>
                </div>
                <p className="mt-1 whitespace-pre-wrap text-sm">{renderWithMentions(c.body)}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
      <form
        className="grid gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <MentionTextarea
          value={body}
          onChange={setBody}
          onSubmit={submit}
          placeholder="Write a comment… (@ to mention, ⌘↵ to send)"
          testId="comment-body"
        />
        <div className="flex items-center justify-between">
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <AtSign className="size-3" /> Mentioned teammates get a notification
          </span>
          <Button type="submit" size="sm" disabled={body.trim() === ''} data-testid="comment-submit">
            Comment
          </Button>
        </div>
      </form>
    </div>
  );
}
