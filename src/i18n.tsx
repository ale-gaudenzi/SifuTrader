/**
 * Minimal UI localization (English / Italian) without external dependencies.
 *
 * - `I18nProvider` owns the selected language (persisted per browser, first
 *   visit follows the browser language) and keeps `<html lang>` in sync.
 * - `useI18n()` exposes `t(key, vars)` for UI strings with `{name}`
 *   placeholders, plus helpers that localize strategy metadata.
 *
 * The engine and strategy definitions stay in English; their user-facing
 * texts are translated here so new strategies keep working untranslated
 * (missing entries fall back to the definition's own English strings).
 */
import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import type { ParamSpec, StrategyDefinition, Timeframe } from './engine/types';
import { isOneOf, usePersistentState } from './hooks/usePersistentState';

export type Lang = 'en' | 'it';
export const LANGS: ReadonlyArray<{ value: Lang; label: string; name: string }> = [
  { value: 'en', label: 'EN', name: 'English' },
  { value: 'it', label: 'IT', name: 'Italiano' },
];

/** Locale used for dates in each language. Numbers stay en-US for stable exports. */
export const LOCALES: Record<Lang, string> = { en: 'en-US', it: 'it-IT' };

const en = {
  'app.privacy': 'Client-side only. No data leaves your browser.',
  'app.loading': 'Loading market data...',
  'app.disclaimer': 'Historical simulation for research and education only. Past performance does not predict future results. Not investment advice.',
  'app.bars': '{n} bars ({tf})',
  'app.language': 'Language',
  'err.capital': 'Capital must be a positive number.',
  'err.fee': 'Fee must be between 0% and 5%.',
  'err.slippage': 'Slippage must be between 0% and 5%.',
  'err.period': 'The backtest period must contain at least two bars.',
  'err.boolean': '{label} must be true or false.',
  'err.number': '{label} must be a number.',
  'err.range': '{label} must be between {min} and {max}.',
  'err.integer': '{label} must be a whole number.',
  'err.smaOrder': 'Fast SMA period must be shorter than the slow SMA period.',
  'err.macdOrder': 'Fast EMA period must be shorter than the slow EMA period.',
  'err.rsiLevels': 'Exit level must be above the oversold level.',

  'tf.1D': '1D',
  'tf.1W': '1W',
  'tf.1M': '1M',

  'data.title': 'Market Data',
  'data.samples': 'Bundled samples (offline)',
  'data.ticker': 'Online ticker',
  'data.fetch': 'Fetch',
  'data.source': 'Data source',
  'data.range': 'History range',
  'data.src.auto': 'Auto',
  'data.src.snapshot': 'Yahoo (site snapshot)',
  'data.note': 'Yahoo symbols come from the snapshot published with the site (watchlist, updated every weekday); crypto pairs load live from Binance. Nothing is saved: every fetch downloads the data again.',
  'data.hintSnapshot': 'Only the symbols in data/watchlist.json are available from Yahoo; crypto pairs (e.g. DOGE-USD) load from Binance.',
  'data.st.fetched': '{s}: {n} bars downloaded.',
  'data.src.binance': 'Binance (crypto)',
  'data.csv': 'Local CSV',
  'data.drop': 'Drop a CSV here or click to browse',
  'data.cancel': 'cancel',
  'data.cancelled': 'Request cancelled.',
  'data.loadingSample': 'Loading sample {s}...',
  'data.fetching': 'Fetching {s}...',
  'data.parsing': 'Parsing {name}...',
  'data.manifestError': 'Sample manifest unavailable: {msg}',
  'data.localFile': 'Local file ({n} of {total} rows)',

  'chart.aria': 'Price chart',
  'chart.timeframe': 'Timeframe',
  'chart.emaPeriod': 'EMA period',
  'chart.tradesTitle': 'Show backtest executions on the chart',
  'chart.trades': 'Trades',
  'chart.log': 'Log',
  'chart.fit': 'Fit',
  'chart.open': 'Open',
  'chart.high': 'High',
  'chart.low': 'Low',
  'chart.close': 'Close',
  'chart.change': 'Change',
  'chart.volume': 'Volume',
  'chart.buyMarker': 'B',
  'chart.sellMarker': 'S',

  'equity.aria': 'Equity curve',
  'equity.title': 'Equity Curve',
  'equity.strategy': 'Strategy',
  'equity.buyHold': 'Buy & Hold',
  'equity.drawdown': 'Drawdown',

  'metrics.aria': 'Backtest metrics',
  'metrics.finalEquity': 'Final Equity',
  'metrics.from': 'from {x}',
  'metrics.totalReturn': 'Total Return',
  'metrics.vsBH': '{x} vs B&H',
  'metrics.buyHold': 'Buy & Hold',
  'metrics.maxDD': 'max DD {x}',
  'metrics.maxDrawdown': 'Max Drawdown',
  'metrics.peakToTrough': 'peak to trough',
  'metrics.winRate': 'Win Rate',
  'metrics.closedTrades': 'closed trades',
  'metrics.totalTrades': 'Total Trades',
  'metrics.fills': '{n} fills',
  'metrics.plusOpen': ' + 1 open',
  'metrics.cagr': 'CAGR',
  'metrics.sharpe': 'Sharpe',
  'metrics.sharpeTitle': 'Annualized with {n} bars/year, risk-free rate 0',
  'metrics.profitFactor': 'Profit Factor',
  'metrics.profitFactorTitle': 'Gross profit / gross loss of closed trades',
  'metrics.exposure': 'Exposure',
  'metrics.exposureTitle': 'Share of bars holding a position',
  'metrics.fees': 'Fees Paid',

  'strategy.aria': 'Strategy',
  'strategy.title': 'Backtest',
  'strategy.runtime': '{n} bars in {ms} ms',
  'strategy.strategy': 'Strategy',
  'strategy.execution': 'Execution',
  'strategy.capital': 'Capital',
  'strategy.capitalTitle': 'Initial capital',
  'strategy.fee': 'Fee',
  'strategy.feeTitle': 'Commission per fill, percent of notional',
  'strategy.slippage': 'Slippage',
  'strategy.slippageTitle': 'Adverse price adjustment on market orders',
  'strategy.note': 'Signals are evaluated on bar close and executed on the next bar (market at open, limits intrabar). Results update automatically.',
  'strategy.reset': 'Reset to defaults',
  'strategy.period': 'Backtest period',
  'strategy.periodFrom': 'From',
  'strategy.periodTo': 'To',
  'strategy.periodAll': 'Full history',
  'strategy.periodNote': 'The strategy starts with fresh capital on the first bar of the period; indicators warm up from there.',
  'unit.bars': 'bars',

  'trades.aria': 'Trade log',
  'trades.title': 'Trade Log',
  'trades.export': 'Export CSV',
  'trades.empty': 'No trades were executed with these parameters.',
  'trades.open': 'Open',
  'trades.prev': 'Prev',
  'trades.next': 'Next',
  'trades.col.entryTime': 'Entry Date',
  'trades.col.exitTime': 'Exit Date',
  'trades.col.avgEntryPrice': 'Buy Price',
  'trades.col.avgEntryPrice.title': 'Average entry price across all buy fills',
  'trades.col.exitPrice': 'Sell Price',
  'trades.col.exitPrice.title': 'Average exit price (last close for open trades)',
  'trades.col.entries': 'Fills',
  'trades.col.entries.title': 'Number of buy fills that built the position',
  'trades.col.barsHeld': 'Bars',
  'trades.col.barsHeld.title': 'Bars held',
  'trades.col.pnl': 'Realized PnL',
  'trades.col.pnl.title': 'Net of commissions; unrealized for open trades',
  'trades.col.roiPct': 'ROI',
  'trades.col.roiPct.title': 'PnL / cost basis',
};

