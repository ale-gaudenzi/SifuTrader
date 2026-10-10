/**
 * Editors for the pieces of a rule: operands, conditions, groups, orders and
 * sizing. Each one is controlled (`value` + `onChange`) and returns a new
 * object on every edit, so the spec stays immutable and every change reruns
 * the backtest.
 */
import { Fragment, useEffect, useState } from 'react';
import { useI18n } from '../../i18n';
import { CALENDAR_VALUE, INDICATOR_CATEGORIES, INDICATOR_INFO, defaultIndicatorParams } from '../../strategies/rules/catalog';
import {
  CALENDAR_EVENTS,
  COMPARE_OPS,
  INDICATORS,
  PATTERNS,
  POSITION_FIELDS,
  PRICE_FIELDS,
  type Condition,
  type Group,
  type Hold,
  type IndicatorName,
  type Operand,
  type OrderSpec,
  type Sizing,
} from '../../strategies/rules/spec';
import { monthName, weekdayName } from './describe';

/** Where a rule lives; position values exist only once a position is open. */
export type RuleSection = 'entry' | 'scaleIn' | 'exit';

interface NumInputProps {
  value: number;
  onChange: (v: number) => void;
  label: string;
  min?: number;
  max?: number;
  step?: number;
  width?: string;
}

/**
 * Compact numeric input. Keeps the raw text while typing; an empty or
 * unparseable field is committed as NaN and reported by the validator.
 */
export function NumInput({ value, onChange, label, min, max, step, width = 'w-16' }: NumInputProps) {
  const [draft, setDraft] = useState(Number.isFinite(value) ? String(value) : '');
  useEffect(() => {
    setDraft((current) => (Number(current) === value ? current : Number.isFinite(value) ? String(value) : current));
  }, [value]);
  return (
    <input
      type="number"
      inputMode="decimal"
      aria-label={label}
      title={label}
      className={`input-sm ${width} ${Number.isFinite(value) ? '' : 'border-down/60'}`}
      value={draft}
      min={min}
      max={max}
      step={step}
      onChange={(e) => {
        setDraft(e.target.value);
        onChange(e.target.value.trim() === '' ? Number.NaN : Number(e.target.value));
      }}
    />
  );
}

/** Typical threshold offered when an oscillator is compared with a value. */
const DEFAULT_THRESHOLD: Partial<Record<IndicatorName, number>> = {
  rsi: 50,
  stochK: 50,
  stochD: 50,
  williamsR: -50,
  mfi: 50,
  adx: 25,
  aroonUp: 70,
  aroonDown: 70,
  bbPercentB: 0.5,
  atrPct: 2,
  bbWidth: 10,
};

const isClose = (op: Operand): boolean => op.kind === 'price' && op.field === 'close' && !op.shift && !op.pct;

function operandKey(op: Operand): string {
  switch (op.kind) {
    case 'price':
      return `price:${op.field}`;
    case 'indicator':
      return `ind:${op.name}`;
    case 'position':
      return `pos:${op.field}`;
    case 'number':
      return 'num';
  }
}

function operandFromKey(key: string): Operand {
  const [kind, name] = key.split(':');
  const price = PRICE_FIELDS.find((f) => f === name);
  if (kind === 'price' && price) return { kind: 'price', field: price };
  const indicator = INDICATORS.find((n) => n === name);
  if (kind === 'ind' && indicator) return { kind: 'indicator', name: indicator, params: defaultIndicatorParams(indicator) };
  const position = POSITION_FIELDS.find((f) => f === name);
  if (kind === 'pos' && position) return { kind: 'position', field: position };
  return { kind: 'number', value: 0 };
}

/** True when the operand is in price units (so it compares with a price rather than a number). */
export function isPriceLike(op: Operand): boolean {
  if (op.kind === 'price') return op.field !== 'volume';
  if (op.kind === 'indicator') return INDICATOR_INFO[op.name].priceScale;
  return op.kind === 'position' && op.field !== 'pnlPct' && op.field !== 'barsHeld' && op.field !== 'entries';
}

