# SifuTrader

A zero-backend financial charting and backtesting single page application. Everything (data parsing, indicator computation, simulation, metrics) runs in the browser, and the build output is a folder of static files that GitHub Pages can host.

Built with React 19, TypeScript (strict), Vite, Tailwind CSS 4, TradingView Lightweight Charts 5 and PapaParse.

## Features

**Market data**
- Bundled 5-year daily samples (AAPL, MSFT, NVDA, SPY, BTC-USD, ETH-USD) load on startup, so the app works offline and needs no API keys.
- **Local history database (IndexedDB)**: every ticker you fetch, and every CSV you upload, is saved in the browser with its full history.
  - Repeat fetches within an hour open instantly from the database, with no network request.
  - Later fetches download only the bars after the last saved one, plus a short overlap, and merge them. If the overlap shows that past prices were re-adjusted (a split), the whole history is downloaded again.
  - If the network fails, the saved copy is shown with a notice, so a ticker fetched once keeps working offline.
  - The **Saved tickers** list opens, updates (one or all), exports to CSV and deletes saved histories.
- **History snapshot**: a build step downloads the full daily history of every symbol in `data/watchlist.json` and publishes it with the site under `history/`. The app reads it from the same origin, so these tickers load reliably with no CORS proxy. The deploy workflow refreshes it every weekday after the US close.
- Online fetch:
  - Yahoo Finance chart API. Covers equities, ETFs, indices (`^GSPC`), FX (`EURUSD=X`) and crypto. Sources, in order: the local proxy of `npm run dev` / `npm run preview`, your custom CORS proxy, the history snapshot, then public CORS proxies.
  - Binance public market data for crypto pairs. No key needed, and it allows cross-origin requests.
  - Alpha Vantage with your own free API key, for equities.
  - `Auto` sends crypto symbols to Binance and everything else to Yahoo. If every network source fails, it loads the bundled sample for that symbol and shows a notice.
- CSV drag-and-drop:
  - Recognizes header aliases case-insensitively and detects the delimiter (comma, semicolon or tab).
  - Accepts these date formats: ISO, `MM/DD/YYYY` vs `DD/MM/YYYY` (decided per file), `DD.MM.YYYY`, `YYYYMMDD`, and epoch seconds or milliseconds.
  - Strips currency symbols and thousands separators from numbers.
  - Sorts rows by date, merges duplicate dates, repairs inconsistent candles, and reports every row it skips.

**Chart**
- Candlesticks with a resizable volume sub-pane.
- 1D / 1W / 1M timeframes, aggregated client-side (ISO weeks, calendar months).
- Toggleable overlays: SMA 20, SMA 50, EMA (configurable period) and Bollinger Bands (20, 2).
- Crosshair with a floating OHLCV tooltip and a legend that follows the cursor. Zoom, pan, log scale and fit-to-content.
- Buy and sell markers for every backtest execution.

**Backtesting**
- Pluggable strategy interface. Each strategy's parameter form is generated from its declarative parameter schema.
- Martingale dip-buying strategy and dual SMA crossover strategy.
- Configurable capital, commission and slippage.
- Metrics: final equity, total return, buy and hold return, max drawdown, win rate, closed trades, CAGR, Sharpe, profit factor, exposure and fees.
- Equity curve against the buy and hold benchmark, with a drawdown sub-pane.
- Sortable, paginated trade log with CSV export.
- Results recompute automatically when the data, timeframe or any parameter changes.

**Interface**

