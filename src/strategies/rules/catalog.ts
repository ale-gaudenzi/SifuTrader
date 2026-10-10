/**
 * What the strategy builder can compute: indicator metadata and formulas,
 * candlestick patterns and calendar events. The UI reads the metadata to
 * render inputs; the compiler and the validator read the same table, so a
 * new indicator needs only an entry here (plus its translations).
 */
import {
  adx,
  aroon,
  atr,
  bollinger,
  cci,
  change,
  ema,
  macd,
  mfi,
  obv,
  parabolicSar,
  rollingMax,
  rollingMin,
  rollingStdDev,
  rollingVwap,
  roc,
  rsi,
  sma,
  stochastic,
  supertrend,
  vwma,
  williamsR,
  wma,
  zScore,
  type Series,
} from '../../engine/indicators';
import type { Bar } from '../../engine/types';
import type { CalendarEvent, IndicatorName, Pattern, PriceField } from './spec';

export type IndicatorParamKey = 'period' | 'fast' | 'slow' | 'signal' | 'mult' | 'smoothK' | 'dPeriod' | 'step' | 'maxStep';

export interface IndicatorParam {
  key: IndicatorParamKey;
  default: number;
  min: number;
  max: number;
  step: number;
  integer: boolean;
}

export type IndicatorCategory = 'average' | 'oscillator' | 'volatility' | 'channel' | 'trend' | 'volume';
export const INDICATOR_CATEGORIES: readonly IndicatorCategory[] = ['average', 'oscillator', 'volatility', 'channel', 'trend', 'volume'];

export interface IndicatorInfo {
  category: IndicatorCategory;
  /**
   * Applied to a source series chosen by the user (the close by default), or
   * to another indicator. Otherwise the formula reads the bars directly.
   */
  input: boolean;
  /** Expressed in price units, so it compares naturally with prices. */
  priceScale: boolean;
  params: readonly IndicatorParam[];
  /** `source` and `bars` are aligned and hold no gaps. */
  compute(source: readonly number[], bars: readonly Bar[], p: readonly number[]): Series;
}

/** Longest lookback accepted anywhere in a spec. */
export const MAX_LOOKBACK = 1000;

const int = (key: IndicatorParamKey, def: number, min = 1, max = MAX_LOOKBACK): IndicatorParam => ({ key, default: def, min, max, step: 1, integer: true });
const real = (key: IndicatorParamKey, def: number, min: number, max: number, step: number): IndicatorParam => ({ key, default: def, min, max, step, integer: false });

const PERIOD = (def: number): IndicatorParam => int('period', def);
const MULT = real('mult', 2, 0.1, 10, 0.1);
const MACD_PARAMS = [int('fast', 12), int('slow', 26), int('signal', 9)] as const;

const highs = (bars: readonly Bar[]): number[] => bars.map((b) => b.high);
const lows = (bars: readonly Bar[]): number[] => bars.map((b) => b.low);
const closesOf = (bars: readonly Bar[]): number[] => bars.map((b) => b.close);

function keltner(bars: readonly Bar[], period: number, mult: number, side: -1 | 0 | 1): Series {
  const mid = ema(closesOf(bars), period);
  const range = atr(bars, period);
  return mid.map((m, i) => {
    const a = range[i];
    return m === null || a === null ? null : m + side * mult * a;
  });
}

function percentB(source: readonly number[], period: number, mult: number): Series {
  const bb = bollinger(source, period, mult);
  return source.map((v, i) => {
    const u = bb.upper[i];
    const l = bb.lower[i];
    return u === null || l === null || u === l ? null : (v - l) / (u - l);
  });
}

function bandWidth(source: readonly number[], period: number, mult: number): Series {
  const bb = bollinger(source, period, mult);
  return bb.middle.map((m, i) => {
    const u = bb.upper[i];
    const l = bb.lower[i];
    return m === null || u === null || l === null || m === 0 ? null : ((u - l) / m) * 100;
  });
}

