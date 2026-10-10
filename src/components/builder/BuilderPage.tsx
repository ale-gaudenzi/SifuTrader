/**
 * Strategy builder view: create, edit, share and test rule-based strategies
 * without code. The page uses the full width: a sidebar with the strategy,
 * its result and a plain-language summary, and one colored card per part of
 * the strategy (entry, adds, exits, risk). The spec being edited is the
 * active strategy of the view, so every change reruns the backtest.
 */
import { useMemo, useRef, useState, type ReactNode } from 'react';
import type { BacktestResult, Bar } from '../../engine/types';
import { formatMoney, formatPct, signClass } from '../../format';
import { useI18n } from '../../i18n';
import { countSignals } from '../../strategies/rules/compile';
import { emptyGroup, type ExitRule, type RiskLevel, type RuleStrategySpec } from '../../strategies/rules/spec';
import { TEMPLATE_IDS, templateSpec, type TemplateId } from '../../strategies/rules/templates';
import { MAX_EXIT_RULES } from '../../strategies/rules/validate';
import { describeSpec } from './describe';
import { GroupEditor, NumInput, OrderEditor, SizingEditor } from './RuleEditors';
import { downloadSpec, newSpecId, shareUrl, specsFromJson } from './share';

export interface BuilderPageProps {
  specs: readonly RuleStrategySpec[];
  /** The spec being edited, or null when there is none yet. */
  spec: RuleStrategySpec | null;
  onSelect: (id: string) => void;
  onChange: (spec: RuleStrategySpec) => void;
  /** Adds new specs and selects the first one. */
  onAdd: (specs: RuleStrategySpec[]) => void;
  onDelete: (id: string) => void;
  onUseInBacktest: (spec: RuleStrategySpec) => void;
  /** Translated validation problems of `spec`. */
  issues: readonly string[];
  /** Bars of the backtest period, for the signal counts. */
  bars: readonly Bar[];
  result: BacktestResult | null;
  /** Message from outside the page, e.g. a strategy imported from a link. */
  notice: string | null;
}

type Tone = 'entry' | 'scaleIn' | 'exit' | 'risk';

/** One color per part of a strategy; full class names so Tailwind can see them. */
const TONES: Record<Tone, { card: string; head: string; title: string; badge: string }> = {
  entry: { card: 'border-t-up', head: 'bg-up/10', title: 'text-up', badge: 'bg-up text-terminal-bg' },
  scaleIn: { card: 'border-t-accent', head: 'bg-accent/10', title: 'text-accent', badge: 'bg-accent text-white' },
  exit: { card: 'border-t-down', head: 'bg-down/10', title: 'text-down', badge: 'bg-down text-white' },
  risk: { card: 'border-t-warn', head: 'bg-warn/10', title: 'text-warn', badge: 'bg-warn text-terminal-bg' },
};

function StepCard({ step, tone, title, control, children }: { step: number; tone: Tone; title: string; control?: ReactNode; children?: ReactNode }) {
  const c = TONES[tone];
  return (
    <section className={`w-full shrink-0 overflow-hidden rounded-md border border-t-[3px] border-terminal-border bg-terminal-panel 2xl:w-[calc(50%-0.375rem)] ${c.card}`} aria-label={title}>
      <header className={`flex min-h-10 items-center gap-2 px-3 py-2 ${c.head}`}>
        <span className={`grid h-5 w-5 place-items-center rounded-full font-mono text-[11px] font-bold ${c.badge}`}>{step}</span>
        <h3 className={`text-sm font-semibold ${c.title}`}>{title}</h3>
        {control && <div className="ml-auto">{control}</div>}
      </header>
      {children && <div className="space-y-3 p-3">{children}</div>}
    </section>
  );
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${checked ? 'bg-accent' : 'bg-terminal-border'}`}
    >
      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${checked ? 'left-[18px]' : 'left-0.5'}`} />
    </button>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="w-36 shrink-0 text-xs text-terminal-muted">{label}</span>
      {children}
    </div>
  );
}

const Unit = ({ children }: { children: ReactNode }) => <span className="text-[11px] text-terminal-faint">{children}</span>;

