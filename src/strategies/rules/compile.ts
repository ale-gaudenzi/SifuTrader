/**
 * Compiles a `RuleStrategySpec` into an engine `Strategy`.
 *
 * Every series a spec references is computed once in `init` (memoized by its
 * canonical JSON), and conditions become closures over bar indices. Indicators
 * are causal and operands only look back, so the value read at bar `i` never
 * depends on later bars: the engine's truncation test holds for any spec.
 *
 * On each bar close:
 * - flat: if the cooldown has elapsed and the entry conditions hold, submit
 *   the entry order;
 * - in a position: submit the exit rules that hold, a time exit, one
 *   protective stop (the highest of stop-loss, trailing stop and break-even),
 *   the take-profit, and a scale-in when its conditions hold.
 */
import { atr, type Series } from '../../engine/indicators';
import type { Bar, Fill, Order, PortfolioSnapshot, StrategyContext, StrategyDefinition } from '../../engine/types';
import { BaseStrategy } from '../base';
import { INDICATOR_INFO, matchCalendar, matchPattern, priceValue } from './catalog';
import { customStrategyId, type Condition, type ExitRule, type Group, type Operand, type OrderSpec, type PositionField, type RuleStrategySpec, type Sizing } from './spec';
import { validateSpec } from './validate';

type Value = (j: number) => number | null;
type Check = (j: number) => boolean;

/** State of the trade in progress, rebuilt from fills. */
interface TradeState {
  /** Bar of the first entry fill. */
  entryIndex: number;
  /** Highest price since entry: the entry fill, the entry bar's close, then the highs of later bars. */
  peak: number;
  /** ATR at the bar that triggered the entry, for ATR-based stop-loss and take-profit. */
  entryAtr: number | null;
  /** Partial exit rules that already sold in this trade. */
  partialsDone: Set<number>;
}

const EXIT_TAG = 'exit ';

export class RuleStrategy extends BaseStrategy<Record<string, never>> {
  readonly id: string;
  readonly name: string;
  private readonly spec: RuleStrategySpec;

  private bars: readonly Bar[] = [];
  private cache = new Map<string, Series>();
  private atrSeries: Series = [];
  private ctx: StrategyContext | null = null;
  private trade: TradeState | null = null;
  private lastExitIndex: number | null = null;

  private entryWhen: Check = () => false;
  private scaleWhen: Check = () => false;
  private exitWhens: Check[] = [];

  constructor(spec: RuleStrategySpec) {
    super({});
    this.spec = spec;
    this.id = customStrategyId(spec);
    this.name = spec.name;
  }

  override init(bars: readonly Bar[]): void {
    this.bars = bars;
    this.cache = new Map();
    this.ctx = null;
    this.trade = null;
    this.lastExitIndex = null;
    const { entry, scaleIn, exits, risk } = this.spec;
    this.entryWhen = this.group(entry.when, true);
    this.scaleWhen = scaleIn.enabled ? this.group(scaleIn.when, true) : () => false;
    this.exitWhens = exits.map((e) => this.group(e.when, false));
    const usesAtr = [risk.stopLoss, risk.takeProfit, risk.trailingStop].some((l) => l.mode === 'atr');
    this.atrSeries = usesAtr ? atr(bars, risk.atrPeriod) : [];
  }

  /** Bars on which each rule's conditions hold, ignoring position values. For previews. */
  signalCounts(): { entry: number; scaleIn: number; exits: number[] } {
    const count = (check: Check): number => this.bars.reduce((n, _b, i) => n + (check(i) ? 1 : 0), 0);
    return { entry: count(this.entryWhen), scaleIn: count(this.scaleWhen), exits: this.exitWhens.map(count) };
  }

  /* ---------------------------------------------------------------------- */
  /* Series and values                                                      */
  /* ---------------------------------------------------------------------- */

  private memo(key: string, build: () => Series): Series {
    let s = this.cache.get(key);
    if (s === undefined) {
      s = build();
      this.cache.set(key, s);
    }
    return s;
  }

