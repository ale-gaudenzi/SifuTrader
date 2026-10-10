/**
 * Plain-language summary of a strategy spec, so users can read back what
 * they built ("Buy 100% of the cash at market when Close crosses above
 * SMA(50)...") in the interface language.
 */
import { formatMoney } from '../../format';
import type { I18n } from '../../i18n';
import { INDICATOR_INFO } from '../../strategies/rules/catalog';
import type { Condition, Group, Operand, OrderSpec, RiskLevel, RuleStrategySpec, Sizing } from '../../strategies/rules/spec';
import type { RuleIssue } from '../../strategies/rules/validate';

/** Localized name of an ISO weekday (1 = Monday). */
export function weekdayName(day: number, locale: string): string {
  // 2024-01-01 was a Monday.
  return new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(Date.UTC(2024, 0, day));
}

export function monthName(month: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' }).format(Date.UTC(2024, month - 1, 1));
}

const lowerFirst = (s: string): string => s.charAt(0).toLocaleLowerCase() + s.slice(1);
const fmt = (n: number): string => (Number.isFinite(n) ? String(Number(n.toFixed(4))) : '?');

export function operandLabel(op: Operand, i18n: I18n): string {
  const { t } = i18n;
  if (op.kind === 'number') return fmt(op.value);
  let label: string;
  if (op.kind === 'price') label = t(`rb.price.${op.field}`);
  else if (op.kind === 'position') label = t(`rb.pos.${op.field}`);
  else {
    const params = op.params.length > 0 ? `(${op.params.map(fmt).join(', ')})` : '';
    label = `${t(`rb.short.${op.name}`)}${params}`;
    if (INDICATOR_INFO[op.name].input && op.input) label += ` ${t('rb.of')} ${operandLabel(op.input, i18n)}`;
  }
  if (op.kind !== 'position' && op.shift) label += ` ${op.shift === 1 ? t('rb.agoOne') : t('rb.ago', { n: op.shift })}`;
  if (op.pct) label += ` ${op.pct > 0 ? '+' : '−'}${fmt(Math.abs(op.pct))}%`;
  return label;
}

function conditionText(c: Condition, i18n: I18n): string {
  const { t, locale } = i18n;
  let text: string;
  switch (c.kind) {
    case 'compare':
      text = `${operandLabel(c.left, i18n)} ${t(`rb.op.${c.op}`)} ${operandLabel(c.right, i18n)}`;
      break;
    case 'trend':
      text = t(`rb.sum.trend.${c.direction}`, { x: operandLabel(c.left, i18n), n: c.bars });
      break;
    case 'pattern':
      text = lowerFirst(t(`rb.pattern.${c.pattern}`));
      break;
    case 'calendar':
      if (c.event === 'weekday') return t('rb.sum.weekday', { day: weekdayName(c.value, locale) });
      if (c.event === 'month') return t('rb.sum.month', { month: monthName(c.value, locale) });
      if (c.event === 'everyN') return t('rb.sum.everyN', { n: c.value });
      return lowerFirst(t(`rb.cal.${c.event}`));
  }
  return c.hold ? t(`rb.sum.hold.${c.hold.mode}`, { c: text, n: c.hold.bars }) : text;
}

function groupText(g: Group, i18n: I18n, nested = false): string {
  const parts = g.items.map((item) => (item.kind === 'group' ? groupText(item, i18n, true) : conditionText(item, i18n)));
  const joined = parts.join(` ${g.mode === 'all' ? i18n.t('rb.and') : i18n.t('rb.or')} `);
  return nested && parts.length > 1 ? `(${joined})` : joined;
}

function orderText(order: OrderSpec, side: 'buy' | 'sell', i18n: I18n): string {
  if (order.type === 'market') return i18n.t('rb.sum.market');
  return i18n.t(`rb.sum.${side}${order.type === 'limit' ? 'Limit' : 'Stop'}`, { price: operandLabel(order.price, i18n) });
}

function sizeText(size: Sizing, i18n: I18n): string {
  if (size.mode === 'fixed') return formatMoney(size.value);
  return i18n.t(`rb.sum.size.${size.mode}`, { v: fmt(size.value) });
}

function levelText(name: string, level: RiskLevel): string | null {
  if (level.mode === 'off') return null;
  return level.mode === 'pct' ? `${name} ${fmt(level.value)}%` : `${name} ${fmt(level.value)} ATR`;
}

/** One sentence per rule, in the order the strategy applies them. */
export function describeSpec(spec: RuleStrategySpec, i18n: I18n): string[] {
  const { t } = i18n;
  const lines: string[] = [];
  const { entry, scaleIn, exits, risk } = spec;

  const buy = { size: sizeText(entry.size, i18n), order: orderText(entry.order, 'buy', i18n) };
  lines.push(entry.when.items.length === 0 ? t('rb.sum.entryAlways', buy) : t('rb.sum.entry', { ...buy, cond: groupText(entry.when, i18n) }));

  if (scaleIn.enabled) {
    lines.push(
      t('rb.sum.scale', {
        size: sizeText(scaleIn.size, i18n),
        order: orderText(scaleIn.order, 'buy', i18n),
        when: scaleIn.when.items.length === 0 ? t('rb.sum.everyBar') : t('rb.sum.when', { cond: groupText(scaleIn.when, i18n) }),
        n: scaleIn.maxEntries,
        mult: scaleIn.multiplier !== 1 ? t('rb.sum.mult', { x: fmt(scaleIn.multiplier) }) : '',
      }),
    );
  }

  for (const exit of exits) {
    const amount = exit.amountPct >= 100 ? t('rb.sum.all') : t('rb.sum.part', { pct: fmt(exit.amountPct) });
    lines.push(t('rb.sum.exit', { amount, order: orderText(exit.order, 'sell', i18n), cond: groupText(exit.when, i18n) }));
  }

  const riskParts = [
    levelText(t('rb.stopLoss'), risk.stopLoss),
    levelText(t('rb.takeProfit'), risk.takeProfit),
    levelText(t('rb.trailingStop'), risk.trailingStop),
    risk.breakEven.enabled ? t('rb.sum.breakEven', { v: fmt(risk.breakEven.value) }) : null,
    risk.maxBars > 0 ? t('rb.sum.maxBars', { n: risk.maxBars }) : null,
    risk.cooldownBars > 0 ? t('rb.sum.cooldown', { n: risk.cooldownBars }) : null,
  ].filter((p): p is string => p !== null);
  if (riskParts.length > 0) lines.push(t('rb.sum.risk', { list: riskParts.join(' · ') }));
  else if (exits.length === 0) lines.push(t('rb.sum.noExit'));

  return lines;
}

/** Localized message for a validation problem, naming the rule it belongs to. */
export function issueText(issue: RuleIssue, i18n: I18n): string {
  const { t } = i18n;
  const where = issue.section === 'exit' ? t('rb.exitN', { n: (issue.rule ?? 0) + 1 }) : t(`rb.${issue.section}`);
  switch (issue.code) {
    case 'range':
      return t('rb.issue.range', { where, field: t(`rb.field.${issue.field}`), min: issue.min, max: issue.max });
    case 'integer':
      return t('rb.issue.integer', { where, field: t(`rb.field.${issue.field}`) });
    default:
      return t(`rb.issue.${issue.code}`, { where });
  }
}
