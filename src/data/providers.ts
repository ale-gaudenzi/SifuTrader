/**
 * Market data providers usable directly from the browser.
 *
 * - Yahoo Finance chart API: broad coverage (equities, ETFs, indices, FX,
 *   crypto) but no CORS headers. Sources, in order of preference:
 *   - the same-origin proxy of the Vite dev/preview server (localhost only);
 *   - a user-supplied CORS proxy;
 *   - the history snapshot published with the site (`public/history`, built
 *     server-side by `scripts/build-history.mjs` for the watchlist symbols);
 *   - public CORS proxies (often rate-limited or down).
 * - Binance public market data: crypto spot pairs, keyless and CORS-enabled.
 * - Alpha Vantage: equities with a free user API key, CORS-enabled.
 * - Bundled samples: static CSV files shipped in `public/sample_data`, used
 *   on first load and as a fallback when every network source fails.
 */
import type { Bar } from '../engine/types';
import { parseOhlcvCsv } from './csv';

export type DataSource = 'auto' | 'yahoo' | 'binance' | 'alphavantage';
export type FetchRange = '1y' | '2y' | '5y' | '10y' | 'max';
export type FetchInterval = '1d' | '1wk';
/** Concrete origin of a dataset, used to refresh it from the same place later. */
export type ProviderId = 'yahoo' | 'binance' | 'alphavantage' | 'sample' | 'csv';

export interface FetchRequest {
  symbol: string;
  source: DataSource;
  range: FetchRange;
  interval: FetchInterval;
  alphaVantageKey?: string;
  /** Proxy URL template; `{url}` is replaced by the encoded target URL. */
  customProxy?: string;
  /**
   * Incremental fetch: only bars from this time (epoch seconds) onwards are
   * requested and `range` is ignored. No bundled-sample fallback is applied.
   */
  since?: number;
}

export interface Dataset {
  symbol: string;
  name: string;
  bars: Bar[];
  /** Human-readable description of where the data came from. */
  source: string;
  provider: ProviderId;
  /** Key of the saved copy in the local database, if any. */
  storeKey?: string;
  /** Informational message, e.g. a fallback notice. */
  notice?: string;
  warnings: string[];
}

export interface SampleInfo {
  symbol: string;
  name: string;
  file: string;
  assetClass: string;
}

const SECONDS_PER_DAY = 86_400;
const REQUEST_TIMEOUT_MS = 12_000;
/** Public proxies can be slow on multi-year histories. */
const PROXY_TIMEOUT_MS = 45_000;
/** 1900-01-01, the `period1` used to request a full Yahoo history. */
const YAHOO_EARLIEST = -2_208_988_800;

/* -------------------------------------------------------------------------- */
/* Utilities                                                                  */
/* -------------------------------------------------------------------------- */

type JsonObject = Record<string, unknown>;

function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asNumberArray(v: unknown): Array<number | null> {
  if (!Array.isArray(v)) return [];
  return v.map((x) => (typeof x === 'number' && Number.isFinite(x) ? x : null));
}

function errorMessage(e: unknown): string {
  if (e instanceof DOMException && e.name === 'AbortError') return 'request timed out';
  return e instanceof Error ? e.message : String(e);
}

