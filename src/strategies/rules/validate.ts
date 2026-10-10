/**
 * Reading and checking strategy specs.
 *
 * `parseSpec` turns untrusted JSON (localStorage, an imported file, a shared
 * link) into a well-typed spec or rejects it. It is lenient about numbers, so
 * a half-edited field (stored by JSON as `null`) survives a reload as NaN and
 * is reported by `validateSpec` instead of discarding the whole strategy.
 *
 * `validateSpec` reports everything that would make a spec unusable: values
 * out of range, misplaced position values, conditions that can never hold.
 */
import { CALENDAR_VALUE, INDICATOR_INFO, MAX_LOOKBACK } from './catalog';
import {
  CALENDAR_EVENTS,
  COMPARE_OPS,
  INDICATORS,
  PATTERNS,
  POSITION_FIELDS,
  PRICE_FIELDS,
  defaultRisk,
  type Condition,
  type EntryRule,
  type ExitRule,
  type Group,
  type Hold,
  type Operand,
  type OrderSpec,
  type RiskLevel,
  type RiskRules,
  type RuleStrategySpec,
  type ScaleInRule,
  type Sizing,
} from './spec';

/* -------------------------------------------------------------------------- */
/* Parsing                                                                    */
/* -------------------------------------------------------------------------- */

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const oneOf = <T extends string>(options: readonly T[], v: unknown): T | null =>
  typeof v === 'string' && (options as readonly string[]).includes(v) ? (v as T) : null;

/** Deepest operand nesting accepted from untrusted input (indicator of indicator of ...). */
const MAX_OPERAND_DEPTH = 4;
/** Most conditions accepted in one group. */
export const MAX_GROUP_ITEMS = 30;
/** Most exit rules accepted in one spec. */
export const MAX_EXIT_RULES = 10;

/** A number, or NaN for a value the user cleared (JSON has no NaN and stores `null`). */
function num(v: unknown): number | null {
  if (typeof v === 'number') return v;
  return v === null ? Number.NaN : null;
}

function optionalNum(v: unknown): number | undefined | null {
  return v === undefined ? undefined : num(v);
}

function parseOperand(v: unknown, depth = 0): Operand | null {
  if (!isObject(v) || depth > MAX_OPERAND_DEPTH) return null;
  const shift = optionalNum(v.shift);
  const pct = optionalNum(v.pct);
  if (shift === null || pct === null) return null;
  const modifiers = { ...(shift !== undefined && { shift }), ...(pct !== undefined && { pct }) };
  switch (v.kind) {
    case 'price': {
      const field = oneOf(PRICE_FIELDS, v.field);
      return field && { kind: 'price', field, ...modifiers };
    }
    case 'indicator': {
      const name = oneOf(INDICATORS, v.name);
      if (!name || !Array.isArray(v.params)) return null;
      const params = v.params.map(num);
      if (params.some((p) => p === null) || params.length !== INDICATOR_INFO[name].params.length) return null;
      let input: Operand | undefined;
      if (v.input !== undefined) {
        const parsed = parseOperand(v.input, depth + 1);
        if (parsed === null) return null;
        input = parsed;
      }
      return { kind: 'indicator', name, params: params.map((p) => p ?? Number.NaN), ...(input && { input }), ...modifiers };
    }
    case 'number': {
      const value = num(v.value);
      return value === null ? null : { kind: 'number', value };
    }
    case 'position': {
      const field = oneOf(POSITION_FIELDS, v.field);
      return field && { kind: 'position', field, ...(pct !== undefined && { pct }) };
    }
    default:
      return null;
  }
}

function parseHold(v: unknown): Hold | undefined | null {
  if (v === undefined) return undefined;
  if (!isObject(v)) return null;
  const mode = oneOf(['for', 'within'] as const, v.mode);
  const bars = num(v.bars);
  return mode && bars !== null ? { mode, bars } : null;
}

