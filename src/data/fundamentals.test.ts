import { describe, expect, it } from 'vitest';
import type { Bar } from '../engine/types';
import { MAX_FIGURE_AGE_DAYS, currencyMismatch, latestFigures, parseFundamentals, periodRatios, valuationSeries } from './fundamentals';

const utc = (y: number, m: number, d: number): number => Date.UTC(y, m - 1, d) / 1000;
const bar = (time: number, close: number): Bar => ({ time, open: close, high: close, low: close, close, volume: 0 });

const payload = {
  symbol: 'TEST',
  name: 'Test Corp',
  currency: 'USD',
  priceCurrency: 'USD',
  annual: [
    // Deliberately out of order: the parser sorts by date.
    { end: '2024-12-31', revenue: 1200, ebitda: 300, netIncome: 120, eps: 1.2, fcf: 100, dividends: 50, shares: 100, debt: 400, cash: 100, equity: 600 },
    { end: '2023-12-31', revenue: 1000, ebitda: 250, netIncome: 100, eps: 1, shares: 100, debt: 500, cash: 100, equity: 500 },
  ],
  quarterly: [{ end: '2025-03-31', revenue: 330, shares: 80, debt: 300, cash: 100, equity: 700, bogus: 'x' }],
  ttm: [{ end: '2025-03-31', revenue: 1300, ebitda: 320, eps: 1.5 }],
};

describe('parseFundamentals', () => {
  it('converts dates to UTC seconds, sorts periods and drops non-numeric items', () => {
    const f = parseFundamentals(payload);
    expect(f.annual.map((p) => p.time)).toEqual([utc(2023, 12, 31), utc(2024, 12, 31)]);
    expect(f.quarterly[0]).toEqual({ time: utc(2025, 3, 31), revenue: 330, shares: 80, debt: 300, cash: 100, equity: 700 });
    expect(f.currency).toBe('USD');
  });

  it('rejects payloads without a symbol', () => {
    expect(() => parseFundamentals({ annual: [] })).toThrow('invalid fundamentals payload');
    expect(() => parseFundamentals(null)).toThrow();
  });
});

describe('valuationSeries', () => {
  const f = parseFundamentals(payload);

  it('starts at the first share count and uses the figures known at each date', () => {
    const bars = [bar(utc(2023, 6, 1), 10), bar(utc(2024, 1, 2), 20), bar(utc(2025, 1, 2), 30), bar(utc(2025, 4, 1), 40)];
    const series = valuationSeries(bars, f);
    expect(series.map((p) => p.time)).toEqual([utc(2024, 1, 2), utc(2025, 1, 2), utc(2025, 4, 1)]);

    // FY2023: 100 shares, EPS 1, revenue 1000, EBITDA 250, net debt 400, equity 500.
    const [a, b, c] = series;
    expect(a.marketCap).toBeCloseTo(2000);
    expect(a.enterpriseValue).toBeCloseTo(2400);
    expect(a.pe).toBeCloseTo(20);
    expect(a.ps).toBeCloseTo(2);
    expect(a.evEbitda).toBeCloseTo(9.6);
    expect(a.pb).toBeCloseTo(4);
    // FY2023 reports no FCF or dividends.
    expect(a.fcfYieldPct).toBeNull();
    expect(a.dividendYieldPct).toBeNull();

    // FY2024: EPS 1.2, FCF 100, dividends 50.
    expect(b.pe).toBeCloseTo(25);
    expect(b.fcfYieldPct).toBeCloseTo((100 / 3000) * 100);
    expect(b.dividendYieldPct).toBeCloseTo((50 / 3000) * 100);

    // Q1 2025: quarterly balance sheet (80 shares) and TTM flows (EPS 1.5, revenue 1300).
    expect(c.marketCap).toBeCloseTo(3200);
    expect(c.pe).toBeCloseTo(40 / 1.5);
    expect(c.ps).toBeCloseTo(3200 / 1300);
    expect(c.enterpriseValue).toBeCloseTo(3400);
    expect(c.evEbitda).toBeCloseTo(3400 / 320);
  });

  it('leaves ratios with a non-positive denominator empty', () => {
    const loss = parseFundamentals({ ...payload, annual: [{ end: '2024-12-31', eps: -2, ebitda: 0, revenue: 10, shares: 10 }], quarterly: [], ttm: [] });
    const [p] = valuationSeries([bar(utc(2025, 1, 2), 5)], loss);
    expect(p.pe).toBeNull();
    expect(p.evEbitda).toBeNull();
    expect(p.enterpriseValue).toBeNull();
    expect(p.ps).toBeCloseTo(5);
  });

  it('ignores figures older than the staleness limit', () => {
    const lastShares = utc(2025, 3, 31);
    const day = 86_400;
    const bars = [bar(lastShares + MAX_FIGURE_AGE_DAYS * day, 10), bar(lastShares + (MAX_FIGURE_AGE_DAYS + 1) * day, 10)];
    expect(valuationSeries(bars, f)).toHaveLength(1);
  });

  it('returns nothing when prices and statements use different currencies', () => {
    const adr = parseFundamentals({ ...payload, priceCurrency: 'EUR' });
    expect(currencyMismatch(adr)).toBe(true);
    expect(valuationSeries([bar(utc(2025, 1, 2), 30)], adr)).toEqual([]);
  });
});

describe('latestFigures and periodRatios', () => {
  it('prefers TTM flows and the latest balance sheet', () => {
    const latest = latestFigures(parseFundamentals(payload));
    expect(latest.revenue).toBe(1300);
    expect(latest.eps).toBe(1.5);
    // Net income has no TTM value, so the last fiscal year is used.
    expect(latest.netIncome).toBe(120);
    expect(latest.shares).toBe(80);
    expect(latest.equity).toBe(700);
  });

  it('computes margins and leverage, leaving missing ones empty', () => {
    const r = periodRatios({ revenue: 200, grossProfit: 80, ebitda: 50, debt: 300, equity: 600 });
    expect(r.grossMarginPct).toBeCloseTo(40);
    expect(r.ebitdaMarginPct).toBeCloseTo(25);
    expect(r.netMarginPct).toBeNull();
    expect(r.debtToEquity).toBeCloseTo(0.5);
  });
});
