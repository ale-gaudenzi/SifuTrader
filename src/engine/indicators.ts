/**
 * Technical indicators and time-series helpers.
 *
 * Every indicator is causal: the value at index `i` is computed exclusively
 * from inputs at indices `<= i`, which makes them safe to pre-compute before a
 * bar-by-bar simulation. Indices that do not yet have enough history hold
 * `null`.
 */
import type { Bar, Timeframe } from './types';

export type Series = Array<number | null>;

const SECONDS_PER_DAY = 86_400;

function assertPeriod(period: number): void {
  if (!Number.isInteger(period) || period < 1) {
    throw new RangeError(`Indicator period must be a positive integer, received ${period}`);
  }
}

/** Simple moving average using an O(n) rolling sum. */
export function sma(values: readonly number[], period: number): Series {
  assertPeriod(period);
  const out: Series = new Array<number | null>(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/**
 * Exponential moving average with smoothing factor `2 / (period + 1)`.
 * Seeded with the simple average of the first `period` values, so the first
 * defined output is at index `period - 1` (matching common charting packages).
 */
export function ema(values: readonly number[], period: number): Series {
  assertPeriod(period);
  const out: Series = new Array<number | null>(values.length).fill(null);
  if (values.length < period) return out;
  const alpha = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = alpha * values[i] + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

/** Rolling population standard deviation over a fixed window. */
export function rollingStdDev(values: readonly number[], period: number): Series {
  assertPeriod(period);
  const out: Series = new Array<number | null>(values.length).fill(null);
  // A direct two-pass computation per window avoids the catastrophic
  // cancellation of the sum-of-squares shortcut on large price levels.
  for (let i = period - 1; i < values.length; i++) {
    let mean = 0;
    for (let k = i - period + 1; k <= i; k++) mean += values[k];
    mean /= period;
    let variance = 0;
    for (let k = i - period + 1; k <= i; k++) {
      const d = values[k] - mean;
      variance += d * d;
    }
    out[i] = Math.sqrt(variance / period);
  }
  return out;
}

export interface BollingerBands {
  middle: Series;
  upper: Series;
  lower: Series;
}

/** Bollinger Bands: SMA(period) plus/minus `multiplier` population std-devs. */
export function bollinger(values: readonly number[], period = 20, multiplier = 2): BollingerBands {
  const middle = sma(values, period);
  const sd = rollingStdDev(values, period);
  const upper: Series = middle.map((m, i) => {
    const s = sd[i];
    return m === null || s === null ? null : m + multiplier * s;
  });
  const lower: Series = middle.map((m, i) => {
    const s = sd[i];
    return m === null || s === null ? null : m - multiplier * s;
  });
  return { middle, upper, lower };
}

/** True when series `a` crosses strictly above `b` on bar `i`. */
export function crossedAbove(a: Series, b: Series, i: number): boolean {
  if (i < 1) return false;
  const a0 = a[i - 1];
  const b0 = b[i - 1];
  const a1 = a[i];
  const b1 = b[i];
  if (a0 === null || b0 === null || a1 === null || b1 === null) return false;
  return a0 <= b0 && a1 > b1;
}

/** True when series `a` crosses strictly below `b` on bar `i`. */
export function crossedBelow(a: Series, b: Series, i: number): boolean {
  if (i < 1) return false;
  const a0 = a[i - 1];
  const b0 = b[i - 1];
  const a1 = a[i];
  const b1 = b[i];
  if (a0 === null || b0 === null || a1 === null || b1 === null) return false;
  return a0 >= b0 && a1 < b1;
}

/* -------------------------------------------------------------------------- */
/* Resampling                                                                 */
/* -------------------------------------------------------------------------- */

/** Days since the Unix epoch for a UTC timestamp in seconds. */
function epochDay(time: number): number {
  return Math.floor(time / SECONDS_PER_DAY);
}

/**
 * Returns a grouping key for the bucket a timestamp belongs to.
 * - 1D: UTC calendar day.
 * - 1W: ISO week starting Monday (1970-01-01 was a Thursday, hence the +3).
 * - 1M: UTC calendar month.
 */
function bucketKey(time: number, timeframe: Timeframe): number {
  switch (timeframe) {
    case '1D':
      return epochDay(time);
    case '1W':
      return Math.floor((epochDay(time) + 3) / 7);
    case '1M': {
      const d = new Date(time * 1000);
      return d.getUTCFullYear() * 12 + d.getUTCMonth();
    }
  }
}

/**
 * Aggregates chronologically sorted bars into the requested timeframe.
 *
 * The resulting bar time is midnight UTC of the first source bar in each
 * bucket, open is the first open, close the last close, high/low the extremes
 * and volume the sum. Resampling to `1D` normalizes timestamps to midnight UTC
 * and merges any intraday bars that share a calendar day.
 */
export function resample(bars: readonly Bar[], timeframe: Timeframe): Bar[] {
  const out: Bar[] = [];
  let currentKey: number | null = null;
  let current: Bar | null = null;
  for (const bar of bars) {
    const key = bucketKey(bar.time, timeframe);
    if (current === null || key !== currentKey) {
      if (current !== null) out.push(current);
      currentKey = key;
      current = {
        time: epochDay(bar.time) * SECONDS_PER_DAY,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
      };
    } else {
      current.high = Math.max(current.high, bar.high);
      current.low = Math.min(current.low, bar.low);
      current.close = bar.close;
      current.volume += bar.volume;
    }
  }
  if (current !== null) out.push(current);
  return out;
}

/**
 * Estimates the number of bars per year from the span of the series. This
 * adapts annualization to equities (~252 daily bars), crypto (~365) and
 * aggregated timeframes without hard-coding a calendar.
 */
export function inferPeriodsPerYear(bars: readonly Bar[]): number {
  if (bars.length < 2) return 252;
  const years = (bars[bars.length - 1].time - bars[0].time) / (365.25 * SECONDS_PER_DAY);
  if (years <= 0) return 252;
  return (bars.length - 1) / years;
}

/** Extracts the close prices of a bar series. */
export function closes(bars: readonly Bar[]): number[] {
  return bars.map((b) => b.close);
}
