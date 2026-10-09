import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchMarketData } from './providers';

const DAY = 86_400;
const T0 = Date.UTC(2024, 0, 2) / 1000;

/** Minimal Yahoo chart payload in the snapshot format. */
function chart(symbol: string, n: number): string {
  const timestamp = Array.from({ length: n }, (_, i) => T0 + i * DAY);
  const series = timestamp.map((_, i) => 100 + i);
  return JSON.stringify({
    chart: {
      result: [{ meta: { symbol, longName: `${symbol} Inc.`, gmtoffset: 0 }, timestamp, indicators: { quote: [{ open: series, high: series, low: series, close: series, volume: series }] } }],
      error: null,
    },
  });
}

/** Binance klines: [openTime, open, high, low, close, volume, closeTime]. */
function klines(n: number): unknown[] {
  return Array.from({ length: n }, (_, i) => {
    const open = (T0 + i * DAY) * 1000;
    return [open, '10', '11', '9', '10.5', '1', open + DAY * 1000 - 1];
  });
}

const SNAPSHOT_INDEX = { generatedAt: '2024-02-01', symbols: { AAPL: { file: 'AAPL.json', name: 'Apple Inc.', first: '2024-01-02', last: '2024-01-11', bars: 10 } } };
const SAMPLE_INDEX = readFileSync(new URL('../../public/sample_data/index.json', import.meta.url), 'utf8');
const SAMPLE_MSFT = readFileSync(new URL('../../public/sample_data/MSFT.csv', import.meta.url), 'utf8');

/** Routes requests to canned responses; `binanceUp` toggles the Binance API. */
function mockNetwork(binanceUp = true): string[] {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (input: string) => {
    const url = String(input);
    calls.push(url);
    const ok = (body: string): Response => new Response(body, { status: 200 });
    if (url.endsWith('history/index.json')) return ok(JSON.stringify(SNAPSHOT_INDEX));
    if (url.endsWith('history/AAPL.json')) return ok(chart('AAPL', 10));
    if (url.endsWith('sample_data/index.json')) return ok(SAMPLE_INDEX);
    if (url.endsWith('sample_data/MSFT.csv')) return ok(SAMPLE_MSFT);
    if (url.includes('binance') && binanceUp) return ok(JSON.stringify(klines(5)));
    return new Response('', { status: 404, statusText: 'Not Found' });
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchMarketData', () => {
  it('serves watchlist symbols from the same-origin snapshot', async () => {
    const calls = mockNetwork();
    const d = await fetchMarketData({ symbol: 'aapl', source: 'auto', range: 'max' });
    expect(d).toMatchObject({ symbol: 'AAPL', name: 'AAPL Inc.', provider: 'snapshot' });
    expect(d.bars).toHaveLength(10);
    expect(calls.some((u) => u.includes('binance'))).toBe(false);
  });

  it('falls through to Binance for crypto symbols outside the snapshot', async () => {
    mockNetwork();
    const d = await fetchMarketData({ symbol: 'DOGE-USD', source: 'auto', range: 'max' });
    expect(d).toMatchObject({ symbol: 'DOGEUSDT', provider: 'binance' });
    expect(d.bars).toHaveLength(5);
  });

  it('never routes stock symbols to Binance', async () => {
    const calls = mockNetwork();
    await expect(fetchMarketData({ symbol: 'TSLA', source: 'auto', range: 'max' })).rejects.toThrow('not in the site snapshot');
    expect(calls.some((u) => u.includes('binance'))).toBe(false);
  });

  it('falls back to the bundled sample when the sources fail', async () => {
    mockNetwork(false);
    const d = await fetchMarketData({ symbol: 'MSFT', source: 'auto', range: 'max' });
    expect(d.provider).toBe('sample');
    expect(d.notice).toMatch(/bundled sample for MSFT/);
  });
});
