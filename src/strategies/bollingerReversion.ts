/**
 * Bollinger Band mean reversion (counter-trend).
 *
 * - Enter long at the next open after a close below the lower band.
 * - Exit to cash at the next open after a close at or above the middle band
 *   (the moving average), or above the upper band when `exitAtUpper` is set.
 */
import { bollinger, closes, type BollingerBands } from '../engine/indicators';
import type { Bar, Order, ParamSpec, ParamValues, StrategyContext, StrategyDefinition } from '../engine/types';
import { ALLOCATION_PARAM, BaseStrategy, booleanParam, numberParam, periodParam, validateParams } from './base';

export interface BollingerReversionParams extends ParamValues {
  period: number;
  stdDev: number;
  exitAtUpper: boolean;
  allocationPct: number;
}

export const BOLLINGER_REVERSION_PARAMS: readonly ParamSpec[] = [
  periodParam('period', 'Band Period', 20, 'Lookback of the moving average and standard deviation.'),
  {
    key: 'stdDev',
    label: 'Band Width',
    type: 'number',
    default: 2,
    min: 0.5,
    max: 4,
    step: 0.1,
    unit: 'x',
    description: 'Number of standard deviations between the middle and the outer bands.',
  },
  {
    key: 'exitAtUpper',
    label: 'Exit at Upper Band',
    type: 'boolean',
    default: false,
    description: 'Hold until the upper band instead of exiting at the middle band.',
  },
  ALLOCATION_PARAM,
];

export class BollingerReversionStrategy extends BaseStrategy<BollingerReversionParams> {
  readonly id = 'bollinger-reversion';
  readonly name = 'Bollinger Band Reversion';

  private bands: BollingerBands = { middle: [], upper: [], lower: [] };

  override init(bars: readonly Bar[]): void {
    this.bands = bollinger(closes(bars), this.params.period, this.params.stdDev);
  }

  onBar(ctx: StrategyContext): Order[] {
    const i = ctx.index;
    const close = ctx.bar.close;
    if (this.isFlat(ctx)) {
      const lower = this.bands.lower[i];
      if (lower !== null && close < lower) {
        return [this.marketBuy((ctx.cash * this.params.allocationPct) / 100, 'below lower band')];
      }
      return [];
    }
    const target = this.params.exitAtUpper ? this.bands.upper[i] : this.bands.middle[i];
    if (target !== null && close >= target) return [this.marketSellAll(this.params.exitAtUpper ? 'upper band' : 'middle band')];
    return [];
  }
}

export const bollingerReversionDefinition: StrategyDefinition = {
  id: 'bollinger-reversion',
  name: 'Bollinger Band Reversion',
  description: 'Buys a close below the lower Bollinger Band and sells when price reverts to the middle band (or the upper band).',
  params: BOLLINGER_REVERSION_PARAMS,
  validate: (values) => validateParams(BOLLINGER_REVERSION_PARAMS, values),
  create: (values) =>
    new BollingerReversionStrategy({
      period: numberParam(values, 'period'),
      stdDev: numberParam(values, 'stdDev'),
      exitAtUpper: booleanParam(values, 'exitAtUpper'),
      allocationPct: numberParam(values, 'allocationPct'),
    }),
};
