/**
 * Deterministic, bar-by-bar portfolio simulator.
 *
 * Execution model (long-only, single instrument, fractional units):
 *
 * 1. At the close of bar `i` the strategy receives a context restricted to
 *    bars `0..i` and returns a list of orders.
 * 2. Those orders are evaluated against bar `i + 1` only, then expire.
 *    - Market orders fill at the open of bar `i + 1` (with slippage).
 *    - Limit buys fill at the open if it gaps below the limit, otherwise at
 *      the limit price if the bar's low reaches it. Limit sells mirror this
 *      using the high. Limit fills are not subject to slippage.
 * 3. When several orders trigger inside the same bar, they are executed in the
 *    order in which an assumed intrabar path reaches their prices:
 *    open -> low -> high -> close for up bars, open -> high -> low -> close
 *    for down bars. Ties preserve submission order.
 * 4. The portfolio is marked to market at the close of each bar.
 *
 * Because a decision made with information from bar `i` can only be executed
 * on bar `i + 1`, the simulation has no lookahead bias.
 */
import { inferPeriodsPerYear } from './indicators';
import { computeMetrics } from './metrics';
import type {
  BacktestConfig,
  BacktestResult,
  Bar,
  BarHistory,
  EquityPoint,
  Fill,
  Order,
  ParamValues,
  PositionState,
  Strategy,
  StrategyContext,
  Trade,
} from './types';

/** Quantities below this threshold are treated as zero to absorb float noise. */
const QTY_EPSILON = 1e-12;
/** Buy orders with a notional below this amount are ignored. */
const MIN_NOTIONAL = 1e-6;

export const DEFAULT_CONFIG: BacktestConfig = {
  initialCapital: 10_000,
  feePct: 0.1,
  slippagePct: 0.05,
};

/** Error raised for invalid inputs or strategy contract violations. */
export class BacktestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BacktestError';
  }
}

/** Accumulates the fills of the round trip that is currently open. */
interface TradeAccumulator {
  entryIndex: number;
  entryTime: number;
  buyQty: number;
  buyNotional: number;
  buyCost: number;
  sellQty: number;
  sellNotional: number;
  sellProceeds: number;
  entries: number;
}

interface TriggeredOrder {
  order: Order;
  /** Position along the intrabar path in [0, 3]; 0 means at the open. */
  at: number;
  price: number;
  seq: number;
}

function flatPosition(): PositionState {
  return { quantity: 0, avgEntryPrice: 0, costBasis: 0, entries: 0, lastBuyPrice: null };
}

/**
 * Returns the first position along a piecewise-linear price path at which
 * `price` is touched, or `null` if it never is.
 */
function firstTouch(path: readonly number[], price: number): number | null {
  for (let k = 0; k < path.length - 1; k++) {
    const a = path[k];
    const b = path[k + 1];
    if (a === price) return k;
    if ((a - price) * (b - price) <= 0) {
      return a === b ? k : k + (a - price) / (a - b);
    }
  }
  return path[path.length - 1] === price ? path.length - 1 : null;
}

/** Determines whether and where an order triggers within a bar. */
function evaluateTrigger(order: Order, bar: Bar, path: readonly number[], slippage: number): { at: number; price: number } | null {
  if (order.kind === 'market') {
    const price = order.side === 'buy' ? bar.open * (1 + slippage) : bar.open * (1 - slippage);
    return { at: 0, price };
  }
  if (order.side === 'buy') {
    if (bar.open <= order.price) return { at: 0, price: bar.open };
    if (bar.low > order.price) return null;
  } else {
    if (bar.open >= order.price) return { at: 0, price: bar.open };
    if (bar.high < order.price) return null;
  }
  const at = firstTouch(path, order.price);
  return at === null ? null : { at, price: order.price };
}

function validateOrder(order: Order, strategyId: string, index: number): void {
  const fail = (why: string): never => {
    throw new BacktestError(`Strategy "${strategyId}" emitted an invalid order on bar ${index}: ${why}`);
  };
  if (order.kind === 'limit' && !(Number.isFinite(order.price) && order.price > 0)) fail('limit price must be positive');
  if (order.side === 'buy' && !(Number.isFinite(order.cash) && order.cash >= 0)) fail('buy cash must be a non-negative number');
  if (order.side === 'sell' && order.quantity !== 'all' && !(Number.isFinite(order.quantity) && order.quantity >= 0)) {
    fail('sell quantity must be a non-negative number or "all"');
  }
}