export const INDICATOR_INFO: Record<IndicatorName, IndicatorInfo> = {
  sma: { category: 'average', input: true, priceScale: true, params: [PERIOD(20)], compute: (s, _b, [p]) => sma(s, p) },
  ema: { category: 'average', input: true, priceScale: true, params: [PERIOD(20)], compute: (s, _b, [p]) => ema(s, p) },
  wma: { category: 'average', input: true, priceScale: true, params: [PERIOD(20)], compute: (s, _b, [p]) => wma(s, p) },
  vwma: {
    category: 'average',
    input: true,
    priceScale: true,
    params: [PERIOD(20)],
    compute: (s, b, [p]) => vwma(s, b.map((x) => x.volume), p),
  },

  rsi: { category: 'oscillator', input: true, priceScale: false, params: [PERIOD(14)], compute: (s, _b, [p]) => rsi(s, p) },
  stochK: {
    category: 'oscillator',
    input: false,
    priceScale: false,
    params: [PERIOD(14), int('smoothK', 3, 1, 50)],
    compute: (_s, b, [p, k]) => stochastic(b, p, k, 1).k,
  },
  stochD: {
    category: 'oscillator',
    input: false,
    priceScale: false,
    params: [PERIOD(14), int('smoothK', 3, 1, 50), int('dPeriod', 3, 1, 50)],
    compute: (_s, b, [p, k, d]) => stochastic(b, p, k, d).d,
  },
  williamsR: { category: 'oscillator', input: false, priceScale: false, params: [PERIOD(14)], compute: (_s, b, [p]) => williamsR(b, p) },
  cci: { category: 'oscillator', input: false, priceScale: false, params: [PERIOD(20)], compute: (_s, b, [p]) => cci(b, p) },
  mfi: { category: 'oscillator', input: false, priceScale: false, params: [PERIOD(14)], compute: (_s, b, [p]) => mfi(b, p) },
  roc: { category: 'oscillator', input: true, priceScale: false, params: [PERIOD(10)], compute: (s, _b, [p]) => roc(s, p) },
  change: { category: 'oscillator', input: true, priceScale: false, params: [PERIOD(1)], compute: (s, _b, [p]) => change(s, p) },
  zscore: { category: 'oscillator', input: true, priceScale: false, params: [PERIOD(20)], compute: (s, _b, [p]) => zScore(s, p) },
  macd: { category: 'oscillator', input: true, priceScale: false, params: MACD_PARAMS, compute: (s, _b, [f, sl, sg]) => macd(s, f, sl, sg).macd },
  macdSignal: { category: 'oscillator', input: true, priceScale: false, params: MACD_PARAMS, compute: (s, _b, [f, sl, sg]) => macd(s, f, sl, sg).signal },
  macdHist: { category: 'oscillator', input: true, priceScale: false, params: MACD_PARAMS, compute: (s, _b, [f, sl, sg]) => macd(s, f, sl, sg).histogram },

  atr: { category: 'volatility', input: false, priceScale: false, params: [PERIOD(14)], compute: (_s, b, [p]) => atr(b, p) },
  atrPct: {
    category: 'volatility',
    input: false,
    priceScale: false,
    params: [PERIOD(14)],
    compute: (_s, b, [p]) => atr(b, p).map((a, i) => (a === null ? null : (a / b[i].close) * 100)),
  },
  stdev: { category: 'volatility', input: true, priceScale: false, params: [PERIOD(20)], compute: (s, _b, [p]) => rollingStdDev(s, p) },
  bbWidth: { category: 'volatility', input: true, priceScale: false, params: [PERIOD(20), MULT], compute: (s, _b, [p, m]) => bandWidth(s, p, m) },
  bbPercentB: { category: 'oscillator', input: true, priceScale: false, params: [PERIOD(20), MULT], compute: (s, _b, [p, m]) => percentB(s, p, m) },

  bbUpper: { category: 'channel', input: true, priceScale: true, params: [PERIOD(20), MULT], compute: (s, _b, [p, m]) => bollinger(s, p, m).upper },
  bbMiddle: { category: 'channel', input: true, priceScale: true, params: [PERIOD(20)], compute: (s, _b, [p]) => sma(s, p) },
  bbLower: { category: 'channel', input: true, priceScale: true, params: [PERIOD(20), MULT], compute: (s, _b, [p, m]) => bollinger(s, p, m).lower },
  keltnerUpper: { category: 'channel', input: false, priceScale: true, params: [PERIOD(20), MULT], compute: (_s, b, [p, m]) => keltner(b, p, m, 1) },
  keltnerMiddle: { category: 'channel', input: false, priceScale: true, params: [PERIOD(20)], compute: (_s, b, [p]) => ema(closesOf(b), p) },
  keltnerLower: { category: 'channel', input: false, priceScale: true, params: [PERIOD(20), MULT], compute: (_s, b, [p, m]) => keltner(b, p, m, -1) },
  donchianUpper: { category: 'channel', input: false, priceScale: true, params: [PERIOD(20)], compute: (_s, b, [p]) => rollingMax(highs(b), p) },
  donchianLower: { category: 'channel', input: false, priceScale: true, params: [PERIOD(20)], compute: (_s, b, [p]) => rollingMin(lows(b), p) },
  donchianMiddle: {
    category: 'channel',
    input: false,
    priceScale: true,
    params: [PERIOD(20)],
    compute: (_s, b, [p]) => {
      const hi = rollingMax(highs(b), p);
      const lo = rollingMin(lows(b), p);
      return hi.map((h, i) => {
        const l = lo[i];
        return h === null || l === null ? null : (h + l) / 2;
      });
    },
  },
  highest: { category: 'channel', input: true, priceScale: true, params: [PERIOD(20)], compute: (s, _b, [p]) => rollingMax(s, p) },
  lowest: { category: 'channel', input: true, priceScale: true, params: [PERIOD(20)], compute: (s, _b, [p]) => rollingMin(s, p) },

  adx: { category: 'trend', input: false, priceScale: false, params: [PERIOD(14)], compute: (_s, b, [p]) => adx(b, p).adx },
  plusDi: { category: 'trend', input: false, priceScale: false, params: [PERIOD(14)], compute: (_s, b, [p]) => adx(b, p).plusDi },
  minusDi: { category: 'trend', input: false, priceScale: false, params: [PERIOD(14)], compute: (_s, b, [p]) => adx(b, p).minusDi },
  aroonUp: { category: 'trend', input: false, priceScale: false, params: [PERIOD(25)], compute: (_s, b, [p]) => aroon(b, p).up },
  aroonDown: { category: 'trend', input: false, priceScale: false, params: [PERIOD(25)], compute: (_s, b, [p]) => aroon(b, p).down },
  psar: {
    category: 'trend',
    input: false,
    priceScale: true,
    params: [real('step', 0.02, 0.001, 0.5, 0.01), real('maxStep', 0.2, 0.01, 1, 0.01)],
    compute: (_s, b, [st, mx]) => parabolicSar(b, st, mx),
  },
  supertrend: {
    category: 'trend',
    input: false,
    priceScale: true,
    params: [PERIOD(10), real('mult', 3, 0.1, 10, 0.1)],
    compute: (_s, b, [p, m]) => supertrend(b, p, m),
  },

  obv: { category: 'volume', input: false, priceScale: false, params: [], compute: (_s, b) => obv(b) },
  vwap: { category: 'volume', input: false, priceScale: true, params: [PERIOD(20)], compute: (_s, b, [p]) => rollingVwap(b, p) },
};

