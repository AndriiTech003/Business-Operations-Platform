import { useQuery } from '@tanstack/react-query';
import type { ForecastDto } from '@bop/contracts';
import { Card, CardContent, CardHeader, CardTitle, Skeleton } from '@bop/ui';
import { TrendingUp } from 'lucide-react';
import { api } from '../../lib/api';
import { compactMoney, money } from '../../lib/format';
import { keys } from '../../lib/query-keys';
import { format, parse } from 'date-fns';

function monthLabel(m: string): string {
  try {
    return format(parse(m.slice(0, 7), 'yyyy-MM', new Date()), 'MMM yy');
  } catch {
    return m;
  }
}

export function ForecastPanel({ pipelineId }: { pipelineId: string | undefined }) {
  const { data, isLoading } = useQuery({
    queryKey: keys.deal.forecast(pipelineId),
    queryFn: () => api.get<ForecastDto>('/v1/deals/forecast', { query: { pipelineId } }),
  });
  const max = Math.max(1, ...(data?.months ?? []).map((m) => m.totalCents));
  return (
    <Card className="w-80 shrink-0 self-start" data-testid="forecast-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <TrendingUp className="size-4 text-primary" /> Forecast
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        {isLoading || data === undefined ? (
          <Skeleton className="h-48" />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-lg border p-2">
                <p className="text-[11px] text-muted-foreground">Open pipeline</p>
                <p className="text-base font-semibold tabular-nums">{money(data.totalCents, data.currency)}</p>
              </div>
              <div className="rounded-lg border bg-primary/5 p-2">
                <p className="text-[11px] text-muted-foreground">Weighted</p>
                <p className="text-base font-semibold tabular-nums text-primary">
                  {money(data.weightedCents, data.currency)}
                </p>
              </div>
            </div>
            <div className="grid gap-1.5">
              <p className="text-xs font-medium text-muted-foreground">By expected close month</p>
              {data.months.length === 0 ? (
                <p className="text-xs text-muted-foreground">No expected close dates set.</p>
              ) : null}
              {data.months.map((m) => (
                <div key={m.month} className="grid grid-cols-[52px_1fr_64px] items-center gap-2 text-xs">
                  <span className="text-muted-foreground">{monthLabel(m.month)}</span>
                  <div className="relative h-4 rounded bg-muted">
                    <div
                      className="absolute inset-y-0 left-0 rounded bg-primary/25"
                      style={{ width: `${(m.totalCents / max) * 100}%` }}
                    />
                    <div
                      className="absolute inset-y-0 left-0 rounded bg-primary"
                      style={{ width: `${(m.weightedCents / max) * 100}%` }}
                    />
                  </div>
                  <span className="text-right tabular-nums">{compactMoney(m.weightedCents, data.currency)}</span>
                </div>
              ))}
            </div>
            <div className="grid gap-1">
              <p className="text-xs font-medium text-muted-foreground">By stage</p>
              {data.byStage.map((s) => (
                <div key={s.stageId} className="flex items-center justify-between text-xs">
                  <span>
                    {s.name} <span className="text-muted-foreground">· {s.deals}</span>
                  </span>
                  <span className="tabular-nums">
                    {compactMoney(s.weightedCents, data.currency)}{' '}
                    <span className="text-muted-foreground">/ {compactMoney(s.totalCents, data.currency)}</span>
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
