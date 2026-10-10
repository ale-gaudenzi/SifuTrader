# SifuTrader

A zero-backend financial charting and backtesting web app. Data parsing, indicators, simulation and metrics all run in the browser; the build is a folder of static files served by a Cloudflare Worker behind Cloudflare Access, so the site is private.

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
- Configurable capital, commission and slippage, and a date range to test only part of the loaded history (the run starts with fresh capital on the first bar of the range, as if the data began there).
- Metrics: final equity, total and buy-and-hold return, max drawdown, win rate, trades, CAGR, Sharpe, profit factor, exposure, fees.
- Equity curve against buy and hold with a drawdown pane; sortable, paginated trade log with CSV export.
- Results recompute on every change of data, timeframe or parameters.

**Strategy Builder** (separate view, `Strategy Builder` in the header or `#builder` in the URL)
- Build long-only strategies without code from entry, scale-in and exit rules, each a group of conditions combined with AND/OR (one level of nesting).
- Conditions compare prices, 41 indicators (moving averages, oscillators, bands and channels, volatility, trend, volume) or open-position values (P&L, bars held, entry price...), with crosses, rising/falling, candlestick patterns, calendar events, past values ("N bars ago"), percentage offsets and "on each / at least once in the last N bars".
- Orders at market, limit or stop (e.g. breakout entries), sized as a share of cash, equity or initial capital or as a fixed amount; partial exits; adds with a size multiplier.
- Risk management: stop loss, take profit and trailing stop in percent or ATR multiples, break-even stop, maximum holding time, cooldown after an exit.
- Every edit reruns the backtest; a plain-language summary and the number of bars on which each rule fires catch rules that never trigger. Templates reproduce the built-in strategies.
- Strategies are saved in the browser, appear in the Backtest strategy list, and can be exported, imported as JSON or shared as a link that carries the strategy in the URL fragment.

**Fundamentals** (separate view, `Fundamentals` in the header or `#fundamentals` in the URL)
- For the watchlist stocks: daily market cap and enterprise value, and the history of P/E, EV/EBITDA, P/S, P/B, dividend yield and FCF yield.
- Revenue, gross profit, operating income, EBITDA, net income, free cash flow and EPS by fiscal year or quarter, plus a table of the annual statements with margins and debt/equity.
- Loaded on demand as a separate chunk; the backtester is unchanged.

**Interface**
- English and Italian UI (EN / IT toggle). The choice is saved; the first visit follows the browser language.

## Quick start

Requires Node.js 22.12 or newer.

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests (Vitest)
npm run build      # type-check and build into dist/
npm run preview    # build and serve dist/ with the local Workers runtime
npm run deploy     # build and deploy to Cloudflare (needs `npx wrangler login`)
npm run history    # download the watchlist snapshot into public/history/ (needed to fetch Yahoo symbols locally)
npm run fundamentals  # download the fundamentals snapshot into public/fundamentals/ (needed for the Fundamentals view locally)
```

## Project structure

```text
.github/workflows/deploy.yml   Test, build and deploy to Cloudflare
wrangler.jsonc                 Cloudflare Worker serving the build
data/watchlist.json            Symbols included in the history snapshot
scripts/build-history.mjs      Downloads the history snapshot (server-side)
scripts/build-fundamentals.mjs Downloads the fundamentals snapshot (server-side)
public/sample_data/            Bundled OHLCV CSV files and their index.json
public/history/                Generated history snapshot (git-ignored)
public/fundamentals/           Generated fundamentals snapshot (git-ignored)
src/
  engine/                      Domain types, backtester, indicators, metrics (pure TS)
  strategies/                  BaseStrategy, strategy implementations, registry
  strategies/rules/            Strategy-builder specs: types, indicator catalog, validation, compiler, templates
  data/                        CSV parsing, data providers, fundamentals and valuation
  components/                  Charts, data input, strategy panel, metrics, trade log
  components/fundamentals/     Fundamentals view
  components/builder/          Strategy Builder view
  hooks/                       localStorage preferences, URL-fragment view
  i18n.tsx                     English / Italian strings and language provider
  App.tsx, main.tsx
