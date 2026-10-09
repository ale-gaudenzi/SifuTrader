/**
 * Donchian channel breakout (Turtle-style trend following).
 *
 * - Enter long at the next open after a close above the highest high of the
 *   previous `entryPeriod` bars.
 * - Exit to cash at the next open after a close below the lowest low of the
 *   previous `exitPeriod` bars.
 *
 * Channels are compared with the value of the previous bar, so the current
 * bar never counts towards the level it has to break.
 */
import { rollingMax, rollingMin, type Series } from '../engine/indicators';
import type { Bar, Order, ParamSpec, ParamValues, StrategyContext, StrategyDefinition } from '../engine/types';
import { ALLOCATION_PARAM, BaseStrategy, numberParam, periodParam, validateParams } from './base';

export interface DonchianBreakoutParams extends ParamValues {
  entryPeriod: number;
  exitPeriod: number;
  allocationPct: number;
}

export const DONCHIAN_BREAKOUT_PARAMS: readonly ParamSpec[] = [
  periodParam('entryPeriod', 'Entry Channel', 20, 'Buy on a close above the highest high of this many previous bars.'),
  periodParam('exitPeriod', 'Exit Channel', 10, 'Sell on a close below the lowest low of this many previous bars.'),
  ALLOCATION_PARAM,
];

export class DonchianBreakoutStrategy extends BaseStrategy<DonchianBreakoutParams> {
  readonly id = 'donchian-breakout';
  readonly name = 'Donchian Breakout';

  private upper: Series = [];
  private lower: Series = [];

  override init(bars: readonly Bar[]): void {
    this.upper = rollingMax(
      bars.map((b) => b.high),
      this.params.entryPeriod,
    );
    this.lower = rollingMin(
      bars.map((b) => b.low),
      this.params.exitPeriod,
    );
  }

  onBar(ctx: StrategyContext): Order[] {
    const i = ctx.index;
    if (i < 1) return [];
    const close = ctx.bar.close;
    if (this.isFlat(ctx)) {
      const upper = this.upper[i - 1];
      if (upper !== null && close > upper) return [this.marketBuy((ctx.cash * this.params.allocationPct) / 100, 'breakout')];
    } else {
      const lower = this.lower[i - 1];
      if (lower !== null && close < lower) return [this.marketSellAll('channel exit')];
    }
    return [];
  }
}

export const donchianBreakoutDefinition: StrategyDefinition = {
  id: 'donchian-breakout',
  name: 'Donchian Breakout',
  description: 'Buys a close above the N-bar high and exits on a close below the M-bar low (Turtle-style trend following).',
  params: DONCHIAN_BREAKOUT_PARAMS,
  validate: (values) => validateParams(DONCHIAN_BREAKOUT_PARAMS, values),
  create: (values) =>
    new DonchianBreakoutStrategy({
      entryPeriod: numberParam(values, 'entryPeriod'),
      exitPeriod: numberParam(values, 'exitPeriod'),
      allocationPct: numberParam(values, 'allocationPct'),
    }),
};
