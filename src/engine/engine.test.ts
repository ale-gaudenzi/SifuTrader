import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseOhlcvCsv } from '../data/csv';
import { martingaleDefinition } from '../strategies/martingale';
import { defaultParams } from '../strategies/base';
import { smaCrossDefinition } from '../strategies/smaCross';
import { BacktestError, runBacktest } from './backtester';
import { bollinger, crossedAbove, crossedBelow, ema, inferPeriodsPerYear, resample, sma } from './indicators';
import { maxDrawdownPct } from './metrics';
import type { BacktestConfig, Bar, Order, Strategy, StrategyContext } from './types';

const DAY = 86_400;
/** 2024-01-01 (a Monday) 00:00 UTC. */
const T0 = Date.UTC(2024, 0, 1) / 1000;
const NO_COSTS: BacktestConfig = { initialCapital: 10_000, feePct: 0, slippagePct: 0 };

function bar(i: number, open: number, high: number, low: number, close: number, volume = 1000): Bar {
  return { time: T0 + i * DAY, open, high, low, close, volume };
}

/** Builds flat-range bars (open = previous close) from a list of closes. */
function barsFromCloses(values: readonly number[]): Bar[] {
  return values.map((c, i) => {
    const o = i === 0 ? c : values[i - 1];
    return bar(i, o, Math.max(o, c) * 1.001, Math.min(o, c) * 0.999, c);
  });
}

/** A strategy that replays a fixed order script keyed by bar index. */
function scripted(script: Record<number, Order[]>, onBar?: (ctx: StrategyContext) => void): Strategy {
  return {
    id: 'scripted',
    name: 'Scripted',
    onBar(ctx) {
      onBar?.(ctx);
      return script[ctx.index] ?? [];
    },
  };
}

function loadSampleBars(file: string): Bar[] {
  return parseOhlcvCsv(readFileSync(new URL(`../../public/sample_data/${file}`, import.meta.url), 'utf8')).bars;
}

