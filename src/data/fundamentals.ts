/**
 * Company fundamentals from the site snapshot (`public/fundamentals`, built by
 * `scripts/build-fundamentals.mjs`) and the valuation history derived from
 * them. Pure functions only: the network side lives in `providers.ts`.
 *
 * Statement items are dated by the end of their fiscal period, not by the
 * filing date, so a ratio can reflect results a few weeks before they were
 * published. The page is descriptive and these values never reach the
 * backtester, whose no-lookahead rule they would otherwise break.
 */
import type { Bar } from '../engine/types';

/** Income and cash-flow items: amounts over a period. */
export const FLOW_FIELDS = ['revenue', 'grossProfit', 'operatingIncome', 'ebitda', 'netIncome', 'eps', 'fcf', 'dividends'] as const;
/** Balance-sheet items: amounts at the end of a period. */
export const BALANCE_FIELDS = ['shares', 'debt', 'cash', 'equity'] as const;

export type FlowField = (typeof FLOW_FIELDS)[number];
export type BalanceField = (typeof BALANCE_FIELDS)[number];
export type PeriodField = FlowField | BalanceField;

/** One fiscal period; items the company does not report are absent. */
export type FiscalPeriod = { time: number } & Partial<Record<PeriodField, number>>;

export interface Fundamentals {
  symbol: string;
  name: string;
  /** Reporting currency of the statements. */
  currency: string | null;
  /** Currency the shares trade in; ratios need it to match `currency`. */
  priceCurrency: string | null;
  annual: FiscalPeriod[];
  quarterly: FiscalPeriod[];
  /** Trailing-twelve-month flows, dated by the quarter that closes them. */
  ttm: FiscalPeriod[];
}

export interface FundamentalsEntry {
  file: string;
  name: string;
  currency: string | null;
  lastPeriod: string | null;
}

export interface FundamentalsIndex {
  generatedAt: string;
  symbols: Record<string, FundamentalsEntry>;
}

/** Daily valuation; a ratio is null when its denominator is missing or not positive. */
export interface ValuationPoint {
  time: number;
  close: number;
  marketCap: number;
  enterpriseValue: number | null;
  pe: number | null;
  ps: number | null;
  evEbitda: number | null;
  pb: number | null;
  fcfYieldPct: number | null;
  dividendYieldPct: number | null;
}

/** Latest known value of each statement item. */
export type LatestFigures = Partial<Record<PeriodField, number>>;

const SECONDS_PER_DAY = 86_400;
/**
 * Older figures are treated as missing, so a series that stops being reported
 * does not freeze a stale value into every later ratio. A year plus a
 * reporting delay covers annual-only items.
 */
export const MAX_FIGURE_AGE_DAYS = 400;

type JsonObject = Record<string, unknown>;
const isObject = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);
const ALL_FIELDS: readonly PeriodField[] = [...FLOW_FIELDS, ...BALANCE_FIELDS];

function parsePeriods(raw: unknown): FiscalPeriod[] {
  if (!Array.isArray(raw)) return [];
  const out: FiscalPeriod[] = [];
  for (const row of raw) {
    if (!isObject(row) || typeof row.end !== 'string') continue;
    const time = Date.parse(`${row.end}T00:00:00Z`) / 1000;
    if (!Number.isFinite(time)) continue;
    const period: FiscalPeriod = { time };
    for (const field of ALL_FIELDS) {
      const v = row[field];
      if (typeof v === 'number' && Number.isFinite(v)) period[field] = v;
    }
    out.push(period);
  }
  return out.sort((a, b) => a.time - b.time);
}

/** Validates a snapshot file. Exported for unit testing. */
export function parseFundamentals(json: unknown): Fundamentals {
  if (!isObject(json) || typeof json.symbol !== 'string') throw new Error('invalid fundamentals payload');
  const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
  return {
    symbol: json.symbol,
    name: str(json.name) ?? json.symbol,
    currency: str(json.currency),
    priceCurrency: str(json.priceCurrency),
    annual: parsePeriods(json.annual),
    quarterly: parsePeriods(json.quarterly),
    ttm: parsePeriods(json.ttm),
  };
}

/**
 * Step function over the dated values of one field: `at(t)` returns the most
 * recent value dated `<= t` that is not older than `MAX_FIGURE_AGE_DAYS`.
 * Queries must come in non-decreasing time order.
 */
class Stepper {
  private readonly points: Array<{ time: number; value: number }>;
  private next = 0;
  private current: { time: number; value: number } | null = null;

