/**
 * Time-series momentum (absolute momentum / trend filter).
 *
 * Holds the asset while its return over the lookback exceeds a threshold and
 * stays in cash otherwise. Unlike a crossover, the rule is a regime: it enters
 * whenever the condition holds while flat, not only on the bar it flips.
 */
import { closes, roc, type Series } from '../engine/indicators';
import type { Bar, Order, ParamSpec, ParamValues, StrategyContext, StrategyDefinition } from '../engine/types';
import { ALLOCATION_PARAM, BaseStrategy, numberParam, periodParam, validateParams } from './base';

export interface MomentumParams extends ParamValues {
  lookback: number;
  thresholdPct: number;
  allocationPct: number;
}

export const MOMENTUM_PARAMS: readonly ParamSpec[] = [
  periodParam('lookback', 'Lookback', 126, 'Bars over which the return is measured (126 daily bars is about six months).', 2, 600),
  {
    key: 'thresholdPct',
    label: 'Threshold',
    type: 'number',
    default: 0,
    min: -50,
    max: 100,
    step: 0.5,
    unit: '%',
    description: 'Minimum lookback return required to hold the asset.',
  },
  ALLOCATION_PARAM,
];

export class MomentumStrategy extends BaseStrategy<MomentumParams> {
  readonly id = 'momentum';
  readonly name = 'Time-Series Momentum';

  private roc: Series = [];

  override init(bars: readonly Bar[]): void {
    this.roc = roc(closes(bars), this.params.lookback);
  }

  onBar(ctx: StrategyContext): Order[] {
    const value = this.roc[ctx.index];
    if (value === null) return [];
    const bullish = value > this.params.thresholdPct;
    if (this.isFlat(ctx)) {
      if (bullish) return [this.marketBuy((ctx.cash * this.params.allocationPct) / 100, 'positive momentum')];
    } else if (!bullish) {
      return [this.marketSellAll('momentum lost')];
    }
    return [];
  }
}

export const momentumDefinition: StrategyDefinition = {
  id: 'momentum',
  name: 'Time-Series Momentum',
  description: 'Holds the asset while its return over the lookback is above a threshold and stays in cash otherwise.',
  params: MOMENTUM_PARAMS,
  validate: (values) => validateParams(MOMENTUM_PARAMS, values),
  create: (values) =>
    new MomentumStrategy({
      lookback: numberParam(values, 'lookback'),
      thresholdPct: numberParam(values, 'thresholdPct'),
      allocationPct: numberParam(values, 'allocationPct'),
    }),
};
