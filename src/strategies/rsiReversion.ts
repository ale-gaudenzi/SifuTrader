/**
 * RSI mean reversion (counter-trend).
 *
 * - Enter long at the next open after the RSI closes below the oversold level.
 * - Exit to cash at the next open after the RSI closes above the exit level.
 *
 * Buying weakness works in range-bound markets and suffers in persistent
 * downtrends; there is no stop-loss, so the drawdown shows that risk.
 */
import { closes, rsi, type Series } from '../engine/indicators';
import type { Bar, Order, ParamSpec, ParamValues, StrategyContext, StrategyDefinition } from '../engine/types';
import { ALLOCATION_PARAM, BaseStrategy, numberParam, periodParam, validateParams } from './base';

export interface RsiReversionParams extends ParamValues {
  rsiPeriod: number;
  entryLevel: number;
  exitLevel: number;
  allocationPct: number;
}

export const RSI_REVERSION_PARAMS: readonly ParamSpec[] = [
  periodParam('rsiPeriod', 'RSI Period', 14, 'Lookback of the Relative Strength Index (Wilder smoothing).', 2, 100),
  {
    key: 'entryLevel',
    label: 'Oversold Level',
    type: 'number',
    default: 30,
    min: 1,
    max: 99,
    step: 1,
    description: 'Buy when the RSI closes below this level.',
  },
  {
    key: 'exitLevel',
    label: 'Exit Level',
    type: 'number',
    default: 55,
    min: 1,
    max: 99,
    step: 1,
    description: 'Sell when the RSI closes above this level. Must exceed the oversold level.',
  },
  ALLOCATION_PARAM,
];

export class RsiReversionStrategy extends BaseStrategy<RsiReversionParams> {
  readonly id = 'rsi-reversion';
  readonly name = 'RSI Mean Reversion';

  private rsi: Series = [];

  override init(bars: readonly Bar[]): void {
    this.rsi = rsi(closes(bars), this.params.rsiPeriod);
  }

  onBar(ctx: StrategyContext): Order[] {
    const value = this.rsi[ctx.index];
    if (value === null) return [];
    if (this.isFlat(ctx)) {
      if (value < this.params.entryLevel) return [this.marketBuy((ctx.cash * this.params.allocationPct) / 100, 'oversold')];
    } else if (value > this.params.exitLevel) {
      return [this.marketSellAll('rsi exit')];
    }
    return [];
  }
}

function validate(values: ParamValues): string[] {
  const errors = validateParams(RSI_REVERSION_PARAMS, values);
  const { entryLevel, exitLevel } = values;
  if (typeof entryLevel === 'number' && typeof exitLevel === 'number' && entryLevel >= exitLevel) {
    errors.push('Exit level must be above the oversold level.');
  }
  return errors;
}

export const rsiReversionDefinition: StrategyDefinition = {
  id: 'rsi-reversion',
  name: 'RSI Mean Reversion',
  description: 'Buys when the RSI closes below an oversold level and moves to cash once it recovers above an exit level.',
  params: RSI_REVERSION_PARAMS,
  validate,
  create: (values) =>
    new RsiReversionStrategy({
      rsiPeriod: numberParam(values, 'rsiPeriod'),
      entryLevel: numberParam(values, 'entryLevel'),
      exitLevel: numberParam(values, 'exitLevel'),
      allocationPct: numberParam(values, 'allocationPct'),
    }),
};
