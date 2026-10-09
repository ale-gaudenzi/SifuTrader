/**
 * Martingale dip-buying strategy (long-only averaging down).
 *
 * Cycle:
 * 1. When flat, buy a base order sized as a percentage of equity (or of the
 *    initial capital when compounding is disabled) at the next open.
 * 2. While in a position, keep two resting limit orders for the next bar:
 *    - a scale-in buy at `lastBuyPrice * (1 - dropStep)` whose cash size is
 *      `baseOrder * multiplier^(entries)`, as long as the number of buys in
 *      the cycle is below `maxSteps`;
 *    - a take-profit sell of the whole position at
 *      `averageCost * (1 + takeProfit)`, where average cost includes the
 *      commissions paid on entry.
 * 3. After the take-profit fills, the cycle resets to the base order.
 *
 * Scale-in orders are capped by available cash. Once `maxSteps` buys have
 * been made the strategy stops adding and waits for the take-profit; there is
 * deliberately no stop-loss, which exposes the characteristic tail risk of
 * martingale sizing in the backtest results.
 */
import type { Order, ParamSpec, ParamValues, StrategyContext, StrategyDefinition } from '../engine/types';
import { BaseStrategy, booleanParam, numberParam, validateParams } from './base';

export interface MartingaleParams extends ParamValues {
  baseOrderPct: number;
  dropStepPct: number;
  sizeMultiplier: number;
  maxSteps: number;
  takeProfitPct: number;
  compound: boolean;
}

export const MARTINGALE_PARAMS: readonly ParamSpec[] = [
  {
    key: 'baseOrderPct',
    label: 'Base Order',
    type: 'number',
    default: 3,
    min: 0.1,
    max: 100,
    step: 0.5,
    unit: '%',
    description: 'Size of the first buy of each cycle as a percentage of equity.',
  },
  {
    key: 'dropStepPct',
    label: 'Drop Step',
    type: 'number',
    default: 2,
    min: 0.1,
    max: 50,
    step: 0.1,
    unit: '%',
    description: 'Price decline from the last buy that triggers the next scale-in order.',
  },
  {
    key: 'sizeMultiplier',
    label: 'Size Multiplier',
    type: 'number',
    default: 2,
    min: 1,
    max: 5,
    step: 0.1,
    unit: 'x',
    description: 'Each scale-in order is this multiple of the previous order size.',
  },
  {
    key: 'maxSteps',
    label: 'Max Steps',
    type: 'number',
    default: 5,
    min: 1,
    max: 20,
    step: 1,
    integer: true,
    description: 'Maximum number of buys per cycle, including the base order.',
  },
  {
    key: 'takeProfitPct',
    label: 'Take Profit',
    type: 'number',
    default: 3,
    min: 0.1,
    max: 100,
    step: 0.1,
    unit: '%',
    description: 'Unrealized gain over average cost (incl. entry fees) that liquidates the position.',
  },
  {
    key: 'compound',
    label: 'Compound',
    type: 'boolean',
    default: true,
    description: 'Size the base order from current equity instead of the initial capital.',
  },
];

export class MartingaleStrategy extends BaseStrategy<MartingaleParams> {
  readonly id = 'martingale';
  readonly name = 'Martingale Dip-Buying';

  /** Cash size of the base order for the cycle in progress. */
  private cycleBaseCash = 0;

  onBar(ctx: StrategyContext): Order[] {
    const p = this.params;

    if (this.isFlat(ctx)) {
      const reference = p.compound ? ctx.equity : ctx.initialCapital;
      this.cycleBaseCash = (reference * p.baseOrderPct) / 100;
      if (this.cycleBaseCash <= 0 || ctx.cash <= 0) return [];
      return [this.marketBuy(this.cycleBaseCash, 'base')];
    }

    const { position } = ctx;
    const orders: Order[] = [];

    const averageCost = position.costBasis / position.quantity;
    orders.push(this.limitSellAll(averageCost * (1 + p.takeProfitPct / 100), 'take-profit'));

    if (position.entries < p.maxSteps && position.lastBuyPrice !== null && ctx.cash > 0) {
      const trigger = position.lastBuyPrice * (1 - p.dropStepPct / 100);
      const size = this.cycleBaseCash * Math.pow(p.sizeMultiplier, position.entries);
      orders.push(this.limitBuy(trigger, size, `step ${position.entries + 1}`));
    }

    return orders;
  }
}

export const martingaleDefinition: StrategyDefinition = {
  id: 'martingale',
  name: 'Martingale Dip-Buying',
  description:
    'Buys a base allocation, scales in with geometrically larger orders on each fixed-percentage drop, ' +
    'and exits the whole position at a take-profit over average cost.',
  params: MARTINGALE_PARAMS,
  validate: (values) => validateParams(MARTINGALE_PARAMS, values),
  create: (values) =>
    new MartingaleStrategy({
      baseOrderPct: numberParam(values, 'baseOrderPct'),
      dropStepPct: numberParam(values, 'dropStepPct'),
      sizeMultiplier: numberParam(values, 'sizeMultiplier'),
      maxSteps: numberParam(values, 'maxSteps'),
      takeProfitPct: numberParam(values, 'takeProfitPct'),
      compound: booleanParam(values, 'compound'),
    }),
};
