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

/**
 * EMA of a series that starts with `null` warm-up values (e.g. the output of
 * another indicator). The EMA is seeded from the first `period` defined values.
 */
function emaOfSeries(values: Series, period: number): Series {
  const start = values.findIndex((v) => v !== null);
  const out: Series = new Array<number | null>(values.length).fill(null);
  if (start < 0) return out;
  const tail = values.slice(start).map((v) => v ?? 0);
  ema(tail, period).forEach((v, k) => {
    out[start + k] = v;
  });
  return out;
}

/**
 * Relative Strength Index with Wilder's smoothing. The first value, at index
 * `period`, averages the first `period` price changes. A window without losses
 * reads 100, and one without any movement reads 50.
 */
export function rsi(values: readonly number[], period = 14): Series {
  assertPeriod(period);
  const out: Series = new Array<number | null>(values.length).fill(null);
  if (values.length <= period) return out;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss -= change;
  }
  avgGain /= period;
  avgLoss /= period;
  const value = (): number => (avgLoss === 0 ? (avgGain === 0 ? 50 : 100) : 100 - 100 / (1 + avgGain / avgLoss));
  out[period] = value();
  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
    out[i] = value();
  }
  return out;
}

export interface Macd {
  /** EMA(fast) - EMA(slow). */
  macd: Series;
  /** EMA(signal) of the MACD line. */
  signal: Series;
  /** MACD line minus signal line. */
  histogram: Series;
}

/** Moving Average Convergence Divergence. */
export function macd(values: readonly number[], fast = 12, slow = 26, signalPeriod = 9): Macd {
  const fastEma = ema(values, fast);
  const slowEma = ema(values, slow);
  const line: Series = fastEma.map((f, i) => {
    const s = slowEma[i];
    return f === null || s === null ? null : f - s;
  });
  const signal = emaOfSeries(line, signalPeriod);
  const histogram: Series = line.map((m, i) => {
    const s = signal[i];
    return m === null || s === null ? null : m - s;
  });
  return { macd: line, signal, histogram };
}

/** Highest value over the trailing window ending at each index (inclusive). */
export function rollingMax(values: readonly number[], period: number): Series {
  assertPeriod(period);
  const out: Series = new Array<number | null>(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let max = values[i];
    for (let k = i - period + 1; k < i; k++) if (values[k] > max) max = values[k];
    out[i] = max;
  }
  return out;
}

/** Lowest value over the trailing window ending at each index (inclusive). */
export function rollingMin(values: readonly number[], period: number): Series {
  assertPeriod(period);
  const out: Series = new Array<number | null>(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let min = values[i];
    for (let k = i - period + 1; k < i; k++) if (values[k] < min) min = values[k];
    out[i] = min;
  }
  return out;
}

/** Rate of change over `period` bars, in percent. */
export function roc(values: readonly number[], period: number): Series {
  assertPeriod(period);
  return values.map((v, i) => {
    if (i < period) return null;
    const base = values[i - period];
    return base === 0 ? null : (v / base - 1) * 100;
  });
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
