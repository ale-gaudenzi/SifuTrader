/**
 * Strategy selection and configuration. Parameter inputs are generated from
 * each strategy's declarative `ParamSpec` list, so new strategies need no UI
 * changes.
 */
import { useEffect, useState } from 'react';
import type { BacktestConfig, ParamSpec, ParamValues, StrategyDefinition } from '../engine/types';
import { isBoolean, usePersistentState } from '../hooks/usePersistentState';
import { useI18n } from '../i18n';
import CollapsibleHeader from './CollapsibleHeader';

interface NumberFieldProps {
  id: string;
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  title?: string;
  onChange: (value: number) => void;
}

/**
 * Numeric input that keeps the raw text while editing, so intermediate states
 * such as an empty field or a trailing decimal point do not fight the user.
 * Unparseable text is committed as NaN and surfaces as a validation error.
 */
function NumberField({ id, label, value, min, max, step, unit, title, onChange }: NumberFieldProps) {
  const [draft, setDraft] = useState(Number.isFinite(value) ? String(value) : '');
  useEffect(() => {
    setDraft((current) => (Number(current) === value ? current : Number.isFinite(value) ? String(value) : current));
  }, [value]);

  return (
    <div title={title}>
      <label htmlFor={id} className="field-label">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          type="number"
          inputMode="decimal"
          className={`input pr-12 ${Number.isFinite(value) ? '' : 'border-down/60'}`}
          value={draft}
          min={min}
          max={max}
          step={step}
          onChange={(e) => {
            setDraft(e.target.value);
            onChange(e.target.value.trim() === '' ? Number.NaN : Number(e.target.value));
          }}
        />
        {unit && <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 font-mono text-[11px] text-terminal-faint">{unit}</span>}
      </div>
    </div>
  );
}

function ParamField({ strategyId, spec, value, onChange }: { strategyId: string; spec: ParamSpec; value: number | boolean | undefined; onChange: (v: number | boolean) => void }) {
  const { t, paramLabel, paramDescription } = useI18n();
  const id = `${strategyId}-${spec.key}`;
  const label = paramLabel(strategyId, spec);
  const description = paramDescription(strategyId, spec);
  if (spec.type === 'boolean') {
    return (
      <label htmlFor={id} className="col-span-2 flex cursor-pointer items-center gap-2 text-xs text-terminal-muted" title={description}>
        <input id={id} type="checkbox" className="accent-accent" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
        <span className="text-terminal-text">{label}</span>
        <span className="text-terminal-faint">- {description}</span>
      </label>
    );
  }
  const unit = spec.unit === 'bars' ? t('unit.bars') : spec.unit;
  return (
    <NumberField
      id={id}
      label={label}
      value={typeof value === 'number' ? value : Number.NaN}
      min={spec.min}
      max={spec.max}
      step={spec.step}
      unit={unit}
      title={description}
      onChange={onChange}
    />
  );
}

export interface StrategyPanelProps {
  strategies: readonly StrategyDefinition[];
  strategyId: string;
  onStrategyChange: (id: string) => void;
  params: ParamValues;
  onParamsChange: (params: ParamValues) => void;
  onResetParams: () => void;
  config: BacktestConfig;
  onConfigChange: (config: BacktestConfig) => void;
  errors: readonly string[];
  /** Milliseconds taken by the last run, for display. */
  runtimeMs: number | null;
  barsCount: number;
  /** Dates chosen by the user; an empty string leaves that side open. */
  period: BacktestPeriod;
  onPeriodChange: (period: BacktestPeriod) => void;
  /**
   * Effective period clamped to the data, or null while no data is loaded. The
   * inputs show the raw `period` instead, so clamping never fights a date being typed.
   */
  range: PeriodRange | null;
}

/** ISO `YYYY-MM-DD` bounds of the backtest window, as typed in the date inputs. */
export interface BacktestPeriod {
  start: string;
  end: string;
}

/** The window actually tested (`start`/`end`) inside the available data (`min`/`max`). */
export interface PeriodRange {
  min: string;
  max: string;
  start: string;
  end: string;
}

export default function StrategyPanel(props: StrategyPanelProps) {
  const { strategies, strategyId, onStrategyChange, params, onParamsChange, onResetParams, config, onConfigChange, errors, runtimeMs, barsCount, period, onPeriodChange, range } =
    props;
  const { t, strategyName, strategyDescription } = useI18n();
  const def = strategies.find((s) => s.id === strategyId) ?? strategies[0];
  const [open, setOpen] = usePersistentState('ui.strategyOpen', true, isBoolean);

  return (
    <section className="panel" aria-label={t('strategy.aria')}>
      <CollapsibleHeader title={t('strategy.title')} open={open} onToggle={() => setOpen((v) => !v)} controls="strategy-panel-body">
        {runtimeMs !== null && errors.length === 0 && (
          <span className="font-mono normal-case tracking-normal text-terminal-faint">
            {t('strategy.runtime', { n: barsCount, ms: runtimeMs.toFixed(1) })}
          </span>
        )}
      </CollapsibleHeader>
      <div id="strategy-panel-body" className="space-y-4 p-3" hidden={!open}>
        <div>
          <label htmlFor="strategy-select" className="field-label">
            {t('strategy.strategy')}
          </label>
          <select id="strategy-select" className="input" value={def.id} onChange={(e) => onStrategyChange(e.target.value)}>
            {strategies.map((s) => (
              <option key={s.id} value={s.id}>
                {strategyName(s)}
              </option>
            ))}
          </select>
          <p className="mt-2 text-[11px] leading-snug text-terminal-faint">{strategyDescription(def)}</p>
        </div>

        <div className="grid grid-cols-2 gap-x-2 gap-y-3">
          {def.params.map((spec) => (
            <ParamField
              key={`${def.id}-${spec.key}`}
              strategyId={def.id}
              spec={spec}
              value={params[spec.key]}
              onChange={(v) => onParamsChange({ ...params, [spec.key]: v })}
            />
          ))}
        </div>

        {range && (
          <div className="border-t border-terminal-border pt-3">
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="field-label mb-0">{t('strategy.period')}</span>
              <button
                type="button"
                className="text-[11px] text-terminal-faint transition-colors hover:text-terminal-text disabled:pointer-events-none disabled:opacity-0"
                disabled={period.start === '' && period.end === ''}
                onClick={() => onPeriodChange({ start: '', end: '' })}
              >
                {t('strategy.periodAll')}
              </button>
            </div>
            <div className="grid grid-cols-2 gap-x-2">
              <div>
                <label htmlFor="period-start" className="field-label">
                  {t('strategy.periodFrom')}
                </label>
                <input
                  id="period-start"
                  type="date"
                  className="input text-xs"
                  value={period.start || range.min}
                  min={range.min}
                  max={range.end}
                  onChange={(e) => onPeriodChange({ ...period, start: e.target.value })}
                />
              </div>
              <div>
                <label htmlFor="period-end" className="field-label">
                  {t('strategy.periodTo')}
                </label>
                <input
                  id="period-end"
                  type="date"
                  className="input text-xs"
                  value={period.end || range.max}
                  min={range.start}
                  max={range.max}
                  onChange={(e) => onPeriodChange({ ...period, end: e.target.value })}
                />
              </div>
            </div>
            <p className="mt-2 text-[11px] leading-snug text-terminal-faint">{t('strategy.periodNote')}</p>
          </div>
        )}

        <div className="border-t border-terminal-border pt-3">
          <span className="field-label">{t('strategy.execution')}</span>
          <div className="grid grid-cols-2 gap-x-2 gap-y-3">
            <div className="col-span-2">
              <NumberField
                id="capital"
                label={t('strategy.capital')}
                value={config.initialCapital}
                min={1}
                step={1000}
                unit="$"
                title={t('strategy.capitalTitle')}
                onChange={(v) => onConfigChange({ ...config, initialCapital: v })}
              />
            </div>
            <NumberField
              id="fee"
              label={t('strategy.fee')}
              value={config.feePct}
              min={0}
              max={5}
              step={0.01}
              unit="%"
              title={t('strategy.feeTitle')}
              onChange={(v) => onConfigChange({ ...config, feePct: v })}
            />
            <NumberField
              id="slippage"
              label={t('strategy.slippage')}
              value={config.slippagePct}
              min={0}
              max={5}
              step={0.01}
              unit="%"
              title={t('strategy.slippageTitle')}
              onChange={(v) => onConfigChange({ ...config, slippagePct: v })}
            />
          </div>
          <p className="mt-2 text-[11px] leading-snug text-terminal-faint">
            {t('strategy.note')}
          </p>
        </div>

        {errors.length > 0 && (
          <ul role="alert" className="space-y-1 rounded border border-down/40 bg-down/10 px-2 py-1.5 text-[11px] text-down">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}

        <button type="button" className="btn w-full" onClick={onResetParams}>
          {t('strategy.reset')}
        </button>
      </div>
    </section>
  );
}
