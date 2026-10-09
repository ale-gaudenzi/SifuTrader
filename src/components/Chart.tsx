/**
 * Price chart: candlesticks, a volume sub-pane, toggleable technical overlays,
 * backtest execution markers and a crosshair tooltip.
 *
 * The Lightweight Charts instance is created once and updated imperatively
 * when inputs change, which keeps zoom/pan state stable across overlay
 * toggles and avoids re-creating canvases on every render.
 */
import {
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  LineStyle,
  PriceScaleMode,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type LineData,
  type MouseEventParams,
  type SeriesMarker,
  type Time,
  type WhitespaceData,
} from 'lightweight-charts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { bollinger, closes, ema, sma, type Series } from '../engine/indicators';
import type { Bar, Fill, Timeframe } from '../engine/types';
import { formatDate, formatPct, formatPrice, formatVolume } from '../format';
import { useI18n } from '../i18n';
import { CHART_COLORS } from '../theme';
import { baseChartOptions, showRecent, toChartTime } from './chartOptions';

export interface OverlayState {
  sma20: boolean;
  sma50: boolean;
  ema: boolean;
  bollinger: boolean;
  markers: boolean;
}

export interface ChartProps {
  symbol: string;
  bars: readonly Bar[];
  timeframe: Timeframe;
  onTimeframeChange: (tf: Timeframe) => void;
  overlays: OverlayState;
  onOverlaysChange: (next: OverlayState) => void;
  emaPeriod: number;
  onEmaPeriodChange: (period: number) => void;
  /** Executions from the latest backtest, drawn as markers when enabled. */
  fills: readonly Fill[];
}

interface OverlaySeries {
  sma20: ISeriesApi<'Line'>;
  sma50: ISeriesApi<'Line'>;
  ema: ISeriesApi<'Line'>;
  bbUpper: ISeriesApi<'Line'>;
  bbMiddle: ISeriesApi<'Line'>;
  bbLower: ISeriesApi<'Line'>;
}

interface ChartHandles {
  chart: IChartApi;
  candles: ISeriesApi<'Candlestick'>;
  volume: ISeriesApi<'Histogram'>;
  overlays: OverlaySeries;
  markers: ISeriesMarkersPluginApi<Time>;
}

interface HoverState {
  index: number;
  x: number;
  y: number;
}

const TIMEFRAMES: readonly Timeframe[] = ['1D', '1W', '1M'];
const RECENT_BARS: Record<Timeframe, number> = { '1D': 260, '1W': 260, '1M': 240 };

function toLineData(bars: readonly Bar[], values: Series): Array<LineData<Time> | WhitespaceData<Time>> {
  return bars.map((b, i) => {
    const v = values[i];
    return v === null ? { time: toChartTime(b.time) } : { time: toChartTime(b.time), value: v };
  });
}

function lineOptions(color: string, style: LineStyle = LineStyle.Solid, width: 1 | 2 = 2) {
  return {
    color,
    lineWidth: width,
    lineStyle: style,
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false,
  } as const;
}

