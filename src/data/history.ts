/**
 * Cache-first loading of ticker histories on top of the local database.
 *
 * 1. A saved series that covers the requested range and was downloaded
 *    recently is served straight from IndexedDB, with no network request.
 * 2. An older saved series is extended incrementally: only the bars after the
 *    last saved one (plus a short overlap) are downloaded and merged.
 *    If the overlap shows that the provider re-adjusted past prices (a split),
 *    the whole history is downloaded again instead of merging.
 * 3. When the network fails, the saved series is served with an offline
 *    status, so a ticker that was fetched once stays usable.
 *
 * The database always keeps the widest history ever downloaded; the dataset
 * returned to the UI is trimmed to the requested range.
 */
import type { Bar } from '../engine/types';
import { fetchMarketData, rangeStartSeconds, type Dataset, type FetchRange, type FetchRequest, type ProviderId } from './providers';
import { fileKey, getSeries, putSeries, seriesKey, touchSeries, type SeriesMeta, type StoredSeries } from './store';

const SECONDS_PER_DAY = 86_400;
/** A saved series younger than this is served without any network request. */
export const FRESH_FOR_MS = 60 * 60 * 1000;
/** Slack when checking range coverage, since range starts move with the clock. */
const COVERAGE_TOLERANCE_S = 7 * SECONDS_PER_DAY;
/** Relative close difference on overlapping bars that signals re-adjusted history. */
const ADJUSTMENT_TOLERANCE = 0.005;

export type LoadStatus =
  /** Served from the database without a network request. */
  | 'cached'
  /** Downloaded in full (first fetch, different source, wider range or re-adjusted history). */
  | 'fetched'
  /** Saved series extended with the latest bars. */
  | 'updated'
  /** Network failed; the saved series was served instead. */
  | 'offline';

export interface LoadResult {
  dataset: Dataset;
  status: LoadStatus;
  /** Bars added to the saved series by an incremental update. */
  added: number;
  /** When the saved data was last downloaded, epoch milliseconds. */
  fetchedAt: number;
  /** Network error behind an `offline` status. */
  error?: string;
}

/* -------------------------------------------------------------------------- */
/* Pure helpers (exported for unit testing)                                   */
/* -------------------------------------------------------------------------- */

/** Merges two sorted bar arrays; on equal timestamps the `fresh` bar wins. */
export function mergeBars(saved: readonly Bar[], fresh: readonly Bar[]): Bar[] {
  const out: Bar[] = [];
  let i = 0;
  let j = 0;
  while (i < saved.length || j < fresh.length) {
    if (j >= fresh.length || (i < saved.length && saved[i].time < fresh[j].time)) out.push(saved[i++]);
    else {
      if (i < saved.length && saved[i].time === fresh[j].time) i++;
      out.push(fresh[j++]);
    }
  }
  return out;
}

/**
 * True when closes on overlapping bars disagree, i.e. the provider re-adjusted
 * past prices (typically after a split) and merging would create a price jump.
 * The last saved bar is ignored because it may have been an unfinished session.
 */
export function historyRewritten(saved: readonly Bar[], fresh: readonly Bar[], tolerance = ADJUSTMENT_TOLERANCE): boolean {
  const byTime = new Map(fresh.map((b) => [b.time, b.close]));
  for (let i = 0; i < saved.length - 1; i++) {
    const c = byTime.get(saved[i].time);
    if (c !== undefined && Math.abs(c - saved[i].close) / saved[i].close > tolerance) return true;
  }
  return false;
}

/** Whether a saved series starting its coverage at `coveredFrom` satisfies `range`. */
export function coversRange(coveredFrom: number, range: FetchRange): boolean {
  return coveredFrom <= rangeStartSeconds(range) + COVERAGE_TOLERANCE_S;
}

const RANGES_ASC: readonly FetchRange[] = ['1y', '2y', '5y', '10y', 'max'];

/** Smallest fetch range that reaches back to `coveredFrom`. */
export function rangeCovering(coveredFrom: number): FetchRange {
  return RANGES_ASC.find((r) => rangeStartSeconds(r) <= coveredFrom + COVERAGE_TOLERANCE_S) ?? 'max';
}

/** Whether a saved series can be extended for a request with the given source. */
export function compatibleProvider(saved: ProviderId, source: FetchRequest['source']): boolean {
  if (saved === 'csv' || saved === 'sample') return false;
  return source === 'auto' || source === saved;
}

/** Overlap re-downloaded on incremental updates, to replace unfinished bars and detect re-adjustments. */
function overlapSeconds(req: FetchRequest): number {
  return (req.interval === '1wk' ? 35 : 10) * SECONDS_PER_DAY;
}

/* -------------------------------------------------------------------------- */
/* Loading                                                                    */
/* -------------------------------------------------------------------------- */

function toDataset(series: StoredSeries, range: FetchRange | null): Dataset {
  const start = range ? rangeStartSeconds(range) : 0;
  const bars = start > 0 ? series.bars.filter((b) => b.time >= start) : series.bars;
  return {
    symbol: series.symbol,
    name: series.name,
    bars: bars.length >= 2 ? bars : series.bars,
    source: series.source,
    provider: series.provider,
    storeKey: series.key,
    warnings: [],
  };
}

async function readSaved(key: string): Promise<StoredSeries | undefined> {
  try {
    return await getSeries(key);
  } catch {
    return undefined;
  }
}

