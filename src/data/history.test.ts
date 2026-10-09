import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bar } from '../engine/types';
import { coversRange, historyRewritten, loadTicker, mergeBars, rangeCovering, refreshSaved, saveFile } from './history';
import type { Dataset, FetchRequest } from './providers';
import { deleteSeries, getSeries, listSeries, putSeries, resetConnectionForTests } from './store';

vi.mock('./providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./providers')>();
  return { ...actual, fetchMarketData: vi.fn() };
});
const { fetchMarketData } = await import('./providers');
const fetchMock = vi.mocked(fetchMarketData);

const DAY = 86_400;
const today = Math.floor(Date.now() / 1000 / DAY) * DAY;
const bar = (time: number, close: number): Bar => ({ time, open: close, high: close, low: close, close, volume: 1 });
/** `n` consecutive daily bars ending `endDaysAgo` days before today, closes starting at `start`. */
const series = (n: number, endDaysAgo: number, start = 100): Bar[] =>
  Array.from({ length: n }, (_, i) => bar(today - (endDaysAgo + n - 1 - i) * DAY, start + i));
const yahoo = (bars: Bar[]): Dataset => ({ symbol: 'AAPL', name: 'Apple Inc.', bars, source: 'Yahoo Finance via test', provider: 'yahoo', warnings: [] });
const req: FetchRequest = { symbol: 'aapl', source: 'auto', range: '1y', interval: '1d' };

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  resetConnectionForTests();
  fetchMock.mockReset();
});

describe('pure helpers', () => {
  it('merges histories, preferring fresh bars on equal dates', () => {
    expect(mergeBars([bar(1, 1), bar(2, 2), bar(3, 3)], [bar(3, 30), bar(4, 4)]).map((b) => b.close)).toEqual([1, 2, 30, 4]);
    expect(mergeBars([], [bar(1, 1)])).toHaveLength(1);
  });

  it('detects re-adjusted history but ignores the unfinished last bar', () => {
    const saved = [bar(1, 100), bar(2, 101), bar(3, 102)];
    expect(historyRewritten(saved, [bar(2, 101), bar(3, 150), bar(4, 103)])).toBe(false);
    expect(historyRewritten(saved, [bar(2, 25.25), bar(3, 25.5)])).toBe(true);
  });

  it('checks range coverage with tolerance', () => {
    const fiveYearsAgo = today - 5 * 365.25 * DAY;
    expect(coversRange(fiveYearsAgo, '5y')).toBe(true);
    expect(coversRange(fiveYearsAgo, '10y')).toBe(false);
    expect(coversRange(0, 'max')).toBe(true);
    expect(rangeCovering(fiveYearsAgo)).toBe('5y');
    expect(rangeCovering(0)).toBe('max');
  });
});

describe('store', () => {
  it('saves, lists and deletes series', async () => {
    const meta = await putSeries({
      key: 'X|1d', query: 'X', symbol: 'X', name: 'X', interval: '1d', provider: 'yahoo', source: 's',
      bars: series(3, 0), coveredFrom: 0, fetchedAt: 1, accessedAt: 1,
    });
    expect(meta).toMatchObject({ count: 3, firstTime: today - 2 * DAY, lastTime: today });
    expect((await listSeries()).map((m) => m.key)).toEqual(['X|1d']);
    expect((await getSeries('X|1d'))?.bars).toHaveLength(3);
    await deleteSeries('X|1d');
    expect(await listSeries()).toEqual([]);
  });
});

describe('loadTicker', () => {
  it('downloads and saves the first request, then serves it from the database', async () => {
    fetchMock.mockResolvedValueOnce(yahoo(series(200, 0)));
    const first = await loadTicker(req);
    expect(first.status).toBe('fetched');
    expect(first.dataset.storeKey).toBe('AAPL|1d');
    expect((await getSeries('AAPL|1d'))?.count).toBe(200);

    const second = await loadTicker(req);
    expect(second.status).toBe('cached');
    expect(second.dataset.bars).toHaveLength(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('extends a stale series with only the missing bars', async () => {
    fetchMock.mockResolvedValueOnce(yahoo(series(100, 5)));
    await loadTicker(req);
    // Overlap re-sends the last 11 saved bars; 5 new days follow.
    fetchMock.mockResolvedValueOnce(yahoo(series(16, 0, 100 + 89)));
    const r = await loadTicker(req, undefined, { force: true });
    expect(r.status).toBe('updated');
    expect(r.added).toBe(5);
    expect(r.dataset.bars).toHaveLength(105);
    const call = fetchMock.mock.calls[1][0];
    expect(call.source).toBe('yahoo');
    expect(call.since).toBe(today - 5 * DAY - 10 * DAY);
  });

  it('downloads everything again when past prices were re-adjusted', async () => {
    fetchMock.mockResolvedValueOnce(yahoo(series(100, 5)));
    await loadTicker(req);
    fetchMock.mockResolvedValueOnce(yahoo(series(16, 0, 10))); // closes no longer match
    fetchMock.mockResolvedValueOnce(yahoo(series(105, 0, 20)));
    const r = await loadTicker(req, undefined, { force: true });
    expect(r.status).toBe('fetched');
    expect(fetchMock.mock.calls[2][0].since).toBeUndefined();
    expect((await getSeries('AAPL|1d'))?.bars[0].close).toBe(20);
  });

  it('serves the saved series when the network fails', async () => {
    fetchMock.mockResolvedValueOnce(yahoo(series(50, 3)));
    await loadTicker(req);
    fetchMock.mockRejectedValueOnce(new Error('All CORS proxies failed'));
    const r = await loadTicker(req, undefined, { force: true });
    expect(r.status).toBe('offline');
    expect(r.error).toMatch(/proxies/);
    expect(r.dataset.bars).toHaveLength(50);
  });

  it('downloads again when a wider range is requested', async () => {
    fetchMock.mockResolvedValueOnce(yahoo(series(50, 0)));
    await loadTicker(req);
    fetchMock.mockResolvedValueOnce(yahoo(series(300, 0)));
    const r = await loadTicker({ ...req, range: '5y' });
    expect(r.status).toBe('fetched');
    expect(fetchMock.mock.calls[1][0]).toMatchObject({ range: '5y', since: undefined });
  });

  it('refreshes a saved series from its original provider', async () => {
    fetchMock.mockResolvedValueOnce(yahoo(series(50, 2)));
    const { dataset } = await loadTicker(req);
    const meta = (await listSeries())[0];
    fetchMock.mockResolvedValueOnce(yahoo(series(13, 0, 100 + 39)));
    const r = await refreshSaved(meta, {});
    expect(r.status).toBe('updated');
    expect(r.added).toBe(2);
    expect(fetchMock.mock.calls[1][0]).toMatchObject({ symbol: 'AAPL', source: 'yahoo' });
    expect(dataset.storeKey).toBe(meta.key);
  });

  it('never stores the bundled-sample fallback', async () => {
    fetchMock.mockResolvedValueOnce({ ...yahoo(series(20, 0)), provider: 'sample', notice: 'fallback' });
    const r = await loadTicker(req);
    expect(r.dataset.provider).toBe('sample');
    expect(await listSeries()).toEqual([]);
  });

  it('saves uploaded files to the library', async () => {
    const d = await saveFile({ symbol: 'MY', name: 'my.csv', bars: series(5, 0), source: 'Local file', provider: 'csv', warnings: [] }, 'my.csv');
    expect(d.storeKey).toBe('file:my.csv');
    expect((await listSeries())[0]).toMatchObject({ provider: 'csv', count: 5 });
  });
});
