/**
 * Strategy registry. To add a strategy, implement `Strategy` (typically by
 * extending `BaseStrategy`), export a `StrategyDefinition`, and append it
 * here. The UI renders parameter forms from the definition's `params`.
 */
import type { StrategyDefinition } from '../engine/types';
import { martingaleDefinition } from './martingale';
import { smaCrossDefinition } from './smaCross';

export const STRATEGIES: readonly StrategyDefinition[] = [martingaleDefinition, smaCrossDefinition];

export function getStrategy(id: string): StrategyDefinition {
  const def = STRATEGIES.find((s) => s.id === id);
  if (!def) throw new Error(`Unknown strategy "${id}"`);
  return def;
}
