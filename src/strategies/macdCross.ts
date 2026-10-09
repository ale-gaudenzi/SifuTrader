/**
 * MACD signal-line crossover (momentum).
 *
 * - Enter long at the next open after the MACD line crosses above its signal
 *   line, optionally only while the MACD is below zero (buying a turn from
 *   weakness).
 * - Exit to cash at the next open after the MACD line crosses below the signal.
 */
import { closes, crossedAbove, crossedBelow, macd, type Macd } from '../engine/indicators';
import type { Bar, Order, ParamSpec, ParamValues, StrategyContext, StrategyDefinition } from '../engine/types';
import { ALLOCATION_PARAM, BaseStrategy, booleanParam, numberParam, periodParam, validateParams } from './base';

export interface MacdCrossParams extends ParamValues {
  fastPeriod: number;
  slowPeriod: number;
  signalPeriod: number;
  belowZeroOnly: boolean;
  allocationPct: number;
}

export const MACD_CROSS_PARAMS: readonly ParamSpec[] = [
  periodParam('fastPeriod', 'Fast EMA', 12, 'Lookback of the fast exponential moving average.'),
  periodParam('slowPeriod', 'Slow EMA', 26, 'Lookback of the slow EMA. Must exceed the fast period.', 3),
  periodParam('signalPeriod', 'Signal EMA', 9, 'Lookback of the EMA applied to the MACD line.', 1, 100),
  {
    key: 'belowZeroOnly',
    label: 'Below Zero Only',
    type: 'boolean',
    default: false,
    description: 'Only take bullish crosses that happen while the MACD line is below zero.',
  },
  ALLOCATION_PARAM,
];

export class MacdCrossStrategy extends BaseStrategy<MacdCrossParams> {
  readonly id = 'macd-cross';
  readonly name = 'MACD Crossover';

  private series: Macd = { macd: [], signal: [], histogram: [] };

  override init(bars: readonly Bar[]): void {
    this.series = macd(closes(bars), this.params.fastPeriod, this.params.slowPeriod, this.params.signalPeriod);
  }

  onBar(ctx: StrategyContext): Order[] {
    const i = ctx.index;
    const { macd: line, signal } = this.series;
    if (this.isFlat(ctx)) {
      const value = line[i];
      if (crossedAbove(line, signal, i) && !(this.params.belowZeroOnly && value !== null && value >= 0)) {
        return [this.marketBuy((ctx.cash * this.params.allocationPct) / 100, 'bullish cross')];
      }
    } else if (crossedBelow(line, signal, i)) {
      return [this.marketSellAll('bearish cross')];
    }
    return [];
  }
}

function validate(values: ParamValues): string[] {
  const errors = validateParams(MACD_CROSS_PARAMS, values);
  const { fastPeriod, slowPeriod } = values;
  if (typeof fastPeriod === 'number' && typeof slowPeriod === 'number' && fastPeriod >= slowPeriod) {
    errors.push('Fast EMA period must be shorter than the slow EMA period.');
  }
  return errors;
}

export const macdCrossDefinition: StrategyDefinition = {
  id: 'macd-cross',
  name: 'MACD Crossover',
  description: 'Goes long when the MACD line crosses above its signal line and moves to cash on the opposite cross.',
  params: MACD_CROSS_PARAMS,
  validate,
  create: (values) =>
    new MacdCrossStrategy({
      fastPeriod: numberParam(values, 'fastPeriod'),
      slowPeriod: numberParam(values, 'slowPeriod'),
      signalPeriod: numberParam(values, 'signalPeriod'),
      belowZeroOnly: booleanParam(values, 'belowZeroOnly'),
      allocationPct: numberParam(values, 'allocationPct'),
    }),
};
