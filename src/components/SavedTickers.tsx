/**
 * Library of tickers saved in the local database: open, update, export and
 * delete each saved history, or update them all at once.
 */
import { useEffect, useState } from 'react';
import { barsToCsv } from '../data/csv';
import { deleteSeries, getSeries, type SeriesMeta } from '../data/store';
import { formatAgo, isoDate } from '../format';
import { useI18n } from '../i18n';

/** Above this many entries a filter box is shown. */
const FILTER_THRESHOLD = 6;
const CONFIRM_TIMEOUT_MS = 3000;

export interface SavedTickersProps {
  items: SeriesMeta[];
  available: boolean;
  activeKey: string | null;
  busy: boolean;
  onOpen: (meta: SeriesMeta) => void;
  onRefresh: (meta: SeriesMeta) => void;
  onRefreshAll: (metas: SeriesMeta[]) => void;
}

async function exportCsv(meta: SeriesMeta): Promise<void> {
  const series = await getSeries(meta.key);
  if (!series) return;
  const url = URL.createObjectURL(new Blob([barsToCsv(series.bars)], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${series.symbol.replace(/[^\w.-]+/g, '_')}_${series.interval}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export default function SavedTickers({ items, available, activeKey, busy, onOpen, onRefresh, onRefreshAll }: SavedTickersProps) {
  const { t, locale } = useI18n();
  const [filter, setFilter] = useState('');
  const [confirmKey, setConfirmKey] = useState<string | null>(null);

  // A delete waits for a second click; the request lapses after a few seconds.
  useEffect(() => {
    if (!confirmKey) return;
    const timer = setTimeout(() => setConfirmKey(null), CONFIRM_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [confirmKey]);

  const refreshable = items.filter((m) => m.provider !== 'csv' && m.provider !== 'sample');
  const q = filter.trim().toUpperCase();
  const shown = q ? items.filter((m) => m.symbol.includes(q) || m.query.includes(q) || m.name.toUpperCase().includes(q)) : items;

  const onDelete = (meta: SeriesMeta): void => {
    if (confirmKey !== meta.key) {
      setConfirmKey(meta.key);
      return;
    }
    setConfirmKey(null);
    void deleteSeries(meta.key);
  };

  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="field-label mb-0">
          {t('lib.title')}
          {items.length > 0 && <span className="ml-1 text-terminal-faint">({items.length})</span>}
        </span>
        {refreshable.length > 0 && (
          <button type="button" className="text-[11px] text-terminal-faint hover:text-terminal-muted disabled:opacity-50" disabled={busy} onClick={() => onRefreshAll(refreshable)}>
            {'↻'} {t('lib.updateAll')}
          </button>
        )}
      </div>

      {!available ? (
        <p className="text-[11px] leading-snug text-warn">{t('lib.unavailable')}</p>
      ) : items.length === 0 ? (
        <p className="text-[11px] leading-snug text-terminal-faint">{t('lib.empty')}</p>
      ) : (
        <>
          {items.length > FILTER_THRESHOLD && (
            <input
              className="input mb-1.5 py-1 text-xs"
              value={filter}
              placeholder={t('lib.filter')}
              aria-label={t('lib.filter')}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setFilter(e.target.value)}
            />
          )}
          <ul className="max-h-72 space-y-1 overflow-y-auto pr-0.5">
            {shown.map((m) => {
              const active = m.key === activeKey;
              const isFile = m.provider === 'csv';
              return (
                <li
                  key={m.key}
                  className={`group flex items-stretch rounded border ${active ? 'border-accent/60 bg-accent/10' : 'border-terminal-border hover:border-terminal-faint'}`}
                >
                  <button
                    type="button"
                    disabled={busy}
                    className="min-w-0 flex-1 px-2 py-1 text-left disabled:cursor-not-allowed"
                    title={`${m.name}\n${m.source}\n${t('lib.updated', { when: formatAgo(m.fetchedAt, locale) })}`}
                    onClick={() => onOpen(m)}
                  >
                    <span className="flex items-baseline gap-1.5">
                      <span className={`font-mono text-xs ${active ? 'text-accent' : 'text-terminal-text'}`}>{m.symbol}</span>
                      {m.interval === '1wk' && <span className="rounded bg-terminal-raised px-1 font-mono text-[9px] text-terminal-muted">{t('lib.weekly')}</span>}
                      {isFile && <span className="rounded bg-terminal-raised px-1 font-mono text-[9px] text-terminal-muted">{t('lib.file')}</span>}
                      {m.name && m.name !== m.symbol && <span className="truncate text-[10px] text-terminal-faint">{m.name}</span>}
                    </span>
                    <span className="flex flex-wrap gap-x-1.5 font-mono text-[10px] text-terminal-faint">
                      <span className="whitespace-nowrap">{t('lib.bars', { n: m.count.toLocaleString('en-US') })}</span>
                      <span className="whitespace-nowrap">
                        {isoDate(m.firstTime)} {'→'} {isoDate(m.lastTime)}
                      </span>
                      {!isFile && <span className="whitespace-nowrap">{formatAgo(m.fetchedAt, locale)}</span>}
                    </span>
                  </button>
                  <div className="flex shrink-0 items-center gap-0.5 pr-1 text-[13px] text-terminal-faint">
                    {!isFile && (
                      <button type="button" className="rounded px-1 hover:text-terminal-text disabled:opacity-40" disabled={busy} title={t('lib.refresh')} aria-label={t('lib.refresh')} onClick={() => onRefresh(m)}>
                        {'↻'}
                      </button>
                    )}
                    <button type="button" className="rounded px-1 hover:text-terminal-text" title={t('lib.export')} aria-label={t('lib.export')} onClick={() => void exportCsv(m)}>
                      {'⤓'}
                    </button>
                    <button
                      type="button"
                      className={`rounded px-1 ${confirmKey === m.key ? 'text-[10px] font-medium text-down' : 'hover:text-down'}`}
                      title={t('lib.delete')}
                      aria-label={confirmKey === m.key ? t('lib.confirmDelete') : t('lib.delete')}
                      onClick={() => onDelete(m)}
                    >
                      {confirmKey === m.key ? t('lib.confirmDelete') : '✕'}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