- English and Italian UI, switchable from the EN / IT toggle in the header. The choice is saved in the browser; the first visit follows the browser language.

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests (Vitest)
npm run history    # download the watchlist history snapshot into public/history/ (optional)
npm run build      # type-check and emit static files to dist/
npm run preview    # serve dist/ locally
```

Node.js 20 or newer is required (CI uses Node 22).

## Project structure

```text
.github/workflows/deploy.yml   Build, test and deploy to GitHub Pages on push to main and every weekday
data/watchlist.json            Symbols included in the history snapshot
scripts/build-history.mjs      Downloads the history snapshot (Yahoo, server-side)
public/sample_data/            Bundled OHLCV CSV files and index.json manifest
public/history/                Generated history snapshot (git-ignored)
src/
  components/
    Chart.tsx                  Price chart, overlays, markers, tooltip
    EquityChart.tsx            Strategy vs buy-and-hold equity and drawdown
    DataInput.tsx              Samples, ticker fetch, CSV upload
    SavedTickers.tsx           Saved tickers list (open, update, export, delete)
    StrategyPanel.tsx          Strategy picker and schema-driven parameter form
    Metrics.tsx                KPI summary cards
    TradeTable.tsx             Trade log
    chartOptions.ts            Shared Lightweight Charts theme
  data/
    csv.ts                     PapaParse-based CSV parsing and validation
    providers.ts               Yahoo / snapshot / Binance / Alpha Vantage / sample loaders
    store.ts                   IndexedDB database of saved histories
    history.ts                 Cache-first loading, incremental updates, offline fallback
  engine/
    types.ts                   Bar, Order, Fill, Trade, Strategy, BacktestResult
    backtester.ts              Bar-by-bar portfolio simulator
    indicators.ts              SMA, EMA, Bollinger, crossovers, resampling
    metrics.ts                 Drawdown, Sharpe, CAGR and summary statistics
  strategies/
    base.ts                    BaseStrategy class and parameter helpers
    martingale.ts              Martingale dip-buying
    smaCross.ts                Dual SMA crossover
    index.ts                   Strategy registry
  hooks/usePersistentState.ts  localStorage-backed preferences
  hooks/useSavedSeries.ts      Live list of the saved histories
  i18n.tsx                     English / Italian UI strings and language provider
  App.tsx, main.tsx
```

## Execution model

The simulator is deterministic and long-only. It trades a single instrument and allows fractional units.

1. When bar `i` closes, the strategy receives a `StrategyContext` that can only reach bars `0..i`. `history.at(j)` throws for `j > i`. The strategy returns a list of orders.
2. Those orders are live for bar `i + 1` only, then they expire.
   - **Market** orders fill at the next open, adjusted by slippage.
   - **Limit buy** orders fill at the open if the market gaps through the limit. Otherwise they fill at the limit price if the bar's low reaches it. Limit sells mirror this using the high. Limit fills have no slippage.
3. If several orders trigger in the same bar, they execute in the order an assumed intrabar path reaches their prices:
   - up bars: open, low, high, close
   - down bars: open, high, low, close
4. Commission is charged on the notional of every fill. Buy orders are sized in cash, never exceed available cash, and include the commission.
5. The portfolio is marked to market at every close. A position still open at the end appears as an `Open` trade, valued at the last close. Open trades are excluded from win rate and trade count.
6. The buy and hold benchmark invests the initial capital at the first bar's close and pays no fees.

A decision based on bar `i` can only execute on bar `i + 1`, so the simulation has no lookahead bias. The test suite checks this directly: running on a truncated history must reproduce the full run's fills and equity curve up to the truncation point.

## Strategies

### Martingale (dip-buying variant)

| Parameter | Default | Meaning |
|---|---|---|
| Base Order | 3% | First buy of a cycle, as a percentage of equity (or of initial capital when Compound is off) |
| Drop Step | 2% | Decline from the last buy that triggers the next buy |
| Size Multiplier | 2.0x | Each scale-in is this multiple of the previous order |
| Max Steps | 5 | Maximum buys per cycle, including the base order |
| Take Profit | 3% | Gain over average cost (including entry fees) that sells the whole position |
| Compound | on | Size base orders from current equity |

There is deliberately no stop-loss. Once `Max Steps` buys have filled, the strategy holds until the take-profit. This shows the strategy's tail risk in the drawdown figures: the win rate is often 100% while drawdowns stay deep.

### Dual SMA crossover

| Parameter | Default | Meaning |
|---|---|---|
| Fast SMA | 20 | Fast moving-average period |
| Slow SMA | 50 | Slow moving-average period (must be greater than fast) |
| Allocation | 100% | Share of cash invested on each long signal |

The strategy goes long at the next open after the fast SMA closes above the slow SMA, and exits after the opposite cross.

### Adding a strategy

1. Create `src/strategies/myStrategy.ts`. Extend `BaseStrategy` and implement `onBar(ctx)`, which returns `Order[]`. Use `init(bars)` to pre-compute indicators; they must be causal.
2. Export a `StrategyDefinition` with an `id`, a `name`, a `params` schema, a `validate` function and a `create` factory.
3. Add it to the `STRATEGIES` array in `src/strategies/index.ts`. The UI renders its parameter form automatically.
4. Optionally add Italian texts for its name, description and parameters to `STRATEGIES_IT` in `src/i18n.tsx`. Without them the English texts are shown.

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

## Data sources and CORS

Static sites cannot attach custom headers, and Yahoo Finance does not send CORS headers. The app therefore reaches Yahoo in one of these ways:

1. **Local proxy.** When the app runs on `localhost` (`npm run dev` or `npm run preview`), the Vite server forwards `/yahoo/...` to Yahoo. Any symbol works.
2. **Custom proxy**, if one is configured (see below).
3. **History snapshot.** Symbols listed in `data/watchlist.json` are downloaded server-side at build time and served as static files. To add a ticker, add its Yahoo symbol to the list and push; the next deploy includes it. Without a private proxy, the snapshot is tried before the public proxies.
4. **Public proxies** (allorigins, corsproxy.io, codetabs), raced in parallel. These are rate-limited and often down; corsproxy.io now requires an API key. When all of them fail, the app falls back to the saved copy in the local database, or to the bundled sample.

Requests use an explicit `period1`/`period2` window, because Yahoo silently returns monthly or quarterly bars for `range=max`.

For reliable Yahoo access, deploy your own proxy and enter it under **Connection settings > Custom CORS proxy** as a template such as `https://your-worker.workers.dev/?url={url}`. A minimal Cloudflare Worker:

