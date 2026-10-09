#!/usr/bin/env node
/**
 * Downloads the fundamentals (income statement, cash flow and balance sheet
 * items) of every symbol in data/watchlist.json from the Yahoo Finance
 * fundamentals-timeseries API and writes a static snapshot the app reads
 * same-origin, with no CORS proxy:
 *
 *   <out>/index.json      { generatedAt, symbols: { "AAPL": { file, name, currency, lastPeriod } } }
 *   <out>/<FILE>.json     { symbol, name, currency, priceCurrency, annual, quarterly, ttm }
 *
 * Each period is `{ end: "YYYY-MM-DD", revenue?, ebitda?, ... }`; missing items
 * are omitted. Symbols without statements (ETFs, indices, FX, crypto) are skipped.
 * Yahoo serves about four fiscal years and five quarters.
 *
 * Usage: node scripts/build-fundamentals.mjs [outDir=public/fundamentals] [SYMBOL ...]
 * Runs server-side (locally or in GitHub Actions), where Yahoo needs no proxy.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [outDir = 'public/fundamentals', ...cliSymbols] = process.argv.slice(2);
const watchlist = JSON.parse(await readFile(new URL('../data/watchlist.json', import.meta.url), 'utf8'));
const symbols = cliSymbols.length > 0 ? cliSymbols : watchlist.symbols;
const HOSTS = ['query2.finance.yahoo.com', 'query1.finance.yahoo.com'];
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64)', Accept: 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Output field -> Yahoo item name, for each period type that Yahoo publishes it under. */
const FLOW_ITEMS = {
  revenue: 'TotalRevenue',
  grossProfit: 'GrossProfit',
  operatingIncome: 'OperatingIncome',
  ebitda: 'EBITDA',
  netIncome: 'NetIncome',
  eps: 'DilutedEPS',
  fcf: 'FreeCashFlow',
  dividends: 'CashDividendsPaid',
};
const BALANCE_ITEMS = {
  shares: 'OrdinarySharesNumber',
  debt: 'TotalDebt',
  cash: 'CashAndCashEquivalents',
  equity: 'StockholdersEquity',
};
const PERIODS = {
  annual: { ...FLOW_ITEMS, ...BALANCE_ITEMS },
  quarterly: { ...FLOW_ITEMS, ...BALANCE_ITEMS },
  trailing: FLOW_ITEMS,
};

/** `^GSPC` -> `_GSPC`, `EURUSD=X` -> `EURUSD_X`. */
const fileName = (symbol) => `${symbol.toUpperCase().replace(/[^A-Z0-9.-]/g, '_')}.json`;

async function getJson(path) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    const host = HOSTS[attempt % HOSTS.length];
    try {
      const res = await fetch(`https://${host}${path}`, { headers: HEADERS });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastError = e;
      await sleep(1500 * (attempt + 1));
    }
  }
  throw lastError;
}

/** Groups the timeseries of one period type into `{ end, ...fields }` rows sorted by date. */
function collect(results, prefix, items) {
  const rows = new Map();
  let currency = null;
  for (const [field, item] of Object.entries(items)) {
    const type = prefix + item;
    const series = results.find((r) => r?.meta?.type?.[0] === type)?.[type] ?? [];
    for (const point of series) {
      const value = point?.reportedValue?.raw;
      if (!point?.asOfDate || typeof value !== 'number' || !Number.isFinite(value)) continue;
      const row = rows.get(point.asOfDate) ?? { end: point.asOfDate };
      // Dividends are reported as a cash outflow; store the amount paid.
      row[field] = field === 'dividends' ? Math.abs(value) : value;
      rows.set(point.asOfDate, row);
      // Share counts carry a bogus currency code, so only money totals set it.
      if (field !== 'shares' && field !== 'eps' && point.currencyCode) currency ??= point.currencyCode;
    }
  }
  return { rows: [...rows.values()].sort((a, b) => a.end.localeCompare(b.end)), currency };
}

async function download(symbol) {
  const types = Object.entries(PERIODS).flatMap(([prefix, items]) => Object.values(items).map((item) => prefix + item));
  const now = Math.floor(Date.now() / 1000) + 86_400;
  const s = encodeURIComponent(symbol);
  const json = await getJson(`/ws/fundamentals-timeseries/v1/finance/timeseries/${s}?symbol=${s}&type=${types.join(',')}&period1=0&period2=${now}`);
  const results = json?.timeseries?.result ?? [];

  const annual = collect(results, 'annual', PERIODS.annual);
  if (!annual.rows.some((r) => r.revenue !== undefined)) return null;
  const quarterly = collect(results, 'quarterly', PERIODS.quarterly);
  const ttm = collect(results, 'trailing', PERIODS.trailing);

  // The listing currency can differ from the reporting currency (ADRs, dual listings).
  const chart = await getJson(`/v8/finance/chart/${s}?range=5d&interval=1d`);
  const meta = chart?.chart?.result?.[0]?.meta ?? {};
  return {
    symbol,
    name: meta.longName || meta.shortName || symbol,
    currency: annual.currency ?? quarterly.currency ?? meta.currency ?? null,
    priceCurrency: meta.currency ?? null,
    annual: annual.rows,
    quarterly: quarterly.rows,
    ttm: ttm.rows,
  };
}

await mkdir(outDir, { recursive: true });
const index = { generatedAt: new Date().toISOString(), symbols: {} };
const failures = [];

for (const raw of symbols) {
  const symbol = raw.trim().toUpperCase();
  try {
    const data = await download(symbol);
    if (data === null) {
      console.log(`${symbol.padEnd(12)} skipped (no financial statements)`);
    } else {
      const file = fileName(symbol);
      await writeFile(join(outDir, file), JSON.stringify(data));
      const lastPeriod = [...data.annual, ...data.quarterly].map((r) => r.end).sort().at(-1) ?? null;
      index.symbols[symbol] = { file, name: data.name, currency: data.currency, lastPeriod };
      console.log(`${symbol.padEnd(12)} ${data.annual.length}y ${data.quarterly.length}q ${data.ttm.length}ttm  ${data.currency}  last ${lastPeriod}`);
    }
  } catch (e) {
    failures.push(symbol);
    console.warn(`${symbol.padEnd(12)} FAILED: ${e instanceof Error ? e.message : e}`);
  }
  await sleep(400);
}

await writeFile(join(outDir, 'index.json'), JSON.stringify(index, null, 1));
console.log(`\n${Object.keys(index.symbols).length}/${symbols.length} symbols with fundamentals written to ${outDir}`);
if (Object.keys(index.symbols).length === 0) process.exit(1);
if (failures.length > 0) console.warn(`Failed: ${failures.join(', ')}`);