describe('indicators', () => {
  it('computes a simple moving average', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });

  it('seeds the EMA with an SMA and smooths with 2/(n+1)', () => {
    expect(ema([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
    const e = ema([10, 10, 10, 20], 3);
    expect(e[3]).toBeCloseTo(15);
  });

  it('collapses Bollinger bands on a constant series', () => {
    const bb = bollinger([5, 5, 5, 5], 2, 2);
    expect(bb.upper[3]).toBe(5);
    expect(bb.lower[3]).toBe(5);
    expect(bb.middle[0]).toBeNull();
  });

  it('computes Bollinger width from the population standard deviation', () => {
    const bb = bollinger([1, 3], 2, 2);
    // mean 2, population sd 1
    expect(bb.upper[1]).toBeCloseTo(4);
    expect(bb.lower[1]).toBeCloseTo(0);
  });

  it('detects crossovers only on the crossing bar', () => {
    const a = [1, 2, 3, 2, 1];
    const b = [2, 2, 2, 2, 2];
    expect([0, 1, 2, 3, 4].map((i) => crossedAbove(a, b, i))).toEqual([false, false, true, false, false]);
    expect([0, 1, 2, 3, 4].map((i) => crossedBelow(a, b, i))).toEqual([false, false, false, false, true]);
  });

  it('resamples daily bars to ISO weeks', () => {
    const daily = [0, 1, 2, 3, 4, 7].map((d, k) => bar(d, 10 + k, 20 + k, 5 + k, 11 + k, 100));
    const weekly = resample(daily, '1W');
    expect(weekly).toHaveLength(2);
    expect(weekly[0]).toEqual({ time: T0, open: 10, high: 24, low: 5, close: 15, volume: 500 });
    expect(weekly[1].time).toBe(T0 + 7 * DAY);
  });

  it('resamples to calendar months and keeps the first bar time', () => {
    const daily = [0, 15, 30, 31, 45].map((d) => bar(d, 1, 2, 0.5, 1.5, 10));
    const monthly = resample(daily, '1M');
    expect(monthly).toHaveLength(2);
    expect(monthly[0].volume).toBe(30);
    expect(monthly[1].time).toBe(Date.UTC(2024, 1, 1) / 1000);
  });

  it('normalizes intraday timestamps when resampling to 1D', () => {
    const intraday: Bar[] = [
      { time: T0 + 3600, open: 1, high: 2, low: 1, close: 2, volume: 1 },
      { time: T0 + 7200, open: 2, high: 3, low: 0.5, close: 1, volume: 2 },
    ];
    expect(resample(intraday, '1D')).toEqual([{ time: T0, open: 1, high: 3, low: 0.5, close: 1, volume: 3 }]);
  });

  it('infers roughly 365 periods per year for continuous daily data', () => {
    const bars = barsFromCloses(Array.from({ length: 731 }, () => 1));
    expect(inferPeriodsPerYear(bars)).toBeCloseTo(365, 0);
  });
});

describe('metrics', () => {
  it('measures the largest peak-to-trough decline', () => {
    expect(maxDrawdownPct([100, 120, 90, 130, 117])).toBeCloseTo(25);
    expect(maxDrawdownPct([1, 2, 3])).toBe(0);
  });
});

describe('backtester execution model', () => {
  const bars = [
    bar(0, 100, 101, 99, 100),
    bar(1, 102, 103, 95, 98), // down bar: path O -> H -> L -> C
    bar(2, 97, 110, 96, 109), // up bar: path O -> L -> H -> C
    bar(3, 105, 106, 104, 105),
  ];

  it('fills market orders at the next bar open', () => {
    const r = runBacktest(bars, scripted({ 0: [{ kind: 'market', side: 'buy', cash: 5_000 }] }), NO_COSTS);
    expect(r.fills).toHaveLength(1);
    expect(r.fills[0]).toMatchObject({ barIndex: 1, price: 102, side: 'buy' });
    expect(r.fills[0].quantity).toBeCloseTo(5_000 / 102);
  });

  it('applies slippage and commissions to market orders', () => {
    const cfg: BacktestConfig = { initialCapital: 10_000, feePct: 0.1, slippagePct: 0.5 };
    const r = runBacktest(bars, scripted({ 0: [{ kind: 'market', side: 'buy', cash: 10_000 }] }), cfg);
    const f = r.fills[0];
    expect(f.price).toBeCloseTo(102 * 1.005);
    expect(f.quantity * f.price + f.fee).toBeCloseTo(10_000);
    expect(r.equityCurve[1].cash).toBeCloseTo(0);
  });

  it('fills limit buys at the limit when the low touches it, and at the open on a gap', () => {
    const touch = runBacktest(bars, scripted({ 0: [{ kind: 'limit', side: 'buy', price: 96, cash: 1_000 }] }), NO_COSTS);
    expect(touch.fills[0]).toMatchObject({ barIndex: 1, price: 96 });

    const gap = runBacktest(bars, scripted({ 1: [{ kind: 'limit', side: 'buy', price: 97.5, cash: 1_000 }] }), NO_COSTS);
    expect(gap.fills[0]).toMatchObject({ barIndex: 2, price: 97 });

    const miss = runBacktest(bars, scripted({ 0: [{ kind: 'limit', side: 'buy', price: 90, cash: 1_000 }] }), NO_COSTS);
    expect(miss.fills).toHaveLength(0);
  });

  it('expires unfilled orders after one bar', () => {
    // The take-profit at 108 is live only on bar 1 (high 103); bar 2 would reach it but the order has expired.
    const strategy = scripted({
      0: [
        { kind: 'market', side: 'buy', cash: 1_000 },
        { kind: 'limit', side: 'sell', price: 108, quantity: 'all' },
      ],
    });
    const r = runBacktest(bars, strategy, NO_COSTS);
    expect(r.fills.map((f) => f.side)).toEqual(['buy']);
  });

  it('orders same-bar triggers along the assumed intrabar path', () => {
    // Bar 2 is an up bar (O97 -> L96 -> H110 -> C109): the buy at 96.5 is reached before the sell at 108.
    const strategy = scripted({
      0: [{ kind: 'market', side: 'buy', cash: 1_000 }],
      1: [
        { kind: 'limit', side: 'sell', price: 108, quantity: 'all', tag: 'tp' },
        { kind: 'limit', side: 'buy', price: 96.5, cash: 1_000, tag: 'dip' },
      ],
    });
    const r = runBacktest(bars, strategy, NO_COSTS);
    expect(r.fills.map((f) => f.tag ?? 'entry')).toEqual(['entry', 'dip', 'tp']);
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].entries).toBe(2);
    expect(r.trades[0].isOpen).toBe(false);
  });

  it('prevents strategies from reading future bars', () => {
    const peek = scripted({}, (ctx) => {
      ctx.history.at(ctx.index + 1);
    });
    expect(() => runBacktest(bars, peek, NO_COSTS)).toThrow(BacktestError);

    const ok = scripted({}, (ctx) => {
      expect(ctx.history.ago(0)).toBe(ctx.bar);
      expect(ctx.history.length).toBe(ctx.index + 1);
    });
    expect(() => runBacktest(bars, ok, NO_COSTS)).not.toThrow();
  });

  it('rejects malformed orders', () => {
    const bad = scripted({ 0: [{ kind: 'limit', side: 'buy', price: -1, cash: 100 }] });
    expect(() => runBacktest(bars, bad, NO_COSTS)).toThrow(/invalid order/);
  });

  it('never spends more cash than available', () => {
    const r = runBacktest(bars, scripted({ 0: [{ kind: 'market', side: 'buy', cash: 1e9 }] }), NO_COSTS);
    expect(r.fills[0].quantity * r.fills[0].price).toBeCloseTo(10_000);
    expect(r.equityCurve.every((p) => p.cash >= 0)).toBe(true);
  });

  it('reports a still-open position as an open trade marked to the last close', () => {
    const r = runBacktest(bars, scripted({ 0: [{ kind: 'market', side: 'buy', cash: 10_200 }] }), {
      ...NO_COSTS,
      initialCapital: 10_200,
    });
    const t = r.trades[0];
    expect(t.isOpen).toBe(true);
    expect(t.exitTime).toBeNull();
    expect(t.exitPrice).toBe(105);
    expect(t.pnl).toBeCloseTo(100 * (105 - 102));
    expect(r.metrics.totalTrades).toBe(0);
    expect(r.metrics.hasOpenPosition).toBe(true);
  });

  it('tracks the buy-and-hold benchmark from the first close', () => {
    const r = runBacktest(bars, scripted({}), NO_COSTS);
    expect(r.metrics.buyHoldReturnPct).toBeCloseTo(5);
    expect(r.metrics.totalReturnPct).toBe(0);
  });
});