```js
export default {
  async fetch(request) {
    const target = new URL(request.url).searchParams.get('url');
    if (!target || !target.startsWith('https://query2.finance.yahoo.com/')) {
      return new Response('Forbidden', { status: 403 });
    }
    const upstream = await fetch(target, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const response = new Response(upstream.body, upstream);
    response.headers.set('Access-Control-Allow-Origin', '*');
    return response;
  },
};
```

Binance (`data-api.binance.vision`) and Alpha Vantage allow cross-origin requests and are called directly. The Alpha Vantage key and the proxy template are stored only in your browser's `localStorage`. Saved histories live in the browser's IndexedDB (database `backtest-terminal`) and never leave the device.

### CSV format

The minimum is a date column and a close column. Typical input:

```csv
Date,Open,High,Low,Close,Volume
2024-01-02,187.15,188.44,183.89,185.64,82488700
```

Exports from Yahoo Finance, Nasdaq.com (`Close/Last`, `$` prefixes, `MM/DD/YYYY`), Stooq, TradingView and most brokers parse without changes. If the file has no OHLC columns, candles are built from the close price. If it has no volume column, volume is set to 0.

## Deployment to GitHub Pages

1. Push the repository to GitHub with `main` as the default branch.
2. In **Settings > Pages > Build and deployment**, set **Source** to **GitHub Actions**.
3. Every push to `main`, and a schedule at 22:30 UTC on weekdays, runs `.github/workflows/deploy.yml`. The workflow:
   1. installs dependencies with `npm ci`
   2. runs the unit tests
   3. downloads the history snapshot (`npm run history`). A failure here does not block the deploy.
   4. type-checks and builds
   5. publishes `dist/` with `actions/deploy-pages@v4`

`vite.config.ts` sets `base: './'`, so every asset URL is relative. The same build therefore works at `https://<user>.github.io/<repo>/`, at a custom domain root, or from any sub-path, with no repository name hard-coded. The app has no client-side router, so no 404 fallback is needed.

## Refreshing the bundled samples

The sample CSVs are split-adjusted daily bars from the Yahoo Finance chart API. To refresh one, download it, convert it to the `Date,Open,High,Low,Close,Volume` format, and overwrite the file in `public/sample_data/`. To add a symbol, also add it to `public/sample_data/index.json`.

## Limitations

- Long-only, single-instrument portfolio. No shorting, leverage, margin calls or dividends.
- The intrabar path assumption is a heuristic. Daily bars cannot show the true order of the high and the low.
- Yahoo daily prices are split-adjusted but not dividend-adjusted, so buy and hold returns on dividend payers are understated.
- Sharpe uses simple per-bar returns, a zero risk-free rate, and an annualization factor inferred from bar spacing.

## Disclaimer

This software is for research and education. Historical simulations do not predict future results, and nothing here is investment advice.