/** Sets the look-back and percentage of an operand; zero or a cleared field removes them. */
function withModifiers<T extends { shift?: number; pct?: number }>(op: T, shift: number | undefined, pct: number | undefined): T {
  const next = { ...op };
  delete next.shift;
  delete next.pct;
  if (shift) next.shift = shift;
  if (pct) next.pct = pct;
  return next;
}

interface OperandEditorProps {
  value: Operand;
  onChange: (v: Operand) => void;
  section: RuleSection;
  /** Source of an indicator: a price or another indicator, never a number or a position value. */
  asInput?: boolean;
  depth?: number;
}

export function OperandEditor({ value, onChange, section, asInput = false, depth = 0 }: OperandEditorProps) {
  const { t } = useI18n();
  const hasModifiers = value.kind !== 'number' && (Boolean(value.pct) || (value.kind !== 'position' && Boolean(value.shift)));
  const [showModifiers, setShowModifiers] = useState(hasModifiers);
  const allowPosition = !asInput && section !== 'entry';

  const setModifier = (key: 'shift' | 'pct', v: number): void => {
    if (value.kind === 'number') return;
    const shift = key === 'shift' ? v : value.kind === 'position' ? undefined : value.shift;
    onChange(withModifiers(value, shift, key === 'pct' ? v : value.pct));
  };

  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <select className="input-sm max-w-[17rem]" aria-label={t('rb.operand')} value={operandKey(value)} onChange={(e) => onChange(operandFromKey(e.target.value))}>
        <optgroup label={t('rb.cat.price')}>
          {PRICE_FIELDS.map((f) => (
            <option key={f} value={`price:${f}`}>
              {t(`rb.price.${f}`)}
            </option>
          ))}
        </optgroup>
        {INDICATOR_CATEGORIES.map((cat) => (
          <optgroup key={cat} label={t(`rb.cat.${cat}`)}>
            {INDICATORS.filter((n) => INDICATOR_INFO[n].category === cat).map((n) => (
              <option key={n} value={`ind:${n}`}>
                {t(`rb.ind.${n}`)}
              </option>
            ))}
          </optgroup>
        ))}
        {allowPosition && (
          <optgroup label={t('rb.cat.position')}>
            {POSITION_FIELDS.map((f) => (
              <option key={f} value={`pos:${f}`}>
                {t(`rb.pos.${f}`)}
              </option>
            ))}
          </optgroup>
        )}
        {!asInput && (
          <optgroup label={t('rb.cat.value')}>
            <option value="num">{t('rb.number')}</option>
          </optgroup>
        )}
      </select>

      {value.kind === 'number' && <NumInput value={value.value} label={t('rb.number')} width="w-20" step={1} onChange={(v) => onChange({ kind: 'number', value: v })} />}

      {value.kind === 'indicator' && (
        <>
          {INDICATOR_INFO[value.name].params.map((p, k) => (
            <span key={p.key} className="inline-flex items-center gap-1 text-[10px] text-terminal-faint">
              {t(`rb.param.${p.key}`)}
              <NumInput
                value={value.params[k]}
                label={t(`rb.param.${p.key}`)}
                min={p.min}
                max={p.max}
                step={p.step}
                width={p.integer ? 'w-14' : 'w-16'}
                onChange={(v) => onChange({ ...value, params: value.params.map((x, j) => (j === k ? v : x)) })}
              />
            </span>
          ))}
          {INDICATOR_INFO[value.name].input && depth < 2 && (
            <>
              <span className="text-[11px] text-terminal-faint">{t('rb.of')}</span>
              <OperandEditor
                value={value.input ?? { kind: 'price', field: 'close' }}
                section={section}
                asInput
                depth={depth + 1}
                onChange={(input) => {
                  const next = { ...value };
                  if (isClose(input)) delete next.input;
                  else next.input = input;
                  onChange(next);
                }}
              />
            </>
          )}
        </>
      )}

      {value.kind !== 'number' && (
        <>
          <button
            type="button"
            className={`chip ${showModifiers ? 'chip-on' : 'chip-off'} px-1.5 py-0.5`}
            title={t('rb.modifiers')}
            aria-label={t('rb.modifiers')}
            aria-pressed={showModifiers}
            onClick={() => setShowModifiers((v) => !v)}
          >
            ⋯
          </button>
          {showModifiers && (
            <span className="inline-flex items-center gap-1 text-[11px] text-terminal-faint">
              {value.kind !== 'position' && (
                <>
                  <NumInput value={value.shift ?? 0} label={t('rb.shift')} min={0} step={1} width="w-12" onChange={(v) => setModifier('shift', v)} />
                  <span>{t('rb.shift')}</span>
                </>
              )}
              <NumInput value={value.pct ?? 0} label={t('rb.pct')} step={0.5} width="w-14" onChange={(v) => setModifier('pct', v)} />
              <span>%</span>
            </span>
          )}
        </>
      )}
    </span>
  );
}

