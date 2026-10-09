/**
 * Dual simple-moving-average crossover (trend following baseline).
 *
 * - Enter long at the next open after the fast SMA closes above the slow SMA.
 * - Exit to cash at the next open after the fast SMA closes below the slow SMA.
 *
 * Only actual crossovers generate signals; the strategy does not enter on the
 * first bar merely because the fast average already sits above the slow one.
 */
import { closes, crossedAbove, crossedBelow, sma, type Series } from '../engine/indicators';
import type { Bar, Order, ParamSpec, ParamValues, StrategyContext, StrategyDefinition } from '../engine/types';
import { BaseStrategy, numberParam, validateParams } from './base';

export interface SmaCrossParams extends ParamValues {
  fastPeriod: number;
  slowPeriod: number;
  allocationPct: number;
}

export const SMA_CROSS_PARAMS: readonly ParamSpec[] = [
  {
    key: 'fastPeriod',
    label: 'Fast SMA',
    type: 'number',
    default: 20,
    min: 2,
    max: 400,
    step: 1,
    integer: true,
    unit: 'bars',
    description: 'Lookback of the fast moving average.',
  },
  {
    key: 'slowPeriod',
    label: 'Slow SMA',
    type: 'number',
    default: 50,
    min: 3,
    max: 400,
    step: 1,
    integer: true,
    unit: 'bars',
    description: 'Lookback of the slow moving average. Must exceed the fast period.',
  },
  {
    key: 'allocationPct',
    label: 'Allocation',
    type: 'number',
    default: 100,
    min: 1,
    max: 100,
    step: 1,
    unit: '%',
    description: 'Share of available cash invested on each long signal.',
  },
];

export class SmaCrossStrategy extends BaseStrategy<SmaCrossParams> {
  readonly id = 'sma-cross';
  readonly name = 'Dual SMA Crossover';

  private fast: Series = [];
  private slow: Series = [];

  override init(bars: readonly Bar[]): void {
    const c = closes(bars);
    this.fast = sma(c, this.params.fastPeriod);
    this.slow = sma(c, this.params.slowPeriod);
  }

  onBar(ctx: StrategyContext): Order[] {
    const i = ctx.index;
    if (this.isFlat(ctx)) {
      if (crossedAbove(this.fast, this.slow, i)) {
        return [this.marketBuy((ctx.cash * this.params.allocationPct) / 100, 'bullish cross')];
      }
    } else if (crossedBelow(this.fast, this.slow, i)) {
      return [this.marketSellAll('bearish cross')];
    }
    return [];
  }
}

function validate(values: ParamValues): string[] {
  const errors = validateParams(SMA_CROSS_PARAMS, values);
  const fast = values.fastPeriod;
  const slow = values.slowPeriod;
  if (typeof fast === 'number' && typeof slow === 'number' && fast >= slow) {
    errors.push('Fast SMA period must be shorter than the slow SMA period.');
  }
  return errors;
}

export const smaCrossDefinition: StrategyDefinition = {
  id: 'sma-cross',
  name: 'Dual SMA Crossover',
  description: 'Goes long when the fast SMA crosses above the slow SMA and moves to cash on the opposite cross.',
  params: SMA_CROSS_PARAMS,
  validate,
  create: (values) =>
    new SmaCrossStrategy({
      fastPeriod: numberParam(values, 'fastPeriod'),
      slowPeriod: numberParam(values, 'slowPeriod'),
      allocationPct: numberParam(values, 'allocationPct'),
    }),
};
