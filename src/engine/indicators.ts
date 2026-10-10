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

/** Weighted moving average with linear weights 1..period (newest weighs most). */
export function wma(values: readonly number[], period: number): Series {
  assertPeriod(period);
  const out: Series = new Array<number | null>(values.length).fill(null);
  const denominator = (period * (period + 1)) / 2;
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    for (let k = 0; k < period; k++) sum += values[i - k] * (period - k);
    out[i] = sum / denominator;
  }
  return out;
}

/** Volume-weighted moving average; null while the window has no volume. */
export function vwma(values: readonly number[], volumes: readonly number[], period: number): Series {
  assertPeriod(period);
  const out: Series = new Array<number | null>(values.length).fill(null);
  let pv = 0;
  let v = 0;
  for (let i = 0; i < values.length; i++) {
    pv += values[i] * volumes[i];
    v += volumes[i];
    if (i >= period) {
      pv -= values[i - period] * volumes[i - period];
      v -= volumes[i - period];
    }
    if (i >= period - 1 && v > 0) out[i] = pv / v;
  }
  return out;
}

/** Rolling z-score: distance from the SMA in population standard deviations. */
export function zScore(values: readonly number[], period: number): Series {
  const mean = sma(values, period);
  const sd = rollingStdDev(values, period);
  return values.map((v, i) => {
    const m = mean[i];
    const s = sd[i];
    return m === null || s === null || s === 0 ? null : (v - m) / s;
  });
}

/** Difference from the value `period` bars earlier, in the units of the input. */
export function change(values: readonly number[], period: number): Series {
  assertPeriod(period);
  return values.map((v, i) => (i < period ? null : v - values[i - period]));
}

/** SMA of a series with leading nulls, seeded at its first defined value. */
function smaOfSeries(values: Series, period: number): Series {
  const start = values.findIndex((v) => v !== null);
  const out: Series = new Array<number | null>(values.length).fill(null);
  if (start < 0) return out;
  sma(values.slice(start).map((v) => v ?? 0), period).forEach((v, k) => {
    out[start + k] = v;
  });
  return out;
}

/** Wilder smoothing seeded with the simple average of the first `period` values. */
function wilder(values: readonly number[], period: number): Series {
  const out: Series = new Array<number | null>(values.length).fill(null);
  if (values.length < period) return out;
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i];
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = (prev * (period - 1) + values[i]) / period;
    out[i] = prev;
  }
  return out;
}

/** True range of each bar; the first bar has no previous close and uses its own range. */
export function trueRange(bars: readonly Bar[]): number[] {
  return bars.map((b, i) => {
    if (i === 0) return b.high - b.low;
    const prev = bars[i - 1].close;
    return Math.max(b.high - b.low, Math.abs(b.high - prev), Math.abs(b.low - prev));
  });
}

/** Average True Range with Wilder smoothing. */
export function atr(bars: readonly Bar[], period = 14): Series {
  assertPeriod(period);
  return wilder(trueRange(bars), period);
}

export interface Stochastic {
  /** %K, smoothed by an SMA of `smoothK` bars. */
  k: Series;
  /** SMA of %K over `dPeriod` bars. */
  d: Series;
}

/** Stochastic oscillator; a window without range reads 50. */
export function stochastic(bars: readonly Bar[], period = 14, smoothK = 3, dPeriod = 3): Stochastic {
  assertPeriod(period);
  assertPeriod(smoothK);
  assertPeriod(dPeriod);
  const hh = rollingMax(bars.map((b) => b.high), period);
  const ll = rollingMin(bars.map((b) => b.low), period);
  const raw: Series = bars.map((b, i) => {
    const h = hh[i];
    const l = ll[i];
    if (h === null || l === null) return null;
    return h === l ? 50 : ((b.close - l) / (h - l)) * 100;
  });
  const k = smaOfSeries(raw, smoothK);
  return { k, d: smaOfSeries(k, dPeriod) };
}