function HoldEditor({ value, onChange }: { value: Hold | undefined; onChange: (v: Hold | undefined) => void }) {
  const { t } = useI18n();
  return (
    <span className="inline-flex items-center gap-1">
      <select
        className="input-sm"
        aria-label={t('rb.hold')}
        value={value?.mode ?? 'now'}
        onChange={(e) => {
          const mode = e.target.value;
          onChange(mode === 'for' || mode === 'within' ? { mode, bars: value?.bars ?? 3 } : undefined);
        }}
      >
        <option value="now">{t('rb.hold.now')}</option>
        <option value="for">{t('rb.hold.for')}</option>
        <option value="within">{t('rb.hold.within')}</option>
      </select>
      {value && (
        <>
          <NumInput value={value.bars} label={t('unit.bars')} min={1} step={1} width="w-14" onChange={(bars) => onChange({ ...value, bars })} />
          <span className="text-[11px] text-terminal-faint">{t('unit.bars')}</span>
        </>
      )}
    </span>
  );
}

function RemoveButton({ onClick }: { onClick: () => void }) {
  const { t } = useI18n();
  return (
    <button type="button" className="ml-auto px-1 text-terminal-faint transition-colors hover:text-down" title={t('rb.remove')} aria-label={t('rb.remove')} onClick={onClick}>
      ×
    </button>
  );
}

interface ConditionEditorProps {
  value: Condition;
  onChange: (v: Condition) => void;
  onRemove: () => void;
  section: RuleSection;
}