function parseCondition(v: unknown): Condition | null {
  if (!isObject(v)) return null;
  const hold = parseHold(v.hold);
  if (hold === null) return null;
  const withHold = hold ? { hold } : {};
  switch (v.kind) {
    case 'compare': {
      const left = parseOperand(v.left);
      const right = parseOperand(v.right);
      const op = oneOf(COMPARE_OPS, v.op);
      return left && right && op ? { kind: 'compare', left, op, right, ...withHold } : null;
    }
    case 'trend': {
      const left = parseOperand(v.left);
      const direction = oneOf(['rising', 'falling'] as const, v.direction);
      const bars = num(v.bars);
      return left && direction && bars !== null ? { kind: 'trend', left, direction, bars, ...withHold } : null;
    }
    case 'pattern': {
      const pattern = oneOf(PATTERNS, v.pattern);
      return pattern && { kind: 'pattern', pattern, ...withHold };
    }
    case 'calendar': {
      const event = oneOf(CALENDAR_EVENTS, v.event);
      const value = num(v.value);
      return event && value !== null ? { kind: 'calendar', event, value } : null;
    }
    default:
      return null;
  }
}

function parseGroup(v: unknown, depth = 0): Group | null {
  if (!isObject(v) || v.kind !== 'group' || !Array.isArray(v.items) || depth > 1) return null;
  const mode = oneOf(['all', 'any'] as const, v.mode);
  if (!mode || v.items.length > MAX_GROUP_ITEMS) return null;
  const items: Group['items'] = [];
  for (const raw of v.items) {
    const item = isObject(raw) && raw.kind === 'group' ? parseGroup(raw, depth + 1) : parseCondition(raw);
    if (item === null) return null;
    items.push(item);
  }
  return { kind: 'group', mode, items };
}

function parseOrder(v: unknown): OrderSpec | null {
  if (!isObject(v)) return null;
  if (v.type === 'market') return { type: 'market' };
  const type = oneOf(['limit', 'stop'] as const, v.type);
  const price = parseOperand(v.price);
  return type && price ? { type, price } : null;
}

function parseSizing(v: unknown): Sizing | null {
  if (!isObject(v)) return null;
  const mode = oneOf(['cashPct', 'equityPct', 'initialPct', 'fixed'] as const, v.mode);
  const value = num(v.value);
  return mode && value !== null ? { mode, value } : null;
}

function parseEntry(v: unknown): EntryRule | null {
  if (!isObject(v)) return null;
  const when = parseGroup(v.when);
  const order = parseOrder(v.order);
  const size = parseSizing(v.size);
  return when && order && size ? { when, order, size } : null;
}

function parseScaleIn(v: unknown): ScaleInRule | null {
  if (!isObject(v) || typeof v.enabled !== 'boolean') return null;
  const when = parseGroup(v.when);
  const order = parseOrder(v.order);
  const size = parseSizing(v.size);
  const multiplier = num(v.multiplier);
  const maxEntries = num(v.maxEntries);
  if (!when || !order || !size || multiplier === null || maxEntries === null) return null;
  return { enabled: v.enabled, when, order, size, multiplier, maxEntries };
}

function parseExit(v: unknown): ExitRule | null {
  if (!isObject(v)) return null;
  const when = parseGroup(v.when);
  const order = parseOrder(v.order);
  const amountPct = num(v.amountPct);
  return when && order && amountPct !== null ? { when, order, amountPct } : null;
}

function parseLevel(v: unknown, fallback: RiskLevel): RiskLevel | null {
  if (v === undefined) return fallback;
  if (!isObject(v)) return null;
  const mode = oneOf(['off', 'pct', 'atr'] as const, v.mode);
  const value = num(v.value);
  return mode && value !== null ? { mode, value } : null;
}

/** Missing risk settings take their defaults, so older specs keep loading as fields are added. */
function parseRisk(v: unknown): RiskRules | null {
  const d = defaultRisk();
  if (v === undefined) return d;
  if (!isObject(v)) return null;
  const stopLoss = parseLevel(v.stopLoss, d.stopLoss);
  const takeProfit = parseLevel(v.takeProfit, d.takeProfit);
  const trailingStop = parseLevel(v.trailingStop, d.trailingStop);
  let breakEven: RiskRules['breakEven'] | null = d.breakEven;
  if (v.breakEven !== undefined) {
    const be = v.breakEven;
    const value = isObject(be) ? num(be.value) : null;
    breakEven = isObject(be) && typeof be.enabled === 'boolean' && value !== null ? { enabled: be.enabled, value } : null;
  }
  const maxBars = v.maxBars === undefined ? d.maxBars : num(v.maxBars);
  const cooldownBars = v.cooldownBars === undefined ? d.cooldownBars : num(v.cooldownBars);
  const atrPeriod = v.atrPeriod === undefined ? d.atrPeriod : num(v.atrPeriod);
  if (!stopLoss || !takeProfit || !trailingStop || !breakEven || maxBars === null || cooldownBars === null || atrPeriod === null) return null;
  return { stopLoss, takeProfit, trailingStop, breakEven, maxBars, cooldownBars, atrPeriod };
}

