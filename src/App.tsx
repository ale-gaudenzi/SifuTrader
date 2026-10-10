/**
 * Application shell: wires the data layer, chart, strategy configuration and
 * backtest results together. All computation happens in the browser.
 */
import { Suspense, lazy, useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';
import Chart, { type OverlayState } from './components/Chart';
import DataInput from './components/DataInput';
import EquityChart from './components/EquityChart';
import Metrics from './components/Metrics';
import { Logo } from './components/Logo';
import StrategyPanel, { type BacktestPeriod, type PeriodRange } from './components/StrategyPanel';
import TradeTable from './components/TradeTable';
import BuilderPage from './components/builder/BuilderPage';
import { issueText } from './components/builder/describe';
import { newSpecId, takeSharedStrategy } from './components/builder/share';
import type { Dataset } from './data/providers';
import { BacktestError, DEFAULT_CONFIG, runBacktest } from './engine/backtester';
import { resample } from './engine/indicators';
import type { BacktestConfig, BacktestResult, ParamValues, StrategyDefinition, Timeframe } from './engine/types';
import { useHashView } from './hooks/useHashView';
import { isOneOf, isString, usePersistentParsed, usePersistentState } from './hooks/usePersistentState';
import { formatDate, isoDate } from './format';
import { LANGS, useI18n } from './i18n';
import { STRATEGIES } from './strategies';
import { defaultParams } from './strategies/base';
import { ruleDefinition } from './strategies/rules/compile';
import { customStrategyId, type RuleStrategySpec } from './strategies/rules/spec';
import { parseSpec, validateSpec } from './strategies/rules/validate';

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
/** Stored custom strategies; unreadable entries are dropped rather than discarding the list. */
const parseSpecList = (v: unknown): RuleStrategySpec[] | null => (Array.isArray(v) ? v.map(parseSpec).filter((s): s is RuleStrategySpec => s !== null) : null);

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
  // Any id is accepted: custom strategies may be deleted, and an unknown id falls back below.
  const [strategyId, setStrategyId] = usePersistentState('bt.strategy', STRATEGIES[0].id, isString);
  const [paramStore, setParamStore] = usePersistentState<ParamStore>('bt.params', {}, isParamStore);
  const [config, setConfig] = usePersistentState<BacktestConfig>('bt.config', DEFAULT_CONFIG, isConfig);
  const [customs, setCustoms] = usePersistentParsed<RuleStrategySpec[]>('custom.strategies', [], parseSpecList);
  const [builderId, setBuilderId] = usePersistentState('builder.selected', '', isString);
  const [builderNotice, setBuilderNotice] = useState<string | null>(null);

  const customDefs = useMemo(() => customs.map(ruleDefinition), [customs]);
  const backtestDef = STRATEGIES.find((s) => s.id === strategyId) ?? customDefs.find((s) => s.id === strategyId) ?? STRATEGIES[0];
  const builderSpec = customs.find((s) => s.id === builderId) ?? customs[0] ?? null;
  const builderDef = useMemo(() => (builderSpec ? ruleDefinition(builderSpec) : null), [builderSpec]);
  const inBuilder = view === 'builder';
  // The builder tests the strategy being edited; the backtest view the one picked in its panel.
  const definition: StrategyDefinition | null = inBuilder ? builderDef : backtestDef;
  const activeSpec = inBuilder ? builderSpec : (customs.find((s) => customStrategyId(s) === backtestDef.id) ?? null);
  const builderIssues = useMemo(() => (builderSpec ? validateSpec(builderSpec).map((issue) => issueText(issue, i18n)) : []), [builderSpec, i18n]);

  const updateSpec = useCallback((spec: RuleStrategySpec) => setCustoms((list) => list.map((s) => (s.id === spec.id ? spec : s))), [setCustoms]);
  const addSpecs = useCallback(
    (specs: RuleStrategySpec[]) => {
      const [first] = specs;
      if (!first) return;
      setCustoms((list) => [...list, ...specs]);
      setBuilderId(first.id);
      setBuilderNotice(null);
    },
    [setCustoms, setBuilderId],
  );
  const deleteSpec = useCallback((id: string) => setCustoms((list) => list.filter((s) => s.id !== id)), [setCustoms]);

  // A strategy shared through a `#builder=...` link is added to the user's list on arrival.
  useEffect(() => {
    const take = (): void => {
      const shared = takeSharedStrategy();
      if (shared === undefined) return;
      if (shared === null) {
        setBuilderNotice(t('rb.sharedInvalid'));
        return;
      }
      const copy = { ...shared, id: newSpecId() };
      setCustoms((list) => [...list, copy]);
      setBuilderId(copy.id);
      setBuilderNotice(t('rb.sharedImported', { name: copy.name || t('rb.untitled') }));
    };
    take();
    window.addEventListener('hashchange', take);
    return () => window.removeEventListener('hashchange', take);
  }, [setCustoms, setBuilderId, t]);
  // Merge stored values over defaults so newly added parameters get sensible values.
  const params = useMemo<ParamValues>(
    () => ({ ...defaultParams(backtestDef.params), ...(paramStore[backtestDef.id] ?? {}) }),
    [backtestDef, paramStore],
  );
  const setParams = useCallback((next: ParamValues) => setParamStore((s) => ({ ...s, [backtestDef.id]: next })), [backtestDef.id, setParamStore]);
  const activeParams = inBuilder ? {} : params;

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
  const deferredParams = useDeferredValue(activeParams);
  const deferredConfig = useDeferredValue(config);
  const deferredDefinition = useDeferredValue(definition);
  const deferredSpec = useDeferredValue(activeSpec);

  const outcome = useMemo<RunOutcome>(() => {
    if (bars.length === 0 || deferredDefinition === null) return { result: null, errors: [], runtimeMs: null };
    const errors = deferredSpec ? validateSpec(deferredSpec).map((issue) => issueText(issue, i18n)) : deferredDefinition.validate(deferredParams);
    if (testBars.length < 2) errors.push(t('err.period'));
    if (!(deferredConfig.initialCapital > 0)) errors.push(t('err.capital'));
    if (!(deferredConfig.feePct >= 0 && deferredConfig.feePct <= 5)) errors.push(t('err.fee'));
    if (!(deferredConfig.slippagePct >= 0 && deferredConfig.slippagePct <= 5)) errors.push(t('err.slippage'));
    if (errors.length > 0) return { result: null, errors, runtimeMs: null };
    try {
      const t0 = performance.now();
      const result = runBacktest(testBars, deferredDefinition.create(deferredParams), deferredConfig, deferredParams);
      return { result, errors: [], runtimeMs: performance.now() - t0 };
    } catch (e) {
      const message = e instanceof BacktestError || e instanceof Error ? e.message : String(e);
      return { result: null, errors: [message], runtimeMs: null };
    }
  }, [bars, testBars, deferredDefinition, deferredSpec, deferredParams, deferredConfig, t, i18n]);

  const { result } = outcome;
  const errors = deferredDefinition ? outcome.errors.map((e) => i18n.validationMessage(deferredDefinition, e)) : [];
  const strategyLabel = definition ? i18n.strategyName(definition) || t('rb.untitled') : '';
  const first = bars[0];
  const last = bars[bars.length - 1];

  return (
    <div className="flex min-h-screen flex-col lg:h-screen">
      <header className="flex flex-wrap items-center gap-x-6 gap-y-1 border-b border-terminal-border bg-terminal-panel px-4 py-2.5">
        <Logo />
        {view !== 'fundamentals' && dataset && first && last && (
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
            {(['backtest', 'builder', 'fundamentals'] as const).map((v) => (
              <button key={v} type="button" aria-pressed={v === view} onClick={() => setView(v)}>
                {t(`view.${v}`)}
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
            customStrategies={customDefs}
            onEditCustom={(id) => {
              const spec = customs.find((s) => customStrategyId(s) === id);
              if (spec) setBuilderId(spec.id);
              setView('builder');
            }}
            strategyId={backtestDef.id}
            onStrategyChange={setStrategyId}
            params={params}
            onParamsChange={setParams}
            onResetParams={() => setParams(defaultParams(backtestDef.params))}
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
                  <EquityChart curve={result.equityCurve} strategyName={strategyLabel} />
                  <TradeTable trades={result.trades} exportName={`${dataset.symbol}_${result.strategyId}_${timeframe}_trades.csv`} />
                </>
              )}
            </>
          ) : (
            <div className="panel flex h-[480px] items-center justify-center text-sm text-terminal-faint">{t('app.loading')}</div>
          )}
        </main>
      </div>

      {inBuilder && (
        <main className="flex-1 p-3 lg:min-h-0">
          <BuilderPage
            specs={customs}
            spec={builderSpec}
            onSelect={setBuilderId}
            onChange={updateSpec}
            onAdd={addSpecs}
            onDelete={deleteSpec}
            onUseInBacktest={(spec) => {
              setStrategyId(customStrategyId(spec));
              setView('backtest');
            }}
            issues={[...new Set([...builderIssues, ...errors])]}
            bars={testBars}
            result={result}
            notice={builderNotice}
          />
        </main>
      )}

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
