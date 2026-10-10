import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseOhlcvCsv } from '../../data/csv';
import { DEFAULT_CONFIG, runBacktest } from '../../engine/backtester';
import type { BacktestConfig, Bar, StrategyDefinition } from '../../engine/types';
import { bollingerReversionDefinition } from '../bollingerReversion';
import { dcaDefinition } from '../dca';
import { donchianBreakoutDefinition } from '../donchianBreakout';
import { macdCrossDefinition } from '../macdCross';
import { momentumDefinition } from '../momentum';
import { rsiReversionDefinition } from '../rsiReversion';
import { smaCrossDefinition } from '../smaCross';
import { INDICATOR_INFO, defaultIndicatorParams } from './catalog';
import { RuleStrategy, countSignals, ruleDefinition } from './compile';
import { INDICATORS, blankSpec, numberOperand, priceOperand, type Condition, type Operand, type RuleStrategySpec } from './spec';
import { TEMPLATE_IDS, templateSpec, type TemplateId } from './templates';
import { parseSpec, validateSpec } from './validate';

const DAY = 86_400;
const T0 = Date.UTC(2024, 0, 1) / 1000;
const NO_COSTS: BacktestConfig = { initialCapital: 10_000, feePct: 0, slippagePct: 0 };

function loadSampleBars(file: string): Bar[] {
  return parseOhlcvCsv(readFileSync(new URL(`../../../public/sample_data/${file}`, import.meta.url), 'utf8')).bars;
}

function bar(i: number, open: number, high: number, low: number, close: number): Bar {
  return { time: T0 + i * DAY, open, high, low, close, volume: 1000 };
}

/** Flat-range bars (open = previous close) from a list of closes. */
function barsFromCloses(values: readonly number[]): Bar[] {
  return values.map((c, i) => {
    const o = i === 0 ? c : values[i - 1];
    return bar(i, o, Math.max(o, c) * 1.001, Math.min(o, c) * 0.999, c);
  });
}

const fillsOf = (bars: Bar[], spec: RuleStrategySpec, cfg: BacktestConfig = NO_COSTS) => runBacktest(bars, new RuleStrategy(spec), cfg).fills;
const always = (): RuleStrategySpec => blankSpec('t', 'Test');

describe('rule strategies reproduce the hand-written strategies', () => {
  const cases: ReadonlyArray<[TemplateId, StrategyDefinition, Record<string, number | boolean>]> = [
    ['smaCross', smaCrossDefinition, { fastPeriod: 20, slowPeriod: 50, allocationPct: 100 }],
    ['rsiReversion', rsiReversionDefinition, { rsiPeriod: 14, entryLevel: 30, exitLevel: 55, allocationPct: 100 }],
    ['bollingerReversion', bollingerReversionDefinition, { period: 20, stdDev: 2, exitAtUpper: false, allocationPct: 100 }],
    ['donchianBreakout', donchianBreakoutDefinition, { entryPeriod: 20, exitPeriod: 10, allocationPct: 100 }],
    ['macdCross', macdCrossDefinition, { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, belowZeroOnly: false, allocationPct: 100 }],
    ['momentum', momentumDefinition, { lookback: 126, thresholdPct: 0, allocationPct: 100 }],
    ['dca', dcaDefinition, { intervalBars: 21, amountPct: 2 }],
  ];

  for (const file of ['AAPL.csv', 'BTC-USD.csv']) {
    const bars = loadSampleBars(file);
    for (const [template, definition, params] of cases) {
      it(`${template} on ${file}`, () => {
        const expected = runBacktest(bars, definition.create(params), DEFAULT_CONFIG).fills;
        const actual = fillsOf(bars, templateSpec(template, 't', template), DEFAULT_CONFIG);
        expect(expected.length).toBeGreaterThan(0);
        expect(actual.map((f) => [f.barIndex, f.side])).toEqual(expected.map((f) => [f.barIndex, f.side]));
        actual.forEach((f, k) => {
          expect(f.price).toBeCloseTo(expected[k].price, 8);
          expect(f.quantity).toBeCloseTo(expected[k].quantity, 8);
        });
      });
    }
  }
});

