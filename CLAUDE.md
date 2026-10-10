# CLAUDE.md

Non aggiungere mai claude come contributore della repository!

Guidance for Claude Code when working in this repository.

## Project

SifuTrader is a zero-backend charting and backtesting SPA: React 19, TypeScript (strict), Vite, Tailwind CSS 4, Lightweight Charts 5, PapaParse. Everything runs in the browser and the build is a folder of static files served by a Cloudflare Worker with static assets (`wrangler.jsonc`), kept private by Cloudflare Access. There is no server, no database, no API keys and no secrets in the repo. Market data is never stored: it is fetched on demand and kept in memory.

## Commands

```bash
npm run dev        # dev server on http://localhost:5173
npm test           # Vitest, all src/**/*.test.ts
npm run typecheck  # tsc -b over app, tests and vite config
npm run build      # typecheck + production build into dist/
npm run deploy     # build + wrangler deploy (CI deploys on push to main)
npm run history    # download the watchlist snapshot into public/history/ (network; needed for Yahoo symbols in dev)
npm run fundamentals  # download the fundamentals snapshot into public/fundamentals/ (network; needed for the Fundamentals view in dev)
```

Node 22.12+ is required (see `.nvmrc`). Before calling a change done, run `npm test` and `npm run build`; both must pass with no TypeScript errors.

## Architecture

Layers, with dependencies pointing only downward:

```text
components/, App.tsx     React UI
hooks/, i18n.tsx         UI state, persistence, localization
data/                    CSV parsing, data providers (snapshot, Binance, samples), fundamentals and valuation
strategies/              Strategy implementations + registry
engine/                  Types, backtester, indicators, metrics (pure TS)
```

- `src/engine/` must stay pure: no React, no DOM, no `fetch`, no `localStorage`. It is deterministic and fully unit-testable in Node.
- Strategies import only from `src/engine/` and `src/strategies/base.ts`.
- `src/engine/types.ts` is the domain contract. Read it before touching the engine or strategies.

## Backtesting invariants (do not break)

- **No lookahead.** A strategy sees bars `0..i` only (`history.at(j)` throws for `j > i`). Orders emitted on bar `i` are live for bar `i + 1` only, then expire. Indicators computed in `init(bars)` must be causal: the value at `i` may use only bars `<= i`.
- **Determinism.** Same input, same output. No `Math.random`, `Date.now` or other hidden state in the engine or strategies.
- **Units.** Time is UTC seconds aligned to 00:00 UTC. Percentages in results are already multiplied by 100 (`12.5` = 12.5%). Buy orders are sized in cash, sells in units or `'all'`.
- The test `engine.test.ts` checks that a truncated history reproduces the full run up to the cut. Any change to execution must keep it green.
- If you change the execution model (fills, slippage, fees, intrabar order, benchmark), update the tests **and** the "Execution model" section of `README.md` in the same change.

## Common tasks

**Adding a strategy**
1. Create `src/strategies/<name>.ts`: extend `BaseStrategy`, implement `onBar`, export a `StrategyDefinition` (`id`, `name`, `params`, `validate`, `create`).
2. Register it in `STRATEGIES` in `src/strategies/index.ts`. The parameter form is generated from `params`.
3. Add Italian texts for its name, description and parameters to `STRATEGIES_IT` in `src/i18n.tsx`. This is required: `i18n.test.ts` fails if a strategy is not translated. Standard validation messages (from `validateParams`) are translated automatically; a custom message needs an `err.*` key and a branch in `validationMessage`.
4. Add engine tests for its entry/exit logic.

**UI strings**: never hard-code user-facing text in components. Add a key to both the `en` and `it` dictionaries in `src/i18n.tsx` and use `t(key, vars)`. The `Messages` type makes a missing Italian key a type error.

**Data providers**: all network code lives in `src/data/providers.ts`. Sources are limited to what works from a static site without a proxy or key: the same-origin history and fundamentals snapshots (`public/history/` and `public/fundamentals/`, built from `data/watchlist.json` by `scripts/build-history.mjs` and `scripts/build-fundamentals.mjs` in CI) and Binance. Nothing is persisted. Every network path falls back to the bundled sample and must never throw unhandled into the UI.

## Conventions

- TypeScript strict, no `any`, no non-null assertions to silence the compiler. `verbatimModuleSyntax` is on: use `import type` for type-only imports.
- Match the surrounding code: short JSDoc on exported functions and types explaining *why*, not *what*. Comments and identifiers in English.
- Tests sit next to the code (`*.test.ts`) and run in Node. Compare floats with `toBeCloseTo`.
- Static assets are loaded via `import.meta.env.BASE_URL` (the build uses `base: './'`). Never use absolute `/path` URLs: they break when the site is served from a sub-path.
- UI preferences live in `localStorage` under the `backtest-terminal:` prefix (`usePersistentState`). Changing the prefix resets users' settings.
- Keep dependencies minimal. Ask before adding a runtime dependency.

## Generated and untracked files

- `dist/`, `node_modules/`, `public/history/`, `public/fundamentals/` are generated and git-ignored. Do not edit or commit them.
- `public/sample_data/` is bundled, committed data. Edit only when refreshing samples on purpose and keep `index.json` in sync.
- `data/watchlist.json` lists the snapshot symbols; CI downloads them on every deploy.

## Scope

This is a research and education tool. Do not present outputs as investment advice, and keep the disclaimer in the UI and README.
