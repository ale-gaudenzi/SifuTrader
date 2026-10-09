/**
 * Small time-series chart for the fundamentals page: one or more lines
 * (daily valuation) or a single histogram (fiscal periods, colored by sign).
 * Series are replaced wholesale when the data changes, which is cheap at
 * these sizes and keeps the component free of per-series bookkeeping.
 */
import { HistogramSeries, LineSeries, LineStyle, createChart, type IChartApi, type ISeriesApi, type MouseEventParams, type Time } from 'lightweight-charts';
import { useEffect, useRef, useState } from 'react';
import { formatDate } from '../../format';
import { useI18n } from '../../i18n';
import { CHART_COLORS } from '../../theme';
import { baseChartOptions, toChartTime } from '../chartOptions';

export interface MetricPoint {
  time: number;
  value: number;
}

export interface MetricSeries {
  label: string;
  color: string;
  points: readonly MetricPoint[];
  dashed?: boolean;
}

export interface MetricChartProps {
  series: readonly MetricSeries[];
  kind: 'line' | 'histogram';
  format: (value: number) => string;
  /** Text shown instead of the chart when every series is empty. */
  emptyText: string;
}

export default function MetricChart({ series, kind, format, emptyText }: MetricChartProps) {
  const { locale } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const [hoverTime, setHoverTime] = useState<number | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const chart = createChart(container, baseChartOptions());
    const onMove = (param: MouseEventParams<Time>): void => setHoverTime(param.time === undefined ? null : (param.time as number));
    chart.subscribeCrosshairMove(onMove);
    chartRef.current = chart;
    return () => {
      chart.unsubscribeCrosshairMove(onMove);
      chartRef.current = null;
      chart.remove();
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const priceFormat = { type: 'custom', formatter: format, minMove: 0.0001 } as const;
    const added: Array<ISeriesApi<'Line'> | ISeriesApi<'Histogram'>> = [];
    for (const s of series) {
      if (kind === 'histogram') {
        const h = chart.addSeries(HistogramSeries, { priceFormat, priceLineVisible: false, base: 0 });
        h.setData(s.points.map((p) => ({ time: toChartTime(p.time), value: p.value, color: p.value >= 0 ? CHART_COLORS.up : CHART_COLORS.down })));
        added.push(h);
      } else {
        const l = chart.addSeries(LineSeries, {
          priceFormat,
          color: s.color,
          lineWidth: 2,
          lineStyle: s.dashed ? LineStyle.Dashed : LineStyle.Solid,
          priceLineVisible: false,
          crosshairMarkerRadius: 3,
        });
        l.setData(s.points.map((p) => ({ time: toChartTime(p.time), value: p.value })));
        added.push(l);
      }
    }
    // A handful of fiscal periods should fill the width rather than leave a gap on the right.
    chart.timeScale().applyOptions({ rightOffset: kind === 'histogram' ? 0 : 4 });
    chart.timeScale().fitContent();
    setHoverTime(null);
    return () => {
      // On unmount the chart may already be gone together with its series.
      if (chartRef.current !== chart) return;
      for (const s of added) chart.removeSeries(s);
    };
  }, [series, kind, format]);

  const empty = series.every((s) => s.points.length === 0);
  // The legend follows the crosshair and falls back to the latest point of each series.
  const legend = series.map((s) => {
    const point = (hoverTime !== null ? s.points.find((p) => p.time === hoverTime) : undefined) ?? s.points[s.points.length - 1];
    return { s, point };
  });
  const legendTime = hoverTime ?? legend.reduce((t, { point }) => Math.max(t, point?.time ?? 0), 0);

  return (
    <div className="relative h-[280px]">
      <div ref={containerRef} className="absolute inset-0" />
      {empty ? (
        <div className="absolute inset-0 flex items-center justify-center bg-terminal-panel text-xs text-terminal-faint">{emptyText}</div>
      ) : (
        <div className="pointer-events-none absolute left-3 top-2 z-10 space-y-0.5 font-mono text-[11px]">
          {legendTime > 0 && <div className="text-terminal-muted">{formatDate(legendTime, locale)}</div>}
          <div className="flex flex-wrap gap-x-4">
            {legend.map(({ s, point }) => (
              <span key={s.label} className="text-terminal-muted">
                {kind === 'line' && (
                  <span className="mr-1 inline-block h-0 w-3 border-t-2 align-middle" style={{ borderColor: s.color, borderTopStyle: s.dashed ? 'dashed' : 'solid' }} />
                )}
                {s.label} <span className="text-terminal-text">{point ? format(point.value) : '-'}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
