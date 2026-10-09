/**
 * Shared Lightweight Charts configuration for the terminal theme.
 */
import { ColorType, CrosshairMode, LineStyle, type ChartOptions, type DeepPartial, type UTCTimestamp } from 'lightweight-charts';
import { CHART_COLORS } from '../theme';

export function baseChartOptions(): DeepPartial<ChartOptions> {
  return {
    autoSize: true,
    layout: {
      background: { type: ColorType.Solid, color: CHART_COLORS.surface },
      textColor: CHART_COLORS.text,
      fontFamily: "'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace",
      fontSize: 11,
      attributionLogo: true,
      panes: { separatorColor: CHART_COLORS.border, separatorHoverColor: CHART_COLORS.grid, enableResize: true },
    },
    grid: {
      vertLines: { color: CHART_COLORS.grid },
      horzLines: { color: CHART_COLORS.grid },
    },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: { color: CHART_COLORS.crosshair, style: LineStyle.Dashed, labelBackgroundColor: '#2a313c' },
      horzLine: { color: CHART_COLORS.crosshair, style: LineStyle.Dashed, labelBackgroundColor: '#2a313c' },
    },
    rightPriceScale: { borderColor: CHART_COLORS.border },
    timeScale: {
      borderColor: CHART_COLORS.border,
      timeVisible: false,
      secondsVisible: false,
      rightOffset: 4,
      minBarSpacing: 0.5,
    },
    handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
  };
}

/** Converts engine time (UTC seconds) to the chart's branded time type. */
export function toChartTime(seconds: number): UTCTimestamp {
  return seconds as UTCTimestamp;
}

/**
 * Shows the most recent `count` bars (or everything when shorter), keeping a
 * small right margin. Used instead of `fitContent` so long daily histories
 * open at a readable bar width.
 */
export function showRecent(chart: { timeScale(): { setVisibleLogicalRange(r: { from: number; to: number }): void; fitContent(): void } }, length: number, count: number): void {
  if (length <= count) {
    chart.timeScale().fitContent();
    return;
  }
  chart.timeScale().setVisibleLogicalRange({ from: length - count, to: length + 3 });
}