export type MessageKey = keyof typeof en;
type Messages = Record<MessageKey, string>;

const it: Messages = {
  'app.privacy': 'Solo lato client. Nessun dato lascia il tuo browser.',
  'app.loading': 'Caricamento dati di mercato...',
  'app.disclaimer':
    'Simulazione storica a solo scopo di ricerca e didattico. I rendimenti passati non sono indicativi di quelli futuri. Non costituisce consulenza finanziaria.',
  'app.bars': '{n} barre ({tf})',
  'app.language': 'Lingua',
  'err.capital': 'Il capitale deve essere un numero positivo.',
  'err.fee': 'La commissione deve essere compresa tra 0% e 5%.',
  'err.slippage': 'Lo slippage deve essere compreso tra 0% e 5%.',
  'err.period': 'Il periodo del backtest deve contenere almeno due barre.',
  'err.boolean': '{label} deve essere vero o falso.',
  'err.number': '{label} deve essere un numero.',
  'err.range': '{label} deve essere compreso tra {min} e {max}.',
  'err.integer': '{label} deve essere un numero intero.',
  'err.smaOrder': 'Il periodo della SMA veloce deve essere inferiore a quello della SMA lenta.',
  'err.macdOrder': "Il periodo dell'EMA veloce deve essere inferiore a quello dell'EMA lenta.",
  'err.rsiLevels': 'Il livello di uscita deve essere superiore al livello di ipervenduto.',

  'tf.1D': '1G',
  'tf.1W': '1S',
  'tf.1M': '1M',

  'data.title': 'Dati di mercato',
  'data.samples': 'Campioni inclusi (offline)',
  'data.ticker': 'Ticker online',
  'data.fetch': 'Scarica',
  'data.source': 'Fonte dati',
  'data.range': 'Periodo storico',
  'data.src.auto': 'Automatica',
  'data.src.snapshot': 'Yahoo (snapshot del sito)',
  'data.note': 'I simboli Yahoo arrivano dallo snapshot pubblicato con il sito (watchlist, aggiornata ogni giorno feriale); le coppie cripto vengono scaricate live da Binance. Non viene salvato nulla: ogni richiesta riscarica i dati.',
  'data.hintSnapshot': 'Da Yahoo sono disponibili solo i simboli in data/watchlist.json; le coppie cripto (es. DOGE-USD) arrivano da Binance.',
  'data.st.fetched': '{s}: {n} barre scaricate.',
  'data.src.binance': 'Binance (cripto)',
  'data.csv': 'CSV locale',
  'data.drop': 'Trascina qui un CSV o clicca per sfogliare',
  'data.cancel': 'annulla',
  'data.cancelled': 'Richiesta annullata.',
  'data.loadingSample': 'Caricamento campione {s}...',
  'data.fetching': 'Download di {s}...',
  'data.parsing': 'Lettura di {name}...',
  'data.manifestError': 'Elenco dei campioni non disponibile: {msg}',
  'data.localFile': 'File locale ({n} di {total} righe)',

  'chart.aria': 'Grafico dei prezzi',
  'chart.timeframe': 'Intervallo temporale',
  'chart.emaPeriod': 'Periodo EMA',
  'chart.tradesTitle': 'Mostra le esecuzioni del backtest sul grafico',
  'chart.trades': 'Operazioni',
  'chart.log': 'Log',
  'chart.fit': 'Adatta',
  'chart.open': 'Apertura',
  'chart.high': 'Massimo',
  'chart.low': 'Minimo',
  'chart.close': 'Chiusura',
  'chart.change': 'Variazione',
  'chart.volume': 'Volume',
  'chart.buyMarker': 'A',
  'chart.sellMarker': 'V',

  'equity.aria': 'Curva del capitale',
  'equity.title': 'Curva del capitale',
  'equity.strategy': 'Strategia',
  'equity.buyHold': 'Buy & Hold',
  'equity.drawdown': 'Drawdown',

  'metrics.aria': 'Metriche del backtest',
  'metrics.finalEquity': 'Capitale finale',
  'metrics.from': 'da {x}',
  'metrics.totalReturn': 'Rendimento totale',
  'metrics.vsBH': '{x} vs B&H',
  'metrics.buyHold': 'Buy & Hold',
  'metrics.maxDD': 'DD max {x}',
  'metrics.maxDrawdown': 'Drawdown massimo',
  'metrics.peakToTrough': 'dal picco al minimo',
  'metrics.winRate': 'Operazioni vincenti',
  'metrics.closedTrades': 'operazioni chiuse',
  'metrics.totalTrades': 'Operazioni totali',
  'metrics.fills': '{n} esecuzioni',
  'metrics.plusOpen': ' + 1 aperta',
  'metrics.cagr': 'CAGR',
  'metrics.sharpe': 'Sharpe',
  'metrics.sharpeTitle': 'Annualizzato con {n} barre/anno, tasso privo di rischio 0',
  'metrics.profitFactor': 'Profit Factor',
  'metrics.profitFactorTitle': 'Profitto lordo / perdita lorda delle operazioni chiuse',
  'metrics.exposure': 'Esposizione',
  'metrics.exposureTitle': 'Quota di barre con una posizione aperta',
  'metrics.fees': 'Commissioni pagate',

  'strategy.aria': 'Strategia',
  'strategy.title': 'Backtest',
  'strategy.runtime': '{n} barre in {ms} ms',
  'strategy.strategy': 'Strategia',
  'strategy.execution': 'Esecuzione',
  'strategy.capital': 'Capitale',
  'strategy.capitalTitle': 'Capitale iniziale',
  'strategy.fee': 'Commissione',
  'strategy.feeTitle': 'Commissione per esecuzione, in percentuale del controvalore',
  'strategy.slippage': 'Slippage',
  'strategy.slippageTitle': 'Scostamento sfavorevole del prezzo sugli ordini a mercato',
  'strategy.note':
    "I segnali sono valutati alla chiusura della barra ed eseguiti sulla barra successiva (a mercato all'apertura, limite durante la barra). I risultati si aggiornano automaticamente.",
  'strategy.reset': 'Ripristina predefiniti',
  'strategy.period': 'Periodo del backtest',
  'strategy.periodFrom': 'Dal',
  'strategy.periodTo': 'Al',
  'strategy.periodAll': 'Tutto lo storico',
  'strategy.periodNote': 'La strategia parte con il capitale iniziale dalla prima barra del periodo; gli indicatori si riscaldano da lì.',
  'unit.bars': 'barre',

  'trades.aria': 'Registro operazioni',
  'trades.title': 'Registro operazioni',
  'trades.export': 'Esporta CSV',
  'trades.empty': 'Nessuna operazione eseguita con questi parametri.',
  'trades.open': 'Aperta',
  'trades.prev': 'Prec.',
  'trades.next': 'Succ.',
  'trades.col.entryTime': 'Data ingresso',
  'trades.col.exitTime': 'Data uscita',
  'trades.col.avgEntryPrice': 'Prezzo acquisto',
  'trades.col.avgEntryPrice.title': 'Prezzo medio di ingresso su tutte le esecuzioni di acquisto',
  'trades.col.exitPrice': 'Prezzo vendita',
  'trades.col.exitPrice.title': "Prezzo medio di uscita (ultima chiusura per le operazioni aperte)",
  'trades.col.entries': 'Esecuz.',
  'trades.col.entries.title': 'Numero di acquisti che hanno costruito la posizione',
  'trades.col.barsHeld': 'Barre',
  'trades.col.barsHeld.title': 'Barre di detenzione',
  'trades.col.pnl': 'P&L realizzato',
  'trades.col.pnl.title': 'Al netto delle commissioni; non realizzato per le operazioni aperte',
  'trades.col.roiPct': 'ROI',
  'trades.col.roiPct.title': 'P&L / costo di carico',
};

