/**
 * Round-trip trade log with sorting, pagination and CSV export.
 */
import Papa from 'papaparse';
import { useMemo, useState } from 'react';
import type { Trade } from '../engine/types';
import { formatPct, formatPrice, formatSignedMoney, isoDate, signClass } from '../format';
import { useI18n, type MessageKey } from '../i18n';

type SortKey = 'id' | 'entryTime' | 'exitTime' | 'avgEntryPrice' | 'exitPrice' | 'pnl' | 'roiPct' | 'entries' | 'barsHeld';

interface Column {
  key: SortKey;
  /** Message key of the header, or null for the untranslated `#` column. */
  label: MessageKey | null;
  align: 'left' | 'right';
  title?: MessageKey;
}

const COLUMNS: readonly Column[] = [
  { key: 'id', label: null, align: 'left' },
  { key: 'entryTime', label: 'trades.col.entryTime', align: 'left' },
  { key: 'exitTime', label: 'trades.col.exitTime', align: 'left' },
  { key: 'avgEntryPrice', label: 'trades.col.avgEntryPrice', align: 'right', title: 'trades.col.avgEntryPrice.title' },
  { key: 'exitPrice', label: 'trades.col.exitPrice', align: 'right', title: 'trades.col.exitPrice.title' },
  { key: 'entries', label: 'trades.col.entries', align: 'right', title: 'trades.col.entries.title' },
  { key: 'barsHeld', label: 'trades.col.barsHeld', align: 'right', title: 'trades.col.barsHeld.title' },
  { key: 'pnl', label: 'trades.col.pnl', align: 'right', title: 'trades.col.pnl.title' },
  { key: 'roiPct', label: 'trades.col.roiPct', align: 'right', title: 'trades.col.roiPct.title' },
];

const PAGE_SIZE = 25;

function sortValue(t: Trade, key: SortKey): number {
  if (key === 'exitTime') return t.exitTime ?? Number.POSITIVE_INFINITY;
  return t[key];
}

function downloadCsv(trades: readonly Trade[], filename: string): void {
  const csv = Papa.unparse(
    trades.map((t) => ({
      id: t.id,
      entry_date: isoDate(t.entryTime),
      exit_date: t.exitTime === null ? '' : isoDate(t.exitTime),
      status: t.isOpen ? 'open' : 'closed',
      avg_buy_price: t.avgEntryPrice,
      sell_price: t.exitPrice,
      quantity: t.quantity,
      buy_fills: t.entries,
      bars_held: t.barsHeld,
      cost_basis: t.costBasis,
      proceeds: t.proceeds,
      pnl: t.pnl,
      roi_pct: t.roiPct,
    })),
  );
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // Revoke on the next tick so the browser has started the download.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export interface TradeTableProps {
  trades: readonly Trade[];
  exportName: string;
}

export default function TradeTable({ trades, exportName }: TradeTableProps) {
  const { t } = useI18n();
  const [sortKey, setSortKey] = useState<SortKey>('id');
  const [descending, setDescending] = useState(true);
  const [page, setPage] = useState(0);

  const sorted = useMemo(() => {
    const out = [...trades];
    out.sort((a, b) => {
      const d = sortValue(a, sortKey) - sortValue(b, sortKey);
      return descending ? -d : d;
    });
    return out;
  }, [trades, sortKey, descending]);

  const pages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  const rows = sorted.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);

  const onSort = (key: SortKey): void => {
    if (key === sortKey) setDescending((d) => !d);
    else {
      setSortKey(key);
      setDescending(true);
    }
    setPage(0);
  };

  return (
    <section className="panel flex flex-col" aria-label={t('trades.aria')}>
      <div className="panel-header">
        <span>
          {t('trades.title')} <span className="text-terminal-faint">({trades.length})</span>
        </span>
        <button type="button" className="btn normal-case tracking-normal" disabled={trades.length === 0} onClick={() => downloadCsv(sorted, exportName)}>
          {t('trades.export')}
        </button>
      </div>

      {trades.length === 0 ? (
        <p className="px-3 py-6 text-center text-sm text-terminal-faint">{t('trades.empty')}</p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse font-mono text-xs tabular-nums">
              <thead>
                <tr className="border-b border-terminal-border text-[10px] uppercase tracking-wider text-terminal-muted">
                  {COLUMNS.map((c) => (
                    <th
                      key={c.key}
                      scope="col"
                      title={c.title && t(c.title)}
                      aria-sort={sortKey === c.key ? (descending ? 'descending' : 'ascending') : 'none'}
                      className={`px-3 py-2 font-medium ${c.align === 'right' ? 'text-right' : 'text-left'}`}
                    >
                      <button type="button" className="uppercase tracking-wider hover:text-terminal-text" onClick={() => onSort(c.key)}>
                        {c.label ? t(c.label) : '#'}
                        {sortKey === c.key ? (descending ? ' \u25BE' : ' \u25B4') : ''}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((trade) => (
                  <tr key={trade.id} className="border-b border-terminal-border/60 hover:bg-terminal-raised">
                    <td className="px-3 py-1.5 text-terminal-faint">{trade.id}</td>
                    <td className="px-3 py-1.5">{isoDate(trade.entryTime)}</td>
                    <td className="px-3 py-1.5">
                      {trade.exitTime === null ? (
                        <span className="rounded border border-warn/40 px-1.5 py-px text-[10px] uppercase text-warn">{t('trades.open')}</span>
                      ) : (
                        isoDate(trade.exitTime)
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-right">{formatPrice(trade.avgEntryPrice)}</td>
                    <td className="px-3 py-1.5 text-right">{formatPrice(trade.exitPrice)}</td>
                    <td className="px-3 py-1.5 text-right text-terminal-muted">{trade.entries}</td>
                    <td className="px-3 py-1.5 text-right text-terminal-muted">{trade.barsHeld}</td>
                    <td className={`px-3 py-1.5 text-right ${signClass(trade.pnl)}`}>{formatSignedMoney(trade.pnl)}</td>
                    <td className={`px-3 py-1.5 text-right ${signClass(trade.roiPct)}`}>{formatPct(trade.roiPct, 2, true)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pages > 1 && (
            <div className="flex items-center justify-end gap-2 px-3 py-2 font-mono text-[11px] text-terminal-muted">
              <button type="button" className="btn px-2 py-0.5" disabled={current === 0} onClick={() => setPage(current - 1)}>
                {t('trades.prev')}
              </button>
              <span>
                {current + 1} / {pages}
              </span>
              <button type="button" className="btn px-2 py-0.5" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>
                {t('trades.next')}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