/** Default parameter values of an indicator, in catalog order. */
export function defaultIndicatorParams(name: IndicatorName): number[] {
  return INDICATOR_INFO[name].params.map((p) => p.default);
}

export function priceValue(bar: Bar, field: PriceField): number {
  switch (field) {
    case 'open':
      return bar.open;
    case 'high':
      return bar.high;
    case 'low':
      return bar.low;
    case 'close':
      return bar.close;
    case 'volume':
      return bar.volume;
    case 'hl2':
      return (bar.high + bar.low) / 2;
    case 'hlc3':
      return (bar.high + bar.low + bar.close) / 3;
    case 'ohlc4':
      return (bar.open + bar.high + bar.low + bar.close) / 4;
  }
}

const body = (b: Bar): number => Math.abs(b.close - b.open);
const upperShadow = (b: Bar): number => b.high - Math.max(b.open, b.close);
const lowerShadow = (b: Bar): number => Math.min(b.open, b.close) - b.low;

/**
 * Candlestick patterns, completed at the close of bar `i`. Two-bar patterns
 * are false on the first bar.
 */
export function matchPattern(pattern: Pattern, bars: readonly Bar[], i: number): boolean {
  const b = bars[i];
  const range = b.high - b.low;
  const prev = i > 0 ? bars[i - 1] : null;
  switch (pattern) {
    case 'bullishBar':
      return b.close > b.open;
    case 'bearishBar':
      return b.close < b.open;
    case 'doji':
      return range > 0 && body(b) <= 0.1 * range;
    case 'hammer':
      return range > 0 && lowerShadow(b) >= 2 * body(b) && upperShadow(b) <= body(b);
    case 'shootingStar':
      return range > 0 && upperShadow(b) >= 2 * body(b) && lowerShadow(b) <= body(b);
  }
  if (prev === null) return false;
  switch (pattern) {
    case 'bullishEngulfing':
      return prev.close < prev.open && b.close > b.open && b.close >= prev.open && b.open <= prev.close;
    case 'bearishEngulfing':
      return prev.close > prev.open && b.close < b.open && b.open >= prev.close && b.close <= prev.open;
    case 'insideBar':
      return b.high < prev.high && b.low > prev.low;
    case 'outsideBar':
      return b.high > prev.high && b.low < prev.low;
    case 'gapUp':
      return b.low > prev.high;
    case 'gapDown':
      return b.high < prev.low;
    case 'higherHigh':
      return b.high > prev.high;
    case 'lowerLow':
      return b.low < prev.low;
    case 'higherClose':
      return b.close > prev.close;
    case 'lowerClose':
      return b.close < prev.close;
  }
}