interface StrategyText {
  name: string;
  description: string;
  params: Record<string, { label: string; description: string }>;
}

/** Italian texts for the shared `ALLOCATION_PARAM`. */
const ALLOCATION_IT = { label: 'Allocazione', description: 'Quota della liquidità disponibile investita a ogni segnale long.' };

/** Validation messages that strategies emit verbatim, translated by exact match. */
const EXACT_ERRORS: readonly MessageKey[] = ['err.smaOrder', 'err.macdOrder', 'err.rsiLevels'];

/** Italian texts for registered strategies, keyed by strategy id. */
const STRATEGIES_IT: Record<string, StrategyText> = {
  martingale: {
    name: 'Martingala su ribassi',
    description:
      "Acquista un'allocazione base, incrementa la posizione con ordini geometricamente più grandi a ogni ribasso di una percentuale fissa " +
      "e chiude l'intera posizione a un take profit sopra il costo medio.",
    params: {
      baseOrderPct: { label: 'Ordine base', description: 'Dimensione del primo acquisto di ogni ciclo, in percentuale del capitale.' },
      dropStepPct: { label: 'Passo di ribasso', description: "Calo del prezzo dall'ultimo acquisto che attiva il successivo ordine di incremento." },
      sizeMultiplier: { label: 'Moltiplicatore', description: "Ogni ordine di incremento è questo multiplo della dimensione dell'ordine precedente." },
      maxSteps: { label: 'Passi massimi', description: "Numero massimo di acquisti per ciclo, incluso l'ordine base." },
      takeProfitPct: { label: 'Take profit', description: 'Guadagno non realizzato sul costo medio (incluse le commissioni di ingresso) che liquida la posizione.' },
      compound: { label: 'Capitalizza', description: "Dimensiona l'ordine base sul capitale attuale invece che su quello iniziale." },
    },
  },
  'sma-cross': {
    name: 'Incrocio doppia SMA',
    description: "Apre una posizione long quando la SMA veloce incrocia al rialzo la SMA lenta e passa alla liquidità con l'incrocio opposto.",
    params: {
      fastPeriod: { label: 'SMA veloce', description: 'Periodo della media mobile veloce.' },
      slowPeriod: { label: 'SMA lenta', description: 'Periodo della media mobile lenta. Deve superare il periodo veloce.' },
      allocationPct: ALLOCATION_IT,
    },
  },
  'macd-cross': {
    name: 'Incrocio MACD',
    description: "Apre una posizione long quando la linea MACD incrocia al rialzo la linea di segnale e passa alla liquidità con l'incrocio opposto.",
    params: {
      fastPeriod: { label: 'EMA veloce', description: 'Periodo della media mobile esponenziale veloce.' },
      slowPeriod: { label: 'EMA lenta', description: "Periodo dell'EMA lenta. Deve superare il periodo veloce." },
      signalPeriod: { label: 'EMA di segnale', description: "Periodo dell'EMA applicata alla linea MACD." },
      belowZeroOnly: { label: 'Solo sotto lo zero', description: 'Considera solo gli incroci rialzisti che avvengono con la linea MACD sotto lo zero.' },
      allocationPct: ALLOCATION_IT,
    },
  },
  'donchian-breakout': {
    name: 'Breakout di Donchian',
    description: 'Acquista sulla chiusura sopra il massimo delle ultime N barre ed esce sulla chiusura sotto il minimo delle ultime M barre (trend following stile Turtle).',
    params: {
      entryPeriod: { label: 'Canale di ingresso', description: 'Acquista sulla chiusura sopra il massimo di questo numero di barre precedenti.' },
      exitPeriod: { label: 'Canale di uscita', description: 'Vende sulla chiusura sotto il minimo di questo numero di barre precedenti.' },
      allocationPct: ALLOCATION_IT,
    },
  },
  momentum: {
    name: 'Momentum assoluto',
    description: 'Mantiene il titolo finché il rendimento sul periodo di osservazione supera una soglia e resta in liquidità altrimenti.',
    params: {
      lookback: { label: 'Periodo di osservazione', description: 'Barre su cui si misura il rendimento (126 barre giornaliere sono circa sei mesi).' },
      thresholdPct: { label: 'Soglia', description: 'Rendimento minimo sul periodo richiesto per mantenere il titolo.' },
      allocationPct: ALLOCATION_IT,
    },
  },
  'rsi-reversion': {
    name: 'Ritorno alla media RSI',
    description: "Acquista quando l'RSI chiude sotto un livello di ipervenduto e passa alla liquidità quando risale sopra un livello di uscita.",
    params: {
      rsiPeriod: { label: 'Periodo RSI', description: 'Periodo del Relative Strength Index (smussamento di Wilder).' },
      entryLevel: { label: 'Livello di ipervenduto', description: "Acquista quando l'RSI chiude sotto questo livello." },
      exitLevel: { label: 'Livello di uscita', description: "Vende quando l'RSI chiude sopra questo livello. Deve superare il livello di ipervenduto." },
      allocationPct: ALLOCATION_IT,
    },
  },
  'bollinger-reversion': {
    name: 'Ritorno alla media Bollinger',
    description: 'Acquista su una chiusura sotto la banda di Bollinger inferiore e vende quando il prezzo torna alla banda centrale (o a quella superiore).',
    params: {
      period: { label: 'Periodo bande', description: 'Periodo della media mobile e della deviazione standard.' },
      stdDev: { label: 'Ampiezza bande', description: 'Numero di deviazioni standard tra la banda centrale e quelle esterne.' },
      exitAtUpper: { label: 'Uscita sulla banda superiore', description: 'Mantiene la posizione fino alla banda superiore invece di uscire su quella centrale.' },
      allocationPct: ALLOCATION_IT,
    },
  },
  dca: {
    name: 'Piano di accumulo (PAC)',
    description: 'Investe una quota fissa del capitale iniziale a intervalli regolari finché resta liquidità, senza mai vendere.',
    params: {
      intervalBars: { label: 'Intervallo', description: 'Barre tra un acquisto e il successivo (21 barre giornaliere sono circa un mese).' },
      amountPct: { label: 'Importo', description: 'Importo di ogni acquisto in percentuale del capitale iniziale.' },
    },
  },
};

