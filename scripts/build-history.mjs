#!/usr/bin/env node
/**
 * Downloads the full daily history of every symbol in data/watchlist.json from
 * the Yahoo Finance chart API and writes a static snapshot the app reads
 * same-origin, with no CORS proxy:
 *
 *   <out>/index.json      { generatedAt, symbols: { "AAPL": { file, name, first, last, bars } } }
 *   <out>/<FILE>.json     trimmed Yahoo v8 chart payload (parsed by parseYahooChart)
 *
 * Usage: node scripts/build-history.mjs [outDir=public/history] [SYMBOL ...]
 * Runs server-side (locally or in GitHub Actions), where Yahoo needs no proxy.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [outDir = 'public/history', ...cliSymbols] = process.argv.slice(2);
const watchlist = JSON.parse(await readFile(new URL('../data/watchlist.json', import.meta.url), 'utf8'));
const symbols = cliSymbols.length > 0 ? cliSymbols : watchlist.symbols;
const HOSTS = ['query2.finance.yahoo.com', 'query1.finance.yahoo.com'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** `^GSPC` -> `_GSPC`, `EURUSD=X` -> `EURUSD_X`. */
const fileName = (symbol) => `${symbol.toUpperCase().replace(/[^A-Z0-9.-]/g, '_')}.json`;
/** 8 significant digits keep sub-cent prices exact enough and shrink the payload. */
const trim = (arr) => (arr ?? []).map((v) => (typeof v === 'number' && Number.isFinite(v) ? Number(v.toPrecision(8)) : null));

async function download(symbol) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    const host = HOSTS[attempt % HOSTS.length];
    // `range=max` silently degrades to monthly or quarterly bars; an explicit period keeps daily ones.
    const url = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?period1=-2208988800&period2=${Math.floor(Date.now() / 1000) + 86_400}&interval=1d&includePrePost=false`;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64)', Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const result = json?.chart?.result?.[0];
      if (!result?.timestamp?.length) throw new Error(json?.chart?.error?.description ?? 'no price history');
      return result;
    } catch (e) {
      lastError = e;
      await sleep(1500 * (attempt + 1));
    }
  }
  throw lastError;
}

await mkdir(outDir, { recursive: true });
const index = { generatedAt: new Date().toISOString(), symbols: {} };
const failures = [];

for (const raw of symbols) {
  const symbol = raw.trim().toUpperCase();
  try {
    const r = await download(symbol);
    const q = r.indicators?.quote?.[0] ?? {};
    const { longName, shortName, gmtoffset } = r.meta ?? {};
    const payload = {
      chart: {
        result: [
          {
            meta: { symbol, longName, shortName, gmtoffset },
            timestamp: r.timestamp,
            indicators: { quote: [{ open: trim(q.open), high: trim(q.high), low: trim(q.low), close: trim(q.close), volume: q.volume ?? [] }] },
          },
        ],
        error: null,
      },
    };
    const file = fileName(symbol);
    await writeFile(join(outDir, file), JSON.stringify(payload));
    const ts = r.timestamp;
    index.symbols[symbol] = {
      file,
      name: longName || shortName || symbol,
      first: new Date(ts[0] * 1000).toISOString().slice(0, 10),
      last: new Date(ts[ts.length - 1] * 1000).toISOString().slice(0, 10),
      bars: ts.length,
    };
    console.log(`${symbol.padEnd(12)} ${String(ts.length).padStart(6)} bars  ${index.symbols[symbol].first} -> ${index.symbols[symbol].last}`);
  } catch (e) {
    failures.push(symbol);
    console.warn(`${symbol.padEnd(12)} FAILED: ${e instanceof Error ? e.message : e}`);
  }
  await sleep(400);
}

await writeFile(join(outDir, 'index.json'), JSON.stringify(index, null, 1));
console.log(`\n${Object.keys(index.symbols).length}/${symbols.length} symbols written to ${outDir}`);
if (Object.keys(index.symbols).length === 0) process.exit(1);
if (failures.length > 0) console.warn(`Failed: ${failures.join(', ')}`);
