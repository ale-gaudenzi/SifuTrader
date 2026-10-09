/**
 * Data source panel: bundled samples, online ticker fetch, the library of
 * saved tickers and CSV upload. Fetched tickers and uploaded files are saved
 * in the local database (see `data/history.ts`).
 */
import { useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { CsvParseError, parseCsvFile } from '../data/csv';
import { loadTicker, openSaved, refreshSaved, saveFile, type LoadResult } from '../data/history';
import {
  loadSample,
  loadSampleManifest,
  loadSnapshotIndex,
  type DataSource,
  type Dataset,
  type FetchInterval,
  type FetchRange,
  type SampleInfo,
} from '../data/providers';
import type { SeriesMeta } from '../data/store';
import { formatAgo } from '../format';
import { isBoolean, isOneOf, isString, usePersistentState } from '../hooks/usePersistentState';
import { useSavedSeries } from '../hooks/useSavedSeries';
import { useI18n, type MessageKey } from '../i18n';
import CollapsibleHeader from './CollapsibleHeader';
import SavedTickers from './SavedTickers';

const SOURCES: ReadonlyArray<{ value: DataSource; label: MessageKey }> = [
  { value: 'auto', label: 'data.src.auto' },
  { value: 'yahoo', label: 'data.src.yahoo' },
  { value: 'binance', label: 'data.src.binance' },
  { value: 'alphavantage', label: 'data.src.alphavantage' },
];
const RANGES: readonly FetchRange[] = ['1y', '2y', '5y', '10y', 'max'];
const INTERVALS: ReadonlyArray<{ value: FetchInterval; label: MessageKey }> = [
  { value: '1d', label: 'data.int.1d' },
  { value: '1wk', label: 'data.int.1wk' },
];
const SUGGESTIONS = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'TSLA', 'SPY', 'QQQ', 'BTC-USD', 'ETH-USD', 'SOL-USD', 'EURUSD=X', '^GSPC'];

type Status =
  | { kind: 'idle' }
  | { kind: 'loading'; message: string }
  | { kind: 'error'; message: string }
  | { kind: 'info'; message: string }
  | { kind: 'ok'; message: string };

/** What a task hands back: a dataset to display (optional) and the status line to show. */
interface Outcome {
  dataset?: Dataset;
  status?: Status;
  warnings?: string[];
}

export interface DataInputProps {
  onDataset: (dataset: Dataset) => void;
  /** Symbol of the dataset currently displayed. */
  activeSymbol: string | null;
  /** Library key of the dataset currently displayed, if it is saved. */
  activeKey: string | null;
  /** Bundled sample loaded on first render. */
  initialSample: string;
}

