import { describe, expect, it } from 'vitest';
import { createI18n } from './i18n';
import { STRATEGIES } from './strategies';
import { macdCrossDefinition } from './strategies/macdCross';
import { martingaleDefinition } from './strategies/martingale';
import { rsiReversionDefinition } from './strategies/rsiReversion';
import { smaCrossDefinition } from './strategies/smaCross';

describe('Italian localization', () => {
  const it18n = createI18n('it');

  it('translates every strategy, parameter label and description', () => {
    for (const def of STRATEGIES) {
      expect(it18n.strategyName(def)).not.toBe(def.name);
      expect(it18n.strategyDescription(def)).not.toBe(def.description);
      for (const spec of def.params) {
        expect(it18n.paramLabel(def.id, spec)).not.toBe(spec.label);
        expect(it18n.paramDescription(def.id, spec)).not.toBe(spec.description);
      }
    }
  });

  it('translates strategy validation messages, including the parameter label', () => {
    const params = { baseOrderPct: 3, dropStepPct: 2, sizeMultiplier: 2, maxSteps: 2.5, takeProfitPct: 300, compound: true };
    const errors = martingaleDefinition.validate(params).map((e) => it18n.validationMessage(martingaleDefinition, e));
    expect(errors).toContain('Passi massimi deve essere un numero intero.');
    expect(errors).toContain('Take profit deve essere compreso tra 0.1 e 100.');

    const [order] = smaCrossDefinition.validate({ fastPeriod: 50, slowPeriod: 20, allocationPct: 100 });
    expect(it18n.validationMessage(smaCrossDefinition, order)).toBe('Il periodo della SMA veloce deve essere inferiore a quello della SMA lenta.');

    const [macdOrder] = macdCrossDefinition.validate({ fastPeriod: 30, slowPeriod: 26, signalPeriod: 9, belowZeroOnly: false, allocationPct: 100 });
    expect(it18n.validationMessage(macdCrossDefinition, macdOrder)).toBe("Il periodo dell'EMA veloce deve essere inferiore a quello dell'EMA lenta.");
    const [levels] = rsiReversionDefinition.validate({ rsiPeriod: 14, entryLevel: 60, exitLevel: 40, allocationPct: 100 });
    expect(it18n.validationMessage(rsiReversionDefinition, levels)).toBe('Il livello di uscita deve essere superiore al livello di ipervenduto.');
  });

  it('interpolates placeholders and leaves English untouched', () => {
    expect(it18n.t('app.bars', { n: 12, tf: it18n.timeframe('1W') })).toBe('12 barre (1S)');
    const en = createI18n('en');
    expect(en.validationMessage(smaCrossDefinition, 'anything')).toBe('anything');
    expect(en.strategyName(martingaleDefinition)).toBe(martingaleDefinition.name);
  });
});
