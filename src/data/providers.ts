/**
 * Market data sources usable directly from the browser, with no proxy and
 * nothing stored locally: every load goes to the network.
 *
 * - Site snapshot: full daily Yahoo Finance history of the symbols in
 *   `data/watchlist.json`, downloaded server-side by
 *   `scripts/build-history.mjs` at deploy time and served as static files
 *   (`public/history`). Same-origin, so no CORS issue.
 * - Binance public market data: crypto spot pairs, keyless and CORS-enabled.
 * - Bundled samples: static CSV files shipped in `public/sample_data`, used
 *   on first load and as a fallback when the network sources fail.
 */
import type { Bar } from '../engine/types';
import { parseOhlcvCsv } from './csv';

export type DataSource = 'auto' | 'snapshot' | 'binance';
export type FetchRange = '1y' | '2y' | '5y' | '10y' | 'max';
/** Concrete origin of a dataset. */
export type ProviderId = 'snapshot' | 'binance' | 'sample' | 'csv';

export interface FetchRequest {
  symbol: string;
  source: DataSource;
  range: FetchRange;
}

export interface Dataset {
  symbol: string;
  name: string;
  bars: Bar[];
  /** Human-readable description of where the data came from. */
  source: string;
  provider: ProviderId;
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
/** Snapshot files of long-lived indices reach a few hundred kilobytes. */
const SNAPSHOT_TIMEOUT_MS = 30_000;

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
/* Yahoo chart payload (format of the snapshot files)                         */
/* -------------------------------------------------------------------------- */

interface YahooParsed {
  bars: Bar[];
  name: string;
}

/** Parses a Yahoo Finance v8 chart payload. Exported for unit testing. */
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
  const entry = (await loadSnapshotIndex())?.symbols[symbol];
  if (!entry) throw new Error(`${symbol} is not in the site snapshot`);
  const res = await fetchWithTimeout(`${import.meta.env.BASE_URL}history/${entry.file}`, signal, SNAPSHOT_TIMEOUT_MS);
  const parsed = parseYahooChart(await res.text());
  const start = rangeStartSeconds(req.range);
  const bars = parsed.bars.filter((b) => b.time >= start);
  if (bars.length < 2) throw new Error(`no snapshot bars in the selected range`);
  return {
    symbol,
    name: parsed.name || entry.name || symbol,
    bars,
    source: `Yahoo Finance (site snapshot, ${entry.last})`,
    provider: 'snapshot',
    warnings: [],
  };
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
  const limit = 1000;
  let startMs = rangeStartSeconds(req.range) * 1000;
  const nowMs = Date.now();
  const bars: Bar[] = [];

  for (let page = 0; page < 50; page++) {
    const url =
      `https://data-api.binance.vision/api/v3/klines?symbol=${encodeURIComponent(pair)}` +
      `&interval=1d&limit=${limit}&startTime=${startMs}`;
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
  if (clean.length < 2) throw new Error(`Binance ${pair}: no data (is the pair listed?)`);
  return { symbol: pair, name: pair, bars: clean, source: 'Binance public market data', provider: 'binance', warnings: [] };
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
 * Fetches daily OHLCV bars according to `req.source`. With `auto`, symbols in
 * the site snapshot load from it and crypto symbols fall through to Binance.
 * If every attempt fails and a bundled sample exists for the symbol, the
 * sample is returned with a notice.
 */
export async function fetchMarketData(req: FetchRequest, signal?: AbortSignal): Promise<Dataset> {
  if (!req.symbol.trim()) throw new Error('Enter a ticker symbol.');

  type Attempt = { label: string; run: () => Promise<Dataset> };
  const snapshot: Attempt = { label: 'Snapshot', run: () => fetchSnapshot(req, signal) };
  const binance: Attempt = { label: 'Binance', run: () => fetchBinance(req, signal) };

  let attempts: Attempt[];
  switch (req.source) {
    case 'snapshot':
      attempts = [snapshot];
      break;
    case 'binance':
      attempts = [binance];
      break;
    case 'auto':
      attempts = looksLikeCrypto(req.symbol) ? [snapshot, binance] : [snapshot];
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

  const sample = await findSampleFor(req.symbol);
  if (sample) {
    const data = await loadSample(sample.symbol);
    return { ...data, notice: `Online fetch failed; loaded bundled sample for ${sample.symbol}. (${failures.join(' / ')})` };
  }
  throw new Error(failures.join(' / '));
}
