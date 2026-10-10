/**
 * Core domain types shared by the data layer, the backtesting engine,
 * strategies and the UI.
 *
 * Conventions:
 * - Time values are UTC timestamps in whole seconds, aligned to 00:00 UTC of
 *   the bar's trading day (or the first trading day of an aggregated bar).
 * - Prices are expressed in the quote currency of the instrument.
 * - Percentages stored in results are already multiplied by 100
 *   (e.g. `12.5` means 12.5%).
 */

/** A single OHLCV candle. */
export interface Bar {
  /** Bar open time, UTC seconds. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Supported chart / backtest aggregation levels. */
export type Timeframe = '1D' | '1W' | '1M';

export type OrderSide = 'buy' | 'sell';

/**
 * An instruction emitted by a strategy after a bar closes. Every order is
 * valid for exactly one bar: the bar that immediately follows the bar on
 * which it was emitted. Unfilled orders expire and must be re-submitted.
 *
 * Buy orders are sized in cash (notional). Sell orders are sized in units,
 * or `'all'` to flatten the position at the moment of execution.
 *
 * A limit order waits for a better price (buy at or below, sell at or above);
 * a stop order waits for a worse one (buy at or above, sell at or below) and
 * then executes like a market order, so it pays slippage.
 */
export type Order =
  | { kind: 'market'; side: 'buy'; cash: number; tag?: string }
  | { kind: 'market'; side: 'sell'; quantity: number | 'all'; tag?: string }
  | { kind: 'limit' | 'stop'; side: 'buy'; price: number; cash: number; tag?: string }
  | { kind: 'limit' | 'stop'; side: 'sell'; price: number; quantity: number | 'all'; tag?: string };

/** An executed order. */
export interface Fill {
  /** Index of the bar on which the fill occurred. */
  barIndex: number;
  time: number;
  side: OrderSide;
  /** Execution price after slippage. */
  price: number;
  quantity: number;
  /** Commission paid in quote currency. */
  fee: number;
  tag?: string;
}

/**
 * A round trip: one or more buy fills that open (and possibly scale into) a
 * position, followed by the sell fill(s) that return it to flat.
 */
export interface Trade {
  id: number;
  entryTime: number;
  /** `null` while the trade is still open at the end of the test. */
  exitTime: number | null;
  /** Quantity-weighted average buy price (excluding fees). */
  avgEntryPrice: number;
  /** Quantity-weighted average sell price, or the last close for open trades. */
  exitPrice: number;
  quantity: number;
  /** Total cash spent including buy commissions. */
  costBasis: number;
  /** Total cash received net of sell commissions (mark-to-market if open). */
  proceeds: number;
  /** Realized PnL (unrealized for open trades) net of all fees. */
  pnl: number;
  /** `pnl / costBasis * 100`. */
  roiPct: number;
  /** Number of buy fills that built the position. */
  entries: number;
  /** Number of bars between first entry and exit (or end of data). */
  barsHeld: number;
  isOpen: boolean;
}

/** One sample of the portfolio valuation, recorded at each bar close. */
export interface EquityPoint {
  time: number;
  equity: number;
  cash: number;
  positionValue: number;
  /** Buy-and-hold benchmark value at the same bar. */
  benchmark: number;
  /** Strategy drawdown from running peak, in percent (<= 0). */
  drawdownPct: number;
}

/** Summary statistics of a backtest run. */
export interface Metrics {
  initialCapital: number;
  finalEquity: number;
  totalReturnPct: number;
  buyHoldReturnPct: number;
  /** Peak-to-trough decline of the equity curve, reported as a positive number. */
  maxDrawdownPct: number;
  buyHoldMaxDrawdownPct: number;
  /** Share of closed trades with positive net PnL. */
  winRatePct: number;
  /** Closed round trips. */
  totalTrades: number;
  /** Individual executions (buy and sell fills). */
  totalFills: number;
  cagrPct: number;
  /** Annualized Sharpe ratio (risk-free rate of zero). */
  sharpe: number;
  /** Gross profit / gross loss of closed trades; `Infinity` with no losers. */
  profitFactor: number;
  /** Percentage of bars with a non-zero position. */
  exposurePct: number;
  totalFees: number;
  /** Bars per year inferred from the data, used for annualization. */
  periodsPerYear: number;
  hasOpenPosition: boolean;
}

/** Execution assumptions applied uniformly to every strategy. */
export interface BacktestConfig {
  initialCapital: number;
  /** Commission per fill as a percentage of notional (e.g. 0.1 = 0.1%). */
  feePct: number;
  /** Adverse price adjustment per fill, as a percentage (e.g. 0.05). */
  slippagePct: number;
}

export interface BacktestResult {
  strategyId: string;
  strategyName: string;
  params: Readonly<Record<string, number | boolean>>;
  config: BacktestConfig;
  fills: Fill[];
  trades: Trade[];
  equityCurve: EquityPoint[];
  metrics: Metrics;
}

/* -------------------------------------------------------------------------- */
/* Strategy contract                                                          */
/* -------------------------------------------------------------------------- */

/** Read-only snapshot of the open position handed to strategies. */
export interface PositionState {
  quantity: number;
  /** Quantity-weighted average buy price of the open position (excluding fees). */
  avgEntryPrice: number;
  /** Cash spent on the open position including buy commissions. */
  costBasis: number;
  /** Number of buy fills since the position was last flat. */
  entries: number;
  /** Price of the most recent buy fill of the open position, if any. */
  lastBuyPrice: number | null;
}

/**
 * Lookahead-safe view over the bar series. Only bars up to and including the
 * current bar are reachable; requesting a future bar throws.
 */
export interface BarHistory {
  /** Number of visible bars (current index + 1). */
  readonly length: number;
  /** Returns the bar at absolute index `i` (0 <= i < length). */
  at(i: number): Bar;
  /** Returns the bar `n` bars back from the current one (`ago(0)` is current). */
  ago(n: number): Bar;
}

/** Portfolio state immediately after an execution. */
export interface PortfolioSnapshot {
  cash: number;
  position: Readonly<PositionState>;
}

/** Information available to a strategy when the bar at `index` has closed. */
export interface StrategyContext {
  index: number;
  bar: Bar;
  history: BarHistory;
  cash: number;
  position: Readonly<PositionState>;
  /** Cash plus position marked at the current close. */
  equity: number;
  initialCapital: number;
}

/**
 * A trading strategy. The engine calls `onBar` once per bar after the bar has
 * closed; returned orders are eligible for execution on the next bar only.
 */
export interface Strategy {
  readonly id: string;
  readonly name: string;
  /**
   * Optional one-time preparation, e.g. pre-computing indicators. Any series
   * derived here must be causal (value at `i` depends only on bars `<= i`).
   */
  init?(bars: readonly Bar[]): void;
  onBar(ctx: StrategyContext): Order[];
  /**
   * Notified after each execution with the post-fill portfolio state. The
   * snapshot intentionally excludes the bar being traded: its close is not yet
   * known at the moment of the fill.
   */
  onFill?(fill: Fill, portfolio: PortfolioSnapshot): void;
}

/** Declarative parameter description used to render configuration forms. */
export type ParamSpec =
  | {
      key: string;
      label: string;
      type: 'number';
      default: number;
      min: number;
      max: number;
      step: number;
      unit?: '%' | 'x' | 'bars' | '$';
      integer?: boolean;
      description: string;
    }
  | {
      key: string;
      label: string;
      type: 'boolean';
      default: boolean;
      description: string;
    };

export type ParamValues = Record<string, number | boolean>;

/** Registry entry that pairs a strategy factory with its parameter schema. */
export interface StrategyDefinition {
  id: string;
  name: string;
  description: string;
  params: readonly ParamSpec[];
  /** Returns human-readable validation errors; empty when valid. */
  validate(params: ParamValues): string[];
  create(params: ParamValues): Strategy;
}
