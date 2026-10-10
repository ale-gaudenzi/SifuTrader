/**
 * Declarative strategy specification edited by the in-app strategy builder.
 *
 * A spec is plain JSON: it is stored in `localStorage`, exported to files and
 * shared in links, then compiled into an ordinary `Strategy` by `compile.ts`.
 * Nothing in it can reach future bars: operands only look back (`shift >= 0`)
 * and every indicator is causal, so the no-lookahead guarantee of the engine
 * holds for any spec a user can build.
 */

/** Price fields of a bar, plus the usual composite prices. */
export const PRICE_FIELDS = ['close', 'open', 'high', 'low', 'hl2', 'hlc3', 'ohlc4', 'volume'] as const;
export type PriceField = (typeof PRICE_FIELDS)[number];

/** State of the open position, available only to scale-in, exit and order-price rules. */
export const POSITION_FIELDS = ['pnlPct', 'barsHeld', 'entries', 'avgEntryPrice', 'lastBuyPrice', 'highSinceEntry'] as const;
export type PositionField = (typeof POSITION_FIELDS)[number];

export const INDICATORS = [
  'sma', 'ema', 'wma', 'vwma',
  'rsi', 'stochK', 'stochD', 'williamsR', 'cci', 'mfi', 'roc', 'change', 'zscore', 'macd', 'macdSignal', 'macdHist',
  'atr', 'atrPct', 'stdev', 'bbUpper', 'bbMiddle', 'bbLower', 'bbPercentB', 'bbWidth',
  'keltnerUpper', 'keltnerMiddle', 'keltnerLower', 'donchianUpper', 'donchianMiddle', 'donchianLower', 'highest', 'lowest',
  'adx', 'plusDi', 'minusDi', 'aroonUp', 'aroonDown', 'psar', 'supertrend',
  'obv', 'vwap',
] as const;
export type IndicatorName = (typeof INDICATORS)[number];

/** Optional adjustments shared by price and indicator operands. */
export interface OperandModifiers {
  /** Value from this many bars ago (0 = current bar). */
  shift?: number;
  /** Percentage added to the value: `-2` reads "2% below". */
  pct?: number;
}

/** A value that can be compared: a price, an indicator, a constant or a position figure. */
export type Operand =
  | ({ kind: 'price'; field: PriceField } & OperandModifiers)
  | ({ kind: 'indicator'; name: IndicatorName; params: number[]; input?: Operand } & OperandModifiers)
  | { kind: 'number'; value: number }
  | ({ kind: 'position'; field: PositionField } & Pick<OperandModifiers, 'pct'>);

export const COMPARE_OPS = ['gt', 'lt', 'gte', 'lte', 'crossAbove', 'crossBelow', 'cross'] as const;
export type CompareOp = (typeof COMPARE_OPS)[number];

export const PATTERNS = [
  'bullishBar', 'bearishBar', 'doji', 'hammer', 'shootingStar', 'bullishEngulfing', 'bearishEngulfing',
  'insideBar', 'outsideBar', 'gapUp', 'gapDown', 'higherHigh', 'lowerLow', 'higherClose', 'lowerClose',
] as const;
export type Pattern = (typeof PATTERNS)[number];

/** Calendar events. `weekday` is ISO (1 = Monday ... 7 = Sunday); `everyN` counts bars from the first tested bar. */
export const CALENDAR_EVENTS = ['weekday', 'month', 'newWeek', 'newMonth', 'newYear', 'everyN'] as const;
export type CalendarEvent = (typeof CALENDAR_EVENTS)[number];

/** Requires a condition to hold on each of the last `bars` bars (`for`) or on at least one of them (`within`). */
export interface Hold {
  mode: 'for' | 'within';
  bars: number;
}

export type Condition =
  | { kind: 'compare'; left: Operand; op: CompareOp; right: Operand; hold?: Hold }
  | { kind: 'trend'; left: Operand; direction: 'rising' | 'falling'; bars: number; hold?: Hold }
  | { kind: 'pattern'; pattern: Pattern; hold?: Hold }
  | { kind: 'calendar'; event: CalendarEvent; value: number };

