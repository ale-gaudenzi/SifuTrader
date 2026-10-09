/**
 * KPI summary cards for a backtest result.
 */
import type { Metrics as MetricsData } from '../engine/types';
import { formatMoney, formatNumber, formatPct, signClass } from '../format';
import { useI18n } from '../i18n';

interface Card {
  label: string;
  value: string;
  tone?: string;
  hint?: string;
  title?: string;
}

export interface MetricsProps {
  metrics: MetricsData;
}

export default function Metrics({ metrics: m }: MetricsProps) {
  const { t } = useI18n();
  const excess = m.totalReturnPct - m.buyHoldReturnPct;

  const primary: Card[] = [
    {
      label: t('metrics.finalEquity'),
      value: formatMoney(m.finalEquity),
      tone: signClass(m.finalEquity - m.initialCapital),
      hint: t('metrics.from', { x: formatMoney(m.initialCapital, 0) }),
    },
    {
      label: t('metrics.totalReturn'),
      value: formatPct(m.totalReturnPct, 2, true),
      tone: signClass(m.totalReturnPct),
      hint: t('metrics.vsBH', { x: formatPct(excess, 2, true) }),
    },
    {
      label: t('metrics.buyHold'),
      value: formatPct(m.buyHoldReturnPct, 2, true),
      tone: signClass(m.buyHoldReturnPct),
      hint: t('metrics.maxDD', { x: formatPct(m.buyHoldMaxDrawdownPct, 1) }),
    },
    {
      label: t('metrics.maxDrawdown'),
      value: formatPct(-m.maxDrawdownPct, 2),
      tone: m.maxDrawdownPct > 0 ? 'text-down' : 'text-terminal-text',
      hint: t('metrics.peakToTrough'),
    },
    {
      label: t('metrics.winRate'),
      value: m.totalTrades > 0 ? formatPct(m.winRatePct, 1) : '-',
      hint: t('metrics.closedTrades'),
    },
    {
      label: t('metrics.totalTrades'),
      value: String(m.totalTrades),
      hint: `${t('metrics.fills', { n: m.totalFills })}${m.hasOpenPosition ? t('metrics.plusOpen') : ''}`,
    },
  ];

  const secondary: Card[] = [
    { label: t('metrics.cagr'), value: formatPct(m.cagrPct, 2, true), tone: signClass(m.cagrPct) },
    { label: t('metrics.sharpe'), value: formatNumber(m.sharpe, 2), title: t('metrics.sharpeTitle', { n: m.periodsPerYear.toFixed(0) }) },
    { label: t('metrics.profitFactor'), value: formatNumber(m.profitFactor, 2), title: t('metrics.profitFactorTitle') },
    { label: t('metrics.exposure'), value: formatPct(m.exposurePct, 1), title: t('metrics.exposureTitle') },
    { label: t('metrics.fees'), value: formatMoney(m.totalFees) },
  ];

  return (
    <section aria-label={t('metrics.aria')} className="space-y-2">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
        {primary.map((c) => (
          <div key={c.label} className="panel px-3 py-2.5">
            <div className="text-[10px] font-medium uppercase tracking-wider text-terminal-muted">{c.label}</div>
            <div className={`mt-1 font-mono text-lg font-semibold tabular-nums ${c.tone ?? 'text-terminal-text'}`}>{c.value}</div>
            {c.hint && <div className="mt-0.5 font-mono text-[11px] text-terminal-faint">{c.hint}</div>}
          </div>
        ))}
      </div>
      <div className="panel flex flex-wrap gap-x-6 gap-y-1 px-3 py-2 font-mono text-[11px]">
        {secondary.map((c) => (
          <div key={c.label} title={c.title}>
            <span className="text-terminal-faint">{c.label} </span>
            <span className={`tabular-nums ${c.tone ?? 'text-terminal-text'}`}>{c.value}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
