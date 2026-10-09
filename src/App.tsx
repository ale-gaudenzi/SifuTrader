/**
 * Application shell: wires the data layer, chart, strategy configuration and
 * backtest results together. All computation happens in the browser.
 */
import { Suspense, lazy, useCallback, useDeferredValue, useMemo, useState } from 'react';
import Chart, { type OverlayState } from './components/Chart';
import DataInput from './components/DataInput';
import EquityChart from './components/EquityChart';
import Metrics from './components/Metrics';
import { Logo } from './components/Logo';
import StrategyPanel, { type BacktestPeriod, type PeriodRange } from './components/StrategyPanel';
import TradeTable from './components/TradeTable';
import type { Dataset } from './data/providers';
import { BacktestError, DEFAULT_CONFIG, runBacktest } from './engine/backtester';
import { resample } from './engine/indicators';
import type { BacktestConfig, BacktestResult, ParamValues, Timeframe } from './engine/types';
import { useHashView } from './hooks/useHashView';
import { isOneOf, usePersistentState } from './hooks/usePersistentState';
import { formatDate, isoDate } from './format';
import { LANGS, useI18n } from './i18n';
import { STRATEGIES, getStrategy } from './strategies';
import { defaultParams } from './strategies/base';

// Split into its own chunk: the backtester never pays for the fundamentals page.
const FundamentalsPage = lazy(() => import('./components/fundamentals/FundamentalsPage'));

const DEFAULT_OVERLAYS: OverlayState = { sma20: true, sma50: true, ema: false, bollinger: false, markers: true };

type ParamStore = Record<string, ParamValues>;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isOverlayState = (v: unknown): v is OverlayState =>
  isObject(v) && (['sma20', 'sma50', 'ema', 'bollinger', 'markers'] as const).every((k) => typeof v[k] === 'boolean');
const isParamStore = (v: unknown): v is ParamStore =>
  isObject(v) && Object.values(v).every((p) => isObject(p) && Object.values(p).every((x) => typeof x === 'number' || typeof x === 'boolean'));
const isConfig = (v: unknown): v is BacktestConfig =>
  isObject(v) && (['initialCapital', 'feePct', 'slippagePct'] as const).every((k) => typeof v[k] === 'number');
const isEmaPeriod = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 2 && v <= 400;

interface RunOutcome {
  result: BacktestResult | null;
  errors: string[];
  runtimeMs: number | null;
}