describe('Martingale strategy', () => {
  // Decline 100 -> 90 in 2.5% steps, then recover to 100.
  const closesSeries = [100, 100, 97.5, 95, 92.5, 90, 92, 94, 96, 98, 100];
  const bars = barsFromCloses(closesSeries);
  const params = { baseOrderPct: 5, dropStepPct: 2, sizeMultiplier: 2, maxSteps: 4, takeProfitPct: 2, compound: false };

  it('scales in geometrically on each drop step and exits at the take-profit', () => {
    const r = runBacktest(bars, martingaleDefinition.create(params), NO_COSTS);
    const firstExit = r.fills.findIndex((f) => f.side === 'sell');
    const buys = r.fills.slice(0, firstExit).filter((f) => f.side === 'buy');
    expect(buys.map((f) => f.tag)).toEqual(['base', 'step 2', 'step 3', 'step 4']);
    // After the take-profit the cycle restarts with a new base order.
    expect(r.fills[firstExit + 1]?.tag).toBe('base');

    // Cash sizes double: 500, 1000, 2000, 4000.
    buys.forEach((f, k) => expect(f.quantity * f.price).toBeCloseTo(500 * 2 ** k));
    // Each scale-in triggers 2% below the previous buy price.
    for (let k = 1; k < buys.length; k++) expect(buys[k].price).toBeLessThanOrEqual(buys[k - 1].price * 0.98 + 1e-9);

    const exit = r.fills[firstExit];
    const avgCost = buys.reduce((a, f) => a + f.quantity * f.price, 0) / buys.reduce((a, f) => a + f.quantity, 0);
    expect(exit.price).toBeGreaterThanOrEqual(avgCost * 1.02 - 1e-9);
    expect(r.trades[0]).toMatchObject({ entries: 4, isOpen: false });
    expect(r.trades[0].pnl).toBeGreaterThan(0);
  });

  it('stops adding once the maximum number of steps is reached', () => {
    const r = runBacktest(bars, martingaleDefinition.create({ ...params, maxSteps: 2 }), NO_COSTS);
    expect(r.fills.filter((f) => f.side === 'buy' && f.barIndex < 6)).toHaveLength(2);
  });

  it('validates parameter ranges', () => {
    expect(martingaleDefinition.validate(defaultParams(martingaleDefinition.params))).toEqual([]);
    expect(martingaleDefinition.validate({ ...params, maxSteps: 2.5 })).toContain('Max Steps must be a whole number.');
  });
});