export function validateBars(bars: readonly Bar[]): void {
  if (bars.length < 2) throw new BacktestError('At least two bars are required to run a backtest.');
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (![b.open, b.high, b.low, b.close].every((v) => Number.isFinite(v) && v > 0)) {
      throw new BacktestError(`Bar ${i} contains non-positive or non-finite prices.`);
    }
    if (i > 0 && b.time <= bars[i - 1].time) {
      throw new BacktestError(`Bars must be strictly increasing in time (violation at index ${i}).`);
    }
  }
}

export function validateConfig(config: BacktestConfig): void {
  if (!(Number.isFinite(config.initialCapital) && config.initialCapital > 0)) {
    throw new BacktestError('Initial capital must be a positive number.');
  }
  if (!(config.feePct >= 0 && config.feePct < 100)) throw new BacktestError('Fee must be between 0% and 100%.');
  if (!(config.slippagePct >= 0 && config.slippagePct < 100)) throw new BacktestError('Slippage must be between 0% and 100%.');
}

/**
 * Runs `strategy` over `bars` and returns fills, round-trip trades, the equity
 * curve against a buy-and-hold benchmark, and summary metrics.
 *
 * The benchmark invests the full initial capital at the first bar's close
 * (the same instant the strategy makes its first decision) without fees.
 */