const DAY = 86_400;

function isoWeekday(time: number): number {
  return ((new Date(time * 1000).getUTCDay() + 6) % 7) + 1;
}

function periodKey(time: number, event: 'newWeek' | 'newMonth' | 'newYear'): number {
  if (event === 'newWeek') return Math.floor((Math.floor(time / DAY) + 3) / 7);
  const d = new Date(time * 1000);
  return event === 'newMonth' ? d.getUTCFullYear() * 12 + d.getUTCMonth() : d.getUTCFullYear();
}

/** Calendar event check at bar `i`; the first tested bar opens a new week, month and year. */
export function matchCalendar(event: CalendarEvent, value: number, bars: readonly Bar[], i: number): boolean {
  const time = bars[i].time;
  switch (event) {
    case 'weekday':
      return isoWeekday(time) === value;
    case 'month':
      return new Date(time * 1000).getUTCMonth() + 1 === value;
    case 'everyN':
      return value > 0 && i % value === 0;
    case 'newWeek':
    case 'newMonth':
    case 'newYear':
      return i === 0 || periodKey(time, event) !== periodKey(bars[i - 1].time, event);
  }
}

/** Whether a calendar event takes a value, and its bounds. */
export const CALENDAR_VALUE: Record<CalendarEvent, { min: number; max: number } | null> = {
  weekday: { min: 1, max: 7 },
  month: { min: 1, max: 12 },
  everyN: { min: 1, max: 10_000 },
  newWeek: null,
  newMonth: null,
  newYear: null,
};
