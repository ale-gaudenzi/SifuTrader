/**
 * Fundamentals view: valuation history (market cap, multiples) derived from
 * daily prices and the statements in the fundamentals snapshot, plus the
 * reported figures themselves. Loaded lazily, separate from the backtester.
 */
import { useEffect, useMemo, useState } from 'react';
import type { Bar } from '../../engine/types';
import {
  currencyMismatch,
  latestFigures,
  periodRatios,
  valuationSeries,
  type FiscalPeriod,
  type FlowField,
  type Fundamentals,
  type FundamentalsIndex,
  type PeriodField,
  type ValuationPoint,
} from '../../data/fundamentals';
import { loadFundamentals, loadFundamentalsIndex, loadPriceHistory } from '../../data/providers';
import { formatDate, formatMultiple, formatNumber, formatPct, formatVolume } from '../../format';
import { isOneOf, isString, usePersistentState } from '../../hooks/usePersistentState';
import { useI18n, type MessageKey } from '../../i18n';
import { CHART_COLORS } from '../../theme';
import MetricChart, { type MetricSeries } from './MetricChart';

type Load =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: Fundamentals; bars: Bar[] | null; priceError: string | null };

type Multiple = 'pe' | 'evEbitda' | 'ps' | 'pb' | 'dividendYieldPct' | 'fcfYieldPct';
const MULTIPLES: ReadonlyArray<{ key: Multiple; label: MessageKey; title: MessageKey; pct: boolean }> = [
  { key: 'pe', label: 'fund.pe', title: 'fund.peTitle', pct: false },
  { key: 'evEbitda', label: 'fund.evEbitda', title: 'fund.evEbitdaTitle', pct: false },
  { key: 'ps', label: 'fund.ps', title: 'fund.psTitle', pct: false },
  { key: 'pb', label: 'fund.pb', title: 'fund.pbTitle', pct: false },
  { key: 'dividendYieldPct', label: 'fund.divYield', title: 'fund.divYieldTitle', pct: true },
  { key: 'fcfYieldPct', label: 'fund.fcfYield', title: 'fund.fcfYieldTitle', pct: true },
];

const FINANCIALS: readonly FlowField[] = ['revenue', 'grossProfit', 'operatingIncome', 'ebitda', 'netIncome', 'fcf', 'eps'];
type PeriodKind = 'annual' | 'quarterly';

const FIELD_LABEL: Record<PeriodField, MessageKey> = {
  revenue: 'fund.revenue',
  grossProfit: 'fund.grossProfit',
  operatingIncome: 'fund.operatingIncome',
  ebitda: 'fund.ebitda',
  netIncome: 'fund.netIncome',
  eps: 'fund.eps',
  fcf: 'fund.fcf',
  dividends: 'fund.dividends',
  shares: 'fund.shares',
  debt: 'fund.debt',
  cash: 'fund.cash',
  equity: 'fund.equity',
};

const formatAmount = (field: PeriodField) => (v: number): string => (field === 'eps' ? formatNumber(v, 2) : formatVolume(v));
const fmtPct = (v: number): string => formatPct(v, 2);
const fmtPct1 = (v: number | null): string => (v === null ? '-' : formatPct(v, 1));
const fmtMultiple = (v: number | null): string => (v === null ? '-' : formatMultiple(v));
const fmtAmount = (v: number | undefined | null, field: PeriodField = 'revenue'): string => (v === undefined || v === null ? '-' : formatAmount(field)(v));

interface Tile {
  label: string;
  value: string;
  hint?: string;
  title?: string;
}

function Tiles({ tiles }: { tiles: readonly Tile[] }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8">
      {tiles.map((c) => (
        <div key={c.label} className="panel px-3 py-2.5" title={c.title}>
          <div className="text-[10px] font-medium uppercase tracking-wider text-terminal-muted">{c.label}</div>
          <div className="mt-1 font-mono text-lg font-semibold tabular-nums text-terminal-text">{c.value}</div>
          {c.hint && <div className="mt-0.5 font-mono text-[11px] text-terminal-faint">{c.hint}</div>}
        </div>
      ))}
    </div>
  );
}