describe('rule strategies are causal', () => {
  const bars = loadSampleBars('AAPL.csv');

  it('computes every indicator causally', () => {
    const cut = 400;
    for (const name of INDICATORS) {
      const info = INDICATOR_INFO[name];
      const source = bars.map((b) => b.close);
      const full = info.compute(source, bars, defaultIndicatorParams(name));
      const head = info.compute(source.slice(0, cut), bars.slice(0, cut), defaultIndicatorParams(name));
      expect(full.slice(0, cut), name).toEqual(head);
      expect(full.some((v) => v !== null), name).toBe(true);
    }
  });

  it('reproduces the full run on a truncated history', () => {
    const spec = always();
    const fast: Operand = { kind: 'indicator', name: 'ema', params: [10], input: { kind: 'indicator', name: 'rsi', params: [14] } };
    spec.entry.when = {
      kind: 'group',
      mode: 'any',
      items: [
        { kind: 'compare', left: fast, op: 'crossAbove', right: numberOperand(50), hold: { mode: 'within', bars: 3 } },
        {
          kind: 'group',
          mode: 'all',
          items: [
            { kind: 'pattern', pattern: 'bullishEngulfing' },
            { kind: 'trend', left: { kind: 'indicator', name: 'supertrend', params: [10, 3] }, direction: 'rising', bars: 2 },
          ],
        },
      ],
    };
    spec.entry.order = { type: 'limit', price: { kind: 'price', field: 'close', pct: -0.5 } };
    spec.scaleIn = { enabled: true, when: { kind: 'group', mode: 'all', items: [] }, order: { type: 'limit', price: { kind: 'position', field: 'lastBuyPrice', pct: -3 } }, size: { mode: 'equityPct', value: 10 }, multiplier: 1.5, maxEntries: 4 };
    spec.exits = [
      { when: { kind: 'group', mode: 'all', items: [{ kind: 'compare', left: { kind: 'position', field: 'pnlPct' }, op: 'gt', right: numberOperand(4) }] }, order: { type: 'market' }, amountPct: 50 },
      { when: { kind: 'group', mode: 'all', items: [{ kind: 'compare', left: priceOperand(), op: 'lt', right: { kind: 'indicator', name: 'keltnerLower', params: [20, 2], shift: 1 } }] }, order: { type: 'market' }, amountPct: 100 },
    ];
    spec.risk = { ...spec.risk, stopLoss: { mode: 'atr', value: 2 }, trailingStop: { mode: 'pct', value: 12 }, breakEven: { enabled: true, value: 6 }, maxBars: 80, cooldownBars: 3 };
    expect(validateSpec(spec)).toEqual([]);

    const full = runBacktest(bars, new RuleStrategy(spec), DEFAULT_CONFIG);
    expect(full.fills.length).toBeGreaterThan(10);
    for (const cut of [300, 700, 1000]) {
      const part = runBacktest(bars.slice(0, cut), new RuleStrategy(spec), DEFAULT_CONFIG);
      const expected = full.fills.filter((f) => f.barIndex < cut);
      expect(part.fills).toEqual(expected);
      expect(part.equityCurve).toEqual(full.equityCurve.slice(0, cut));
    }
  });
});