function LevelRow({ label, value, onChange }: { label: string; value: RiskLevel; onChange: (v: RiskLevel) => void }) {
  const { t } = useI18n();
  return (
    <Row label={label}>
      <select
        className="input-sm"
        aria-label={label}
        value={value.mode}
        onChange={(e) => onChange({ ...value, mode: e.target.value === 'pct' ? 'pct' : e.target.value === 'atr' ? 'atr' : 'off' })}
      >
        <option value="off">{t('rb.level.off')}</option>
        <option value="pct">{t('rb.level.pct')}</option>
        <option value="atr">{t('rb.level.atr')}</option>
      </select>
      {value.mode !== 'off' && (
        <>
          <NumInput value={value.value} label={label} min={0.1} step={value.mode === 'pct' ? 0.5 : 0.1} onChange={(v) => onChange({ ...value, value: v })} />
          <Unit>{value.mode === 'pct' ? '%' : '× ATR'}</Unit>
        </>
      )}
    </Row>
  );
}

/** A bar count where 0 means "off", edited as a switch plus a number. */
function BarsRow({ label, value, fallback, onChange }: { label: string; value: number; fallback: number; onChange: (v: number) => void }) {
  const { t } = useI18n();
  const on = value !== 0;
  return (
    <Row label={label}>
      <Switch checked={on} label={label} onChange={(v) => onChange(v ? fallback : 0)} />
      {on && (
        <>
          <NumInput value={value} label={label} min={1} step={1} onChange={onChange} />
          <Unit>{t('unit.bars')}</Unit>
        </>
      )}
    </Row>
  );
}

const newExit = (): ExitRule => ({ when: emptyGroup(), order: { type: 'market' }, amountPct: 100 });