/** All (`and`) or any (`or`) of its items must hold. Groups nest one level. */
export interface Group {
  kind: 'group';
  mode: 'all' | 'any';
  items: Array<Condition | Group>;
}

/** How an order is placed on the next bar: at the open, or resting at a price computed now. */
export type OrderSpec = { type: 'market' } | { type: 'limit' | 'stop'; price: Operand };

/**
 * Cash committed by a buy. Percentages refer to the available cash, the
 * current equity or the initial capital; `fixed` is an amount in quote currency.
 */
export interface Sizing {
  mode: 'cashPct' | 'equityPct' | 'initialPct' | 'fixed';
  value: number;
}

export interface EntryRule {
  when: Group;
  order: OrderSpec;
  size: Sizing;
}

export interface ScaleInRule {
  enabled: boolean;
  when: Group;
  order: OrderSpec;
  size: Sizing;
  /** Each further add is this multiple of the previous one (1 = constant size). */
  multiplier: number;
  /** Maximum number of buys in a trade, the initial entry included. */
  maxEntries: number;
}

export interface ExitRule {
  when: Group;
  order: OrderSpec;
  /** Share of the position sold. Partial exits (below 100) fire at most once per trade. */
  amountPct: number;
}

/** A protective level in percent of the reference price or in ATR multiples. */
export interface RiskLevel {
  mode: 'off' | 'pct' | 'atr';
  value: number;
}

/**
 * Exits applied automatically while a position is open, from the bar after
 * the first entry fill. Levels refer to the average entry price; the trailing
 * stop follows the highest price since entry.
 */
export interface RiskRules {
  stopLoss: RiskLevel;
  takeProfit: RiskLevel;
  trailingStop: RiskLevel;
  /** Raises the stop to the average entry price once the gain reaches `value` percent. */
  breakEven: { enabled: boolean; value: number };
  /** Closes the position at market after this many bars (0 = off). */
  maxBars: number;
  /** Bars to wait after a position closes before a new entry. */
  cooldownBars: number;
  /** ATR period used by every level in `atr` mode. */
  atrPeriod: number;
}

export interface RuleStrategySpec {
  version: 1;
  /** Stable identifier; the registered strategy id is `custom-<id>`. */
  id: string;
  name: string;
  description: string;
  entry: EntryRule;
  scaleIn: ScaleInRule;
  exits: ExitRule[];
  risk: RiskRules;
}

export const CUSTOM_PREFIX = 'custom-';

export function customStrategyId(spec: Pick<RuleStrategySpec, 'id'>): string {
  return CUSTOM_PREFIX + spec.id;
}

export const emptyGroup = (mode: Group['mode'] = 'all'): Group => ({ kind: 'group', mode, items: [] });
export const priceOperand = (field: PriceField = 'close'): Operand => ({ kind: 'price', field });
export const numberOperand = (value: number): Operand => ({ kind: 'number', value });

export function defaultRisk(): RiskRules {
  return {
    stopLoss: { mode: 'off', value: 5 },
    takeProfit: { mode: 'off', value: 10 },
    trailingStop: { mode: 'off', value: 10 },
    breakEven: { enabled: false, value: 5 },
    maxBars: 0,
    cooldownBars: 0,
    atrPeriod: 14,
  };
}

/** A spec with no conditions: buys at once with all the cash and never sells. */
export function blankSpec(id: string, name: string): RuleStrategySpec {
  return {
    version: 1,
    id,
    name,
    description: '',
    entry: { when: emptyGroup(), order: { type: 'market' }, size: { mode: 'cashPct', value: 100 } },
    scaleIn: {
      enabled: false,
      when: emptyGroup(),
      order: { type: 'market' },
      size: { mode: 'cashPct', value: 25 },
      multiplier: 1,
      maxEntries: 3,
    },
    exits: [],
    risk: defaultRisk(),
  };
}