export default function App() {
  const i18n = useI18n();
  const { t, locale } = i18n;
  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [view, setView] = useHashView();
  const [timeframe, setTimeframe] = usePersistentState<Timeframe>('chart.timeframe', '1D', isOneOf(['1D', '1W', '1M'] as const));
  const [overlays, setOverlays] = usePersistentState<OverlayState>('chart.overlays', DEFAULT_OVERLAYS, isOverlayState);
  const [emaPeriod, setEmaPeriod] = usePersistentState('chart.emaPeriod', 21, isEmaPeriod);
  const [strategyId, setStrategyId] = usePersistentState('bt.strategy', STRATEGIES[0].id, isOneOf(STRATEGIES.map((s) => s.id)));
  const [paramStore, setParamStore] = usePersistentState<ParamStore>('bt.params', {}, isParamStore);
  const [config, setConfig] = usePersistentState<BacktestConfig>('bt.config', DEFAULT_CONFIG, isConfig);

  const definition = getStrategy(strategyId);
  // Merge stored values over defaults so newly added parameters get sensible values.
  const params = useMemo<ParamValues>(
    () => ({ ...defaultParams(definition.params), ...(paramStore[definition.id] ?? {}) }),
    [definition, paramStore],
  );
  const setParams = useCallback((next: ParamValues) => setParamStore((s) => ({ ...s, [definition.id]: next })), [definition.id, setParamStore]);

  const bars = useMemo(() => (dataset ? resample(dataset.bars, timeframe) : []), [dataset, timeframe]);

  // The chosen dates are kept across symbol changes and clamped to whatever data is loaded.
  const [period, setPeriod] = useState<BacktestPeriod>({ start: '', end: '' });
  const range = useMemo<PeriodRange | null>(() => {
    const head = bars[0];
    const tail = bars[bars.length - 1];
    if (!head || !tail) return null;
    const min = isoDate(head.time);
    const max = isoDate(tail.time);
    const clamp = (v: string, fallback: string): string => (v === '' ? fallback : v < min ? min : v > max ? max : v);
    return { min, max, start: clamp(period.start, min), end: clamp(period.end, max) };
  }, [bars, period]);
  // Slicing (rather than warming up on earlier bars) keeps the run identical to loading only this window.
  const testBars = useMemo(() => {
    if (!range || (range.start === range.min && range.end === range.max)) return bars;
    const from = Date.parse(range.start) / 1000;
    const to = Date.parse(range.end) / 1000;
    return bars.filter((b) => b.time >= from && b.time <= to);
  }, [bars, range]);

  // Deferring inputs keeps typing in parameter fields responsive on long histories.
  const deferredParams = useDeferredValue(params);
  const deferredConfig = useDeferredValue(config);

  const outcome = useMemo<RunOutcome>(() => {
    if (bars.length === 0) return { result: null, errors: [], runtimeMs: null };
    const errors = definition.validate(deferredParams);
    if (testBars.length < 2) errors.push(t('err.period'));
    if (!(deferredConfig.initialCapital > 0)) errors.push(t('err.capital'));
    if (!(deferredConfig.feePct >= 0 && deferredConfig.feePct <= 5)) errors.push(t('err.fee'));
    if (!(deferredConfig.slippagePct >= 0 && deferredConfig.slippagePct <= 5)) errors.push(t('err.slippage'));
    if (errors.length > 0) return { result: null, errors, runtimeMs: null };
    try {
      const t0 = performance.now();
      const result = runBacktest(testBars, definition.create(deferredParams), deferredConfig, deferredParams);
      return { result, errors: [], runtimeMs: performance.now() - t0 };
    } catch (e) {
      const message = e instanceof BacktestError || e instanceof Error ? e.message : String(e);
      return { result: null, errors: [message], runtimeMs: null };
    }
  }, [bars, testBars, definition, deferredParams, deferredConfig, t]);

  const { result } = outcome;
  const errors = outcome.errors.map((e) => i18n.validationMessage(definition, e));
  const first = bars[0];
  const last = bars[bars.length - 1];

  return (
    <div className="flex min-h-screen flex-col lg:h-screen">
      <header className="flex flex-wrap items-center gap-x-6 gap-y-1 border-b border-terminal-border bg-terminal-panel px-4 py-2.5">
        <Logo />
        {view === 'backtest' && dataset && first && last && (
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-0.5 font-mono text-[11px] text-terminal-muted">
            <span className="text-terminal-text">
              {dataset.symbol}
              {dataset.name && dataset.name !== dataset.symbol && <span className="ml-1.5 text-terminal-faint">{dataset.name}</span>}
            </span>
            <span>
              {formatDate(first.time, locale)} - {formatDate(last.time, locale)}
            </span>
            <span>{t('app.bars', { n: bars.length, tf: i18n.timeframe(timeframe) })}</span>
            <span className="text-terminal-faint">{dataset.source}</span>
          </div>
        )}
        <div className="ml-auto flex items-center gap-3">
          <div className="seg" role="group" aria-label={t('view.aria')}>
            {(['backtest', 'fundamentals'] as const).map((v) => (
              <button key={v} type="button" aria-pressed={v === view} onClick={() => setView(v)}>
                {t(v === 'backtest' ? 'view.backtest' : 'view.fundamentals')}
              </button>
            ))}
          </div>
          <span className="hidden text-[11px] text-terminal-faint md:inline">{t('app.privacy')}</span>
          <div className="seg" role="group" aria-label={t('app.language')}>
            {LANGS.map((l) => (
              <button key={l.value} type="button" lang={l.value} title={l.name} aria-pressed={l.value === i18n.lang} onClick={() => i18n.setLang(l.value)}>
                {l.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* On wide screens the sidebar and the results scroll independently, like two columns.
          The backtest view stays mounted while hidden so its data and chart state survive a view switch. */}
      <div className={`${view === 'backtest' ? 'grid' : 'hidden'} flex-1 grid-cols-1 gap-3 p-3 lg:min-h-0 lg:grid-cols-[320px_minmax(0,1fr)]`}>
        <aside className="space-y-3 lg:min-h-0 lg:overflow-y-auto">
          <DataInput onDataset={setDataset} activeSymbol={dataset?.symbol ?? null} initialSample="AAPL" />
          <StrategyPanel
            strategies={STRATEGIES}
            strategyId={definition.id}
            onStrategyChange={setStrategyId}
            params={params}
            onParamsChange={setParams}
            onResetParams={() => setParams(defaultParams(definition.params))}
            config={config}
            onConfigChange={setConfig}
            errors={errors}
            runtimeMs={outcome.runtimeMs}
            barsCount={testBars.length}
            period={period}
            onPeriodChange={setPeriod}
            range={range}
          />
        </aside>

        <main className="min-w-0 space-y-3 lg:min-h-0 lg:overflow-y-auto">
          {dataset ? (
            <>
              <Chart
                symbol={dataset.symbol}
                bars={bars}
                timeframe={timeframe}
                onTimeframeChange={setTimeframe}
                overlays={overlays}
                onOverlaysChange={setOverlays}
                emaPeriod={emaPeriod}
                onEmaPeriodChange={setEmaPeriod}
                fills={result?.fills ?? []}
              />
              {result && (
                <>
                  <Metrics metrics={result.metrics} />
                  <EquityChart curve={result.equityCurve} strategyName={i18n.strategyName(definition)} />
                  <TradeTable trades={result.trades} exportName={`${dataset.symbol}_${result.strategyId}_${timeframe}_trades.csv`} />
                </>
              )}
            </>
          ) : (
            <div className="panel flex h-[480px] items-center justify-center text-sm text-terminal-faint">{t('app.loading')}</div>
          )}
        </main>
      </div>

      {view === 'fundamentals' && (
        <main className="flex-1 p-3 lg:min-h-0 lg:overflow-y-auto">
          <Suspense fallback={<div className="panel p-6 text-center text-sm text-terminal-faint">{t('fund.loading')}</div>}>
            <FundamentalsPage preferredSymbol={dataset?.symbol ?? null} />
          </Suspense>
        </main>
      )}

      <footer className="border-t border-terminal-border px-4 py-2 text-[11px] text-terminal-faint">
        {t('app.disclaimer')}
      </footer>
    </div>
  );
}