/** Returns a well-typed spec, or null when `v` is not a version-1 strategy spec. */
export function parseSpec(v: unknown): RuleStrategySpec | null {
  if (!isObject(v) || v.version !== 1 || typeof v.id !== 'string' || v.id === '' || typeof v.name !== 'string') return null;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(v.id)) return null;
  const entry = parseEntry(v.entry);
  const scaleIn = parseScaleIn(v.scaleIn);
  const risk = parseRisk(v.risk);
  if (!entry || !scaleIn || !risk || !Array.isArray(v.exits) || v.exits.length > MAX_EXIT_RULES) return null;
  const exits: ExitRule[] = [];
  for (const raw of v.exits) {
    const exit = parseExit(raw);
    if (exit === null) return null;
    exits.push(exit);
  }
  return {
    version: 1,
    id: v.id,
    name: v.name.slice(0, 120),
    description: typeof v.description === 'string' ? v.description.slice(0, 2000) : '',
    entry,
    scaleIn,
    exits,
    risk,
  };
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

export type IssueSection = 'entry' | 'scaleIn' | 'exit' | 'risk';

/** Names of the checked values, used by the UI to word the message. */
export type IssueField =
  | 'indicator'
  | 'shift'
  | 'pct'
  | 'number'
  | 'holdBars'
  | 'trendBars'
  | 'calendar'
  | 'size'
  | 'multiplier'
  | 'maxEntries'
  | 'amount'
  | 'stopLoss'
  | 'takeProfit'
  | 'trailingStop'
  | 'breakEven'
  | 'maxBars'
  | 'cooldown'
  | 'atrPeriod';

export type RuleIssue =
  | { section: IssueSection; rule?: number; code: 'range'; field: IssueField; min: number; max: number }
  | { section: IssueSection; rule?: number; code: 'integer'; field: IssueField }
  | { section: IssueSection; rule?: number; code: 'exitEmpty' | 'positionInEntry' | 'positionMisuse' };

interface Scope {
  section: IssueSection;
  rule?: number;
  issues: RuleIssue[];
}

function checkNumber(scope: Scope, field: IssueField, value: number, min: number, max: number, integer: boolean): void {
  const at = { section: scope.section, ...(scope.rule !== undefined && { rule: scope.rule }) };
  if (!Number.isFinite(value) || value < min || value > max) {
    scope.issues.push({ ...at, code: 'range', field, min, max });
  } else if (integer && !Number.isInteger(value)) {
    scope.issues.push({ ...at, code: 'integer', field });
  }
}

function addIssue(scope: Scope, code: 'exitEmpty' | 'positionInEntry' | 'positionMisuse'): void {
  scope.issues.push({ section: scope.section, ...(scope.rule !== undefined && { rule: scope.rule }), code });
}

/** True when the operand reads the open position. */
const usesPosition = (op: Operand): boolean => op.kind === 'position';

/**
 * Checks an operand. Position values have no history, so they are only valid
 * at the top level of a condition evaluated on the current bar.
 */
function checkOperand(scope: Scope, op: Operand, nested: boolean): void {
  if (op.kind === 'number') {
    checkNumber(scope, 'number', op.value, -1e12, 1e12, false);
    return;
  }
  if (op.pct !== undefined) checkNumber(scope, 'pct', op.pct, -99, 1000, false);
  if (op.kind === 'position') {
    if (nested) addIssue(scope, 'positionMisuse');
    else if (scope.section === 'entry') addIssue(scope, 'positionInEntry');
    return;
  }
  if (op.shift !== undefined) checkNumber(scope, 'shift', op.shift, 0, MAX_LOOKBACK, true);
  if (op.kind === 'indicator') {
    const info = INDICATOR_INFO[op.name];
    info.params.forEach((spec, k) => checkNumber(scope, 'indicator', op.params[k], spec.min, spec.max, spec.integer));
    if (op.input && info.input) checkOperand(scope, op.input, true);
  }
}