  constructor(sources: ReadonlyArray<readonly FiscalPeriod[]>, field: PeriodField) {
    // Later sources win on equal dates (quarterly over annual, TTM over annual).
    const byTime = new Map<number, number>();
    for (const periods of sources) {
      for (const p of periods) {
        const v = p[field];
        if (v !== undefined) byTime.set(p.time, v);
      }
    }
    this.points = [...byTime].map(([time, value]) => ({ time, value })).sort((a, b) => a.time - b.time);
  }

  at(time: number): number | null {
    while (this.next < this.points.length && this.points[this.next].time <= time) {
      this.current = this.points[this.next];
      this.next++;
    }
    if (this.current === null || time - this.current.time > MAX_FIGURE_AGE_DAYS * SECONDS_PER_DAY) return null;
    return this.current.value;
  }
}

function flowSteppers(f: Fundamentals): Record<FlowField, Stepper> {
  const out = {} as Record<FlowField, Stepper>;
  for (const field of FLOW_FIELDS) out[field] = new Stepper([f.annual, f.ttm], field);
  return out;
}

function balanceSteppers(f: Fundamentals): Record<BalanceField, Stepper> {
  const out = {} as Record<BalanceField, Stepper>;
  for (const field of BALANCE_FIELDS) out[field] = new Stepper([f.annual, f.quarterly], field);
  return out;
}

/** True when prices and statements are in different currencies, which makes every ratio meaningless. */
export function currencyMismatch(f: Fundamentals): boolean {
  return f.currency !== null && f.priceCurrency !== null && f.currency !== f.priceCurrency;
}

const ratio = (num: number | null, den: number | null): number | null => (num !== null && den !== null && den > 0 ? num / den : null);

/**
 * Daily market capitalization, enterprise value and valuation multiples:
 * each close is combined with the latest TTM flows and balance items known
 * at that date. Starts at the first bar with a share count and returns an
 * empty series when prices and statements use different currencies.
 */
export function valuationSeries(bars: readonly Bar[], f: Fundamentals): ValuationPoint[] {
  if (currencyMismatch(f)) return [];
  const flow = flowSteppers(f);
  const bal = balanceSteppers(f);
  const out: ValuationPoint[] = [];
  for (const bar of bars) {
    const shares = bal.shares.at(bar.time);
    const debt = bal.debt.at(bar.time);
    const cash = bal.cash.at(bar.time);
    const equity = bal.equity.at(bar.time);
    const eps = flow.eps.at(bar.time);
    const revenue = flow.revenue.at(bar.time);
    const ebitda = flow.ebitda.at(bar.time);
    const fcf = flow.fcf.at(bar.time);
    const dividends = flow.dividends.at(bar.time);
    if (shares === null || shares <= 0) continue;

    const marketCap = bar.close * shares;
    const enterpriseValue = debt !== null && cash !== null ? marketCap + debt - cash : null;
    out.push({
      time: bar.time,
      close: bar.close,
      marketCap,
      enterpriseValue,
      pe: ratio(bar.close, eps),
      ps: ratio(marketCap, revenue),
      evEbitda: ratio(enterpriseValue, ebitda),
      pb: ratio(marketCap, equity),
      fcfYieldPct: fcf !== null ? (fcf / marketCap) * 100 : null,
      dividendYieldPct: dividends !== null ? (dividends / marketCap) * 100 : null,
    });
  }
  return out;
}

/** Latest TTM flows (TTM, else last fiscal year) and the latest balance sheet. */
export function latestFigures(f: Fundamentals): LatestFigures {
  const all = [...f.annual, ...f.quarterly, ...f.ttm];
  if (all.length === 0) return {};
  const asOf = Math.max(...all.map((p) => p.time));
  const flow = flowSteppers(f);
  const bal = balanceSteppers(f);
  const out: LatestFigures = {};
  for (const field of FLOW_FIELDS) {
    const v = flow[field].at(asOf);
    if (v !== null) out[field] = v;
  }
  for (const field of BALANCE_FIELDS) {
    const v = bal[field].at(asOf);
    if (v !== null) out[field] = v;
  }
  return out;
}

/** Profitability and leverage ratios of one period, in percent (debt/equity as a multiple). */
export interface PeriodRatios {
  grossMarginPct: number | null;
  ebitdaMarginPct: number | null;
  netMarginPct: number | null;
  debtToEquity: number | null;
}

export function periodRatios(p: Partial<Record<PeriodField, number>>): PeriodRatios {
  const pct = (num: number | undefined): number | null => {
    const r = ratio(num ?? null, p.revenue ?? null);
    return r === null ? null : r * 100;
  };
  return {
    grossMarginPct: pct(p.grossProfit),
    ebitdaMarginPct: pct(p.ebitda),
    netMarginPct: pct(p.netIncome),
    debtToEquity: ratio(p.debt ?? null, p.equity ?? null),
  };
}