export function ConditionEditor({ value, onChange, onRemove, section }: ConditionEditorProps) {
  const { t, locale } = useI18n();
  const hold = (h: Hold | undefined): void => {
    if (value.kind === 'calendar') return;
    const next = { ...value };
    if (h) next.hold = h;
    else delete next.hold;
    onChange(next);
  };

  let body;
  switch (value.kind) {
    case 'compare':
      body = (
        <>
          <OperandEditor
            value={value.left}
            section={section}
            onChange={(left) => {
              // Comparing an oscillator with a price is meaningless: offer a typical level instead.
              const threshold = left.kind === 'indicator' ? DEFAULT_THRESHOLD[left.name] ?? 0 : 0;
              const right = !isPriceLike(left) && isPriceLike(value.right) ? { kind: 'number' as const, value: threshold } : value.right;
              onChange({ ...value, left, right });
            }}
          />
          <select className="input-sm" aria-label={t('rb.comparison')} value={value.op} onChange={(e) => onChange({ ...value, op: COMPARE_OPS.find((o) => o === e.target.value) ?? 'gt' })}>
            {COMPARE_OPS.map((op) => (
              <option key={op} value={op}>
                {t(`rb.op.${op}`)}
              </option>
            ))}
          </select>
          <OperandEditor value={value.right} section={section} onChange={(right) => onChange({ ...value, right })} />
          <HoldEditor value={value.hold} onChange={hold} />
        </>
      );
      break;
    case 'trend':
      body = (
        <>
          <OperandEditor value={value.left} section={section} onChange={(left) => onChange({ ...value, left })} />
          <select
            className="input-sm"
            aria-label={t('rb.add.trend')}
            value={value.direction}
            onChange={(e) => onChange({ ...value, direction: e.target.value === 'falling' ? 'falling' : 'rising' })}
          >
            <option value="rising">{t('rb.trend.rising')}</option>
            <option value="falling">{t('rb.trend.falling')}</option>
          </select>
          <NumInput value={value.bars} label={t('unit.bars')} min={1} step={1} width="w-14" onChange={(bars) => onChange({ ...value, bars })} />
          <span className="text-[11px] text-terminal-faint">{t('unit.bars')}</span>
          <HoldEditor value={value.hold} onChange={hold} />
        </>
      );
      break;
    case 'pattern':
      body = (
        <>
          <select className="input-sm max-w-[16rem]" aria-label={t('rb.add.pattern')} value={value.pattern} onChange={(e) => onChange({ ...value, pattern: PATTERNS.find((p) => p === e.target.value) ?? 'bullishBar' })}>
            {PATTERNS.map((p) => (
              <option key={p} value={p}>
                {t(`rb.pattern.${p}`)}
              </option>
            ))}
          </select>
          <HoldEditor value={value.hold} onChange={hold} />
        </>
      );
      break;
    case 'calendar': {
      const bounds = CALENDAR_VALUE[value.event];
      body = (
        <>
          <select
            className="input-sm"
            aria-label={t('rb.add.calendar')}
            value={value.event}
            onChange={(e) => {
              const event = CALENDAR_EVENTS.find((x) => x === e.target.value) ?? 'newMonth';
              onChange({ kind: 'calendar', event, value: event === 'everyN' ? 21 : 1 });
            }}
          >
            {CALENDAR_EVENTS.map((ev) => (
              <option key={ev} value={ev}>
                {t(`rb.cal.${ev}`)}
              </option>
            ))}
          </select>
          {value.event === 'weekday' || value.event === 'month' ? (
            <select className="input-sm" aria-label={t(`rb.cal.${value.event}`)} value={value.value} onChange={(e) => onChange({ ...value, value: Number(e.target.value) })}>
              {Array.from({ length: value.event === 'weekday' ? 7 : 12 }, (_, k) => k + 1).map((n) => (
                <option key={n} value={n}>
                  {value.event === 'weekday' ? weekdayName(n, locale) : monthName(n, locale)}
                </option>
              ))}
            </select>
          ) : (
            bounds && <NumInput value={value.value} label={t(`rb.cal.${value.event}`)} min={bounds.min} max={bounds.max} step={1} onChange={(v) => onChange({ ...value, value: v })} />
          )}
        </>
      );
      break;
    }
  }

  return (
    <div className="rule-card flex flex-wrap items-center gap-1">
      {body}
      <RemoveButton onClick={onRemove} />
    </div>
  );
}

type NewItem = 'compare' | 'trend' | 'pattern' | 'calendar' | 'group';

const newComparison = (): Condition => ({ kind: 'compare', left: { kind: 'price', field: 'close' }, op: 'gt', right: { kind: 'indicator', name: 'sma', params: [50] } });

function newItem(kind: NewItem): Condition | Group {
  const close: Operand = { kind: 'price', field: 'close' };
  switch (kind) {
    case 'compare':
      return newComparison();
    case 'trend':
      return { kind: 'trend', left: close, direction: 'rising', bars: 3 };
    case 'pattern':
      return { kind: 'pattern', pattern: 'bullishEngulfing' };
    case 'calendar':
      return { kind: 'calendar', event: 'newMonth', value: 1 };
    case 'group':
      return { kind: 'group', mode: 'any', items: [newComparison()] };
  }
}

interface GroupEditorProps {
  value: Group;
  onChange: (v: Group) => void;
  section: RuleSection;
  /** Shown when the group has no conditions, explaining what that means here. */
  emptyHint: string;
  depth?: number;
}

