import { useState } from 'react';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Popover,
  PopoverAnchor,
  PopoverContent,
  toast,
} from '@bop/ui';
import { Bookmark, BookmarkPlus, Link2, Trash2 } from 'lucide-react';
import { loadViews, sameSearch, saveViews, type SavedView, type TableSearch } from '../../lib/table';

export function SavedViews({
  entity,
  search,
  onApply,
}: {
  entity: string;
  search: TableSearch;
  onApply(search: TableSearch): void;
}) {
  const [views, setViews] = useState<SavedView[]>(() => loadViews(entity));
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const active = views.find((v) => sameSearch(v.search, search));

  const persist = (next: SavedView[]) => {
    setViews(next);
    saveViews(entity, next);
  };

  return (
    <Popover open={naming} onOpenChange={setNaming}>
      <PopoverAnchor asChild>
        <div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" data-testid="saved-views">
                <Bookmark /> {active?.name ?? 'Views'}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuLabel>Saved views</DropdownMenuLabel>
              {views.length === 0 ? (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">No saved views yet</p>
              ) : null}
              {views.map((v) => (
                <DropdownMenuItem key={v.name} onSelect={() => onApply(v.search)} className="justify-between">
                  <span className="truncate">{v.name}</span>
                  <button
                    type="button"
                    aria-label={`Delete view ${v.name}`}
                    className="cursor-pointer rounded p-0.5 hover:bg-background"
                    onClick={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      persist(views.filter((x) => x.name !== v.name));
                    }}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setTimeout(() => setNaming(true), 0)} data-testid="save-view">
                <BookmarkPlus /> Save current view…
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  void navigator.clipboard?.writeText(window.location.href).then(
                    () => toast.success('Link to this view copied'),
                    () => toast.error('Could not copy link'),
                  );
                }}
              >
                <Link2 /> Copy link to view
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </PopoverAnchor>
      <PopoverContent align="end" className="w-64">
        <form
          className="grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const trimmed = name.trim();
            if (trimmed === '') return;
            persist([
              ...views.filter((v) => v.name !== trimmed),
              { name: trimmed, search, createdAt: new Date().toISOString() },
            ]);
            setName('');
            setNaming(false);
            toast.success(`View "${trimmed}" saved`);
          }}
        >
          <Input
            autoFocus
            placeholder="View name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            data-testid="view-name"
          />
          <Button type="submit" size="sm">
            Save view
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}