/** Williams %R, from -100 (close at the low of the window) to 0 (at the high). */
export function williamsR(bars: readonly Bar[], period = 14): Series {
  assertPeriod(period);
  const hh = rollingMax(bars.map((b) => b.high), period);
  const ll = rollingMin(bars.map((b) => b.low), period);
  return bars.map((b, i) => {
    const h = hh[i];
    const l = ll[i];
    if (h === null || l === null) return null;
    return h === l ? -50 : ((h - b.close) / (h - l)) * -100;
  });
}

/** Typical price (high + low + close) / 3 of each bar. */
export function typicalPrices(bars: readonly Bar[]): number[] {
  return bars.map((b) => (b.high + b.low + b.close) / 3);
}

/** Commodity Channel Index with the conventional 0.015 constant. */
export function cci(bars: readonly Bar[], period = 20): Series {
  assertPeriod(period);
  const tp = typicalPrices(bars);
  const mean = sma(tp, period);
  return tp.map((v, i) => {
    const m = mean[i];
    if (m === null) return null;
    let dev = 0;
    for (let k = i - period + 1; k <= i; k++) dev += Math.abs(tp[k] - m);
    dev /= period;
    return dev === 0 ? 0 : (v - m) / (0.015 * dev);
  });
}

/** Money Flow Index: a volume-weighted RSI of the typical price. */
export function mfi(bars: readonly Bar[], period = 14): Series {
  assertPeriod(period);
  const tp = typicalPrices(bars);
  const out: Series = new Array<number | null>(bars.length).fill(null);
  for (let i = period; i < bars.length; i++) {
    let pos = 0;
    let neg = 0;
    for (let k = i - period + 1; k <= i; k++) {
      const flow = tp[k] * bars[k].volume;
      if (tp[k] > tp[k - 1]) pos += flow;
      else if (tp[k] < tp[k - 1]) neg += flow;
    }
    out[i] = neg === 0 ? (pos === 0 ? 50 : 100) : 100 - 100 / (1 + pos / neg);
  }
  return out;
}

export interface Adx {
  adx: Series;
  plusDi: Series;
  minusDi: Series;
}

/** Wilder's Average Directional Index with the +DI and -DI lines. */
export function adx(bars: readonly Bar[], period = 14): Adx {
  assertPeriod(period);
  const n = bars.length;
  const empty = (): Series => new Array<number | null>(n).fill(null);
  const result: Adx = { adx: empty(), plusDi: empty(), minusDi: empty() };
  if (n <= period) return result;
  // Directional movement starts at bar 1; the smoothed sums are seeded over bars 1..period.
  const tr = trueRange(bars);
  let trSum = 0;
  let plusSum = 0;
  let minusSum = 0;
  const dx: number[] = [];
  for (let i = 1; i < n; i++) {
    const up = bars[i].high - bars[i - 1].high;
    const down = bars[i - 1].low - bars[i].low;
    const plusDm = up > down && up > 0 ? up : 0;
    const minusDm = down > up && down > 0 ? down : 0;
    if (i <= period) {
      trSum += tr[i];
      plusSum += plusDm;
      minusSum += minusDm;
      if (i < period) continue;
    } else {
      trSum = trSum - trSum / period + tr[i];
      plusSum = plusSum - plusSum / period + plusDm;
      minusSum = minusSum - minusSum / period + minusDm;
    }
    const pdi = trSum === 0 ? 0 : (plusSum / trSum) * 100;
    const mdi = trSum === 0 ? 0 : (minusSum / trSum) * 100;
    result.plusDi[i] = pdi;
    result.minusDi[i] = mdi;
    dx.push(pdi + mdi === 0 ? 0 : (Math.abs(pdi - mdi) / (pdi + mdi)) * 100);
  }
  // ADX is the Wilder average of DX, first defined `period` DX values after the DIs start.
  wilder(dx, period).forEach((v, k) => {
    result.adx[period + k] = v;
  });
  return result;
}

export interface Aroon {
  up: Series;
  down: Series;
}