export default function DataInput({ onDataset, activeSymbol, activeKey, initialSample }: DataInputProps) {
  const { t, locale } = useI18n();
  const library = useSavedSeries();
  const [samples, setSamples] = useState<SampleInfo[]>([]);
  const [snapshotSymbols, setSnapshotSymbols] = useState<string[]>([]);
  const [symbol, setSymbol] = usePersistentState('fetch.symbol', 'AAPL', isString);
  const [source, setSource] = usePersistentState<DataSource>('fetch.source', 'auto', isOneOf(SOURCES.map((s) => s.value)));
  const [range, setRange] = usePersistentState<FetchRange>('fetch.range', '5y', isOneOf(RANGES));
  const [interval, setFetchInterval] = usePersistentState<FetchInterval>('fetch.interval', '1d', isOneOf(INTERVALS.map((i) => i.value)));
  const [avKey, setAvKey] = usePersistentState('fetch.alphaVantageKey', '', isString);
  const [proxy, setProxy] = usePersistentState('fetch.customProxy', '', isString);
  const [open, setOpen] = usePersistentState('ui.dataOpen', true, isBoolean);
  const [showSettings, setShowSettings] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [warnings, setWarnings] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const bootstrapped = useRef(false);

  const deliver = (dataset: Dataset): Outcome => ({
    dataset,
    warnings: dataset.warnings,
    status: dataset.notice ? { kind: 'info', message: dataset.notice } : { kind: 'idle' },
  });

  /** Turns a library load into the dataset plus a status line explaining where the bars came from. */
  const describe = (r: LoadResult, show: boolean): Outcome => {
    const s = r.dataset.symbol;
    const when = formatAgo(r.fetchedAt, locale);
    let status: Status;
    if (r.dataset.notice) status = { kind: 'info', message: r.dataset.notice };
    else if (r.status === 'offline') status = { kind: 'info', message: t('data.st.offline', { s, when, msg: r.error ?? '' }) };
    else if (r.status === 'cached') status = { kind: 'ok', message: t('data.st.cached', { s, when }) };
    else if (r.status === 'updated') status = { kind: 'ok', message: r.added > 0 ? t('data.st.updated', { s, n: r.added }) : t('data.st.upToDate', { s }) };
    else status = { kind: 'ok', message: t(r.dataset.storeKey ? 'data.st.fetched' : 'data.st.fetchedUnsaved', { s, n: r.dataset.bars.length }) };
    return { dataset: show ? r.dataset : undefined, status, warnings: r.dataset.warnings };
  };

  const run = async (label: string, task: (signal: AbortSignal) => Promise<Outcome>): Promise<void> => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus({ kind: 'loading', message: label });
    setWarnings([]);
    try {
      const outcome = await task(controller.signal);
      if (controller.signal.aborted) return;
      if (outcome.dataset) onDataset(outcome.dataset);
      setWarnings(outcome.warnings ?? []);
      setStatus(outcome.status ?? { kind: 'idle' });
    } catch (e) {
      if (controller.signal.aborted) return;
      setStatus({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  const openSample = (s: string): Promise<void> => run(t('data.loadingSample', { s }), async () => deliver(await loadSample(s)));
  const settings = { alphaVantageKey: avKey, customProxy: proxy };

  const onOpenSaved = (meta: SeriesMeta): void => {
    void run(t('data.opening', { s: meta.symbol }), async () => ({ ...deliver(await openSaved(meta.key)), status: { kind: 'idle' } }));
  };

  const onRefreshSaved = (meta: SeriesMeta): void => {
    void run(t('data.fetching', { s: meta.symbol }), async (signal) => describe(await refreshSaved(meta, settings, signal), meta.key === activeKey));
  };

  const onRefreshAll = (metas: SeriesMeta[]): void => {
    void run(t('data.updatingAll', { i: 1, n: metas.length, s: metas[0].symbol }), async (signal) => {
      const failures: string[] = [];
      let active: Dataset | undefined;
      for (const [i, meta] of metas.entries()) {
        if (signal.aborted) break;
        setStatus({ kind: 'loading', message: t('data.updatingAll', { i: i + 1, n: metas.length, s: meta.symbol }) });
        try {
          const r = await refreshSaved(meta, settings, signal);
          if (r.status === 'offline') failures.push(`${meta.symbol}: ${r.error ?? ''}`);
          if (meta.key === activeKey) active = r.dataset;
        } catch (e) {
          if (signal.aborted) throw e;
          failures.push(`${meta.symbol}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return {
        dataset: active,
        status: { kind: failures.length > 0 ? 'info' : 'ok', message: t('data.updatedAll', { ok: metas.length - failures.length, n: metas.length }) },
        warnings: failures,
      };
    });
  };

  // Load the manifest and the default sample once so the app works offline out of the box.
  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;
    loadSampleManifest()
      .then(setSamples)
      .catch((e: unknown) => setStatus({ kind: 'error', message: t('data.manifestError', { msg: e instanceof Error ? e.message : String(e) }) }));
    void loadSnapshotIndex().then((index) => setSnapshotSymbols(index ? Object.keys(index.symbols) : []));
    void openSample(initialSample);
    // Bootstrapping runs exactly once on mount.
  }, []);

  const onFetch = (e: FormEvent): void => {
    e.preventDefault();
    const s = symbol.trim();
    if (!s) return;
    void run(t('data.fetching', { s: s.toUpperCase() }), async (signal) => {
      try {
        return describe(await loadTicker({ symbol: s, source, range, interval, ...settings }, signal), true);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        // Yahoo unreachable: point to the two reliable routes.
        throw new Error(message.includes('CORS proxies failed') ? `${message} ${t('data.hintYahoo')}` : message);
      }
    });
  };

  const onFile = (file: File | undefined): void => {
    if (!file) return;
    void run(t('data.parsing', { name: file.name }), async () => {
      try {
        const parsed = await parseCsvFile(file);
        const name = file.name.replace(/\.(csv|txt)$/i, '');
        const dataset: Dataset = {
          symbol: name.toUpperCase(),
          name: file.name,
          bars: parsed.bars,
          source: t('data.localFile', { n: parsed.bars.length, total: parsed.rowsRead }),
          provider: 'csv',
          warnings: parsed.warnings,
        };
        return deliver(await saveFile(dataset, file.name));
      } catch (e) {
        if (e instanceof CsvParseError) throw new Error(`${file.name}: ${e.message}`);
        throw e;
      }
    });
  };

  const onDrop = (e: DragEvent<HTMLElement>): void => {
    e.preventDefault();
    setDragging(false);
    onFile(e.dataTransfer.files[0]);
  };

  const loading = status.kind === 'loading';

  return (
    <section className="panel" aria-label={t('data.title')}>
      <CollapsibleHeader title={t('data.title')} open={open} onToggle={() => setOpen((v) => !v)} controls="data-panel-body" />
      <div id="data-panel-body" className="space-y-4 p-3" hidden={!open}>
        {/* Bundled samples */}
        <div>
          <span className="field-label">{t('data.samples')}</span>
          <div className="flex flex-wrap gap-1.5">
            {samples.map((s) => (
              <button
                key={s.symbol}
                type="button"
                title={s.name}
                disabled={loading}
                className={`chip ${activeSymbol === s.symbol ? 'chip-on border-accent text-accent' : 'chip-off text-terminal-muted'}`}
                onClick={() => void openSample(s.symbol)}
              >
                {s.symbol}
              </button>
            ))}
          </div>
        </div>

        {/* Online fetch */}
        <form onSubmit={onFetch} className="space-y-2">
          <label className="field-label" htmlFor="ticker">
            {t('data.ticker')}
          </label>
          <div className="flex gap-1.5">
            <input
              id="ticker"
              className="input uppercase"
              list="ticker-suggestions"
              value={symbol}
              placeholder="AAPL, BTC-USD, ^GSPC"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setSymbol(e.target.value)}
            />
            <datalist id="ticker-suggestions">
              {[...new Set([...library.items.filter((m) => m.provider !== 'csv').map((m) => m.query), ...snapshotSymbols, ...SUGGESTIONS])].map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
            <button type="submit" className="btn btn-primary shrink-0" disabled={loading || !symbol.trim()}>
              {t('data.fetch')}
            </button>
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            <select className="input text-xs" aria-label={t('data.source')} value={source} onChange={(e) => setSource(e.target.value as DataSource)}>
              {SOURCES.map((s) => (
                <option key={s.value} value={s.value}>
                  {t(s.label)}
                </option>
              ))}
            </select>
            <select className="input text-xs" aria-label={t('data.range')} value={range} onChange={(e) => setRange(e.target.value as FetchRange)}>
              {RANGES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <select className="input text-xs" aria-label={t('data.interval')} value={interval} onChange={(e) => setFetchInterval(e.target.value as FetchInterval)}>
              {INTERVALS.map((i) => (
                <option key={i.value} value={i.value}>
                  {t(i.label)}
                </option>
              ))}
            </select>
          </div>
          <button type="button" className="text-[11px] text-terminal-faint hover:text-terminal-muted" onClick={() => setShowSettings((v) => !v)}>
            {showSettings ? '\u25BE' : '\u25B8'} {t('data.settings')}
          </button>
          {showSettings && (
            <div className="space-y-2 rounded border border-terminal-border bg-terminal-bg/60 p-2">
              <div>
                <label className="field-label" htmlFor="av-key">
                  {t('data.avKey')}
                </label>
                <input
                  id="av-key"
                  className="input text-xs"
                  type="password"
                  value={avKey}
                  placeholder={t('data.optional')}
                  autoComplete="off"
                  onChange={(e) => setAvKey(e.target.value)}
                />
              </div>
              <div>
                <label className="field-label" htmlFor="proxy">
                  {t('data.proxy')}
                </label>
                <input
                  id="proxy"
                  className="input text-xs"
                  value={proxy}
                  placeholder="https://my-proxy.example/?url={url}"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setProxy(e.target.value)}
                />
              </div>
              <p className="text-[11px] leading-snug text-terminal-faint">
                {t('data.settingsNote')}
              </p>
            </div>
          )}
        </form>

        {/* Saved tickers */}
        <SavedTickers
          items={library.items}
          available={library.available}
          activeKey={activeKey}
          busy={loading}
          onOpen={onOpenSaved}
          onRefresh={onRefreshSaved}
          onRefreshAll={onRefreshAll}
        />

        {/* CSV upload */}
        <div>
          <span className="field-label">{t('data.csv')}</span>
          <button
            type="button"
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            onClick={() => fileRef.current?.click()}
            disabled={loading}
            className={`flex w-full flex-col items-center justify-center gap-1 rounded border border-dashed px-3 py-4 text-center transition-colors ${
              dragging ? 'border-accent bg-accent/10' : 'border-terminal-border hover:border-terminal-faint'
            }`}
          >
            <span className="text-xs text-terminal-text">{t('data.drop')}</span>
            <span className="font-mono text-[10px] text-terminal-faint">Date, Open, High, Low, Close, Volume</span>
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.txt,text/csv"
            className="hidden"
            onChange={(e) => {
              onFile(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </div>

        {/* Status */}
        {status.kind !== 'idle' && (
          <div
            role={status.kind === 'error' ? 'alert' : 'status'}
            className={`rounded border px-2 py-1.5 text-[11px] leading-snug break-words ${
              status.kind === 'error'
                ? 'border-down/40 bg-down/10 text-down'
                : status.kind === 'info'
                  ? 'border-warn/40 bg-warn/10 text-warn'
                  : status.kind === 'ok'
                    ? 'border-up/30 bg-up/5 text-terminal-muted'
                    : 'border-terminal-border text-terminal-muted'
            }`}
          >
            {status.kind === 'loading' && <span className="mr-1.5 inline-block h-2 w-2 animate-pulse rounded-full bg-accent" />}
            {status.message}
            {loading && (
              <button
                type="button"
                className="ml-2 underline"
                onClick={() => {
                  abortRef.current?.abort();
                  setStatus({ kind: 'info', message: t('data.cancelled') });
                }}
              >
                {t('data.cancel')}
              </button>
            )}
          </div>
        )}
        {warnings.length > 0 && (
          <ul className="space-y-1 text-[11px] leading-snug text-warn">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
