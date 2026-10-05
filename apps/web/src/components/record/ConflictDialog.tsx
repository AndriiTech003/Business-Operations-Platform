import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@bop/ui';
import { GitMerge } from 'lucide-react';
import { humanize } from '../../lib/format';
import { getPath } from '../../lib/table';

function flatten(patch: Record<string, unknown>): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [];
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'custom' && v !== null && typeof v === 'object' && !Array.isArray(v)) {
      for (const [ck, cv] of Object.entries(v as Record<string, unknown>)) out.push([`custom.${ck}`, cv]);
    } else out.push([k, v]);
  }
  return out;
}

function show(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function ConflictDialog({
  open,
  mine,
  current,
  onOverwrite,
  onTakeTheirs,
  onClose,
}: {
  open: boolean;
  mine: Record<string, unknown>;
  current: unknown;
  onOverwrite(): void;
  onTakeTheirs(): void;
  onClose(): void;
}) {
  const rows = flatten(mine);
  const actor = (current as { updatedAt?: string } | null)?.updatedAt;
  return (
    <Dialog open={open} onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent size="lg" data-testid="conflict-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitMerge className="size-4 text-warning" /> Someone else saved this record
          </DialogTitle>
          <DialogDescription>
            Your change was based on an older version
            {actor ? ` (saved version updated ${new Date(actor).toLocaleString()})` : ''}. Choose which value to keep.
          </DialogDescription>
        </DialogHeader>
        <div className="overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Field</th>
                <th className="px-3 py-2 text-left font-medium">Yours</th>
                <th className="px-3 py-2 text-left font-medium">Saved</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([key, value]) => {
                const saved = getPath(current, key);
                const differs = JSON.stringify(saved ?? null) !== JSON.stringify(value ?? null);
                return (
                  <tr key={key} className="border-t">
                    <td className="px-3 py-2 font-medium">{humanize(key)}</td>
                    <td className="px-3 py-2">
                      <span className={differs ? 'rounded bg-success/15 px-1' : ''}>{show(value)}</span>
                    </td>
                    <td className="px-3 py-2">
                      <span className={differs ? 'rounded bg-destructive/10 px-1' : ''}>{show(saved)}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onTakeTheirs} data-testid="conflict-take-theirs">
            Take theirs
          </Button>
          <Button onClick={onOverwrite} data-testid="conflict-overwrite">
            Overwrite with mine
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
