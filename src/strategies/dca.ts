/**
 * Dollar-cost averaging (periodic accumulation).
 *
 * Buys a fixed amount every `intervalBars` bars, starting on the first bar,
 * until the cash runs out. It never sells: the result is a single open trade
 * to compare against lump-sum buy and hold. Contributions are sized from the
 * initial capital, so the schedule is the same whatever the price path.
 */
import type { Order, ParamSpec, ParamValues, StrategyContext, StrategyDefinition } from '../engine/types';
import { BaseStrategy, numberParam, periodParam, validateParams } from './base';

export interface DcaParams extends ParamValues {
  intervalBars: number;
  amountPct: number;
}

export const DCA_PARAMS: readonly ParamSpec[] = [
  periodParam('intervalBars', 'Interval', 21, 'Bars between purchases (21 daily bars is about one month).', 1, 400),
  {
    key: 'amountPct',
    label: 'Amount',
    type: 'number',
    default: 2,
    min: 0.1,
    max: 100,
    step: 0.1,
    unit: '%',
    description: 'Size of each purchase as a percentage of the initial capital.',
  },
];

export class DcaStrategy extends BaseStrategy<DcaParams> {
  readonly id = 'dca';
  readonly name = 'Dollar-Cost Averaging';

  onBar(ctx: StrategyContext): Order[] {
    if (ctx.index % this.params.intervalBars !== 0 || ctx.cash <= 0) return [];
    return [this.marketBuy((ctx.initialCapital * this.params.amountPct) / 100, 'dca')];
  }
}

export const dcaDefinition: StrategyDefinition = {
  id: 'dca',
  name: 'Dollar-Cost Averaging',
  description: 'Invests a fixed share of the initial capital at regular intervals until the cash runs out, and never sells.',
  params: DCA_PARAMS,
  validate: (values) => validateParams(DCA_PARAMS, values),
  create: (values) =>
    new DcaStrategy({
      intervalBars: numberParam(values, 'intervalBars'),
      amountPct: numberParam(values, 'amountPct'),
    }),
};
