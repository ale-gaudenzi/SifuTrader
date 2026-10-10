/**
 * Shared building blocks for strategy implementations.
 */
import type { Bar, Fill, Order, ParamSpec, ParamValues, PortfolioSnapshot, Strategy, StrategyContext } from '../engine/types';

/**
 * Convenience base class. Subclasses implement `onBar` and may override the
 * optional lifecycle hooks. The helpers build well-formed orders so concrete
 * strategies read declaratively.
 */
export abstract class BaseStrategy<P extends ParamValues> implements Strategy {
  abstract readonly id: string;
  abstract readonly name: string;
  protected readonly params: Readonly<P>;

  constructor(params: P) {
    this.params = Object.freeze({ ...params });
  }

  init(_bars: readonly Bar[]): void {
    // Optional hook; no preparation by default.
  }

  abstract onBar(ctx: StrategyContext): Order[];

  onFill(_fill: Fill, _portfolio: PortfolioSnapshot): void {
    // Optional hook; no reaction by default.
  }

  protected isFlat(ctx: StrategyContext): boolean {
    return ctx.position.quantity <= 0;
  }

  protected marketBuy(cash: number, tag?: string): Order {
    return { kind: 'market', side: 'buy', cash, tag };
  }

  protected marketSellAll(tag?: string): Order {
    return { kind: 'market', side: 'sell', quantity: 'all', tag };
  }

  protected limitBuy(price: number, cash: number, tag?: string): Order {
    return { kind: 'limit', side: 'buy', price, cash, tag };
  }

  protected limitSellAll(price: number, tag?: string): Order {
    return { kind: 'limit', side: 'sell', price, quantity: 'all', tag };
  }

  protected stopBuy(price: number, cash: number, tag?: string): Order {
    return { kind: 'stop', side: 'buy', price, cash, tag };
  }

  protected stopSellAll(price: number, tag?: string): Order {
    return { kind: 'stop', side: 'sell', price, quantity: 'all', tag };
  }
}

/** Share of cash committed per entry, common to the all-in/all-out signal strategies. */
export const ALLOCATION_PARAM: ParamSpec = {
  key: 'allocationPct',
  label: 'Allocation',
  type: 'number',
  default: 100,
  min: 1,
  max: 100,
  step: 1,
  unit: '%',
  description: 'Share of available cash invested on each long signal.',
};

/**
 * Integer bar-count parameter. The `label` doubles as the key used to match
 * validation messages, so it must be unique within a strategy.
 */
export function periodParam(key: string, label: string, defaultValue: number, description: string, min = 2, max = 400): ParamSpec {
  return { key, label, type: 'number', default: defaultValue, min, max, step: 1, integer: true, unit: 'bars', description };
}

/** Builds a parameter object populated with each spec's default value. */
export function defaultParams(specs: readonly ParamSpec[]): ParamValues {
  const out: ParamValues = {};
  for (const spec of specs) out[spec.key] = spec.default;
  return out;
}

/** Validates values against their specs (type, range and integrality). */
export function validateParams(specs: readonly ParamSpec[], values: ParamValues): string[] {
  const errors: string[] = [];
  for (const spec of specs) {
    const value = values[spec.key];
    if (spec.type === 'boolean') {
      if (typeof value !== 'boolean') errors.push(`${spec.label} must be true or false.`);
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      errors.push(`${spec.label} must be a number.`);
      continue;
    }
    if (value < spec.min || value > spec.max) errors.push(`${spec.label} must be between ${spec.min} and ${spec.max}.`);
    if (spec.integer && !Number.isInteger(value)) errors.push(`${spec.label} must be a whole number.`);
  }
  return errors;
}

/** Reads a numeric parameter, throwing if it is missing or of the wrong type. */
export function numberParam(values: ParamValues, key: string): number {
  const v = values[key];
  if (typeof v !== 'number') throw new TypeError(`Parameter "${key}" must be a number.`);
  return v;
}

/** Reads a boolean parameter, throwing if it is missing or of the wrong type. */
export function booleanParam(values: ParamValues, key: string): boolean {
  const v = values[key];
  if (typeof v !== 'boolean') throw new TypeError(`Parameter "${key}" must be a boolean.`);
  return v;
}
