import { Link } from '@tanstack/react-router';
import { Button, EmptyState, Spinner } from '@bop/ui';
import { Compass, RefreshCw, TriangleAlert } from 'lucide-react';

export function NotFound() {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <EmptyState
        icon={<Compass />}
        title="Page not found"
        description="The page you are looking for does not exist or was moved."
        action={
          <Button asChild variant="outline" size="sm">
            <Link to="/deals">Go to deals</Link>
          </Button>
        }
      />
    </div>
  );
}

export function RoutePending() {
  return (
    <div className="flex h-full min-h-48 items-center justify-center">
      <Spinner className="size-5" />
    </div>
  );
}

export function RouteError({ error, reset }: { error: unknown; reset(): void }) {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <EmptyState
        icon={<TriangleAlert />}
        title="This page failed to load"
        description={error instanceof Error ? error.message : 'Unexpected error'}
        action={
          <Button size="sm" variant="outline" onClick={reset}>
            <RefreshCw /> Try again
          </Button>
        }
      />
    </div>
  );
}