  /** The full series of a price or indicator operand, with its modifiers applied. */
  private series(op: Operand & { kind: 'price' | 'indicator' }): Series {
    return this.memo(JSON.stringify(op), () => {
      const base = op.kind === 'price' ? this.bars.map((b) => priceValue(b, op.field)) : this.indicator(op);
      const shift = op.shift ?? 0;
      const factor = 1 + (op.pct ?? 0) / 100;
      if (shift === 0 && factor === 1) return base;
      return base.map((_v, j) => {
        const v = j - shift >= 0 ? base[j - shift] : null;
        return v === null || v === undefined ? null : v * factor;
      });
    });
  }

  /**
   * Computes an indicator. Input-based indicators run on the defined tail of
   * their source; gaps inside it (rare, e.g. a zero base in a rate of change)
   * carry the previous value forward, which keeps the result causal.
   */
  private indicator(op: Operand & { kind: 'indicator' }): Series {
    const info = INDICATOR_INFO[op.name];
    if (!info.input) return info.compute([], this.bars, op.params);
    const source: Series = op.input && op.input.kind !== 'number' && op.input.kind !== 'position' ? this.series(op.input) : this.series({ kind: 'price', field: 'close' });
    const start = source.findIndex((v) => v !== null);
    const out: Series = new Array<number | null>(this.bars.length).fill(null);
    if (start < 0) return out;
    let last = 0;
    const tail = source.slice(start).map((v) => (v === null ? last : (last = v)));
    info.compute(tail, this.bars.slice(start), op.params).forEach((v, k) => {
      out[start + k] = v;
    });
    return out;
  }

  private value(op: Operand): Value {
    switch (op.kind) {
      case 'number': {
        const v = op.value;
        return () => v;
      }
      case 'position': {
        const factor = 1 + (op.pct ?? 0) / 100;
        const field = op.field;
        return (j) => {
          if (this.ctx === null || j !== this.ctx.index) return null;
          const v = this.positionValue(field, this.ctx);
          return v === null ? null : v * factor;
        };
      }
      default: {
        const s = this.series(op);
        return (j) => (j >= 0 && j < s.length ? s[j] : null);
      }
    }
  }

