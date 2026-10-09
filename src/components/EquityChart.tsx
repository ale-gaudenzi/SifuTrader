/**
 * Equity curve of the strategy against the buy-and-hold benchmark, with the
 * strategy drawdown in a sub-pane. Both curves share one dollar axis; the
 * drawdown lives in its own pane and scale.
 */
import {
  BaselineSeries,
  LineSeries,
  LineStyle,
  PriceScaleMode,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type MouseEventParams,
  type Time,
} from 'lightweight-charts';
import { useEffect, useRef, useState } from 'react';
import type { EquityPoint } from '../engine/types';
import { formatDate, formatMoney, formatPct } from '../format';
import { useI18n } from '../i18n';
import { CHART_COLORS } from '../theme';
import { baseChartOptions, toChartTime } from './chartOptions';

interface Handles {
  chart: IChartApi;
  equity: ISeriesApi<'Line'>;
  benchmark: ISeriesApi<'Line'>;
  drawdown: ISeriesApi<'Baseline'>;
}

export interface EquityChartProps {
  curve: readonly EquityPoint[];
  strategyName: string;
}

export default function EquityChart({ curve, strategyName }: EquityChartProps) {
  const { t, locale } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const handlesRef = useRef<Handles | null>(null);
  const indexRef = useRef<Map<number, number>>(new Map());
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [logScale, setLogScale] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const chart = createChart(container, baseChartOptions());
    const common = { priceLineVisible: false, crosshairMarkerRadius: 4 } as const;
    const benchmark = chart.addSeries(LineSeries, {
      ...common,
      color: CHART_COLORS.benchmark,
      lineWidth: 2,
      lineStyle: LineStyle.Dashed,
      priceFormat: { type: 'price', precision: 0, minMove: 1 },
    });
    const equity = chart.addSeries(LineSeries, {
      ...common,
      color: CHART_COLORS.equity,
      lineWidth: 2,
      priceFormat: { type: 'price', precision: 0, minMove: 1 },
    });
    // Drawdown is always <= 0, so a baseline at zero fills only the area under water.
    const drawdown = chart.addSeries(
      BaselineSeries,
      {
        baseValue: { type: 'price', price: 0 },
        topLineColor: 'transparent',
        topFillColor1: 'transparent',
        topFillColor2: 'transparent',
        bottomLineColor: CHART_COLORS.drawdown,
        bottomFillColor1: CHART_COLORS.drawdownFill,
        bottomFillColor2: CHART_COLORS.drawdownFill,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: true,
        priceFormat: { type: 'custom', formatter: (v: number) => `${v.toFixed(1)}%`, minMove: 0.01 },
      },
      1,
    );
    chart.panes()[1]?.setHeight(90);

    const onMove = (param: MouseEventParams<Time>): void => {
      const idx = param.time === undefined ? undefined : indexRef.current.get(param.time as number);
      setHoverIndex(idx ?? null);
    };
    chart.subscribeCrosshairMove(onMove);
    handlesRef.current = { chart, equity, benchmark, drawdown };
    return () => {
      chart.unsubscribeCrosshairMove(onMove);
      handlesRef.current = null;
      chart.remove();
    };
  }, []);

  useEffect(() => {
    const h = handlesRef.current;
    if (!h) return;
    indexRef.current = new Map(curve.map((p, i) => [p.time, i]));
    h.equity.setData(curve.map((p) => ({ time: toChartTime(p.time), value: p.equity })));
    h.benchmark.setData(curve.map((p) => ({ time: toChartTime(p.time), value: p.benchmark })));
    h.drawdown.setData(curve.map((p) => ({ time: toChartTime(p.time), value: p.drawdownPct })));
    h.chart.timeScale().fitContent();
    setHoverIndex(null);
  }, [curve]);

  // Series titles appear on the price axis labels and follow the UI language.
  useEffect(() => {
    handlesRef.current?.equity.applyOptions({ title: t('equity.strategy') });
    handlesRef.current?.benchmark.applyOptions({ title: t('equity.buyHold') });
  }, [t]);

  useEffect(() => {
    handlesRef.current?.equity.priceScale().applyOptions({ mode: logScale ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal });
  }, [logScale]);

  const point = curve[hoverIndex ?? curve.length - 1];
  const initial = curve[0]?.equity ?? 0;

  return (
    <section className="panel flex flex-col" aria-label={t('equity.aria')}>
      <div className="panel-header">
        <span>{t('equity.title')}</span>
        <div className="flex items-center gap-2 normal-case tracking-normal">
          <button type="button" className={`chip ${logScale ? 'chip-on' : 'chip-off'}`} aria-pressed={logScale} onClick={() => setLogScale((v) => !v)}>
            {t('chart.log')}
          </button>
        </div>
      </div>
      <div className="relative h-[340px]">
        <div ref={containerRef} className="absolute inset-0" />
        {point && (
          <div className="pointer-events-none absolute left-3 top-2 z-10 space-y-0.5 font-mono text-[11px]">
            <div className="text-terminal-muted">{formatDate(point.time, locale)}</div>
            <div className="flex flex-wrap gap-x-4">
              <span className="text-terminal-muted">
                <span className="mr-1 inline-block h-0 w-3 border-t-2 align-middle" style={{ borderColor: CHART_COLORS.equity }} />
                {strategyName} <span className="text-terminal-text">{formatMoney(point.equity, 0)}</span>{' '}
                <span className="text-terminal-faint">({formatPct((point.equity / initial - 1) * 100, 1, true)})</span>
              </span>
              <span className="text-terminal-muted">
                <span
                  className="mr-1 inline-block h-0 w-3 border-t-2 align-middle"
                  style={{ borderColor: CHART_COLORS.benchmark, borderTopStyle: 'dashed' }}
                />
                {t('equity.buyHold')} <span className="text-terminal-text">{formatMoney(point.benchmark, 0)}</span>{' '}
                <span className="text-terminal-faint">({formatPct((point.benchmark / initial - 1) * 100, 1, true)})</span>
              </span>
              <span className="text-terminal-muted">
                {t('equity.drawdown')} <span className="text-down">{formatPct(point.drawdownPct, 1)}</span>
              </span>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
