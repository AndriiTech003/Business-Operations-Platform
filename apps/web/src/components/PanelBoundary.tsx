import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from '@bop/ui';
import { RefreshCw, TriangleAlert } from 'lucide-react';

interface Props {
  children: ReactNode;
  title?: string;
  resetKey?: unknown;
  className?: string;
}

interface State {
  error: Error | null;
  resetKey: unknown;
}

export class PanelBoundary extends Component<Props, State> {
  override state: State = { error: null, resetKey: undefined };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.resetKey !== state.resetKey) return { resetKey: props.resetKey, error: null };
    return null;
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    if (import.meta.env.DEV) console.error(error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    return (
      <div
        role="alert"
        className={
          this.props.className ??
          'm-4 flex flex-col items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-4'
        }
      >
        <div className="flex items-center gap-2 text-sm font-medium text-destructive">
          <TriangleAlert className="size-4" /> {this.props.title ?? 'This panel crashed'}
        </div>
        <p className="text-xs text-muted-foreground">{this.state.error.message}</p>
        <Button size="xs" variant="outline" onClick={() => this.setState({ error: null })}>
          <RefreshCw /> Try again
        </Button>
      </div>
    );
  }
}
