/**
 * Performance statistics derived from an equity curve and a trade list.
 */
import type { EquityPoint, Metrics, Trade } from './types';

const SECONDS_PER_YEAR = 365.25 * 86_400;

/** Largest peak-to-trough decline of a value series, as a positive percentage. */
export function maxDrawdownPct(values: readonly number[]): number {
  let peak = -Infinity;
  let worst = 0;
  for (const v of values) {
    if (v > peak) peak = v;
    if (peak > 0) {
      const dd = (v - peak) / peak;
      if (dd < worst) worst = dd;
    }
  }
  return worst === 0 ? 0 : -worst * 100;
}

/** Annualized Sharpe ratio of simple per-bar returns (zero risk-free rate). */
export function sharpeRatio(values: readonly number[], periodsPerYear: number): number {
  if (values.length < 3) return 0;
  const returns: number[] = [];
  for (let i = 1; i < values.length; i++) {
    const prev = values[i - 1];
    if (prev > 0) returns.push(values[i] / prev - 1);
  }
  if (returns.length < 2) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, r) => a + (r - mean) * (r - mean), 0) / (returns.length - 1);
  const sd = Math.sqrt(variance);
  if (sd === 0 || !Number.isFinite(sd)) return 0;
  return (mean / sd) * Math.sqrt(periodsPerYear);
}

/** Compound annual growth rate in percent. */
export function cagrPct(initial: number, final: number, startTime: number, endTime: number): number {
  const years = (endTime - startTime) / SECONDS_PER_YEAR;
  if (years <= 0 || initial <= 0 || final <= 0) return 0;
  return (Math.pow(final / initial, 1 / years) - 1) * 100;
}

export interface MetricsInput {
  initialCapital: number;
  equityCurve: readonly EquityPoint[];
  trades: readonly Trade[];
  totalFills: number;
  totalFees: number;
  barsInMarket: number;
  periodsPerYear: number;
}

export function computeMetrics(input: MetricsInput): Metrics {
  const { initialCapital, equityCurve, trades, periodsPerYear } = input;
  const first = equityCurve[0];
  const last = equityCurve[equityCurve.length - 1];
  const equity = equityCurve.map((p) => p.equity);
  const benchmark = equityCurve.map((p) => p.benchmark);

  const closed = trades.filter((t) => !t.isOpen);
  const winners = closed.filter((t) => t.pnl > 0);
  const grossProfit = winners.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = closed.filter((t) => t.pnl < 0).reduce((a, t) => a - t.pnl, 0);
  let profitFactor: number;
  if (grossLoss > 0) profitFactor = grossProfit / grossLoss;
  else profitFactor = grossProfit > 0 ? Infinity : 0;

  return {
    initialCapital,
    finalEquity: last.equity,
    totalReturnPct: (last.equity / initialCapital - 1) * 100,
    buyHoldReturnPct: (last.benchmark / initialCapital - 1) * 100,
    maxDrawdownPct: maxDrawdownPct(equity),
    buyHoldMaxDrawdownPct: maxDrawdownPct(benchmark),
    winRatePct: closed.length > 0 ? (winners.length / closed.length) * 100 : 0,
    totalTrades: closed.length,
    totalFills: input.totalFills,
    cagrPct: cagrPct(initialCapital, last.equity, first.time, last.time),
    sharpe: sharpeRatio(equity, periodsPerYear),
    profitFactor,
    exposurePct: equityCurve.length > 0 ? (input.barsInMarket / equityCurve.length) * 100 : 0,
    totalFees: input.totalFees,
    periodsPerYear,
    hasOpenPosition: trades.some((t) => t.isOpen),
  };
}