export function GroupEditor({ value, onChange, section, emptyHint, depth = 0 }: GroupEditorProps) {
  const { t } = useI18n();
  const setItem = (k: number, item: Condition | Group | null): void => {
    const items = item === null ? value.items.filter((_, j) => j !== k) : value.items.map((x, j) => (j === k ? item : x));
    onChange({ ...value, items });
  };

  return (
    <div className="space-y-1.5">
      {value.items.length === 0 && <p className="text-[11px] italic text-terminal-faint">{emptyHint}</p>}
      {value.items.map((item, k) => (
        <Fragment key={k}>
          {k > 0 && (
            <button
              type="button"
              className="ml-2 rounded border border-accent/40 bg-accent/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-accent transition-colors hover:border-accent"
              title={t('rb.mode')}
              onClick={() => onChange({ ...value, mode: value.mode === 'all' ? 'any' : 'all' })}
            >
              {value.mode === 'all' ? t('rb.and') : t('rb.or')}
            </button>
          )}
          {item.kind === 'group' ? (
            <div className="rule-card space-y-1.5 border-dashed">
              <div className="flex items-center">
                <span className="text-[11px] text-terminal-muted">{t('rb.add.group')}</span>
                <RemoveButton onClick={() => setItem(k, null)} />
              </div>
              <GroupEditor value={item} onChange={(g) => setItem(k, g)} section={section} emptyHint={t('rb.emptyGroup')} depth={depth + 1} />
            </div>
          ) : (
            <ConditionEditor value={item} section={section} onChange={(c) => setItem(k, c)} onRemove={() => setItem(k, null)} />
          )}
        </Fragment>
      ))}
      <div className="flex flex-wrap items-center gap-1.5">
        <select
          className="input-sm"
          aria-label={t('rb.add')}
          value=""
          onChange={(e) => {
            const kind = (['compare', 'trend', 'pattern', 'calendar', 'group'] as const).find((x) => x === e.target.value);
            if (kind) onChange({ ...value, items: [...value.items, newItem(kind)] });
          }}
        >
          <option value="" disabled>
            {t('rb.add')}
          </option>
          <option value="compare">{t('rb.add.compare')}</option>
          <option value="trend">{t('rb.add.trend')}</option>
          <option value="pattern">{t('rb.add.pattern')}</option>
          <option value="calendar">{t('rb.add.calendar')}</option>
          {depth === 0 && <option value="group">{t('rb.add.group')}</option>}
        </select>
      </div>
    </div>
  );
}

interface OrderEditorProps {
  value: OrderSpec;
  onChange: (v: OrderSpec) => void;
  side: 'buy' | 'sell';
  section: RuleSection;
}

/** A sensible resting price for a new limit or stop order on each side. */
function defaultOrderPrice(type: 'limit' | 'stop', side: 'buy' | 'sell'): Operand {
  if (type === 'stop') return { kind: 'price', field: side === 'buy' ? 'high' : 'low' };
  return { kind: 'price', field: 'close', pct: side === 'buy' ? -1 : 2 };
}

export function OrderEditor({ value, onChange, side, section }: OrderEditorProps) {
  const { t } = useI18n();
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1">
        <select
          className="input-sm"
          aria-label={t('rb.order')}
          value={value.type}
          onChange={(e) => {
            const type = e.target.value;
            if (type === 'limit' || type === 'stop') onChange({ type, price: value.type === 'market' ? defaultOrderPrice(type, side) : value.price });
            else onChange({ type: 'market' });
          }}
        >
          <option value="market">{t('rb.order.market')}</option>
          <option value="limit">{t(`rb.order.${side}Limit`)}</option>
          <option value="stop">{t(`rb.order.${side}Stop`)}</option>
        </select>
        {value.type !== 'market' && <OperandEditor value={value.price} section={section} onChange={(price) => onChange({ ...value, price })} />}
      </div>
    </div>
  );
}

export function SizingEditor({ value, onChange }: { value: Sizing; onChange: (v: Sizing) => void }) {
  const { t } = useI18n();
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <NumInput value={value.value} label={t('rb.size')} min={0} step={value.mode === 'fixed' ? 100 : 1} width="w-20" onChange={(v) => onChange({ ...value, value: v })} />
      <select
        className="input-sm"
        aria-label={t('rb.size')}
        value={value.mode}
        onChange={(e) => onChange({ ...value, mode: (['cashPct', 'equityPct', 'initialPct', 'fixed'] as const).find((m) => m === e.target.value) ?? 'cashPct' })}
      >
        <option value="cashPct">{t('rb.size.cashPct')}</option>
        <option value="equityPct">{t('rb.size.equityPct')}</option>
        <option value="initialPct">{t('rb.size.initialPct')}</option>
        <option value="fixed">{t('rb.size.fixed')}</option>
      </select>
    </span>
  );
}