function StatementsTable({ data }: { data: Fundamentals }) {
  const { t } = useI18n();
  const years = data.annual;
  const ttm = latestFigures(data);
  const lastQuarter = [...data.ttm, ...data.quarterly].reduce((m, p) => Math.max(m, p.time), 0);
  const columns: Array<{ key: string; head: string; sub: string; values: Partial<Record<PeriodField, number>> }> = [
    ...years.map((p) => ({ key: String(p.time), head: `FY${new Date(p.time * 1000).getUTCFullYear()}`, sub: new Date(p.time * 1000).toISOString().slice(0, 10), values: p })),
    { key: 'ttm', head: 'TTM', sub: lastQuarter > 0 ? new Date(lastQuarter * 1000).toISOString().slice(0, 10) : t('fund.ttm'), values: ttm },
  ];
  const fields: readonly PeriodField[] = ['revenue', 'grossProfit', 'operatingIncome', 'ebitda', 'netIncome', 'eps', 'fcf', 'dividends', 'shares', 'debt', 'cash', 'equity'];
  const ratioRows: ReadonlyArray<{ label: MessageKey; get: (v: Partial<Record<PeriodField, number>>) => string }> = [
    { label: 'fund.grossMargin', get: (v) => fmtPct1(periodRatios(v).grossMarginPct) },
    { label: 'fund.ebitdaMargin', get: (v) => fmtPct1(periodRatios(v).ebitdaMarginPct) },
    { label: 'fund.netMargin', get: (v) => fmtPct1(periodRatios(v).netMarginPct) },
    { label: 'fund.debtToEquity', get: (v) => fmtMultiple(periodRatios(v).debtToEquity) },
  ];
  const cell = 'px-3 py-1.5 text-right tabular-nums';

  return (
    <section className="panel" aria-label={t('fund.tableTitle')}>
      <div className="panel-header">
        <span>{t('fund.tableTitle')}</span>
        {data.currency && <span className="font-mono normal-case tracking-normal text-terminal-faint">{data.currency}</span>}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full font-mono text-[11px]">
          <thead>
            <tr className="border-b border-terminal-border text-terminal-muted">
              <th className="px-3 py-1.5 text-left font-medium" />
              {columns.map((c) => (
                <th key={c.key} className={`${cell} whitespace-nowrap font-medium`}>
                  <div className="text-terminal-text">{c.head}</div>
                  <div className="text-[10px] font-normal text-terminal-faint">{c.sub}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {fields.map((field) => (
              <tr key={field} className="border-b border-terminal-border/50 hover:bg-terminal-raised/40">
                <th scope="row" className="whitespace-nowrap px-3 py-1.5 text-left font-normal text-terminal-muted">
                  {t(FIELD_LABEL[field])}
                </th>
                {columns.map((c) => (
                  <td key={c.key} className={`${cell} ${(c.values[field] ?? 0) < 0 ? 'text-down' : 'text-terminal-text'}`}>
                    {fmtAmount(c.values[field], field)}
                  </td>
                ))}
              </tr>
            ))}
            {ratioRows.map((r) => (
              <tr key={r.label} className="border-b border-terminal-border/50 hover:bg-terminal-raised/40">
                <th scope="row" className="whitespace-nowrap px-3 py-1.5 text-left font-normal text-terminal-muted">
                  {t(r.label)}
                </th>
                {columns.map((c) => (
                  <td key={c.key} className={`${cell} text-terminal-text`}>
                    {r.get(c.values)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export interface FundamentalsPageProps {
  /** Symbol open in the backtester, preselected when it has fundamentals. */
  preferredSymbol: string | null;
}

export default function FundamentalsPage({ preferredSymbol }: FundamentalsPageProps) {
  const { t, locale } = useI18n();
  const [index, setIndex] = useState<FundamentalsIndex | null | undefined>(undefined);
  const [symbol, setSymbol] = usePersistentState('fund.symbol', '', isString);
  const [multiple, setMultiple] = usePersistentState<Multiple>('fund.multiple', 'pe', isOneOf(MULTIPLES.map((m) => m.key)));
  const [metric, setMetric] = usePersistentState<FlowField>('fund.metric', 'revenue', isOneOf(FINANCIALS));
  const [periodKind, setPeriodKind] = usePersistentState<PeriodKind>('fund.period', 'annual', isOneOf(['annual', 'quarterly'] as const));
  const [load, setLoad] = useState<Load>({ kind: 'loading' });

  useEffect(() => {
    let alive = true;
    void loadFundamentalsIndex().then((idx) => {
      if (!alive) return;
      setIndex(idx);
      const symbols = idx ? Object.keys(idx.symbols) : [];
      const preferred = preferredSymbol?.toUpperCase();
      if (preferred && symbols.includes(preferred)) setSymbol(preferred);
      else if (!symbols.includes(symbol) && symbols.length > 0) setSymbol(symbols[0]);
    });
    return () => {
      alive = false;
    };
    // Resolve the initial symbol once, when the page opens.
  }, []);

  useEffect(() => {
    if (!index || !index.symbols[symbol]) return;
    const controller = new AbortController();
    setLoad({ kind: 'loading' });
    void (async () => {
      const [statements, prices] = await Promise.allSettled([loadFundamentals(symbol), loadPriceHistory(symbol, controller.signal)]);
      if (controller.signal.aborted) return;
      if (statements.status === 'rejected') {
        setLoad({ kind: 'error', message: t('fund.error', { s: symbol, msg: String(statements.reason instanceof Error ? statements.reason.message : statements.reason) }) });
        return;
      }
      setLoad({
        kind: 'ready',
        data: statements.value,
        bars: prices.status === 'fulfilled' ? prices.value.bars : null,
        priceError: prices.status === 'rejected' ? String(prices.reason instanceof Error ? prices.reason.message : prices.reason) : null,
      });
    })();
    return () => controller.abort();
  }, [index, symbol, t]);

  const data = load.kind === 'ready' ? load.data : null;
  const valuation = useMemo<ValuationPoint[]>(() => (load.kind === 'ready' && load.bars ? valuationSeries(load.bars, load.data) : []), [load]);
  const latest = useMemo(() => (data ? latestFigures(data) : {}), [data]);
  const last = valuation[valuation.length - 1];
  const spec = MULTIPLES.find((m) => m.key === multiple) ?? MULTIPLES[0];

  const capSeries = useMemo<MetricSeries[]>(
    () => [
      { label: t('fund.marketCap'), color: CHART_COLORS.equity, points: valuation.map((p) => ({ time: p.time, value: p.marketCap })) },
      {
        label: t('fund.ev'),
        color: CHART_COLORS.benchmark,
        dashed: true,
        points: valuation.flatMap((p) => (p.enterpriseValue === null ? [] : [{ time: p.time, value: p.enterpriseValue }])),
      },
    ],
    [valuation, t],
  );
  const multipleSeries = useMemo<MetricSeries[]>(
    () => [
      {
        label: t(spec.label),
        color: CHART_COLORS.sma20,
        points: valuation.flatMap((p) => {
          const v = p[spec.key];
          return v === null ? [] : [{ time: p.time, value: v }];
        }),
      },
    ],
    [valuation, spec, t],
  );
  const financialSeries = useMemo<MetricSeries[]>(() => {
    const periods: readonly FiscalPeriod[] = data ? data[periodKind] : [];
    return [
      {
        label: t(FIELD_LABEL[metric]),
        color: CHART_COLORS.up,
        points: periods.flatMap((p) => {
          const v = p[metric];
          return v === undefined ? [] : [{ time: p.time, value: v }];
        }),
      },
    ];
  }, [data, periodKind, metric, t]);
  const metricFormat = useMemo(() => formatAmount(metric), [metric]);
  const multipleFormat = useMemo(() => (spec.pct ? fmtPct : formatMultiple), [spec]);

  if (index === undefined) return <div className="panel p-6 text-center text-sm text-terminal-faint">{t('fund.loading')}</div>;
  if (index === null || Object.keys(index.symbols).length === 0) {
    return <div className="panel p-6 text-center text-sm text-terminal-faint">{t('fund.unavailable')}</div>;
  }

  const entry = index.symbols[symbol];
  const ratios = periodRatios(latest);
  const valuationTiles: Tile[] = [
    { label: t('fund.marketCap'), value: last ? formatVolume(last.marketCap) : '-', hint: last ? `${t('fund.atClose')} ${formatDate(last.time, locale)}` : undefined },
    { label: t('fund.ev'), value: fmtAmount(last?.enterpriseValue), title: t('fund.evEbitdaTitle') },
    ...MULTIPLES.map((m) => {
      const v = last ? last[m.key] : null;
      return { label: t(m.label), value: v === null ? '-' : m.pct ? formatPct(v, 2) : formatMultiple(v), title: t(m.title) };
    }),
  ];
  const figureTiles: Tile[] = [
    { label: t('fund.revenue'), value: fmtAmount(latest.revenue), hint: t('fund.ttm') },
    { label: t('fund.ebitda'), value: fmtAmount(latest.ebitda), hint: t('fund.ttm') },
    { label: t('fund.netIncome'), value: fmtAmount(latest.netIncome), hint: t('fund.ttm') },
    { label: t('fund.fcf'), value: fmtAmount(latest.fcf), hint: t('fund.ttm') },
    { label: t('fund.ebitdaMargin'), value: fmtPct1(ratios.ebitdaMarginPct), hint: t('fund.ttm') },
    { label: t('fund.netMargin'), value: fmtPct1(ratios.netMarginPct), hint: t('fund.ttm') },
    { label: t('fund.cash'), value: fmtAmount(latest.cash), hint: t('fund.latestBalance') },
    { label: t('fund.debtToEquity'), value: fmtMultiple(ratios.debtToEquity), hint: t('fund.latestBalance') },
  ];

  return (
    <section className="space-y-3" aria-label={t('fund.aria')}>
      <section className="panel flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5">
        <label className="flex items-center gap-2">
          <span className="field-label mb-0">{t('fund.company')}</span>
          <select className="input w-auto text-xs" value={symbol} onChange={(e) => setSymbol(e.target.value)}>
            {Object.entries(index.symbols).map(([s, e]) => (
              <option key={s} value={s}>
                {s} - {e.name}
              </option>
            ))}
          </select>
        </label>
        {entry && (
          <span className="font-mono text-[11px] text-terminal-faint">
            {t('fund.source', { d: entry.lastPeriod ?? '-', c: entry.currency ?? '-' })}
          </span>
        )}
        <p className="basis-full text-[11px] leading-snug text-terminal-faint">{t('fund.note')}</p>
      </section>

      {load.kind === 'loading' && <div className="panel p-6 text-center text-sm text-terminal-faint">{t('fund.loading')}</div>}
      {load.kind === 'error' && (
        <div role="alert" className="rounded border border-down/40 bg-down/10 px-3 py-2 text-xs text-down">
          {load.message}
        </div>
      )}

      {load.kind === 'ready' && (
        <>
          {load.priceError && <div className="rounded border border-terminal-border px-3 py-2 text-xs text-terminal-muted">{t('fund.priceError', { msg: load.priceError })}</div>}
          {currencyMismatch(load.data) && (
            <div className="rounded border border-terminal-border px-3 py-2 text-xs text-terminal-muted">
              {t('fund.mismatch', { p: load.data.priceCurrency ?? '-', c: load.data.currency ?? '-' })}
            </div>
          )}

          <Tiles tiles={valuationTiles} />
          <Tiles tiles={figureTiles} />

          <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            <section className="panel" aria-label={t('fund.capTitle')}>
              <div className="panel-header">
                <span>{t('fund.capTitle')}</span>
              </div>
              <MetricChart series={capSeries} kind="line" format={formatVolume} emptyText={t('fund.noData')} />
            </section>
            <section className="panel" aria-label={t('fund.multiplesTitle')}>
              <div className="panel-header flex-wrap">
                <span>{t('fund.multiplesTitle')}</span>
                <div className="seg flex-wrap normal-case tracking-normal" role="group" aria-label={t('fund.multiplesTitle')}>
                  {MULTIPLES.map((m) => (
                    <button key={m.key} type="button" title={t(m.title)} aria-pressed={m.key === multiple} onClick={() => setMultiple(m.key)}>
                      {t(m.label)}
                    </button>
                  ))}
                </div>
              </div>
              <MetricChart series={multipleSeries} kind="line" format={multipleFormat} emptyText={t('fund.noData')} />
            </section>
          </div>

          <section className="panel" aria-label={t('fund.financialsTitle')}>
            <div className="panel-header flex-wrap">
              <span>{t('fund.financialsTitle')}</span>
              <div className="flex flex-wrap items-center gap-2 normal-case tracking-normal">
                <select className="input w-auto py-1 text-xs" aria-label={t('fund.metric')} value={metric} onChange={(e) => setMetric(e.target.value as FlowField)}>
                  {FINANCIALS.map((f) => (
                    <option key={f} value={f}>
                      {t(FIELD_LABEL[f])}
                    </option>
                  ))}
                </select>
                <div className="seg" role="group" aria-label={t('fund.period')}>
                  {(['annual', 'quarterly'] as const).map((k) => (
                    <button key={k} type="button" aria-pressed={k === periodKind} onClick={() => setPeriodKind(k)}>
                      {t(k === 'annual' ? 'fund.annual' : 'fund.quarterly')}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <MetricChart series={financialSeries} kind="histogram" format={metricFormat} emptyText={t('fund.noData')} />
          </section>

          <StatementsTable data={load.data} />
        </>
      )}
    </section>
  );
}
