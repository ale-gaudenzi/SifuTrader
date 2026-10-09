import { describe, expect, it } from 'vitest';
import { runBacktest } from '../engine/backtester';
import { closes, crossedAbove, macd } from '../engine/indicators';
import type { BacktestConfig, Bar } from '../engine/types';
import { defaultParams } from './base';
import { bollingerReversionDefinition } from './bollingerReversion';
import { dcaDefinition } from './dca';
import { donchianBreakoutDefinition } from './donchianBreakout';
import { macdCrossDefinition } from './macdCross';
import { momentumDefinition } from './momentum';
import { rsiReversionDefinition } from './rsiReversion';

const DAY = 86_400;
const T0 = Date.UTC(2024, 0, 1) / 1000;
const NO_COSTS: BacktestConfig = { initialCapital: 10_000, feePct: 0, slippagePct: 0 };

/** Builds flat-range bars (open = previous close) from a list of closes. */
function barsFromCloses(values: readonly number[]): Bar[] {
  return values.map((c, i) => {
    const o = i === 0 ? c : values[i - 1];
    return { time: T0 + i * DAY, open: o, high: Math.max(o, c) * 1.001, low: Math.min(o, c) * 0.999, close: c, volume: 1000 };
  });
}

describe('RSI mean reversion', () => {
  it('buys after an oversold close and sells after the RSI recovers', () => {
    const bars = barsFromCloses([10, 11, 12, 11, 10, 9, 8, 9, 10, 11, 12]);
    const r = runBacktest(bars, rsiReversionDefinition.create({ rsiPeriod: 2, entryLevel: 30, exitLevel: 70, allocationPct: 100 }), NO_COSTS);
    // RSI(2) first closes below 30 on bar 4 (two straight losses) and above 70 on bar 8.
    expect(r.fills.map((f) => [f.side, f.barIndex])).toEqual([
      ['buy', 5],
      ['sell', 9],
    ]);
  });

  it('requires the exit level to sit above the oversold level', () => {
    const errors = rsiReversionDefinition.validate({ rsiPeriod: 14, entryLevel: 60, exitLevel: 40, allocationPct: 100 });
    expect(errors).toContain('Exit level must be above the oversold level.');
  });
});

describe('Bollinger Band reversion', () => {
  it('buys a close below the lower band and exits back at the middle band', () => {
    // Bar 5: window [10,10,10,10,8] -> mean 9.6, sd 0.8, lower band 8.4 at 1.5 sd. Bar 6 closes above the mean.
    const bars = barsFromCloses([10, 10, 10, 10, 10, 8, 10, 10, 10]);
    const r = runBacktest(bars, bollingerReversionDefinition.create({ period: 5, stdDev: 1.5, exitAtUpper: false, allocationPct: 100 }), NO_COSTS);
    expect(r.fills.map((f) => [f.side, f.barIndex])).toEqual([
      ['buy', 6],
      ['sell', 7],
    ]);
    expect(r.trades[0].pnl).toBeGreaterThan(0);
  });
});

describe('Donchian breakout', () => {
  it('enters on a close above the prior channel high and exits below the prior channel low', () => {
    const bars = barsFromCloses([10, 10, 10, 10, 10, 12, 13, 14, 13, 12, 11, 10]);
    const r = runBacktest(bars, donchianBreakoutDefinition.create({ entryPeriod: 3, exitPeriod: 2, allocationPct: 100 }), NO_COSTS);
    // Bar 5 closes above the 3-bar high; bar 9 (12) is the first close below the prior 2-bar low (~12.99).
    expect(r.fills.map((f) => [f.side, f.barIndex])).toEqual([
      ['buy', 6],
      ['sell', 10],
    ]);
  });

  it('does not count the current bar towards the level it must break', () => {
    const rising = barsFromCloses([10, 11, 12, 13, 14, 15]);
    const r = runBacktest(rising, donchianBreakoutDefinition.create({ entryPeriod: 2, exitPeriod: 2, allocationPct: 100 }), NO_COSTS);
    expect(r.fills[0]).toMatchObject({ side: 'buy', barIndex: 3 });
  });
});

describe('MACD crossover', () => {
  const series = [10, 10, 10, 10, 9, 8, 9, 10, 11, 12, 13, 12, 11, 10, 9, 8];
  const bars = barsFromCloses(series);
  const params = { fastPeriod: 2, slowPeriod: 4, signalPeriod: 2, belowZeroOnly: false, allocationPct: 100 };

  it('buys at the open after a bullish signal-line cross', () => {
    const m = macd(closes(bars), 2, 4, 2);
    const cross = bars.findIndex((_, i) => crossedAbove(m.macd, m.signal, i));
    const r = runBacktest(bars, macdCrossDefinition.create(params), NO_COSTS);
    expect(cross).toBeGreaterThan(0);
    expect(r.fills[0]).toMatchObject({ side: 'buy', barIndex: cross + 1 });
    expect(r.fills[1].side).toBe('sell');
  });

  it('only takes crosses below zero when the filter is on', () => {
    const m = macd(closes(bars), 2, 4, 2);
    const r = runBacktest(bars, macdCrossDefinition.create({ ...params, belowZeroOnly: true }), NO_COSTS);
    for (const f of r.fills.filter((x) => x.side === 'buy')) expect(m.macd[f.barIndex - 1] ?? 0).toBeLessThan(0);
  });

  it('requires the fast period to be shorter than the slow period', () => {
    expect(macdCrossDefinition.validate({ ...params, fastPeriod: 30 })).toContain('Fast EMA period must be shorter than the slow EMA period.');
    expect(macdCrossDefinition.validate(defaultParams(macdCrossDefinition.params))).toEqual([]);
  });
});

describe('Time-series momentum', () => {
  it('holds while the lookback return is positive', () => {
    const bars = barsFromCloses([10, 10, 10, 10, 11, 12, 13, 12, 11, 10, 9]);
    const r = runBacktest(bars, momentumDefinition.create({ lookback: 3, thresholdPct: 0, allocationPct: 100 }), NO_COSTS);
    // ROC(3) turns positive on bar 4 (11 vs 10) and negative on bar 8 (11 vs 12).
    expect(r.fills.map((f) => [f.side, f.barIndex])).toEqual([
      ['buy', 5],
      ['sell', 9],
    ]);
  });
});

describe('Dollar-cost averaging', () => {
  const bars = barsFromCloses(Array.from({ length: 50 }, () => 100));

  it('buys a fixed amount on schedule and never sells', () => {
    const r = runBacktest(bars, dcaDefinition.create({ intervalBars: 10, amountPct: 10 }), NO_COSTS);
    expect(r.fills.map((f) => f.barIndex)).toEqual([1, 11, 21, 31, 41]);
    r.fills.forEach((f) => expect(f.quantity * f.price).toBeCloseTo(1_000));
    expect(r.fills.every((f) => f.side === 'buy')).toBe(true);
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].isOpen).toBe(true);
  });

  it('stops buying once the cash is spent', () => {
    const r = runBacktest(bars, dcaDefinition.create({ intervalBars: 1, amountPct: 30 }), NO_COSTS);
    expect(r.fills).toHaveLength(4);
    expect(r.fills[3].quantity * r.fills[3].price).toBeCloseTo(1_000);
  });
});
