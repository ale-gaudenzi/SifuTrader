# SifuTrader

A zero-backend financial charting and backtesting web app. Data parsing, indicators, simulation and metrics all run in the browser; the build is a folder of static files hosted on GitHub Pages.

Built with React 19, TypeScript, Vite, Tailwind CSS 4, [Lightweight Charts](https://github.com/tradingview/lightweight-charts) 5 and PapaParse.

> For research and education only. Historical simulations do not predict future results, and nothing here is investment advice.

## Features

**Market data**
- Bundled 5-year daily samples (AAPL, MSFT, NVDA, SPY, BTC-USD, ETH-USD): the app works offline with no API keys.
- Online fetch, with no proxy and no API key: Yahoo Finance history for the symbols in `data/watchlist.json` (equities, ETFs, indices, FX, futures, crypto), published with the site as a static snapshot, and any crypto pair live from Binance.
- CSV drag-and-drop with header aliases, delimiter and date-format detection, number cleanup, duplicate merging and a report of skipped rows.
- Nothing is stored: market data is downloaded on every fetch and kept only in memory.

**Chart**
- Candlesticks with a resizable volume pane, 1D / 1W / 1M timeframes aggregated client-side.
- Overlays: SMA 20, SMA 50, EMA (configurable) and Bollinger Bands (20, 2).
- OHLCV tooltip, cursor legend, zoom, pan, log scale, and buy/sell markers for every backtest fill.

**Backtesting**
- Pluggable strategies with parameter forms generated from a declarative schema. Included: Martingale dip-buying, dual SMA crossover, MACD crossover, Donchian breakout, time-series momentum, RSI and Bollinger Band mean reversion, and dollar-cost averaging.
- Configurable capital, commission and slippage.
- Metrics: final equity, total and buy-and-hold return, max drawdown, win rate, trades, CAGR, Sharpe, profit factor, exposure, fees.
- Equity curve against buy and hold with a drawdown pane; sortable, paginated trade log with CSV export.
- Results recompute on every change of data, timeframe or parameters.

**Interface**
- English and Italian UI (EN / IT toggle). The choice is saved; the first visit follows the browser language.

## Quick start

Requires Node.js 22.12 or newer.

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests (Vitest)
npm run build      # type-check and build into dist/
npm run preview    # serve dist/ locally
npm run history    # download the watchlist snapshot into public/history/ (needed to fetch Yahoo symbols locally)
```

## Project structure

```text
.github/workflows/deploy.yml   Test, build and deploy to GitHub Pages
data/watchlist.json            Symbols included in the history snapshot
scripts/build-history.mjs      Downloads the history snapshot (server-side)
public/sample_data/            Bundled OHLCV CSV files and their index.json
public/history/                Generated history snapshot (git-ignored)
src/
  engine/                      Domain types, backtester, indicators, metrics (pure TS)
  strategies/                  BaseStrategy, strategy implementations, registry
  data/                        CSV parsing, data providers
  components/                  Charts, data input, strategy panel, metrics, trade log
  hooks/                       localStorage preferences
  i18n.tsx                     English / Italian strings and language provider
  App.tsx, main.tsx
```

## Execution model

The simulator is deterministic and long-only, trades a single instrument and allows fractional units.

1. When bar `i` closes, the strategy receives a context that can only reach bars `0..i` (`history.at(j)` throws for `j > i`) and returns a list of orders.
2. Orders are live for bar `i + 1` only, then expire.
   - **Market** orders fill at the next open, adjusted by slippage.
   - **Limit buy** orders fill at the open if the market gaps through the limit, otherwise at the limit price if the bar's low reaches it. Limit sells mirror this using the high. Limit fills have no slippage.
3. Multiple orders triggered in the same bar execute in the order of an assumed intrabar path: open, low, high, close on up bars; open, high, low, close on down bars.
4. Commission is charged on the notional of every fill. Buys are sized in cash, include the commission, and never exceed available cash.
5. The portfolio is marked to market at every close. A position still open at the end appears as an `Open` trade valued at the last close, and is excluded from win rate and trade count.
6. The buy-and-hold benchmark invests the initial capital at the first bar's close with no fees.

There is no lookahead bias: the test suite checks that a run on a truncated history reproduces the full run's fills and equity up to the cut.

## Strategies

### Martingale (dip-buying)

| Parameter | Default | Meaning |
|---|---|---|
| Base Order | 3% | First buy of a cycle, as a percentage of equity (or of initial capital when Compound is off) |
| Drop Step | 2% | Decline from the last buy that triggers the next buy |
| Size Multiplier | 2.0x | Each scale-in is this multiple of the previous order |
| Max Steps | 5 | Maximum buys per cycle, including the base order |
| Take Profit | 3% | Gain over average cost (including entry fees) that sells the whole position |
| Compound | on | Size base orders from current equity |

There is deliberately no stop-loss: after `Max Steps` buys the strategy holds until the take-profit. The drawdown figures expose the tail risk; the win rate is often 100% while drawdowns stay deep.

### Dual SMA crossover

| Parameter | Default | Meaning |
|---|---|---|
| Fast SMA | 20 | Fast moving-average period |
| Slow SMA | 50 | Slow moving-average period (must be greater than fast) |
| Allocation | 100% | Share of cash invested on each long signal |

Goes long at the next open after the fast SMA closes above the slow SMA, and exits after the opposite cross.

All the signal strategies below are long-only and all-in/all-out: they evaluate on the bar close, trade at the next open, and invest `Allocation` (default 100%) of the available cash on each entry.

### MACD crossover

| Parameter | Default | Meaning |
|---|---|---|
| Fast EMA / Slow EMA | 12 / 26 | EMAs whose difference is the MACD line (fast must be shorter) |
| Signal EMA | 9 | EMA of the MACD line |
| Below Zero Only | off | Only take bullish crosses while the MACD line is below zero |

Buys after the MACD line crosses above the signal line, sells after the opposite cross.

### Donchian breakout

| Parameter | Default | Meaning |
|---|---|---|
| Entry Channel | 20 | Buy on a close above the highest high of the previous N bars |
| Exit Channel | 10 | Sell on a close below the lowest low of the previous N bars |

Turtle-style trend following. The current bar is excluded from the channel it has to break.

### Time-series momentum

| Parameter | Default | Meaning |
|---|---|---|
| Lookback | 126 | Bars over which the return is measured (about six months of daily bars) |
| Threshold | 0% | Minimum lookback return required to hold |

A regime filter: holds while the lookback return is above the threshold and stays in cash otherwise.

### RSI mean reversion

| Parameter | Default | Meaning |
|---|---|---|
| RSI Period | 14 | Wilder RSI lookback |
| Oversold Level | 30 | Buy when the RSI closes below it |
| Exit Level | 55 | Sell when the RSI closes above it (must exceed the oversold level) |

### Bollinger Band reversion

| Parameter | Default | Meaning |
|---|---|---|
| Band Period | 20 | Moving-average and standard-deviation window |
| Band Width | 2.0x | Standard deviations to the outer bands |
| Exit at Upper Band | off | Hold until the upper band instead of the middle band |

Buys a close below the lower band and sells when price reverts to the middle (or upper) band. Neither mean-reversion strategy has a stop-loss.

### Dollar-cost averaging

| Parameter | Default | Meaning |
|---|---|---|
| Interval | 21 | Bars between purchases (about monthly on daily bars) |
| Amount | 2% | Each purchase as a percentage of the initial capital |

Buys on schedule from the first bar until the cash runs out and never sells, so the result is one open position. Useful as a comparison with lump-sum buy and hold.

### Adding a strategy

1. Create `src/strategies/myStrategy.ts`, extend `BaseStrategy` and implement `onBar(ctx)`, returning `Order[]`. Pre-compute indicators in `init(bars)`; they must be causal.
2. Export a `StrategyDefinition` with `id`, `name`, `params` schema, `validate` and `create`.
3. Add it to `STRATEGIES` in `src/strategies/index.ts`. The UI renders its parameter form automatically.
4. Add Italian texts for its name, description and parameters to `STRATEGIES_IT` in `src/i18n.tsx` (enforced by the tests).

```ts
export class MyStrategy extends BaseStrategy<MyParams> {
  readonly id = 'my-strategy';
  readonly name = 'My Strategy';
  onBar(ctx: StrategyContext): Order[] {
    if (this.isFlat(ctx) && ctx.bar.close > ctx.history.ago(1).close) return [this.marketBuy(ctx.cash)];
    return [];
  }
}
```

## Data sources

Only sources that work from a static site, with no proxy, key or local storage:

1. **Site snapshot (Yahoo Finance).** Yahoo sends no CORS headers, so the browser cannot call it. Instead, `scripts/build-history.mjs` downloads the full daily history of every symbol in `data/watchlist.json` server-side, during the GitHub Actions deploy (on every push and every weekday at 22:30 UTC), and publishes it as static JSON under `history/`. The browser reads it same-origin. To add a symbol, add its Yahoo ticker to the list and push. Locally, run `npm run history` once to populate `public/history/`.
2. **Binance** (`data-api.binance.vision`): public, keyless and CORS-enabled, so any listed crypto pair (`BTC-USD`, `DOGE-USD`, `ETHBTC`, ...) is fetched live. History starts in 2017.
3. **Bundled samples**: if the selected sources fail, the bundled sample for the symbol is shown with a notice.

`Auto` tries the snapshot first and, for crypto symbols, falls back to Binance. Data is daily; weekly and monthly bars are aggregated in the browser. Nothing is saved: each fetch downloads the data again, and only the UI preferences (language, strategy parameters, chart settings) are kept in `localStorage`. Nothing leaves the device except the requests to the site and to Binance.

### CSV format

The minimum is a date column and a close column:

```csv
Date,Open,High,Low,Close,Volume
2024-01-02,187.15,188.44,183.89,185.64,82488700
```

Exports from Yahoo Finance, Nasdaq.com, Stooq, TradingView and most brokers parse unchanged. Supported dates: ISO, `MM/DD/YYYY` or `DD/MM/YYYY` (detected per file), `DD.MM.YYYY`, `YYYYMMDD`, epoch seconds or milliseconds. Without OHLC columns, candles are built from the close; without volume, volume is 0.

### Bundled samples

The sample CSVs in `public/sample_data/` are split-adjusted daily bars from Yahoo Finance in `Date,Open,High,Low,Close,Volume` format. To add a symbol, add its CSV and list it in `public/sample_data/index.json`.

## Deployment

1. Push to GitHub with `main` as the default branch.
2. In **Settings > Pages > Build and deployment**, set **Source** to **GitHub Actions**.

`.github/workflows/deploy.yml` runs on every push to `main`, on weekdays at 22:30 UTC (to refresh the snapshot) and on demand. It installs dependencies, runs the tests, downloads the history snapshot (a failure there does not block the deploy), builds, and publishes `dist/`.

`vite.config.ts` sets `base: './'`, so the same build works at `https://<user>.github.io/<repo>/`, at a custom domain, or from any sub-path. There is no client-side router, so no 404 fallback is needed.

## Limitations

- Long-only, single instrument. No shorting, leverage, margin or dividends.
- The intrabar path is a heuristic: daily bars cannot show whether the high or the low came first.
- Yahoo daily prices are split-adjusted but not dividend-adjusted, so buy-and-hold returns on dividend payers are understated.
- Sharpe uses simple per-bar returns, a zero risk-free rate and an annualization factor inferred from bar spacing.

## License

[MIT](LICENSE)