/** Aroon up/down: how recently the window made its high or low, from 0 to 100. */
export function aroon(bars: readonly Bar[], period = 25): Aroon {
  assertPeriod(period);
  const up: Series = new Array<number | null>(bars.length).fill(null);
  const down: Series = new Array<number | null>(bars.length).fill(null);
  for (let i = period; i < bars.length; i++) {
    let hi = i - period;
    let lo = i - period;
    for (let k = i - period + 1; k <= i; k++) {
      if (bars[k].high >= bars[hi].high) hi = k;
      if (bars[k].low <= bars[lo].low) lo = k;
    }
    up[i] = ((period - (i - hi)) / period) * 100;
    down[i] = ((period - (i - lo)) / period) * 100;
  }
  return { up, down };
}

/**
 * Parabolic SAR. The stop for bar `i` is derived from bars before `i` and is
 * reported at `i`, so comparing it with the close of `i` is causal.
 */
export function parabolicSar(bars: readonly Bar[], step = 0.02, maxStep = 0.2): Series {
  const out: Series = new Array<number | null>(bars.length).fill(null);
  if (bars.length < 2) return out;
  let long = bars[1].close >= bars[0].close;
  let sar = long ? bars[0].low : bars[0].high;
  let ep = long ? bars[0].high : bars[0].low;
  let af = step;
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i];
    const prev = bars[i - 1];
    sar = sar + af * (ep - sar);
    // The SAR may not enter the prior bar's range (two bars where available).
    if (long) sar = Math.min(sar, prev.low, i > 1 ? bars[i - 2].low : prev.low);
    else sar = Math.max(sar, prev.high, i > 1 ? bars[i - 2].high : prev.high);

    if (long && b.low < sar) {
      long = false;
      sar = ep;
      ep = b.low;
      af = step;
    } else if (!long && b.high > sar) {
      long = true;
      sar = ep;
      ep = b.high;
      af = step;
    } else if (long && b.high > ep) {
      ep = b.high;
      af = Math.min(af + step, maxStep);
    } else if (!long && b.low < ep) {
      ep = b.low;
      af = Math.min(af + step, maxStep);
    }
    out[i] = sar;
  }
  return out;
}

/**
 * Supertrend line: a trailing band at `multiplier` ATRs below the median price
 * in an uptrend (above it in a downtrend) that flips when the close crosses it.
 */
export function supertrend(bars: readonly Bar[], period = 10, multiplier = 3): Series {
  const range = atr(bars, period);
  const out: Series = new Array<number | null>(bars.length).fill(null);
  let upper = 0;
  let lower = 0;
  let up = true;
  let started = false;
  for (let i = 0; i < bars.length; i++) {
    const a = range[i];
    if (a === null) continue;
    const b = bars[i];
    const mid = (b.high + b.low) / 2;
    const basicUpper = mid + multiplier * a;
    const basicLower = mid - multiplier * a;
    if (!started) {
      upper = basicUpper;
      lower = basicLower;
      up = b.close >= mid;
      started = true;
    } else {
      const prevClose = bars[i - 1].close;
      upper = basicUpper < upper || prevClose > upper ? basicUpper : upper;
      lower = basicLower > lower || prevClose < lower ? basicLower : lower;
      if (up && b.close < lower) up = false;
      else if (!up && b.close > upper) up = true;
    }
    out[i] = up ? lower : upper;
  }
  return out;
}

/** On-Balance Volume, starting from zero. */
export function obv(bars: readonly Bar[]): Series {
  let total = 0;
  return bars.map((b, i) => {
    if (i > 0) {
      const prev = bars[i - 1].close;
      if (b.close > prev) total += b.volume;
      else if (b.close < prev) total -= b.volume;
    }
    return total;
  });
}

/** Rolling VWAP of the typical price over `period` bars. */
export function rollingVwap(bars: readonly Bar[], period = 20): Series {
  return vwma(
    typicalPrices(bars),
    bars.map((b) => b.volume),
    period,
  );
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