function checkHold(scope: Scope, hold: Hold | undefined, left: Operand, right?: Operand): void {
  if (!hold) return;
  checkNumber(scope, 'holdBars', hold.bars, 1, MAX_LOOKBACK, true);
  if (usesPosition(left) || (right && usesPosition(right))) addIssue(scope, 'positionMisuse');
}

function checkCondition(scope: Scope, c: Condition): void {
  switch (c.kind) {
    case 'compare': {
      checkOperand(scope, c.left, false);
      checkOperand(scope, c.right, false);
      const crossing = c.op === 'crossAbove' || c.op === 'crossBelow' || c.op === 'cross';
      if (crossing && (usesPosition(c.left) || usesPosition(c.right))) addIssue(scope, 'positionMisuse');
      checkHold(scope, c.hold, c.left, c.right);
      return;
    }
    case 'trend':
      checkOperand(scope, c.left, false);
      checkNumber(scope, 'trendBars', c.bars, 1, MAX_LOOKBACK, true);
      if (usesPosition(c.left)) addIssue(scope, 'positionMisuse');
      checkHold(scope, c.hold, c.left);
      return;
    case 'pattern':
      if (c.hold) checkNumber(scope, 'holdBars', c.hold.bars, 1, MAX_LOOKBACK, true);
      return;
    case 'calendar': {
      const bounds = CALENDAR_VALUE[c.event];
      if (bounds) checkNumber(scope, 'calendar', c.value, bounds.min, bounds.max, true);
      return;
    }
  }
}

function checkGroup(scope: Scope, g: Group): void {
  for (const item of g.items) {
    if (item.kind === 'group') checkGroup(scope, item);
    else checkCondition(scope, item);
  }
}

function checkOrder(scope: Scope, order: OrderSpec): void {
  if (order.type !== 'market') checkOperand(scope, order.price, false);
}

function checkSizing(scope: Scope, size: Sizing): void {
  if (size.mode === 'fixed') checkNumber(scope, 'size', size.value, 0.01, 1e12, false);
  else checkNumber(scope, 'size', size.value, 0.1, 100, false);
}

function checkLevel(scope: Scope, field: IssueField, level: RiskLevel, maxPct: number): void {
  if (level.mode === 'pct') checkNumber(scope, field, level.value, 0.1, maxPct, false);
  else if (level.mode === 'atr') checkNumber(scope, field, level.value, 0.1, 50, false);
}

/** Lists every problem in a spec; an empty list means it compiles and runs. */
export function validateSpec(spec: RuleStrategySpec): RuleIssue[] {
  const issues: RuleIssue[] = [];

  const entry: Scope = { section: 'entry', issues };
  checkGroup(entry, spec.entry.when);
  checkOrder(entry, spec.entry.order);
  checkSizing(entry, spec.entry.size);

  if (spec.scaleIn.enabled) {
    const scale: Scope = { section: 'scaleIn', issues };
    checkGroup(scale, spec.scaleIn.when);
    checkOrder(scale, spec.scaleIn.order);
    checkSizing(scale, spec.scaleIn.size);
    checkNumber(scale, 'multiplier', spec.scaleIn.multiplier, 0.1, 10, false);
    checkNumber(scale, 'maxEntries', spec.scaleIn.maxEntries, 2, 10_000, true);
  }

  spec.exits.forEach((exit, rule) => {
    const scope: Scope = { section: 'exit', rule, issues };
    if (exit.when.items.length === 0) addIssue(scope, 'exitEmpty');
    checkGroup(scope, exit.when);
    checkOrder(scope, exit.order);
    checkNumber(scope, 'amount', exit.amountPct, 1, 100, false);
  });

  const risk: Scope = { section: 'risk', issues };
  const r = spec.risk;
  checkLevel(risk, 'stopLoss', r.stopLoss, 99);
  checkLevel(risk, 'takeProfit', r.takeProfit, 10_000);
  checkLevel(risk, 'trailingStop', r.trailingStop, 99);
  if (r.breakEven.enabled) checkNumber(risk, 'breakEven', r.breakEven.value, 0.1, 10_000, false);
  checkNumber(risk, 'maxBars', r.maxBars, 0, 100_000, true);
  checkNumber(risk, 'cooldown', r.cooldownBars, 0, 100_000, true);
  if ([r.stopLoss, r.takeProfit, r.trailingStop].some((l) => l.mode === 'atr')) checkNumber(risk, 'atrPeriod', r.atrPeriod, 1, MAX_LOOKBACK, true);

  return issues;
}