describe('risk management', () => {
  it('exits on a stop-loss at the stop price, from the bar after the entry', () => {
    const spec = always();
    spec.risk.stopLoss = { mode: 'pct', value: 5 };
    // Entry at the open of bar 1 (100). Bar 3 trades down to 90: the stop at 95 fills there.
    const bars = [bar(0, 100, 101, 99, 100), bar(1, 100, 102, 99, 101), bar(2, 101, 103, 99, 102), bar(3, 101, 101, 90, 92), bar(4, 92, 93, 91, 92)];
    const fills = fillsOf(bars, spec);
    expect(fills.slice(0, 2).map((f) => [f.side, f.barIndex, f.tag])).toEqual([
      ['buy', 1, 'entry'],
      ['sell', 3, 'stop loss'],
    ]);
    expect(fills[1].price).toBeCloseTo(95);
  });

  it('fills a stop-loss at the open when the market gaps through it', () => {
    const spec = always();
    spec.risk.stopLoss = { mode: 'pct', value: 5 };
    const bars = [bar(0, 100, 101, 99, 100), bar(1, 100, 102, 99, 101), bar(2, 88, 89, 85, 86), bar(3, 86, 87, 85, 86)];
    expect(fillsOf(bars, spec)[1]).toMatchObject({ barIndex: 2, price: 88, tag: 'stop loss' });
  });

  it('trails the stop below the highest price since entry', () => {
    const spec = always();
    spec.risk.trailingStop = { mode: 'pct', value: 10 };
    const bars = barsFromCloses([100, 100, 110, 120, 130, 125, 115, 110, 100]);
    const fills = fillsOf(bars, spec);
    // The peak reaches 130 * 1.001 on bar 4, so the stop sits near 117.1 and the drop to 115 on bar 6 hits it.
    expect(fills[1]).toMatchObject({ side: 'sell', barIndex: 6, tag: 'trailing stop' });
    expect(fills[1].price).toBeCloseTo(130 * 1.001 * 0.9);
  });

  it('takes profit at a limit above the average entry price', () => {
    const spec = always();
    spec.risk.takeProfit = { mode: 'pct', value: 10 };
    const bars = barsFromCloses([100, 100, 105, 112, 108]);
    const fills = fillsOf(bars, spec);
    expect(fills[1]).toMatchObject({ side: 'sell', barIndex: 3, tag: 'take profit' });
    expect(fills[1].price).toBeCloseTo(110);
  });

  it('moves the stop to break-even once the gain reaches the trigger', () => {
    const spec = always();
    spec.risk.stopLoss = { mode: 'pct', value: 20 };
    spec.risk.breakEven = { enabled: true, value: 5 };
    const bars = barsFromCloses([100, 100, 106, 103, 98, 97]);
    const fills = fillsOf(bars, spec);
    expect(fills[1]).toMatchObject({ side: 'sell', barIndex: 4, tag: 'break-even' });
    expect(fills[1].price).toBeCloseTo(100);
  });

  it('closes after the maximum holding time and waits for the cooldown', () => {
    const spec = always();
    spec.risk.maxBars = 3;
    spec.risk.cooldownBars = 2;
    const bars = barsFromCloses(Array.from({ length: 12 }, () => 100));
    const fills = fillsOf(bars, spec);
    // Buy at 1, held 3 bars -> sell order at the close of 4, filled at 5; flat at 5, re-entry allowed from the close of 7.
    // The second trade would close at the close of bar 11, the last one, so it stays open.
    expect(fills.map((f) => [f.side, f.barIndex, f.tag])).toEqual([
      ['buy', 1, 'entry'],
      ['sell', 5, 'time exit'],
      ['buy', 8, 'entry'],
    ]);
  });

  it('sells a partial exit only once per trade', () => {
    const spec = always();
    spec.exits = [{ when: { kind: 'group', mode: 'all', items: [{ kind: 'compare', left: priceOperand(), op: 'gt', right: numberOperand(104) }] }, order: { type: 'market' }, amountPct: 50 }];
    const bars = barsFromCloses([100, 100, 105, 106, 107, 108]);
    const fills = fillsOf(bars, spec);
    expect(fills.map((f) => [f.side, f.barIndex])).toEqual([
      ['buy', 1],
      ['sell', 3],
    ]);
    expect(fills[1].quantity).toBeCloseTo(fills[0].quantity / 2);
  });

  it('enters on a stop order above the market (breakout entry)', () => {
    const spec = always();
    spec.entry.order = { type: 'stop', price: { kind: 'price', field: 'high' } };
    const bars = [bar(0, 100, 101, 99, 100), bar(1, 100, 100.5, 99, 100), bar(2, 100, 104, 99, 103)];
    // Bar 1 never trades above bar 0's high (101); bar 2 does, above bar 1's high (100.5).
    expect(fillsOf(bars, spec)[0]).toMatchObject({ side: 'buy', barIndex: 2, price: 100.5 });
  });

  it('scales in with a growing size up to the maximum number of entries', () => {
    const spec = templateSpec('martingale', 't', 'm');
    spec.risk.takeProfit = { mode: 'off', value: 3 };
    const bars = barsFromCloses([100, 100, 97, 94, 91, 88, 85, 82]);
    const buys = fillsOf(bars, spec).filter((f) => f.side === 'buy');
    expect(buys).toHaveLength(5);
    const sizes = buys.map((f) => f.price * f.quantity);
    expect(sizes[2] / sizes[1]).toBeGreaterThan(1.8);
  });
});

