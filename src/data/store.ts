/**
 * Local price-history database backed by IndexedDB.
 *
 * Every ticker fetched online (and every uploaded CSV) is saved here with its
 * full bar history, so it can be reopened instantly, used offline and later
 * extended with only the missing bars. Metadata and bars live in separate
 * object stores so listing the library never loads the price arrays.
 *
 * IndexedDB may be unavailable (some private modes, blocked site data); every
 * function then rejects and callers fall back to network-only behaviour.
 */
import type { Bar } from '../engine/types';
import type { FetchInterval, ProviderId } from './providers';

export interface SeriesMeta {
  /** Primary key, see `seriesKey`. */
  key: string;
  /** Symbol as typed by the user (normalized), used to refresh the series. */
  query: string;
  /** Symbol reported by the provider, e.g. `BTCUSDT` for a `BTC-USD` query. */
  symbol: string;
  name: string;
  interval: FetchInterval;
  provider: ProviderId;
  /** Human-readable source of the last download. */
  source: string;
  count: number;
  firstTime: number;
  lastTime: number;
  /** Earliest start (epoch seconds) ever requested; 0 means full history. */
  coveredFrom: number;
  /** Last successful download, epoch milliseconds. */
  fetchedAt: number;
  /** Last time the series was opened, epoch milliseconds. */
  accessedAt: number;
}

export interface StoredSeries extends SeriesMeta {
  bars: Bar[];
}

const DB_NAME = 'backtest-terminal';
const DB_VERSION = 1;
const META = 'meta';
const BARS = 'bars';

/** Library key for a ticker query and interval, e.g. `AAPL|1d`. */
export function seriesKey(query: string, interval: FetchInterval): string {
  return `${query.trim().toUpperCase()}|${interval}`;
}

/** Library key for an uploaded CSV file. */
export function fileKey(fileName: string): string {
  return `file:${fileName}`;
}

/* -------------------------------------------------------------------------- */
/* Connection                                                                 */
/* -------------------------------------------------------------------------- */

let dbPromise: Promise<IDBDatabase> | null = null;

function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
  });
}

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available in this browser'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(BARS)) db.createObjectStore(BARS, { keyPath: 'key' });
    };
    req.onsuccess = () => {
      const db = req.result;
      // Another tab upgrading the schema: release the connection and reopen lazily.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      // Ask the browser not to evict the library under storage pressure. Best effort.
      if (typeof navigator !== 'undefined') void navigator.storage?.persist?.()?.catch(() => false);
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error('Cannot open IndexedDB'));
    req.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'));
  }).catch((e: unknown) => {
    dbPromise = null;
    throw e;
  });
  return dbPromise;
}

/* -------------------------------------------------------------------------- */
/* Change notifications                                                       */
/* -------------------------------------------------------------------------- */

const listeners = new Set<() => void>();

/** Registers a callback fired after any write; returns the unsubscribe function. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  for (const l of listeners) l();
}

/* -------------------------------------------------------------------------- */
/* Operations                                                                 */
/* -------------------------------------------------------------------------- */

/** All saved series, most recently opened first. */
export async function listSeries(): Promise<SeriesMeta[]> {
  const db = await openDb();
  const all = await requestToPromise(db.transaction(META, 'readonly').objectStore(META).getAll() as IDBRequest<SeriesMeta[]>);
  return all.sort((a, b) => b.accessedAt - a.accessedAt);
}

export async function getSeries(key: string): Promise<StoredSeries | undefined> {
  const db = await openDb();
  const tx = db.transaction([META, BARS], 'readonly');
  const [meta, bars] = await Promise.all([
    requestToPromise(tx.objectStore(META).get(key) as IDBRequest<SeriesMeta | undefined>),
    requestToPromise(tx.objectStore(BARS).get(key) as IDBRequest<{ key: string; bars: Bar[] } | undefined>),
  ]);
  if (!meta || !bars) return undefined;
  return { ...meta, bars: bars.bars };
}

/** Inserts or replaces a series. `count`, `firstTime` and `lastTime` are derived from the bars. */
export async function putSeries(series: Omit<StoredSeries, 'count' | 'firstTime' | 'lastTime'>): Promise<SeriesMeta> {
  if (series.bars.length === 0) throw new Error('Cannot save an empty series');
  const { bars, ...rest } = series;
  const meta: SeriesMeta = { ...rest, count: bars.length, firstTime: bars[0].time, lastTime: bars[bars.length - 1].time };
  const db = await openDb();
  const tx = db.transaction([META, BARS], 'readwrite');
  tx.objectStore(META).put(meta);
  tx.objectStore(BARS).put({ key: meta.key, bars });
  await txDone(tx);
  notify();
  return meta;
}

/** Marks a series as just opened, which moves it to the top of the library. */
export async function touchSeries(key: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(META, 'readwrite');
  const store = tx.objectStore(META);
  const meta = await requestToPromise(store.get(key) as IDBRequest<SeriesMeta | undefined>);
  if (meta) store.put({ ...meta, accessedAt: Date.now() });
  await txDone(tx);
  notify();
}

export async function deleteSeries(key: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([META, BARS], 'readwrite');
  tx.objectStore(META).delete(key);
  tx.objectStore(BARS).delete(key);
  await txDone(tx);
  notify();
}

/** Test helper: drops the cached connection so a fresh IndexedDB can be injected. */
export function resetConnectionForTests(): void {
  dbPromise = null;
}