/** Saves a series; storage failures are reported as a warning, never thrown. */
async function save(series: Omit<StoredSeries, 'count' | 'firstTime' | 'lastTime'>, dataset: Dataset): Promise<void> {
  try {
    await putSeries(series);
  } catch (e) {
    dataset.warnings.push(`Not saved to the local database: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export interface LoadOptions {
  /** Skip the freshness check and always contact the provider. */
  force?: boolean;
}

/** Loads a ticker for `req`, using and maintaining the local database. */
export async function loadTicker(req: FetchRequest, signal?: AbortSignal, options: LoadOptions = {}): Promise<LoadResult> {
  const query = req.symbol.trim().toUpperCase();
  const key = seriesKey(query, req.interval);
  const saved = await readSaved(key);
  const usable = saved && compatibleProvider(saved.provider, req.source) ? saved : undefined;

  if (usable && coversRange(usable.coveredFrom, req.range)) {
    if (!options.force && Date.now() - usable.fetchedAt < FRESH_FOR_MS) {
      void touchSeries(key).catch(() => undefined);
      return { dataset: toDataset(usable, req.range), status: 'cached', added: 0, fetchedAt: usable.fetchedAt };
    }

    let fresh: Dataset;
    try {
      const source = usable.provider as FetchRequest['source'];
      fresh = await fetchMarketData({ ...req, source, since: usable.lastTime - overlapSeconds(req) }, signal);
    } catch (e) {
      if (signal?.aborted) throw e;
      void touchSeries(key).catch(() => undefined);
      const error = e instanceof Error ? e.message : String(e);
      return { dataset: toDataset(usable, req.range), status: 'offline', added: 0, fetchedAt: usable.fetchedAt, error };
    }

    if (!historyRewritten(usable.bars, fresh.bars)) {
      const bars = mergeBars(usable.bars, fresh.bars);
      const now = Date.now();
      const series: StoredSeries = {
        ...usable,
        bars,
        name: fresh.name && fresh.name !== fresh.symbol ? fresh.name : usable.name,
        source: fresh.source,
        count: bars.length,
        lastTime: bars[bars.length - 1].time,
        fetchedAt: now,
        accessedAt: now,
      };
      const dataset = toDataset(series, req.range);
      await save(series, dataset);
      return { dataset, status: 'updated', added: bars.length - usable.bars.length, fetchedAt: now };
    }
    // Past prices changed: download everything again over the saved coverage.
    return fullFetch({ ...req, range: rangeCovering(Math.min(usable.coveredFrom, rangeStartSeconds(req.range))) }, req.range, key, query, saved, signal);
  }

  return fullFetch(req, req.range, key, query, saved, signal);
}

async function fullFetch(
  req: FetchRequest,
  displayRange: FetchRange,
  key: string,
  query: string,
  saved: StoredSeries | undefined,
  signal?: AbortSignal,
): Promise<LoadResult> {
  let fresh: Dataset;
  try {
    fresh = await fetchMarketData({ ...req, since: undefined }, signal);
  } catch (e) {
    if (signal?.aborted || !saved) throw e;
    // Anything saved beats an error, even if it is shorter or from another source.
    void touchSeries(key).catch(() => undefined);
    const error = e instanceof Error ? e.message : String(e);
    return { dataset: toDataset(saved, displayRange), status: 'offline', added: 0, fetchedAt: saved.fetchedAt, error };
  }

  if (fresh.provider === 'sample') {
    // Every online source failed and the bundled sample was returned: prefer saved data, never store the sample.
    if (saved) return { dataset: toDataset(saved, displayRange), status: 'offline', added: 0, fetchedAt: saved.fetchedAt, error: fresh.notice };
    return { dataset: fresh, status: 'fetched', added: 0, fetchedAt: Date.now() };
  }

  const now = Date.now();
  const series: StoredSeries = {
    key,
    query,
    symbol: fresh.symbol,
    name: fresh.name,
    interval: req.interval,
    provider: fresh.provider,
    source: fresh.source,
    bars: fresh.bars,
    count: fresh.bars.length,
    firstTime: fresh.bars[0].time,
    lastTime: fresh.bars[fresh.bars.length - 1].time,
    coveredFrom: rangeStartSeconds(req.range),
    fetchedAt: now,
    accessedAt: now,
  };
  const dataset: Dataset = { ...toDataset(series, displayRange), warnings: [...fresh.warnings], notice: fresh.notice };
  await save(series, dataset);
  return { dataset, status: 'fetched', added: 0, fetchedAt: now };
}

/** Opens a saved series with its whole history. */
export async function openSaved(key: string): Promise<Dataset> {
  const series = await getSeries(key);
  if (!series) throw new Error('This series is no longer in the local database.');
  void touchSeries(key).catch(() => undefined);
  return toDataset(series, null);
}

/** Downloads the latest bars for a saved series, from the provider it came from. */
export function refreshSaved(meta: SeriesMeta, settings: Pick<FetchRequest, 'alphaVantageKey' | 'customProxy'>, signal?: AbortSignal): Promise<LoadResult> {
  if (meta.provider === 'csv' || meta.provider === 'sample') return Promise.reject(new Error('Local files cannot be refreshed.'));
  return loadTicker(
    { ...settings, symbol: meta.query, source: meta.provider, interval: meta.interval, range: rangeCovering(meta.coveredFrom) },
    signal,
    { force: true },
  );
}

/** Saves an uploaded CSV dataset to the library and returns it with its key. */
export async function saveFile(dataset: Dataset, fileName: string): Promise<Dataset> {
  const now = Date.now();
  const key = fileKey(fileName);
  const out: Dataset = { ...dataset, provider: 'csv', storeKey: key, warnings: [...dataset.warnings] };
  await save(
    {
      key,
      query: dataset.symbol,
      symbol: dataset.symbol,
      name: dataset.name,
      interval: '1d',
      provider: 'csv',
      source: dataset.source,
      bars: dataset.bars,
      coveredFrom: dataset.bars[0]?.time ?? 0,
      fetchedAt: now,
      accessedAt: now,
    },
    out,
  );
  return out;
}