export default function Chart(props: ChartProps) {
  const { symbol, bars, timeframe, onTimeframeChange, overlays, onOverlaysChange, emaPeriod, onEmaPeriodChange, fills } = props;
  const { t, locale, timeframe: tfLabel } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const handlesRef = useRef<ChartHandles | null>(null);
  const timeIndexRef = useRef<Map<number, number>>(new Map());
  const [hover, setHover] = useState<HoverState | null>(null);
  const [logScale, setLogScale] = useState(false);

  const indicators = useMemo(() => {
    const c = closes(bars);
    return {
      sma20: sma(c, 20),
      sma50: sma(c, 50),
      ema: ema(c, emaPeriod),
      bb: bollinger(c, 20, 2),
    };
  }, [bars, emaPeriod]);

  // Create the chart once.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const chart = createChart(container, baseChartOptions());

    const candles = chart.addSeries(CandlestickSeries, {
      upColor: CHART_COLORS.up,
      downColor: CHART_COLORS.down,
      borderUpColor: CHART_COLORS.up,
      borderDownColor: CHART_COLORS.down,
      wickUpColor: CHART_COLORS.up,
      wickDownColor: CHART_COLORS.down,
      priceLineVisible: true,
    });
    const volume = chart.addSeries(
      HistogramSeries,
      { priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false },
      1,
    );
    const overlaySeries: OverlaySeries = {
      bbUpper: chart.addSeries(LineSeries, lineOptions(CHART_COLORS.bollinger, LineStyle.Dotted, 1)),
      bbMiddle: chart.addSeries(LineSeries, lineOptions(CHART_COLORS.bollinger, LineStyle.Dashed, 1)),
      bbLower: chart.addSeries(LineSeries, lineOptions(CHART_COLORS.bollinger, LineStyle.Dotted, 1)),
      sma20: chart.addSeries(LineSeries, lineOptions(CHART_COLORS.sma20)),
      sma50: chart.addSeries(LineSeries, lineOptions(CHART_COLORS.sma50)),
      ema: chart.addSeries(LineSeries, lineOptions(CHART_COLORS.ema, LineStyle.Dashed)),
    };
    const markers = createSeriesMarkers(candles, []);

    const volumePane = chart.panes()[1];
    volumePane?.setHeight(110);

    const onMove = (param: MouseEventParams<Time>): void => {
      if (param.point === undefined || param.time === undefined) {
        setHover(null);
        return;
      }
      const index = timeIndexRef.current.get(param.time as number);
      if (index === undefined) {
        setHover(null);
        return;
      }
      setHover({ index, x: param.point.x, y: param.point.y });
    };
    chart.subscribeCrosshairMove(onMove);

    handlesRef.current = { chart, candles, volume, overlays: overlaySeries, markers };
    return () => {
      chart.unsubscribeCrosshairMove(onMove);
      handlesRef.current = null;
      chart.remove();
    };
  }, []);

  // Push price and volume data whenever the bar series changes.
  useEffect(() => {
    const h = handlesRef.current;
    if (!h) return;
    timeIndexRef.current = new Map(bars.map((b, i) => [b.time, i]));
    h.candles.setData(bars.map((b) => ({ time: toChartTime(b.time), open: b.open, high: b.high, low: b.low, close: b.close })));
    h.volume.setData(
      bars.map((b) => ({
        time: toChartTime(b.time),
        value: b.volume,
        color: b.close >= b.open ? CHART_COLORS.upVolume : CHART_COLORS.downVolume,
      })),
    );
    showRecent(h.chart, bars.length, RECENT_BARS[timeframe]);
    setHover(null);
    // The visible range resets only when the data set changes, not when the
    // timeframe prop alone changes (a timeframe change always yields new bars).
  }, [bars]);

  // Overlay data.
  useEffect(() => {
    const h = handlesRef.current;
    if (!h) return;
    h.overlays.sma20.setData(toLineData(bars, indicators.sma20));
    h.overlays.sma50.setData(toLineData(bars, indicators.sma50));
    h.overlays.ema.setData(toLineData(bars, indicators.ema));
    h.overlays.bbUpper.setData(toLineData(bars, indicators.bb.upper));
    h.overlays.bbMiddle.setData(toLineData(bars, indicators.bb.middle));
    h.overlays.bbLower.setData(toLineData(bars, indicators.bb.lower));
  }, [bars, indicators]);

  // Overlay visibility.
  useEffect(() => {
    const h = handlesRef.current;
    if (!h) return;
    h.overlays.sma20.applyOptions({ visible: overlays.sma20 });
    h.overlays.sma50.applyOptions({ visible: overlays.sma50 });
    h.overlays.ema.applyOptions({ visible: overlays.ema });
    for (const s of [h.overlays.bbUpper, h.overlays.bbMiddle, h.overlays.bbLower]) s.applyOptions({ visible: overlays.bollinger });
  }, [overlays]);

  // Execution markers. Fills are only meaningful when they belong to this series.
  useEffect(() => {
    const h = handlesRef.current;
    if (!h) return;
    if (!overlays.markers) {
      h.markers.setMarkers([]);
      return;
    }
    const known = timeIndexRef.current;
    const markers: SeriesMarker<Time>[] = fills
      .filter((f) => known.has(f.time))
      .map((f) =>
        f.side === 'buy'
          ? { time: toChartTime(f.time), position: 'belowBar', shape: 'arrowUp', color: CHART_COLORS.buyMarker, text: t('chart.buyMarker'), size: 1 }
          : { time: toChartTime(f.time), position: 'aboveBar', shape: 'arrowDown', color: CHART_COLORS.sellMarker, text: t('chart.sellMarker'), size: 1 },
      );
    h.markers.setMarkers(markers);
  }, [fills, overlays.markers, bars, t]);

  useEffect(() => {
    handlesRef.current?.candles.priceScale().applyOptions({ mode: logScale ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal });
  }, [logScale]);

  const focusIndex = hover?.index ?? bars.length - 1;
  const focus = bars[focusIndex];
  const prev = focusIndex > 0 ? bars[focusIndex - 1] : undefined;
  const changePct = focus && prev ? (focus.close / prev.close - 1) * 100 : 0;

  const legendItems: Array<{ key: keyof OverlayState; label: string; color: string; value: number | null; dashed?: boolean }> = [
    { key: 'sma20', label: 'SMA 20', color: CHART_COLORS.sma20, value: indicators.sma20[focusIndex] ?? null },
    { key: 'sma50', label: 'SMA 50', color: CHART_COLORS.sma50, value: indicators.sma50[focusIndex] ?? null },
    { key: 'ema', label: `EMA ${emaPeriod}`, color: CHART_COLORS.ema, value: indicators.ema[focusIndex] ?? null, dashed: true },
    { key: 'bollinger', label: 'BB 20,2', color: CHART_COLORS.bollinger, value: indicators.bb.middle[focusIndex] ?? null, dashed: true },
  ];

  const toggle = (key: keyof OverlayState): void => onOverlaysChange({ ...overlays, [key]: !overlays[key] });

  // Keep the floating tooltip inside the chart area.
  const container = containerRef.current;
  const tooltipStyle =
    hover && container
      ? {
          left: Math.min(hover.x + 16, container.clientWidth - 196),
          top: Math.max(8, Math.min(hover.y + 16, container.clientHeight - 150)),
        }
      : undefined;

  return (
    <section className="panel flex min-h-0 flex-col" aria-label={t('chart.aria')}>
      <div className="flex flex-wrap items-center gap-2 border-b border-terminal-border px-3 py-2">
        <div className="seg" role="group" aria-label={t('chart.timeframe')}>
          {TIMEFRAMES.map((tf) => (
            <button key={tf} type="button" aria-pressed={tf === timeframe} onClick={() => onTimeframeChange(tf)}>
              {tfLabel(tf)}
            </button>
          ))}
        </div>
        <div className="mx-1 h-5 w-px bg-terminal-border" />
        {legendItems.map((item) => (
          <button
            key={item.key}
            type="button"
            className={`chip ${overlays[item.key] ? 'chip-on' : 'chip-off'}`}
            aria-pressed={overlays[item.key]}
            onClick={() => toggle(item.key)}
          >
            <span
              className="inline-block h-0 w-3 border-t-2"
              style={{ borderColor: item.color, borderTopStyle: item.dashed ? 'dashed' : 'solid', opacity: overlays[item.key] ? 1 : 0.4 }}
            />
            {item.label}
          </button>
        ))}
        <label className="flex items-center gap-1 font-mono text-[11px] text-terminal-faint" title={t('chart.emaPeriod')}>
          n=
          <input
            type="number"
            className="input w-14 px-1 py-0.5 text-[11px]"
            min={2}
            max={400}
            value={emaPeriod}
            onChange={(e) => {
              const n = Math.round(Number(e.target.value));
              if (Number.isFinite(n) && n >= 2 && n <= 400) onEmaPeriodChange(n);
            }}
          />
        </label>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            className={`chip ${overlays.markers ? 'chip-on' : 'chip-off'}`}
            aria-pressed={overlays.markers}
            onClick={() => toggle('markers')}
            title={t('chart.tradesTitle')}
          >
            <span className="text-up">&#9650;</span>
            <span className="text-down">&#9660;</span>
            {t('chart.trades')}
          </button>
          <button type="button" className={`chip ${logScale ? 'chip-on' : 'chip-off'}`} aria-pressed={logScale} onClick={() => setLogScale((v) => !v)}>
            {t('chart.log')}
          </button>
          <button type="button" className="chip chip-off" onClick={() => handlesRef.current?.chart.timeScale().fitContent()}>
            {t('chart.fit')}
          </button>
        </div>
      </div>

      <div className="relative min-h-[420px] flex-1">
        <div ref={containerRef} className="absolute inset-0" />

        {/* Static legend: symbol, OHLC of the focused bar and overlay values. */}
        {focus && (
          <div className="pointer-events-none absolute left-3 top-2 z-10 space-y-0.5 font-mono text-[11px]">
            <div className="flex flex-wrap items-baseline gap-x-3">
              <span className="text-sm font-semibold text-terminal-text">{symbol}</span>
              <span className="text-terminal-faint">{tfLabel(timeframe)}</span>
              <span className="text-terminal-muted">
                O <span className="text-terminal-text">{formatPrice(focus.open)}</span> H{' '}
                <span className="text-terminal-text">{formatPrice(focus.high)}</span> L{' '}
                <span className="text-terminal-text">{formatPrice(focus.low)}</span> C{' '}
                <span className="text-terminal-text">{formatPrice(focus.close)}</span>
              </span>
              <span className={changePct >= 0 ? 'text-up' : 'text-down'}>{formatPct(changePct, 2, true)}</span>
            </div>
            <div className="flex flex-wrap gap-x-3">
              {legendItems
                .filter((item) => overlays[item.key] && item.value !== null)
                .map((item) => (
                  <span key={item.key} className="text-terminal-muted">
                    <span className="mr-1 inline-block h-0 w-2.5 border-t-2 align-middle" style={{ borderColor: item.color }} />
                    {item.label} <span className="text-terminal-text">{formatPrice(item.value ?? Number.NaN)}</span>
                  </span>
                ))}
            </div>
          </div>
        )}

        {/* Floating crosshair tooltip. */}
        {hover && focus && tooltipStyle && (
          <div
            className="pointer-events-none absolute z-20 w-[180px] rounded border border-terminal-border bg-terminal-raised/95 px-2.5 py-2 font-mono text-[11px] shadow-lg"
            style={tooltipStyle}
          >
            <div className="mb-1 text-terminal-text">{formatDate(focus.time, locale)}</div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
              <dt className="text-terminal-faint">{t('chart.open')}</dt>
              <dd className="text-right">{formatPrice(focus.open)}</dd>
              <dt className="text-terminal-faint">{t('chart.high')}</dt>
              <dd className="text-right">{formatPrice(focus.high)}</dd>
              <dt className="text-terminal-faint">{t('chart.low')}</dt>
              <dd className="text-right">{formatPrice(focus.low)}</dd>
              <dt className="text-terminal-faint">{t('chart.close')}</dt>
              <dd className="text-right">{formatPrice(focus.close)}</dd>
              <dt className="text-terminal-faint">{t('chart.change')}</dt>
              <dd className={`text-right ${changePct >= 0 ? 'text-up' : 'text-down'}`}>{formatPct(changePct, 2, true)}</dd>
              <dt className="text-terminal-faint">{t('chart.volume')}</dt>
              <dd className="text-right">{formatVolume(focus.volume)}</dd>
            </dl>
          </div>
        )}
      </div>
    </section>
  );
}
