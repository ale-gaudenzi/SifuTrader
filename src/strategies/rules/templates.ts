/**
 * Starting points offered by the strategy builder. Several reproduce the
 * hand-written strategies with their default parameters, which the tests use
 * to check that the compiler trades exactly like them.
 */
import { defaultIndicatorParams } from './catalog';
import { blankSpec, defaultRisk, emptyGroup, numberOperand, priceOperand, type CompareOp, type Condition, type Group, type IndicatorName, type Operand, type RuleStrategySpec } from './spec';

export const TEMPLATE_IDS = [
  'blank',
  'smaCross',
  'goldenCross',
  'rsiReversion',
  'bollingerReversion',
  'donchianBreakout',
  'macdCross',
  'momentum',
  'supertrend',
  'dca',
  'martingale',
] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

const ind = (name: IndicatorName, params: number[] = defaultIndicatorParams(name), extra: { input?: Operand; shift?: number } = {}): Operand => ({
  kind: 'indicator',
  name,
  params,
  ...extra,
});
const all = (...items: Condition[]): Group => ({ kind: 'group', mode: 'all', items });
const cmp = (left: Operand, op: CompareOp, right: Operand): Condition => ({ kind: 'compare', left, op, right });

/** Builds the spec of a template; names and descriptions are localized by the UI. */
export function templateSpec(template: TemplateId, id: string, name: string): RuleStrategySpec {
  const spec = blankSpec(id, name);
  const close = priceOperand('close');
  switch (template) {
    case 'blank':
      return spec;
    case 'smaCross': {
      const fast = ind('sma', [20]);
      const slow = ind('sma', [50]);
      spec.entry.when = all(cmp(fast, 'crossAbove', slow));
      spec.exits = [{ when: all(cmp(fast, 'crossBelow', slow)), order: { type: 'market' }, amountPct: 100 }];
      return spec;
    }
    case 'goldenCross': {
      const fast = ind('sma', [50]);
      const slow = ind('sma', [200]);
      spec.entry.when = all(cmp(fast, 'crossAbove', slow));
      spec.exits = [{ when: all(cmp(fast, 'crossBelow', slow)), order: { type: 'market' }, amountPct: 100 }];
      spec.risk = { ...defaultRisk(), stopLoss: { mode: 'pct', value: 8 }, trailingStop: { mode: 'pct', value: 15 } };
      return spec;
    }
    case 'rsiReversion': {
      const r = ind('rsi', [14]);
      spec.entry.when = all(cmp(r, 'lt', numberOperand(30)));
      spec.exits = [{ when: all(cmp(r, 'gt', numberOperand(55))), order: { type: 'market' }, amountPct: 100 }];
      return spec;
    }
    case 'bollingerReversion':
      spec.entry.when = all(cmp(close, 'lt', ind('bbLower', [20, 2])));
      spec.exits = [{ when: all(cmp(close, 'gte', ind('bbMiddle', [20]))), order: { type: 'market' }, amountPct: 100 }];
      return spec;
    case 'donchianBreakout':
      // The channel of the previous bars: the breakout bar must not set its own level.
      spec.entry.when = all(cmp(close, 'gt', ind('highest', [20], { input: priceOperand('high'), shift: 1 })));
      spec.exits = [{ when: all(cmp(close, 'lt', ind('lowest', [10], { input: priceOperand('low'), shift: 1 }))), order: { type: 'market' }, amountPct: 100 }];
      return spec;
    case 'macdCross': {
      const line = ind('macd', [12, 26, 9]);
      const signal = ind('macdSignal', [12, 26, 9]);
      spec.entry.when = all(cmp(line, 'crossAbove', signal));
      spec.exits = [{ when: all(cmp(line, 'crossBelow', signal)), order: { type: 'market' }, amountPct: 100 }];
      return spec;
    }
    case 'momentum': {
      const r = ind('roc', [126]);
      spec.entry.when = all(cmp(r, 'gt', numberOperand(0)));
      spec.exits = [{ when: all(cmp(r, 'lte', numberOperand(0))), order: { type: 'market' }, amountPct: 100 }];
      return spec;
    }
    case 'supertrend': {
      const st = ind('supertrend', [10, 3]);
      spec.entry.when = all(cmp(close, 'crossAbove', st), cmp(ind('adx', [14]), 'gt', numberOperand(20)));
      spec.exits = [{ when: all(cmp(close, 'crossBelow', st)), order: { type: 'market' }, amountPct: 100 }];
      spec.risk = { ...defaultRisk(), stopLoss: { mode: 'atr', value: 3 } };
      return spec;
    }
    case 'dca': {
      const every: Condition = { kind: 'calendar', event: 'everyN', value: 21 };
      spec.entry = { when: all(every), order: { type: 'market' }, size: { mode: 'initialPct', value: 2 } };
      spec.scaleIn = { enabled: true, when: all(every), order: { type: 'market' }, size: { mode: 'initialPct', value: 2 }, multiplier: 1, maxEntries: 10_000 };
      return spec;
    }
    case 'martingale':
      spec.entry = { when: emptyGroup(), order: { type: 'market' }, size: { mode: 'equityPct', value: 3 } };
      spec.scaleIn = {
        enabled: true,
        when: emptyGroup(),
        order: { type: 'limit', price: { kind: 'position', field: 'lastBuyPrice', pct: -2 } },
        size: { mode: 'equityPct', value: 6 },
        multiplier: 2,
        maxEntries: 5,
      };
      spec.risk = { ...defaultRisk(), takeProfit: { mode: 'pct', value: 3 } };
      return spec;
  }
}