describe('SMA crossover strategy', () => {
  it('enters after a bullish cross and exits after a bearish cross, at the next open', () => {
    const series = [10, 10, 10, 10, 11, 12, 13, 14, 13, 12, 11, 10, 9, 9];
    const bars = barsFromCloses(series);
    const r = runBacktest(bars, smaCrossDefinition.create({ fastPeriod: 2, slowPeriod: 4, allocationPct: 100 }), NO_COSTS);
    // fast SMA(2) crosses above SMA(4) on bar 4 -> buy at open of bar 5.
    expect(r.fills[0]).toMatchObject({ side: 'buy', barIndex: 5, price: bars[5].open });
    expect(r.fills[1].side).toBe('sell');
    expect(r.trades).toHaveLength(1);
  });

  it('requires the fast period to be shorter than the slow period', () => {
    expect(smaCrossDefinition.validate({ fastPeriod: 50, slowPeriod: 20, allocationPct: 100 })).toContain(
      'Fast SMA period must be shorter than the slow SMA period.',
    );
  });
});

describe('invariants on bundled market data', () => {
  const datasets = ['AAPL.csv', 'BTC-USD.csv', 'SPY.csv'];
  const cfg: BacktestConfig = { initialCapital: 10_000, feePct: 0.1, slippagePct: 0.05 };
  const strategies = [
    () => martingaleDefinition.create(defaultParams(martingaleDefinition.params)),
    () => smaCrossDefinition.create(defaultParams(smaCrossDefinition.params)),
  ];

  for (const file of datasets) {
    const bars = loadSampleBars(file);

    it(`${file}: equity change equals the sum of trade PnL`, () => {
      for (const make of strategies) {
        const r = runBacktest(bars, make(), cfg);
        const pnl = r.trades.reduce((a, t) => a + t.pnl, 0);
        expect(r.metrics.finalEquity - cfg.initialCapital).toBeCloseTo(pnl, 4);
        expect(r.equityCurve).toHaveLength(bars.length);
        expect(r.equityCurve.every((p) => p.cash >= -1e-9 && p.equity > 0)).toBe(true);
      }
    });

    it(`${file}: results on a truncated history match the full run (no lookahead)`, () => {
      const cut = Math.floor(bars.length * 0.6);
      for (const make of strategies) {
        const full = runBacktest(bars, make(), cfg);
        const part = runBacktest(bars.slice(0, cut + 1), make(), cfg);
        expect(part.fills).toEqual(full.fills.filter((f) => f.barIndex <= cut));
        expect(part.equityCurve).toEqual(full.equityCurve.slice(0, cut + 1));
      }
    });

    it(`${file}: weekly and monthly resampling preserve the price range`, () => {
      for (const tf of ['1W', '1M'] as const) {
        const agg = resample(bars, tf);
        expect(agg.length).toBeLessThan(bars.length);
        expect(Math.max(...agg.map((b) => b.high))).toBe(Math.max(...bars.map((b) => b.high)));
        expect(agg[agg.length - 1].close).toBe(bars[bars.length - 1].close);
      }
    });
  }
});