/** `fetch` with a timeout that also honours an external abort signal. */
async function fetchWithTimeout(url: string, signal?: AbortSignal, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = (): void => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
    return res;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** First timestamp (epoch seconds) covered by a history range; 0 for `max`. */
export function rangeStartSeconds(range: FetchRange): number {
  if (range === 'max') return 0;
  const years = Number(range.replace('y', ''));
  return Math.floor(Date.now() / 1000 - years * 365.25 * SECONDS_PER_DAY);
}

/** Sorts, de-duplicates and sanity-checks bars coming from an API. */
function sanitize(bars: Bar[]): Bar[] {
  const valid = bars.filter((b) => [b.open, b.high, b.low, b.close].every((v) => Number.isFinite(v) && v > 0));
  valid.sort((a, b) => a.time - b.time);
  const out: Bar[] = [];
  for (const b of valid) {
    const fixed: Bar = {
      ...b,
      high: Math.max(b.high, b.open, b.close),
      low: Math.min(b.low, b.open, b.close),
      volume: Number.isFinite(b.volume) && b.volume >= 0 ? b.volume : 0,
    };
    if (out.length > 0 && out[out.length - 1].time === b.time) out[out.length - 1] = fixed;
    else out.push(fixed);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* CORS proxies                                                               */
/* -------------------------------------------------------------------------- */

interface CorsProxy {
  name: string;
  build(target: string): string;
  /** Extracts the upstream response body from the proxy response. */
  unwrap(res: Response): Promise<string>;
}

const asText = (res: Response): Promise<string> => res.text();

export const PUBLIC_PROXIES: readonly CorsProxy[] = [
  {
    name: 'allorigins (json)',
    build: (u) => `https://api.allorigins.win/get?url=${encodeURIComponent(u)}`,
    unwrap: async (res) => {
      const body: unknown = await res.json();
      if (!isObject(body) || typeof body.contents !== 'string') throw new Error('unexpected proxy payload');
      return body.contents;
    },
  },
  { name: 'allorigins (raw)', build: (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`, unwrap: asText },
  { name: 'corsproxy.io', build: (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`, unwrap: asText },
  { name: 'codetabs', build: (u) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`, unwrap: asText },
];

/** Same-origin Yahoo proxy configured in `vite.config.ts` for `vite` and `vite preview`. */
const LOCAL_PROXY: CorsProxy = {
  name: 'local dev proxy',
  build: (u) => u.replace(/^https:\/\/query[12]\.finance\.yahoo\.com\//, `${import.meta.env.BASE_URL}yahoo/`),
  unwrap: asText,
};

function onLocalDevServer(): boolean {
  return typeof location !== 'undefined' && ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
}

function customProxy(template: string): CorsProxy {
  return {
    name: 'custom proxy',
    build: (u) => (template.includes('{url}') ? template.replace('{url}', encodeURIComponent(u)) : template + u),
    unwrap: asText,
  };
}

/**
 * Queries every proxy concurrently and resolves with the first response that
 * `parse` accepts; the remaining requests are aborted. Public proxies vary
 * widely in latency and availability, so racing them is both faster and more
 * reliable than trying them one after another.
 */
async function fetchViaProxies<T>(
  target: string,
  parse: (body: string) => T,
  signal: AbortSignal | undefined,
  chain: readonly CorsProxy[],
): Promise<{ value: T; proxy: string }> {
  const race = new AbortController();
  const onAbort = (): void => race.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const failures: string[] = [];
  try {
    return await Promise.any(
      chain.map(async (proxy) => {
        try {
          const res = await fetchWithTimeout(proxy.build(target), race.signal, PROXY_TIMEOUT_MS);
          const value = parse(await proxy.unwrap(res));
          race.abort();
          return { value, proxy: proxy.name };
        } catch (e) {
          failures.push(`${proxy.name}: ${errorMessage(e)}`);
          throw e;
        }
      }),
    );
  } catch (e) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (e instanceof AggregateError) throw new Error(`All CORS proxies failed (${failures.join(' | ')})`);
    throw e;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

/* -------------------------------------------------------------------------- */
/* Yahoo Finance                                                              */
/* -------------------------------------------------------------------------- */

interface YahooParsed {
  bars: Bar[];
  name: string;
}

/** Parses a Yahoo Finance v8 chart response. Exported for unit testing. */
export function parseYahooChart(body: string): YahooParsed {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error('response is not JSON');
  }
  const chart = isObject(json) && isObject(json.chart) ? json.chart : null;
  if (!chart) throw new Error('missing chart payload');
  if (isObject(chart.error) && typeof chart.error.description === 'string') throw new Error(chart.error.description);
  const result = Array.isArray(chart.result) && isObject(chart.result[0]) ? chart.result[0] : null;
  if (!result) throw new Error('symbol not found');

  const meta = isObject(result.meta) ? result.meta : {};
  const gmtOffset = typeof meta.gmtoffset === 'number' ? meta.gmtoffset : 0;
  const name =
    (typeof meta.longName === 'string' && meta.longName) ||
    (typeof meta.shortName === 'string' && meta.shortName) ||
    (typeof meta.symbol === 'string' ? meta.symbol : '');

  const timestamps = asNumberArray(result.timestamp);
  const indicators = isObject(result.indicators) ? result.indicators : {};
  const quote = Array.isArray(indicators.quote) && isObject(indicators.quote[0]) ? indicators.quote[0] : null;
  if (!quote || timestamps.length === 0) throw new Error('no price history returned');

  const open = asNumberArray(quote.open);
  const high = asNumberArray(quote.high);
  const low = asNumberArray(quote.low);
  const close = asNumberArray(quote.close);
  const volume = asNumberArray(quote.volume);

  const bars: Bar[] = [];
  timestamps.forEach((t, i) => {
    const o = open[i];
    const h = high[i];
    const l = low[i];
    const c = close[i];
    if (t === null || o === null || h === null || l === null || c === null) return;
    // Shift to exchange-local time before truncating so each bar lands on its
    // trading date rather than the UTC date of the session open.
    const day = Math.floor((t + gmtOffset) / SECONDS_PER_DAY) * SECONDS_PER_DAY;
    bars.push({ time: day, open: o, high: h, low: l, close: c, volume: volume[i] ?? 0 });
  });
  return { bars: sanitize(bars), name };
}

/* -------------------------------------------------------------------------- */
/* History snapshot (same-origin static files)                                */
/* -------------------------------------------------------------------------- */

export interface SnapshotEntry {
  file: string;
  name: string;
  first: string;
  last: string;
  bars: number;
}

export interface SnapshotIndex {
  generatedAt: string;
  symbols: Record<string, SnapshotEntry>;
}

let snapshotCache: Promise<SnapshotIndex | null> | null = null;

/** Index of the history snapshot published with the site, or null when the build has none. */
export function loadSnapshotIndex(): Promise<SnapshotIndex | null> {
  snapshotCache ??= (async () => {
    try {
      const res = await fetchWithTimeout(`${import.meta.env.BASE_URL}history/index.json`);
      const json: unknown = await res.json();
      if (!isObject(json) || !isObject(json.symbols)) return null;
      return json as unknown as SnapshotIndex;
    } catch {
      return null;
    }
  })();
  return snapshotCache;
}

async function fetchSnapshot(req: FetchRequest, signal?: AbortSignal): Promise<Dataset> {
  const symbol = req.symbol.trim().toUpperCase();
  if (req.interval !== '1d') throw new Error('snapshot holds daily bars only');
  const entry = (await loadSnapshotIndex())?.symbols[symbol];
  if (!entry) throw new Error(`${symbol} is not in the history snapshot`);
  const res = await fetchWithTimeout(`${import.meta.env.BASE_URL}history/${entry.file}`, signal, PROXY_TIMEOUT_MS);
  const parsed = parseYahooChart(await res.text());
  const start = req.since ?? rangeStartSeconds(req.range);
  const bars = parsed.bars.filter((b) => b.time >= start);
  if (bars.length < (req.since === undefined ? 2 : 1)) throw new Error(`no snapshot bars after ${entry.last}`);
  return {
    symbol,
    name: parsed.name || entry.name || symbol,
    bars,
    source: `Yahoo Finance (site snapshot, ${entry.last})`,
    provider: 'yahoo',
    warnings: [],
  };
}

async function fetchYahooLive(req: FetchRequest, chain: readonly CorsProxy[], signal?: AbortSignal): Promise<Dataset> {
  const symbol = req.symbol.trim().toUpperCase();
  // An explicit period rather than `range=`: Yahoo silently degrades `range=max` to monthly or quarterly bars.
  // For `max`, start in 1900: Yahoo accepts negative epochs and indices go back to the 1920s.
  const period1 = Math.floor(req.since ?? (req.range === 'max' ? YAHOO_EARLIEST : rangeStartSeconds(req.range)));
  const window = `period1=${period1}&period2=${Math.floor(Date.now() / 1000) + SECONDS_PER_DAY}`;
  const target =
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?${window}&interval=${req.interval}&includePrePost=false&events=div%2Csplits`;
  const { value, proxy } = await fetchViaProxies(target, parseYahooChart, signal, chain);
  if (value.bars.length < (req.since === undefined ? 2 : 1)) throw new Error('not enough bars returned');
  return {
    symbol,
    name: value.name || symbol,
    bars: value.bars,
    source: `Yahoo Finance via ${proxy}`,
    provider: 'yahoo',
    warnings: [],
  };
}

/**
 * Yahoo with a private route (local dev proxy or custom proxy) goes live first
 * and falls back to the snapshot. Without one, the snapshot is preferred to
 * the unreliable public proxies.
 */
async function fetchYahoo(req: FetchRequest, signal?: AbortSignal): Promise<Dataset> {
  const custom = req.customProxy?.trim();
  const privateChain = [...(onLocalDevServer() ? [LOCAL_PROXY] : []), ...(custom ? [customProxy(custom)] : [])];
  const attempts: Array<() => Promise<Dataset>> =
    privateChain.length > 0
      ? [() => fetchYahooLive(req, [...privateChain, ...PUBLIC_PROXIES], signal), () => fetchSnapshot(req, signal)]
      : [() => fetchSnapshot(req, signal), () => fetchYahooLive(req, PUBLIC_PROXIES, signal)];
  const failures: string[] = [];
  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch (e) {
      if (signal?.aborted) throw e;
      failures.push(errorMessage(e));
    }
  }
  throw new Error(failures.join('; '));
}

/* -------------------------------------------------------------------------- */
/* Binance                                                                    */
/* -------------------------------------------------------------------------- */

const QUOTE_ASSETS = ['USDT', 'USDC', 'FDUSD', 'BTC', 'ETH', 'EUR', 'TRY', 'BRL'];
const KNOWN_CRYPTO = new Set([
  'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'DOGE', 'AVAX', 'DOT', 'LINK', 'LTC', 'TRX', 'MATIC', 'POL', 'ATOM',
  'UNI', 'XLM', 'NEAR', 'APT', 'ARB', 'OP', 'SUI', 'TON', 'SHIB', 'PEPE', 'BCH', 'ETC', 'FIL', 'AAVE',
]);

/** Maps `BTC-USD`, `BTC/USDT`, `btcusdt` or `BTC` to a Binance pair (`BTCUSDT`). */
export function toBinanceSymbol(symbol: string): string {
  const s = symbol.trim().toUpperCase();
  const pair = /^([A-Z0-9]+)[-/_]([A-Z]+)$/.exec(s);
  if (pair) {
    const quote = pair[2] === 'USD' ? 'USDT' : pair[2];
    return pair[1] + quote;
  }
  if (QUOTE_ASSETS.some((q) => s.endsWith(q) && s.length > q.length)) return s;
  return `${s}USDT`;
}

/** Heuristic used by the `auto` source to route crypto symbols to Binance. */
export function looksLikeCrypto(symbol: string): boolean {
  const s = symbol.trim().toUpperCase();
  const pair = /^([A-Z0-9]+)[-/_]?(USD|USDT|USDC)$/.exec(s);
  if (pair) return KNOWN_CRYPTO.has(pair[1]);
  return KNOWN_CRYPTO.has(s);
}

async function fetchBinance(req: FetchRequest, signal?: AbortSignal): Promise<Dataset> {
  const pair = toBinanceSymbol(req.symbol);
  const interval = req.interval === '1wk' ? '1w' : '1d';
  const limit = 1000;
  let startMs = (req.since ?? rangeStartSeconds(req.range)) * 1000;
  const nowMs = Date.now();
  const bars: Bar[] = [];

  for (let page = 0; page < 50; page++) {
    const url =
      `https://data-api.binance.vision/api/v3/klines?symbol=${encodeURIComponent(pair)}` +
      `&interval=${interval}&limit=${limit}&startTime=${startMs}`;
    let res: Response;
    try {
      res = await fetchWithTimeout(url, signal);
    } catch (e) {
      throw new Error(`Binance ${pair}: ${errorMessage(e)}`);
    }
    const rows: unknown = await res.json();
    if (!Array.isArray(rows)) throw new Error(`Binance ${pair}: unexpected response`);
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 7) continue;
      const closeTime = Number(row[6]);
      // Skip the candle that is still forming.
      if (closeTime > nowMs) continue;
      bars.push({
        time: Math.floor(Number(row[0]) / 1000),
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
        volume: Number(row[5]),
      });
    }
    if (rows.length < limit) break;
    const last: unknown = rows[rows.length - 1];
    if (!Array.isArray(last)) break;
    startMs = Number(last[6]) + 1;
    if (startMs >= nowMs) break;
  }

  const clean = sanitize(bars);
  if (clean.length < (req.since === undefined ? 2 : 1)) throw new Error(`Binance ${pair}: no data (is the pair listed?)`);
  return { symbol: pair, name: pair, bars: clean, source: 'Binance public market data', provider: 'binance', warnings: [] };
}

/* -------------------------------------------------------------------------- */
/* Alpha Vantage                                                              */
/* -------------------------------------------------------------------------- */

/** Parses an Alpha Vantage TIME_SERIES_* response. Exported for unit testing. */
export function parseAlphaVantage(json: unknown): Bar[] {
  if (!isObject(json)) throw new Error('unexpected response');
  for (const key of ['Error Message', 'Note', 'Information']) {
    if (typeof json[key] === 'string') throw new Error(json[key] as string);
  }
  const seriesKey = Object.keys(json).find((k) => k.toLowerCase().includes('time series'));
  const series = seriesKey ? json[seriesKey] : null;
  if (!isObject(series)) throw new Error('no time series in response');
  const bars: Bar[] = [];
  for (const [date, raw] of Object.entries(series)) {
    if (!isObject(raw)) continue;
    const time = Date.parse(`${date}T00:00:00Z`) / 1000;
    if (!Number.isFinite(time)) continue;
    bars.push({
      time,
      open: Number(raw['1. open']),
      high: Number(raw['2. high']),
      low: Number(raw['3. low']),
      close: Number(raw['4. close']),
      volume: Number(raw['5. volume'] ?? 0),
    });
  }
  return sanitize(bars);
}

async function fetchAlphaVantage(req: FetchRequest, signal?: AbortSignal): Promise<Dataset> {
  const key = req.alphaVantageKey?.trim();
  if (!key) throw new Error('Alpha Vantage requires an API key (free at alphavantage.co).');
  const symbol = req.symbol.trim().toUpperCase();
  const fn = req.interval === '1wk' ? 'TIME_SERIES_WEEKLY' : 'TIME_SERIES_DAILY';
  const base = `https://www.alphavantage.co/query?function=${fn}&symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(key)}`;
  const warnings: string[] = [];

  const load = async (url: string): Promise<Bar[]> => parseAlphaVantage(await (await fetchWithTimeout(url, signal)).json());
  let bars: Bar[];
  // The compact output (latest 100 sessions) is enough for a short incremental update.
  const compactSuffices = req.since !== undefined && req.since > Date.now() / 1000 - 120 * SECONDS_PER_DAY;
  if (fn === 'TIME_SERIES_DAILY' && compactSuffices) {
    bars = await load(`${base}&outputsize=compact`);
  } else if (fn === 'TIME_SERIES_DAILY') {
    try {
      bars = await load(`${base}&outputsize=full`);
    } catch {
      // Full daily history is a premium feature on some plans; fall back to
      // the most recent 100 sessions.
      bars = await load(`${base}&outputsize=compact`);
      warnings.push('Alpha Vantage returned the compact daily history (latest 100 sessions).');
    }
  } else {
    bars = await load(base);
  }
  const start = req.since ?? rangeStartSeconds(req.range);
  bars = bars.filter((b) => b.time >= start);
  if (bars.length < (req.since === undefined ? 2 : 1)) throw new Error('not enough bars returned');
  return { symbol, name: symbol, bars, source: 'Alpha Vantage', provider: 'alphavantage', warnings };
}

/* -------------------------------------------------------------------------- */
/* Bundled samples                                                            */
/* -------------------------------------------------------------------------- */

function sampleUrl(path: string): string {
  return `${import.meta.env.BASE_URL}sample_data/${path}`;
}

let manifestCache: Promise<SampleInfo[]> | null = null;

export function loadSampleManifest(): Promise<SampleInfo[]> {
  manifestCache ??= (async () => {
    const res = await fetchWithTimeout(sampleUrl('index.json'));
    const json: unknown = await res.json();
    if (!isObject(json) || !Array.isArray(json.datasets)) throw new Error('invalid sample manifest');
    return json.datasets.filter(isObject).map((d) => ({
      symbol: String(d.symbol),
      name: String(d.name),
      file: String(d.file),
      assetClass: String(d.assetClass ?? ''),
    }));
  })().catch((e: unknown) => {
    manifestCache = null;
    throw e;
  });
  return manifestCache;
}

export async function loadSample(symbol: string): Promise<Dataset> {
  const manifest = await loadSampleManifest();
  const info = manifest.find((s) => s.symbol.toUpperCase() === symbol.trim().toUpperCase());
  if (!info) throw new Error(`No bundled sample for ${symbol}`);
  const res = await fetchWithTimeout(sampleUrl(info.file));
  const parsed = parseOhlcvCsv(await res.text());
  return {
    symbol: info.symbol,
    name: info.name,
    bars: parsed.bars,
    source: 'Bundled sample (offline)',
    provider: 'sample',
    warnings: parsed.warnings,
  };
}

/** Finds the bundled sample matching a user-entered symbol, if any. */
async function findSampleFor(symbol: string): Promise<SampleInfo | undefined> {
  try {
    const manifest = await loadSampleManifest();
    const s = symbol.trim().toUpperCase();
    const candidates = new Set([s, s.replace(/USDT$/, '-USD'), s.replace(/[/_]/, '-'), `${s}-USD`]);
    return manifest.find((m) => candidates.has(m.symbol.toUpperCase()));
  } catch {
    return undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* Public entry point                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Fetches OHLCV data according to `req.source`. With `auto`, crypto symbols
 * are routed to Binance first and everything else to Yahoo (then Alpha
 * Vantage when a key is configured). If every network attempt fails and a
 * bundled sample exists for the symbol, the sample is returned with a notice.
 */
export async function fetchMarketData(req: FetchRequest, signal?: AbortSignal): Promise<Dataset> {
  if (!req.symbol.trim()) throw new Error('Enter a ticker symbol.');

  type Attempt = { label: string; run: () => Promise<Dataset> };
  const yahoo: Attempt = { label: 'Yahoo', run: () => fetchYahoo(req, signal) };
  const binance: Attempt = { label: 'Binance', run: () => fetchBinance(req, signal) };
  const alpha: Attempt = { label: 'Alpha Vantage', run: () => fetchAlphaVantage(req, signal) };

  let attempts: Attempt[];
  switch (req.source) {
    case 'yahoo':
      attempts = [yahoo];
      break;
    case 'binance':
      attempts = [binance];
      break;
    case 'alphavantage':
      attempts = [alpha];
      break;
    case 'auto':
      attempts = looksLikeCrypto(req.symbol) ? [binance, yahoo] : [yahoo];
      if (req.alphaVantageKey?.trim() && !looksLikeCrypto(req.symbol)) attempts.push(alpha);
      break;
  }

  const failures: string[] = [];
  for (const attempt of attempts) {
    try {
      return await attempt.run();
    } catch (e) {
      if (signal?.aborted) throw e;
      failures.push(`${attempt.label}: ${errorMessage(e)}`);
    }
  }

  if (req.since !== undefined) throw new Error(failures.join(' / '));
  const sample = await findSampleFor(req.symbol);
  if (sample) {
    const data = await loadSample(sample.symbol);
    return { ...data, notice: `Online fetch failed; loaded bundled sample for ${sample.symbol}. (${failures.join(' / ')})` };
  }
  throw new Error(failures.join(' / '));
}