export default function BuilderPage(props: BuilderPageProps) {
  const { specs, spec, onSelect, onChange, onAdd, onDelete, onUseInBacktest, issues, bars, result, notice } = props;
  const i18n = useI18n();
  const { t } = i18n;
  const [message, setMessage] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const createFrom = (template: TemplateId): void => {
    onAdd([templateSpec(template, newSpecId(), t(`rb.tpl.${template}`))]);
    setMessage(null);
  };

  const signals = useMemo(() => {
    if (!spec || issues.length > 0 || bars.length === 0) return null;
    try {
      return countSignals(spec, bars);
    } catch {
      return null;
    }
  }, [spec, issues.length, bars]);

  const summary = useMemo(() => (spec ? describeSpec(spec, i18n) : []), [spec, i18n]);

  const importFile = async (file: File): Promise<void> => {
    const found = specsFromJson(await file.text()).map((s) => ({ ...s, id: newSpecId() }));
    if (found.length > 0) onAdd(found);
    setMessage(found.length > 0 ? t('rb.imported', { n: found.length }) : t('rb.importFailed'));
  };

  const copyLink = async (s: RuleStrategySpec): Promise<void> => {
    try {
      await navigator.clipboard.writeText(shareUrl(s));
      setMessage(t('rb.linkCopied'));
    } catch {
      setMessage(t('rb.linkFailed'));
    }
  };

  const status = message ?? notice;
  const fileInput = (
    <input
      ref={fileRef}
      type="file"
      accept=".json,application/json"
      className="hidden"
      onChange={(e) => {
        const file = e.target.files?.[0];
        if (file) void importFile(file);
        e.target.value = '';
      }}
    />
  );

  if (spec === null) {
    return (
      <section className="mx-auto max-w-5xl space-y-4" aria-label={t('rb.aria')}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-terminal-text">{t('rb.emptyTitle')}</h2>
          <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
            {t('rb.import')}
          </button>
        </div>
        {status && <p className="text-xs text-terminal-muted">{status}</p>}
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {TEMPLATE_IDS.map((id) => (
            <li key={id}>
              <button type="button" className="panel h-full w-full p-3 text-left transition-colors hover:border-accent" onClick={() => createFrom(id)}>
                <span className="block text-sm font-medium text-terminal-text">{t(`rb.tpl.${id}`)}</span>
                <span className="mt-1 block text-xs leading-snug text-terminal-faint">{t(`rb.tpl.${id}.desc`)}</span>
              </button>
            </li>
          ))}
        </ul>
        {fileInput}
      </section>
    );
  }

  const set = (patch: Partial<RuleStrategySpec>): void => onChange({ ...spec, ...patch });
  const setRisk = (patch: Partial<RuleStrategySpec['risk']>): void => set({ risk: { ...spec.risk, ...patch } });
  const setExit = (k: number, exit: ExitRule | null): void =>
    set({ exits: exit === null ? spec.exits.filter((_, j) => j !== k) : spec.exits.map((x, j) => (j === k ? exit : x)) });
  const usesAtr = [spec.risk.stopLoss, spec.risk.takeProfit, spec.risk.trailingStop].some((l) => l.mode === 'atr');
  const m = result?.metrics;

  return (
    <div className="grid gap-3 lg:h-full lg:grid-cols-[300px_minmax(0,1fr)]">
      <aside className="space-y-3 lg:min-h-0 lg:overflow-y-auto">
        <section className="panel" aria-label={t('rb.aria')}>
          <div className="panel-header">{t('rb.title')}</div>
          <div className="space-y-2 p-3">
            <select aria-label={t('rb.strategy')} className="input text-xs" value={spec.id} onChange={(e) => onSelect(e.target.value)}>
              {specs.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name || t('rb.untitled')}
                </option>
              ))}
            </select>
            <select
              className="input text-xs"
              aria-label={t('rb.new')}
              value=""
              onChange={(e) => {
                const id = TEMPLATE_IDS.find((x) => x === e.target.value);
                if (id) createFrom(id);
              }}
            >
              <option value="" disabled>
                {t('rb.new')}
              </option>
              {TEMPLATE_IDS.map((id) => (
                <option key={id} value={id}>
                  {t(`rb.tpl.${id}`)}
                </option>
              ))}
            </select>
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                className="btn"
                onClick={() => onAdd([{ ...structuredClone(spec), id: newSpecId(), name: `${spec.name || t('rb.untitled')}${t('rb.copySuffix')}` }])}
              >
                {t('rb.duplicate')}
              </button>
              <button type="button" className="btn" onClick={() => downloadSpec(spec)}>
                {t('rb.export')}
              </button>
              <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
                {t('rb.import')}
              </button>
              <button type="button" className="btn" onClick={() => void copyLink(spec)}>
                {t('rb.copyLink')}
              </button>
              <button
                type="button"
                className={`btn ${confirmDelete ? 'border-down/60 text-down' : ''}`}
                onBlur={() => setConfirmDelete(false)}
                onClick={() => {
                  if (!confirmDelete) return setConfirmDelete(true);
                  setConfirmDelete(false);
                  onDelete(spec.id);
                }}
              >
                {confirmDelete ? t('rb.confirmDelete') : t('rb.delete')}
              </button>
            </div>
            {fileInput}
            {status && <p className="text-[11px] text-terminal-muted">{status}</p>}
            <div className="space-y-2 border-t border-terminal-border pt-2">
              <div>
                <label htmlFor="rb-name" className="field-label">
                  {t('rb.name')}
                </label>
                <input id="rb-name" className="input text-xs" value={spec.name} maxLength={120} placeholder={t('rb.untitled')} onChange={(e) => set({ name: e.target.value })} />
              </div>
              <div>
                <label htmlFor="rb-notes" className="field-label">
                  {t('rb.description')}
                </label>
                <textarea
                  id="rb-notes"
                  className="input min-h-[2.5rem] resize-y text-xs"
                  value={spec.description}
                  maxLength={2000}
                  placeholder={t('rb.descriptionPlaceholder')}
                  onChange={(e) => set({ description: e.target.value })}
                />
              </div>
            </div>
          </div>
        </section>

        <section className="panel" aria-label={t('rb.results')}>
          <div className="panel-header">{t('rb.results')}</div>
          <div className="space-y-2 p-3">
            {issues.length > 0 ? (
              <ul role="alert" className="space-y-1 rounded border border-down/40 bg-down/10 px-2 py-1.5 text-[11px] text-down">
                {issues.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            ) : (
              m && (
                <dl className="grid grid-cols-2 gap-x-3 gap-y-2 font-mono text-xs">
                  {[
                    [t('metrics.totalReturn'), formatPct(m.totalReturnPct, 2, true), signClass(m.totalReturnPct)],
                    [t('metrics.buyHold'), formatPct(m.buyHoldReturnPct, 2, true), signClass(m.buyHoldReturnPct)],
                    [t('metrics.finalEquity'), formatMoney(m.finalEquity, 0), 'text-terminal-text'],
                    [t('metrics.maxDrawdown'), formatPct(-m.maxDrawdownPct), m.maxDrawdownPct > 0 ? 'text-down' : 'text-terminal-text'],
                    [t('metrics.totalTrades'), String(m.totalTrades), 'text-terminal-text'],
                    [t('metrics.winRate'), formatPct(m.winRatePct, 0), 'text-terminal-text'],
                  ].map(([label, value, cls]) => (
                    <div key={label}>
                      <dt className="text-[10px] uppercase tracking-wide text-terminal-faint">{label}</dt>
                      <dd className={`text-sm ${cls}`}>{value}</dd>
                    </div>
                  ))}
                </dl>
              )
            )}
            {signals && (
              <p className="font-mono text-[11px] text-terminal-faint">
                {t('rb.signals')}: {t('rb.signalsEntry', { n: signals.entry, total: bars.length })}
                {spec.scaleIn.enabled && ` · ${t('rb.signalsScale', { n: signals.scaleIn })}`}
                {signals.exits.map((n, k) => ` · ${t('rb.signalsExit', { k: k + 1, n })}`)}
              </p>
            )}
            {signals && signals.entry === 0 && <p className="text-[11px] text-warn">{t('rb.neverEntry')}</p>}
            <button type="button" className="btn btn-primary w-full" disabled={issues.length > 0} onClick={() => onUseInBacktest(spec)}>
              {t('rb.use')}
            </button>
          </div>
        </section>

        <section className="panel" aria-label={t('rb.summary')}>
          <div className="panel-header">{t('rb.summary')}</div>
          <ul className="list-disc space-y-1.5 p-3 pl-7 text-xs leading-snug text-terminal-muted">
            {summary.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
      </aside>

      {/* Flex rather than grid: grid rows here could end up shorter than the cards on some widths (e.g. when zooming), making them overlap. */}
      <div className="flex flex-col gap-3 lg:min-h-0 lg:overflow-y-auto 2xl:flex-row 2xl:flex-wrap 2xl:content-start 2xl:items-start">
        <StepCard step={1} tone="entry" title={t('rb.entry')}>
          <GroupEditor value={spec.entry.when} section="entry" emptyHint={t('rb.emptyEntry')} onChange={(when) => set({ entry: { ...spec.entry, when } })} />
          <div className="space-y-2 border-t border-terminal-border pt-3">
            <Row label={t('rb.size')}>
              <SizingEditor value={spec.entry.size} onChange={(size) => set({ entry: { ...spec.entry, size } })} />
            </Row>
            <Row label={t('rb.order')}>
              <OrderEditor value={spec.entry.order} side="buy" section="entry" onChange={(order) => set({ entry: { ...spec.entry, order } })} />
            </Row>
          </div>
        </StepCard>

        <StepCard
          step={2}
          tone="scaleIn"
          title={t('rb.scaleIn')}
          control={<Switch checked={spec.scaleIn.enabled} label={t('rb.scaleIn')} onChange={(enabled) => set({ scaleIn: { ...spec.scaleIn, enabled } })} />}
        >
          {spec.scaleIn.enabled && (
            <>
              <GroupEditor value={spec.scaleIn.when} section="scaleIn" emptyHint={t('rb.emptyScale')} onChange={(when) => set({ scaleIn: { ...spec.scaleIn, when } })} />
              <div className="space-y-2 border-t border-terminal-border pt-3">
                <Row label={t('rb.size')}>
                  <SizingEditor value={spec.scaleIn.size} onChange={(size) => set({ scaleIn: { ...spec.scaleIn, size } })} />
                </Row>
                <Row label={t('rb.order')}>
                  <OrderEditor value={spec.scaleIn.order} side="buy" section="scaleIn" onChange={(order) => set({ scaleIn: { ...spec.scaleIn, order } })} />
                </Row>
                <Row label={t('rb.multiplier')}>
                  <NumInput value={spec.scaleIn.multiplier} label={t('rb.multiplier')} min={0.1} max={10} step={0.1} onChange={(multiplier) => set({ scaleIn: { ...spec.scaleIn, multiplier } })} />
                  <Unit>×</Unit>
                </Row>
                <Row label={t('rb.maxEntries')}>
                  <NumInput value={spec.scaleIn.maxEntries} label={t('rb.maxEntries')} min={2} step={1} onChange={(maxEntries) => set({ scaleIn: { ...spec.scaleIn, maxEntries } })} />
                </Row>
              </div>
            </>
          )}
        </StepCard>

        <StepCard step={3} tone="exit" title={t('rb.exits')}>
          {spec.exits.length === 0 && <p className="text-xs italic text-terminal-faint">{t('rb.noExits')}</p>}
          {spec.exits.map((exit, k) => (
            <div key={k} className="space-y-2 rounded border border-l-[3px] border-terminal-border border-l-down/60 p-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-terminal-muted">{t('rb.exitN', { n: k + 1 })}</span>
                <button type="button" className="text-[11px] text-terminal-faint transition-colors hover:text-down" onClick={() => setExit(k, null)}>
                  {t('rb.remove')}
                </button>
              </div>
              <GroupEditor value={exit.when} section="exit" emptyHint={t('rb.emptyExit')} onChange={(when) => setExit(k, { ...exit, when })} />
              <div className="space-y-2 border-t border-terminal-border pt-2">
                <Row label={t('rb.amount')}>
                  <NumInput value={exit.amountPct} label={t('rb.amount')} min={1} max={100} step={5} onChange={(amountPct) => setExit(k, { ...exit, amountPct })} />
                  <Unit>
                    {t('rb.amountUnit')}
                    {exit.amountPct < 100 && ` ${t('rb.partialOnce')}`}
                  </Unit>
                </Row>
                <Row label={t('rb.order')}>
                  <OrderEditor value={exit.order} side="sell" section="exit" onChange={(order) => setExit(k, { ...exit, order })} />
                </Row>
              </div>
            </div>
          ))}
          {spec.exits.length < MAX_EXIT_RULES && (
            <button type="button" className="btn w-full" onClick={() => set({ exits: [...spec.exits, newExit()] })}>
              {t('rb.addExit')}
            </button>
          )}
        </StepCard>

        <StepCard step={4} tone="risk" title={t('rb.risk')}>
          <LevelRow label={t('rb.stopLoss')} value={spec.risk.stopLoss} onChange={(stopLoss) => setRisk({ stopLoss })} />
          <LevelRow label={t('rb.takeProfit')} value={spec.risk.takeProfit} onChange={(takeProfit) => setRisk({ takeProfit })} />
          <LevelRow label={t('rb.trailingStop')} value={spec.risk.trailingStop} onChange={(trailingStop) => setRisk({ trailingStop })} />
          <Row label={t('rb.breakEven')}>
            <Switch checked={spec.risk.breakEven.enabled} label={t('rb.breakEven')} onChange={(enabled) => setRisk({ breakEven: { ...spec.risk.breakEven, enabled } })} />
            {spec.risk.breakEven.enabled && (
              <>
                <Unit>{t('rb.breakEvenAfter')}</Unit>
                <NumInput value={spec.risk.breakEven.value} label={t('rb.breakEven')} min={0.1} step={0.5} onChange={(value) => setRisk({ breakEven: { ...spec.risk.breakEven, value } })} />
                <Unit>%</Unit>
              </>
            )}
          </Row>
          <BarsRow label={t('rb.maxBars')} value={spec.risk.maxBars} fallback={20} onChange={(maxBars) => setRisk({ maxBars })} />
          <BarsRow label={t('rb.cooldown')} value={spec.risk.cooldownBars} fallback={5} onChange={(cooldownBars) => setRisk({ cooldownBars })} />
          {usesAtr && (
            <Row label={t('rb.atrPeriod')}>
              <NumInput value={spec.risk.atrPeriod} label={t('rb.atrPeriod')} min={1} step={1} onChange={(atrPeriod) => setRisk({ atrPeriod })} />
              <Unit>{t('unit.bars')}</Unit>
            </Row>
          )}
        </StepCard>
      </div>
    </div>
  );
}