```

## Execution model

The simulator is deterministic and long-only, trades a single instrument and allows fractional units.

1. When bar `i` closes, the strategy receives a context that can only reach bars `0..i` (`history.at(j)` throws for `j > i`) and returns a list of orders.
2. Orders are live for bar `i + 1` only, then expire.
   - **Market** orders fill at the next open, adjusted by slippage.
   - **Limit buy** orders fill at the open if the market gaps through the limit, otherwise at the limit price if the bar's low reaches it. Limit sells mirror this using the high. Limit fills have no slippage.
   - **Stop sell** orders (stop-losses) fill at the open if the market gaps below the stop, otherwise at the stop price if the bar's low reaches it. Stop buys (breakout entries) mirror this using the high. A triggered stop becomes a market order, so its fill pays slippage.
3. Multiple orders triggered in the same bar execute in the order of an assumed intrabar path: open, low, high, close on up bars; open, high, low, close on down bars. A stop and a take-profit in the same bar therefore resolve by which price the path reaches first.
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

### Strategy Builder

A builder strategy is a JSON spec (`src/strategies/rules/spec.ts`) compiled into an ordinary `Strategy` (`compile.ts`), so it runs through the same engine and execution model. Operands only look back and every indicator is causal, so no spec can see future bars; the tests check this with the truncation test and check that the templates trade exactly like the hand-written strategies.

On each bar close a flat strategy submits its entry order if the cooldown has elapsed and the entry conditions hold (no conditions means "buy whenever flat"). With a position open it submits, in order: exit rules whose conditions hold, the time exit, one protective stop (the highest of stop loss, trailing stop and break-even), the take-profit, and a scale-in when its conditions hold. Risk levels refer to the average entry price and apply from the bar after the first entry fill; the trailing stop follows the entry price, the entry bar's close and the highs of later bars. ATR-based stop loss and take profit use the ATR at the bar that triggered the entry; the ATR trailing stop uses the current ATR. Open-position values have no history, so they cannot be used in crosses, trends, "last N bars" checks or as indicator inputs.

To add an indicator: implement it causally in `src/engine/indicators.ts`, add its name to `INDICATORS` in `spec.ts` and its entry to `INDICATOR_INFO` in `catalog.ts`, then add `rb.ind.*` and `rb.short.*` texts in both languages (the `Messages` type enforces them).

## Data sources

Only sources that work from a static site, with no proxy, key or local storage:

1. **Site snapshot (Yahoo Finance).** Yahoo sends no CORS headers, so the browser cannot call it. Instead, `scripts/build-history.mjs` downloads the full daily history of every symbol in `data/watchlist.json` server-side, during the GitHub Actions deploy (on every push and every weekday at 22:30 UTC), and publishes it as static JSON under `history/`. The browser reads it same-origin. To add a symbol, add its Yahoo ticker to the list and push. Locally, run `npm run history` once to populate `public/history/`.
2. **Binance** (`data-api.binance.vision`): public, keyless and CORS-enabled, so any listed crypto pair (`BTC-USD`, `DOGE-USD`, `ETHBTC`, ...) is fetched live. History starts in 2017.
3. **Bundled samples**: if the selected sources fail, the bundled sample for the symbol is shown with a notice.
4. **Fundamentals snapshot (Yahoo Finance).** `scripts/build-fundamentals.mjs` downloads, in the same deploy, the statements of the watchlist symbols from Yahoo's fundamentals-timeseries API and publishes them under `fundamentals/`. Symbols without statements (ETFs, indices, FX, futures, crypto) are skipped. Yahoo serves about four fiscal years and the last five quarters, so the valuation history covers roughly four years. The browser combines each daily close with the latest trailing-twelve-month figures and balance sheet; figures are dated at the end of their fiscal period, not at publication, and older than 400 days count as missing. Ratios are not computed when the shares trade in a different currency from the statements. These values are descriptive and never reach the backtester.

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

The build is served by a Cloudflare Worker with static assets (`wrangler.jsonc`) and kept private with Cloudflare Access. Both are free at this scale. One-time setup:

1. `npx wrangler login`, then `npm run deploy` once to create the Worker. It is served at `sifutrader.<account>.workers.dev`; per-version preview URLs are disabled in `wrangler.jsonc`.
2. In the Cloudflare dashboard, open the Worker, go to **Settings > Domains & Routes**, and enable **Cloudflare Access** on the `workers.dev` route. Then, in **Zero Trust > Access > Applications**, restrict the generated application's policy to your own email.
3. Create an API token from the **Edit Cloudflare Workers** template and add it to the GitHub repository secrets as `CLOUDFLARE_API_TOKEN`, together with `CLOUDFLARE_ACCOUNT_ID`.

`.github/workflows/deploy.yml` runs on every push to `main`, on weekdays at 22:30 UTC (to refresh the snapshot) and on demand. It installs dependencies, runs the tests, downloads the history and fundamentals snapshots (a failure there does not block the deploy), builds, and deploys with `wrangler deploy`.

`vite.config.ts` sets `base: './'`, so the same build works at a domain root or from any sub-path. There is no client-side router, so no 404 fallback is needed.

## Limitations

- Long-only, single instrument. No shorting, leverage, margin or dividends. The Strategy Builder has the same limits and does not use fundamentals.
- The intrabar path is a heuristic: daily bars cannot show whether the high or the low came first.
- Yahoo daily prices are split-adjusted but not dividend-adjusted, so buy-and-hold returns on dividend payers are understated.
- Sharpe uses simple per-bar returns, a zero risk-free rate and an annualization factor inferred from bar spacing.

## License

[MIT](LICENSE)
