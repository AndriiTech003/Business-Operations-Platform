import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, FunnelChart, LineChart } from 'echarts/charts';
import { DatasetComponent, GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsOption } from 'echarts';
import { useTheme, type Theme } from '../../lib/theme';

echarts.use([
  BarChart,
  FunnelChart,
  LineChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DatasetComponent,
  CanvasRenderer,
]);

export const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100'] as const;
export const INK = { primary: '#0b0b0b', secondary: '#52514e', muted: '#8a8984', grid: '#e7e6e1' } as const;
export const DARK_INK = { primary: '#f4f4f2', secondary: '#c9c8c3', muted: '#93928d', grid: '#3a3a42' } as const;

const DARK_MAP: Record<string, string> = Object.fromEntries(
  (Object.keys(INK) as Array<keyof typeof INK>).map((k) => [INK[k], DARK_INK[k]]),
);

export function themedOption<T>(value: T, theme: Theme): T {
  if (theme === 'light') return value;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return DARK_MAP[v] ?? v;
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype)
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

export function EChart({
  option,
  height = 300,
  ariaLabel,
  testId,
}: {
  option: EChartsOption;
  height?: number;
  ariaLabel: string;
  testId?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  useEffect(() => {
    if (host.current === null) return undefined;
    const instance = echarts.init(host.current, undefined, { renderer: 'canvas' });
    chart.current = instance;
    const ro = new ResizeObserver(() => instance.resize());
    ro.observe(host.current);
    return () => {
      ro.disconnect();
      instance.dispose();
      chart.current = null;
    };
  }, []);
  const [theme] = useTheme();
  useEffect(() => {
    chart.current?.setOption(
      themedOption(
        {
          textStyle: { fontFamily: 'inherit', color: INK.secondary },
          animationDuration: 400,
          ...option,
        },
        theme,
      ),
      true,
    );
  }, [option, theme]);
  return <div ref={host} role="img" aria-label={ariaLabel} data-testid={testId} style={{ height, width: '100%' }} />;
}