const MESSAGES: Record<Lang, Messages> = { en, it };

export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

export interface I18n {
  lang: Lang;
  setLang: (lang: Lang) => void;
  locale: string;
  t: Translate;
  timeframe: (tf: Timeframe) => string;
  strategyName: (def: StrategyDefinition) => string;
  strategyDescription: (def: StrategyDefinition) => string;
  paramLabel: (strategyId: string, spec: ParamSpec) => string;
  paramDescription: (strategyId: string, spec: ParamSpec) => string;
  /** Translates a validation message produced by the strategy layer; unknown messages pass through. */
  validationMessage: (def: StrategyDefinition, message: string) => string;
}

/** Builds the translator for a language. Exported for unit testing. */
export function createI18n(lang: Lang, setLang: (lang: Lang) => void = () => {}): I18n {
  const messages = MESSAGES[lang];
  const t: Translate = (key, vars) => interpolate(messages[key], vars);
  const strategyText = (id: string): StrategyText | undefined => (lang === 'it' ? STRATEGIES_IT[id] : undefined);
  const paramLabel = (strategyId: string, spec: ParamSpec): string => strategyText(strategyId)?.params[spec.key]?.label ?? spec.label;

  const validationMessage = (def: StrategyDefinition, message: string): string => {
    if (lang === 'en') return message;
    const exact = EXACT_ERRORS.find((key) => en[key] === message);
    if (exact) return t(exact);
    const label = (english: string): string => {
      const spec = def.params.find((p) => p.label === english);
      return spec ? paramLabel(def.id, spec) : english;
    };
    let m = /^(.+) must be between (.+) and (.+)\.$/.exec(message);
    if (m) return t('err.range', { label: label(m[1]), min: m[2], max: m[3] });
    m = /^(.+) must be a whole number\.$/.exec(message);
    if (m) return t('err.integer', { label: label(m[1]) });
    m = /^(.+) must be a number\.$/.exec(message);
    if (m) return t('err.number', { label: label(m[1]) });
    m = /^(.+) must be true or false\.$/.exec(message);
    if (m) return t('err.boolean', { label: label(m[1]) });
    return message;
  };

  return {
    lang,
    setLang,
    locale: LOCALES[lang],
    t,
    timeframe: (tf) => t(`tf.${tf}`),
    strategyName: (def) => strategyText(def.id)?.name ?? def.name,
    strategyDescription: (def) => strategyText(def.id)?.description ?? def.description,
    paramLabel,
    paramDescription: (strategyId, spec) => strategyText(strategyId)?.params[spec.key]?.description ?? spec.description,
    validationMessage,
  };
}

function browserLang(): Lang {
  try {
    return navigator.language.toLowerCase().startsWith('it') ? 'it' : 'en';
  } catch {
    return 'en';
  }
}

const I18nContext = createContext<I18n>(createI18n('en'));

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = usePersistentState<Lang>('ui.lang', browserLang(), isOneOf(LANGS.map((l) => l.value)));
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  const value = useMemo(() => createI18n(lang, setLang), [lang, setLang]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  return useContext(I18nContext);
}
