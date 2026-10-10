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
  type Fundamentals,
  type FundamentalsIndex,
  type PeriodField,
  type PeriodRatios,
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

/** Every statement item, in the order of the statements table. */
const FIELDS: readonly PeriodField[] = ['revenue', 'grossProfit', 'operatingIncome', 'ebitda', 'netIncome', 'eps', 'fcf', 'dividends', 'shares', 'debt', 'cash', 'equity'];
type PeriodKind = 'annual' | 'quarterly';

type Ratio = keyof PeriodRatios;
const RATIOS: ReadonlyArray<{ key: Ratio; label: MessageKey; pct: boolean }> = [
  { key: 'grossMarginPct', label: 'fund.grossMargin', pct: true },
  { key: 'ebitdaMarginPct', label: 'fund.ebitdaMargin', pct: true },
  { key: 'netMarginPct', label: 'fund.netMargin', pct: true },
  { key: 'debtToEquity', label: 'fund.debtToEquity', pct: false },
];

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

/** One chart of the fundamentals grid; `format` must be stable or the chart redraws on every render. */
interface ChartSpec {
  key: string;
  title: string;
  hint?: string;
  series: MetricSeries[];
  format: (value: number) => string;
}

function ChartGrid({ charts, kind }: { charts: readonly ChartSpec[]; kind: 'line' | 'histogram' }) {
  const { t } = useI18n();
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
      {charts.map((c) => (
        <section key={c.key} className="panel" aria-label={c.title}>
          <div className="panel-header" title={c.hint}>
            <span>{c.title}</span>
          </div>
          <MetricChart series={c.series} kind={kind} format={c.format} emptyText={t('fund.noData')} height={200} />
        </section>
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
            {FIELDS.map((field) => (
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
            {RATIOS.map((r) => (
              <tr key={r.label} className="border-b border-terminal-border/50 hover:bg-terminal-raised/40">
                <th scope="row" className="whitespace-nowrap px-3 py-1.5 text-left font-normal text-terminal-muted">
                  {t(r.label)}
                </th>
                {columns.map((c) => (
                  <td key={c.key} className={`${cell} text-terminal-text`}>
                    {(r.pct ? fmtPct1 : fmtMultiple)(periodRatios(c.values)[r.key])}
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
  const multipleCharts = useMemo<ChartSpec[]>(
    () =>
      MULTIPLES.map((m) => ({
        key: m.key,
        title: t(m.label),
        hint: t(m.title),
        format: m.pct ? fmtPct : formatMultiple,
        series: [
          {
            label: t(m.label),
            color: CHART_COLORS.sma20,
            points: valuation.flatMap((p) => {
              const v = p[m.key];
              return v === null ? [] : [{ time: p.time, value: v }];
            }),
          },
        ],
      })),
    [valuation, t],
  );
  const financialCharts = useMemo<ChartSpec[]>(() => {
    const periods: readonly FiscalPeriod[] = data ? data[periodKind] : [];
    const chart = (key: string, label: string, format: (v: number) => string, get: (p: FiscalPeriod) => number | null | undefined): ChartSpec => ({
      key,
      title: label,
      format,
      series: [
        {
          label,
          color: CHART_COLORS.up,
          points: periods.flatMap((p) => {
            const v = get(p);
            return v === undefined || v === null ? [] : [{ time: p.time, value: v }];
          }),
        },
      ],
    });
    return [
      ...FIELDS.map((f) => chart(f, t(FIELD_LABEL[f]), formatAmount(f), (p) => p[f])),
      ...RATIOS.map((r) => chart(r.key, t(r.label), r.pct ? fmtPct : formatMultiple, (p) => periodRatios(p)[r.key])),
    ];
  }, [data, periodKind, t]);

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

          <section className="panel" aria-label={t('fund.capTitle')}>
            <div className="panel-header">
              <span>{t('fund.capTitle')}</span>
            </div>
            <MetricChart series={capSeries} kind="line" format={formatVolume} emptyText={t('fund.noData')} />
          </section>

          <section className="space-y-3" aria-label={t('fund.multiplesTitle')}>
            <h2 className="panel-header panel">{t('fund.multiplesTitle')}</h2>
            <ChartGrid charts={multipleCharts} kind="line" />
          </section>

          <section className="space-y-3" aria-label={t('fund.financialsTitle')}>
            <div className="panel panel-header flex-wrap">
              <h2>{t('fund.financialsTitle')}</h2>
              <div className="seg normal-case tracking-normal" role="group" aria-label={t('fund.period')}>
                {(['annual', 'quarterly'] as const).map((k) => (
                  <button key={k} type="button" aria-pressed={k === periodKind} onClick={() => setPeriodKind(k)}>
                    {t(k === 'annual' ? 'fund.annual' : 'fund.quarterly')}
                  </button>
                ))}
              </div>
            </div>
            <ChartGrid charts={financialCharts} kind="histogram" />
          </section>

          <StatementsTable data={load.data} />
        </>
      )}
    </section>
  );
}