describe('conditions', () => {
  const closes = [10, 11, 12, 11, 10, 11, 12, 13, 14, 13];
  const bars = barsFromCloses(closes);
  const entryCount = (c: Condition): number => {
    const spec = always();
    spec.entry.when = { kind: 'group', mode: 'all', items: [c] };
    return countSignals(spec, bars).entry;
  };

  it('compares values, including a past value and a percentage offset', () => {
    expect(entryCount({ kind: 'compare', left: priceOperand(), op: 'gt', right: numberOperand(12) })).toBe(3);
    expect(entryCount({ kind: 'compare', left: priceOperand(), op: 'gt', right: { kind: 'price', field: 'close', shift: 1 } })).toBe(6);
    expect(entryCount({ kind: 'compare', left: priceOperand(), op: 'gte', right: { kind: 'price', field: 'close', shift: 1, pct: 9 } })).toBe(4);
  });

  it('detects crosses and trends', () => {
    expect(entryCount({ kind: 'compare', left: priceOperand(), op: 'crossAbove', right: numberOperand(11.5) })).toBe(2);
    expect(entryCount({ kind: 'compare', left: priceOperand(), op: 'cross', right: numberOperand(11.5) })).toBe(3);
    expect(entryCount({ kind: 'trend', left: priceOperand(), direction: 'rising', bars: 3 })).toBe(2);
  });

  it('requires a condition for several bars or within the last bars', () => {
    const up: Condition = { kind: 'pattern', pattern: 'higherClose' };
    expect(entryCount(up)).toBe(6);
    expect(entryCount({ ...up, hold: { mode: 'for', bars: 2 } })).toBe(4);
    expect(entryCount({ kind: 'compare', left: priceOperand(), op: 'crossAbove', right: numberOperand(11.5), hold: { mode: 'within', bars: 2 } })).toBe(4);
  });

  it('matches calendar events', () => {
    // 2024-01-01 is a Monday.
    expect(entryCount({ kind: 'calendar', event: 'weekday', value: 1 })).toBe(2);
    expect(entryCount({ kind: 'calendar', event: 'newWeek', value: 0 })).toBe(2);
    expect(entryCount({ kind: 'calendar', event: 'everyN', value: 4 })).toBe(3);
  });
});

describe('spec parsing and validation', () => {
  it('validates every template', () => {
    for (const id of TEMPLATE_IDS) expect(validateSpec(templateSpec(id, 't', id)), id).toEqual([]);
  });

  it('round-trips through JSON and keeps cleared numbers as NaN', () => {
    const spec = templateSpec('supertrend', 'abc', 'Name');
    expect(parseSpec(JSON.parse(JSON.stringify(spec)))).toEqual(spec);

    spec.risk.stopLoss.value = Number.NaN;
    const parsed = parseSpec(JSON.parse(JSON.stringify(spec)));
    expect(parsed?.risk.stopLoss.value).toBeNaN();
    expect(validateSpec(parsed ?? spec)).toContainEqual({ section: 'risk', code: 'range', field: 'stopLoss', min: 0.1, max: 50 });
  });

  it('rejects malformed input', () => {
    expect(parseSpec(null)).toBeNull();
    expect(parseSpec({ version: 2 })).toBeNull();
    const spec = JSON.parse(JSON.stringify(templateSpec('smaCross', 'x', 'x'))) as { entry: { when: { items: Array<{ left: { name: string } }> } } };
    spec.entry.when.items[0].left.name = 'nope';
    expect(parseSpec(spec)).toBeNull();
    expect(parseSpec({ ...templateSpec('blank', 'bad id!', 'x') })).toBeNull();
  });

  it('flags misplaced position values and empty exits', () => {
    const spec = always();
    spec.entry.when = { kind: 'group', mode: 'all', items: [{ kind: 'compare', left: { kind: 'position', field: 'pnlPct' }, op: 'gt', right: numberOperand(1) }] };
    spec.exits = [{ when: { kind: 'group', mode: 'all', items: [] }, order: { type: 'market' }, amountPct: 100 }];
    spec.scaleIn.enabled = true;
    spec.scaleIn.when = {
      kind: 'group',
      mode: 'all',
      items: [{ kind: 'compare', left: { kind: 'position', field: 'pnlPct' }, op: 'crossBelow', right: numberOperand(-5) }],
    };
    const codes = validateSpec(spec).map((i) => `${i.section}:${i.code}`);
    expect(codes).toEqual(['entry:positionInEntry', 'scaleIn:positionMisuse', 'exit:exitEmpty']);
  });

  it('reports invalid indicator parameters', () => {
    const spec = always();
    spec.entry.when = { kind: 'group', mode: 'all', items: [{ kind: 'compare', left: { kind: 'indicator', name: 'sma', params: [2.5] }, op: 'gt', right: priceOperand() }] };
    expect(validateSpec(spec)).toEqual([{ section: 'entry', code: 'integer', field: 'indicator' }]);
    expect(ruleDefinition(spec).validate({})).toEqual(['entry: integer']);
  });
});