export function runBacktest(
  bars: readonly Bar[],
  strategy: Strategy,
  config: BacktestConfig = DEFAULT_CONFIG,
  params: ParamValues = {},
): BacktestResult {
  validateBars(bars);
  validateConfig(config);

  const fee = config.feePct / 100;
  const slippage = config.slippagePct / 100;

  let cash = config.initialCapital;
  let position = flatPosition();
  let cursor = 0;
  let pending: Order[] = [];
  let acc: TradeAccumulator | null = null;
  let totalFees = 0;
  let barsInMarket = 0;
  let peakEquity = config.initialCapital;

  const fills: Fill[] = [];
  const trades: Trade[] = [];
  const equityCurve: EquityPoint[] = [];
  const benchmarkBase = bars[0].close;

  const history: BarHistory = {
    get length() {
      return cursor + 1;
    },
    at(i: number): Bar {
      if (!Number.isInteger(i) || i < 0 || i > cursor) {
        throw new BacktestError(`Lookahead violation: bar ${i} requested while current bar is ${cursor}.`);
      }
      return bars[i];
    },
    ago(n: number): Bar {
      return this.at(cursor - n);
    },
  };

  const closeTrade = (exitIndex: number, exitTime: number): void => {
    if (acc === null) return;
    const pnl = acc.sellProceeds - acc.buyCost;
    trades.push({
      id: trades.length + 1,
      entryTime: acc.entryTime,
      exitTime,
      avgEntryPrice: acc.buyNotional / acc.buyQty,
      exitPrice: acc.sellNotional / acc.sellQty,
      quantity: acc.buyQty,
      costBasis: acc.buyCost,
      proceeds: acc.sellProceeds,
      pnl,
      roiPct: (pnl / acc.buyCost) * 100,
      entries: acc.entries,
      barsHeld: exitIndex - acc.entryIndex,
      isOpen: false,
    });
    acc = null;
  };

  const executeBuy = (order: Order & { side: 'buy' }, price: number, index: number, bar: Bar): Fill | null => {
    const budget = Math.min(order.cash, cash);
    if (budget < MIN_NOTIONAL) return null;
    const quantity = budget / (price * (1 + fee));
    const notional = quantity * price;
    const commission = notional * fee;
    cash = Math.max(0, cash - notional - commission);
    totalFees += commission;

    const newQty = position.quantity + quantity;
    position = {
      quantity: newQty,
      avgEntryPrice: (position.avgEntryPrice * position.quantity + notional) / newQty,
      costBasis: position.costBasis + notional + commission,
      entries: position.entries + 1,
      lastBuyPrice: price,
    };

    if (acc === null) {
      acc = {
        entryIndex: index,
        entryTime: bar.time,
        buyQty: 0,
        buyNotional: 0,
        buyCost: 0,
        sellQty: 0,
        sellNotional: 0,
        sellProceeds: 0,
        entries: 0,
      };
    }
    acc.buyQty += quantity;
    acc.buyNotional += notional;
    acc.buyCost += notional + commission;
    acc.entries += 1;

    return { barIndex: index, time: bar.time, side: 'buy', price, quantity, fee: commission, tag: order.tag };
  };

  const executeSell = (order: Order & { side: 'sell' }, price: number, index: number, bar: Bar): Fill | null => {
    const requested = order.quantity === 'all' ? position.quantity : Math.min(order.quantity, position.quantity);
    if (requested <= QTY_EPSILON) return null;
    const notional = requested * price;
    const commission = notional * fee;
    cash += notional - commission;
    totalFees += commission;

    const remaining = position.quantity - requested;
    if (remaining <= QTY_EPSILON) {
      position = flatPosition();
    } else {
      position = {
        ...position,
        quantity: remaining,
        costBasis: position.costBasis * (remaining / position.quantity),
      };
    }

    if (acc !== null) {
      acc.sellQty += requested;
      acc.sellNotional += notional;
      acc.sellProceeds += notional - commission;
      if (position.quantity === 0) closeTrade(index, bar.time);
    }

    return { barIndex: index, time: bar.time, side: 'sell', price, quantity: requested, fee: commission, tag: order.tag };
  };

  strategy.init?.(bars);

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    cursor = i;

    // 1. Execute orders submitted at the previous close against this bar.
    if (pending.length > 0) {
      const path = bar.close >= bar.open ? [bar.open, bar.low, bar.high, bar.close] : [bar.open, bar.high, bar.low, bar.close];
      const triggered: TriggeredOrder[] = [];
      pending.forEach((order, seq) => {
        const t = evaluateTrigger(order, bar, path, slippage);
        if (t !== null) triggered.push({ order, at: t.at, price: t.price, seq });
      });
      triggered.sort((a, b) => a.at - b.at || a.seq - b.seq);

      for (const { order, price } of triggered) {
        const fill = order.side === 'buy' ? executeBuy(order, price, i, bar) : executeSell(order, price, i, bar);
        if (fill !== null) {
          fills.push(fill);
          strategy.onFill?.(fill, { cash, position });
        }
      }
      pending = [];
    }

    // 2. Mark to market at the close.
    const positionValue = position.quantity * bar.close;
    const equity = cash + positionValue;
    if (position.quantity > 0) barsInMarket++;
    if (equity > peakEquity) peakEquity = equity;
    equityCurve.push({
      time: bar.time,
      equity,
      cash,
      positionValue,
      benchmark: config.initialCapital * (bar.close / benchmarkBase),
      drawdownPct: peakEquity > 0 ? (equity / peakEquity - 1) * 100 : 0,
    });

    // 3. Ask the strategy for orders to execute on the next bar.
    if (i < bars.length - 1) {
      const ctx: StrategyContext = {
        index: i,
        bar,
        history,
        cash,
        position,
        equity,
        initialCapital: config.initialCapital,
      };
      const orders = strategy.onBar(ctx);
      for (const order of orders) validateOrder(order, strategy.id, i);
      pending = orders;
    }
  }

  // Report a still-open position as an open trade marked at the last close.
  // The finalized accumulator is read through a local constant because the
  // closures above may reassign `acc`, which defeats control-flow narrowing.
  const openAcc = acc as TradeAccumulator | null;
  if (openAcc !== null && position.quantity > 0) {
    const last = bars[bars.length - 1];
    const markValue = position.quantity * last.close;
    const proceeds = openAcc.sellProceeds + markValue;
    const pnl = proceeds - openAcc.buyCost;
    trades.push({
      id: trades.length + 1,
      entryTime: openAcc.entryTime,
      exitTime: null,
      avgEntryPrice: openAcc.buyNotional / openAcc.buyQty,
      exitPrice: (openAcc.sellNotional + markValue) / openAcc.buyQty,
      quantity: openAcc.buyQty,
      costBasis: openAcc.buyCost,
      proceeds,
      pnl,
      roiPct: (pnl / openAcc.buyCost) * 100,
      entries: openAcc.entries,
      barsHeld: bars.length - 1 - openAcc.entryIndex,
      isOpen: true,
    });
  }

  const metrics = computeMetrics({
    initialCapital: config.initialCapital,
    equityCurve,
    trades,
    totalFills: fills.length,
    totalFees,
    barsInMarket,
    periodsPerYear: inferPeriodsPerYear(bars),
  });

  return {
    strategyId: strategy.id,
    strategyName: strategy.name,
    params: { ...params },
    config: { ...config },
    fills,
    trades,
    equityCurve,
    metrics,
  };
}