  private positionValue(field: PositionField, ctx: StrategyContext): number | null {
    const { position } = ctx;
    if (position.quantity <= 0 || this.trade === null) return null;
    switch (field) {
      case 'pnlPct':
        return (ctx.bar.close / position.avgEntryPrice - 1) * 100;
      case 'barsHeld':
        return ctx.index - this.trade.entryIndex;
      case 'entries':
        return position.entries;
      case 'avgEntryPrice':
        return position.avgEntryPrice;
      case 'lastBuyPrice':
        return position.lastBuyPrice;
      case 'highSinceEntry':
        return this.trade.peak;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Conditions                                                             */
  /* ---------------------------------------------------------------------- */

  /** An empty group holds when `emptyHolds` (entry: buy at once) and never otherwise. */
  private group(g: Group, emptyHolds: boolean): Check {
    if (g.items.length === 0) return () => emptyHolds;
    const checks = g.items.map((item) => (item.kind === 'group' ? this.group(item, true) : this.condition(item)));
    return g.mode === 'all' ? (j) => checks.every((c) => c(j)) : (j) => checks.some((c) => c(j));
  }

  private condition(c: Condition): Check {
    const base = this.baseCondition(c);
    if (c.kind === 'calendar' || !c.hold) return base;
    const { mode, bars } = c.hold;
    if (mode === 'for') {
      return (j) => {
        if (j - bars + 1 < 0) return false;
        for (let k = 0; k < bars; k++) if (!base(j - k)) return false;
        return true;
      };
    }
    return (j) => {
      for (let k = 0; k < bars && j - k >= 0; k++) if (base(j - k)) return true;
      return false;
    };
  }

  private baseCondition(c: Condition): Check {
    const bars = this.bars;
    switch (c.kind) {
      case 'compare': {
        const l = this.value(c.left);
        const r = this.value(c.right);
        const at = (j: number): [number, number] | null => {
          const a = l(j);
          const b = r(j);
          return a === null || b === null ? null : [a, b];
        };
        const above = (j: number): boolean => {
          const now = at(j);
          const before = at(j - 1);
          return now !== null && before !== null && before[0] <= before[1] && now[0] > now[1];
        };
        const below = (j: number): boolean => {
          const now = at(j);
          const before = at(j - 1);
          return now !== null && before !== null && before[0] >= before[1] && now[0] < now[1];
        };
        const test = (holds: (a: number, b: number) => boolean): Check => (j) => {
          const v = at(j);
          return v !== null && holds(v[0], v[1]);
        };
        switch (c.op) {
          case 'gt':
            return test((a, b) => a > b);
          case 'lt':
            return test((a, b) => a < b);
          case 'gte':
            return test((a, b) => a >= b);
          case 'lte':
            return test((a, b) => a <= b);
          case 'crossAbove':
            return above;
          case 'crossBelow':
            return below;
          case 'cross':
            return (j) => above(j) || below(j);
        }
        break;
      }
      case 'trend': {
        const v = this.value(c.left);
        const n = c.bars;
        const rising = c.direction === 'rising';
        return (j) => {
          if (j - n < 0) return false;
          for (let k = j - n + 1; k <= j; k++) {
            const a = v(k - 1);
            const b = v(k);
            if (a === null || b === null || (rising ? b <= a : b >= a)) return false;
          }
          return true;
        };
      }
      case 'pattern':
        return (j) => j >= 0 && j < bars.length && matchPattern(c.pattern, bars, j);
      case 'calendar':
        return (j) => j >= 0 && j < bars.length && matchCalendar(c.event, c.value, bars, j);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Orders                                                                 */
  /* ---------------------------------------------------------------------- */

  private cashFor(size: Sizing, ctx: StrategyContext): number {
    switch (size.mode) {
      case 'cashPct':
        return (ctx.cash * size.value) / 100;
      case 'equityPct':
        return (ctx.equity * size.value) / 100;
      case 'initialPct':
        return (ctx.initialCapital * size.value) / 100;
      case 'fixed':
        return size.value;
    }
  }

  private orderPrice(order: OrderSpec & { type: 'limit' | 'stop' }, i: number): number | null {
    const p = this.value(order.price)(i);
    return p !== null && Number.isFinite(p) && p > 0 ? p : null;
  }

  private buy(order: OrderSpec, cash: number, i: number, tag: string): Order | null {
    if (!(cash > 0)) return null;
    if (order.type === 'market') return this.marketBuy(cash, tag);
    const price = this.orderPrice(order, i);
    if (price === null) return null;
    return order.type === 'limit' ? this.limitBuy(price, cash, tag) : this.stopBuy(price, cash, tag);
  }

  private sell(exit: ExitRule, quantity: number | 'all', i: number, tag: string): Order | null {
    if (exit.order.type === 'market') return { kind: 'market', side: 'sell', quantity, tag };
    const price = this.orderPrice(exit.order, i);
    return price === null ? null : { kind: exit.order.type, side: 'sell', price, quantity, tag };
  }

  onBar(ctx: StrategyContext): Order[] {
    this.ctx = ctx;
    const i = ctx.index;
    const { entry, scaleIn, exits, risk } = this.spec;

    if (this.isFlat(ctx)) {
      if (this.lastExitIndex !== null && i - this.lastExitIndex < risk.cooldownBars) return [];
      if (ctx.cash <= 0 || !this.entryWhen(i)) return [];
      const order = this.buy(entry.order, Math.min(this.cashFor(entry.size, ctx), ctx.cash), i, 'entry');
      return order ? [order] : [];
    }

    const trade = this.trade;
    if (trade === null) return [];
    trade.peak = Math.max(trade.peak, i > trade.entryIndex ? ctx.bar.high : ctx.bar.close);

    const orders: Order[] = [];
    let closing = false;
    exits.forEach((exit, k) => {
      const partial = exit.amountPct < 100;
      if (partial && trade.partialsDone.has(k)) return;
      if (!this.exitWhens[k](i)) return;
      const quantity = partial ? (ctx.position.quantity * exit.amountPct) / 100 : 'all';
      const order = this.sell(exit, quantity, i, EXIT_TAG + (k + 1));
      if (order === null) return;
      orders.push(order);
      if (!partial && exit.order.type === 'market') closing = true;
    });

    if (risk.maxBars > 0 && i - trade.entryIndex >= risk.maxBars) {
      orders.push(this.marketSellAll('time exit'));
      closing = true;
    }
    if (closing) return orders;

    const avg = ctx.position.avgEntryPrice;
    const atrNow = this.atrSeries[i] ?? null;
    // Only the highest protective level matters: one stop order covers them all.
    const stops: Array<{ price: number; tag: string }> = [];
    const { stopLoss, trailingStop, takeProfit, breakEven } = risk;
    if (stopLoss.mode === 'pct') stops.push({ price: avg * (1 - stopLoss.value / 100), tag: 'stop loss' });
    if (stopLoss.mode === 'atr' && trade.entryAtr !== null) stops.push({ price: avg - stopLoss.value * trade.entryAtr, tag: 'stop loss' });
    if (trailingStop.mode === 'pct') stops.push({ price: trade.peak * (1 - trailingStop.value / 100), tag: 'trailing stop' });
    if (trailingStop.mode === 'atr' && atrNow !== null) stops.push({ price: trade.peak - trailingStop.value * atrNow, tag: 'trailing stop' });
    if (breakEven.enabled && trade.peak >= avg * (1 + breakEven.value / 100)) stops.push({ price: avg, tag: 'break-even' });
    const protective = stops.filter((s) => s.price > 0).reduce<{ price: number; tag: string } | null>((best, s) => (best === null || s.price > best.price ? s : best), null);
    if (protective !== null) orders.push(this.stopSellAll(protective.price, protective.tag));

    if (takeProfit.mode === 'pct') orders.push(this.limitSellAll(avg * (1 + takeProfit.value / 100), 'take profit'));
    if (takeProfit.mode === 'atr' && trade.entryAtr !== null) orders.push(this.limitSellAll(avg + takeProfit.value * trade.entryAtr, 'take profit'));

    const entries = ctx.position.entries;
    if (scaleIn.enabled && entries < scaleIn.maxEntries && ctx.cash > 0 && this.scaleWhen(i)) {
      const cash = this.cashFor(scaleIn.size, ctx) * Math.pow(scaleIn.multiplier, entries - 1);
      const order = this.buy(scaleIn.order, Math.min(cash, ctx.cash), i, 'scale in');
      if (order) orders.push(order);
    }
    return orders;
  }

  override onFill(fill: Fill, portfolio: PortfolioSnapshot): void {
    if (fill.side === 'buy' && portfolio.position.entries === 1) {
      this.trade = {
        entryIndex: fill.barIndex,
        peak: fill.price,
        entryAtr: this.atrSeries[fill.barIndex - 1] ?? null,
        partialsDone: new Set(),
      };
      return;
    }
    if (fill.side !== 'sell') return;
    if (portfolio.position.quantity <= 0) {
      this.trade = null;
      this.lastExitIndex = fill.barIndex;
    } else if (this.trade !== null && fill.tag?.startsWith(EXIT_TAG)) {
      this.trade.partialsDone.add(Number(fill.tag.slice(EXIT_TAG.length)) - 1);
    }
  }
}

/** Registry entry for a custom strategy; it has no form parameters (it is edited in the builder). */
export function ruleDefinition(spec: RuleStrategySpec): StrategyDefinition {
  return {
    id: customStrategyId(spec),
    name: spec.name,
    description: spec.description,
    params: [],
    validate: () => validateSpec(spec).map((issue) => `${issue.section}: ${issue.code}`),
    create: () => new RuleStrategy(spec),
  };
}

/** Bars on which each rule of `spec` would fire on `bars`, ignoring the position. */
export function countSignals(spec: RuleStrategySpec, bars: readonly Bar[]): { entry: number; scaleIn: number; exits: number[] } {
  const strategy = new RuleStrategy(spec);
  strategy.init(bars);
  return strategy.signalCounts();
}
