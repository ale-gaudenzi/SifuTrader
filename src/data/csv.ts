/**
 * Client-side OHLCV CSV parsing and validation built on PapaParse.
 *
 * Accepted input:
 * - Any delimiter PapaParse can detect (comma, semicolon, tab, pipe).
 * - Case-insensitive headers with common aliases, e.g. `Date`/`Timestamp`,
 *   `Close`/`Close/Last`/`Price`, `Volume`/`Vol`.
 * - Dates as ISO strings (`2024-01-31`, `2024-01-31T15:30:00Z`), `YYYY/MM/DD`,
 *   `MM/DD/YYYY` or `DD/MM/YYYY` (disambiguated per file), `DD.MM.YYYY`,
 *   `YYYYMMDD`, or Unix epoch seconds / milliseconds.
 * - Numbers with thousands separators or currency symbols (`$1,234.50`).
 *
 * Rows that cannot be parsed are skipped and reported; inconsistent candles
 * (e.g. high below close) are repaired and reported as warnings.
 */
import Papa from 'papaparse';
import type { Bar } from '../engine/types';

export interface CsvParseResult {
  bars: Bar[];
  rowsRead: number;
  rowsSkipped: number;
  warnings: string[];
}

export class CsvParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CsvParseError';
  }
}

type Field = 'time' | 'open' | 'high' | 'low' | 'close' | 'adjclose' | 'volume';

const HEADER_ALIASES: Record<Field, readonly string[]> = {
  time: ['date', 'time', 'timestamp', 'datetime', 'day', 'opentime', 'dateutc', 'unix'],
  open: ['open', 'o', 'openprice'],
  high: ['high', 'h', 'highprice'],
  low: ['low', 'l', 'lowprice'],
  close: ['close', 'c', 'closelast', 'last', 'price', 'closeprice'],
  adjclose: ['adjclose', 'adjustedclose'],
  volume: ['volume', 'vol', 'v', 'volumeusd', 'volumeto', 'tradevolume'],
};

const MAX_REPORTED_ISSUES = 5;

function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Maps canonical fields to the actual header names present in the file. */
function resolveColumns(headers: readonly string[]): Partial<Record<Field, string>> {
  const out: Partial<Record<Field, string>> = {};
  const normalized = headers.map((h) => ({ raw: h, norm: normalizeHeader(h) }));
  for (const field of Object.keys(HEADER_ALIASES) as Field[]) {
    const match = normalized.find((h) => HEADER_ALIASES[field].includes(h.norm));
    if (match) out[field] = match.raw;
  }
  return out;
}

/** Parses a numeric cell, tolerating currency symbols, spaces and thousands separators. */
export function parseNumber(raw: string | undefined): number {
  if (raw === undefined) return Number.NaN;
  const cleaned = raw.trim().replace(/[$\u20AC\u00A3\s]/g, '').replace(/,/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned.toLowerCase() === 'null') return Number.NaN;
  return Number(cleaned);
}

type SlashOrder = 'mdy' | 'dmy';

/** Decides whether `a/b/yyyy` dates in a column are month-first or day-first. */
function detectSlashOrder(values: readonly string[]): SlashOrder {
  for (const v of values) {
    const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/.exec(v.trim());
    if (!m) continue;
    if (Number(m[1]) > 12) return 'dmy';
    if (Number(m[2]) > 12) return 'mdy';
  }
  return 'mdy';
}

function utcSeconds(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): number {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 60) return Number.NaN;
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  const check = new Date(ms);
  // Reject rolled-over dates such as 2024-02-31.
  if (check.getUTCDate() !== d) return Number.NaN;
  return Math.floor(ms / 1000);
}

/**
 * Converts a date cell to UTC seconds. Date-only values map to 00:00 UTC.
 * Timestamps with a time but no zone designator are interpreted as UTC.
 */
export function parseDate(raw: string, slashOrder: SlashOrder = 'mdy'): number {
  const v = raw.trim();
  if (v === '') return Number.NaN;

  if (/^\d{8}$/.test(v)) {
    return utcSeconds(Number(v.slice(0, 4)), Number(v.slice(4, 6)), Number(v.slice(6, 8)));
  }
  if (/^-?\d+(\.\d+)?$/.test(v)) {
    const n = Number(v);
    // Heuristic: values beyond year ~5138 in seconds are milliseconds.
    return Math.floor(n > 1e11 ? n / 1000 : n);
  }

  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(v);
  if (m) {
    if (m[7] && m[7].toUpperCase() !== 'Z') {
      const parsed = Date.parse(v.replace(' ', 'T'));
      return Number.isNaN(parsed) ? Number.NaN : Math.floor(parsed / 1000);
    }
    return utcSeconds(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
  }

  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(v);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    const [mo, d] = slashOrder === 'mdy' ? [a, b] : [b, a];
    return utcSeconds(Number(m[3]), mo, d, Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
  }

  m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(v);
  if (m) return utcSeconds(Number(m[3]), Number(m[2]), Number(m[1]));

  // Last resort: free-form strings such as "Jan 5, 2024". The engine parses
  // them in local time; keep the calendar date and pin it to UTC midnight.
  const parsed = Date.parse(v);
  if (Number.isNaN(parsed)) return Number.NaN;
  const local = new Date(parsed);
  return utcSeconds(local.getFullYear(), local.getMonth() + 1, local.getDate());
}

/** Parses CSV text into validated, chronologically sorted bars. */
export function parseOhlcvCsv(text: string): CsvParseResult {
  const parsed = Papa.parse<Record<string, string>>(text.replace(/^\uFEFF/, ''), {
    header: true,
    skipEmptyLines: 'greedy',
    dynamicTyping: false,
    transformHeader: (h) => h.trim(),
  });

  const headers = parsed.meta.fields ?? [];
  const cols = resolveColumns(headers);
  const warnings: string[] = [];

  if (!cols.time) {
    throw new CsvParseError(`No date column found. Expected one of: Date, Time, Timestamp. Headers seen: ${headers.join(', ') || '(none)'}`);
  }
  const closeCol = cols.close ?? cols.adjclose;
  if (!closeCol) {
    throw new CsvParseError(`No close price column found. Expected Close (or Adj Close / Price). Headers seen: ${headers.join(', ')}`);
  }
  if (!cols.close && cols.adjclose) warnings.push('Using "Adj Close" as the close price.');
  const hasOhl = Boolean(cols.open && cols.high && cols.low);
  if (!hasOhl) warnings.push('Open/High/Low columns missing; candles are derived from the close price.');
  if (!cols.volume) warnings.push('Volume column missing; volume set to 0.');

  const rows = parsed.data;
  const timeCol = cols.time;
  const slashOrder = detectSlashOrder(rows.slice(0, 500).map((r) => r[timeCol] ?? ''));

  const issues: string[] = [];
  let skipped = 0;
  let repaired = 0;
  const bars: Bar[] = [];

  rows.forEach((row, idx) => {
    const line = idx + 2; // 1-based, accounting for the header row.
    const time = parseDate(row[timeCol] ?? '', slashOrder);
    const close = parseNumber(row[closeCol]);
    let open = hasOhl && cols.open ? parseNumber(row[cols.open]) : close;
    let high = hasOhl && cols.high ? parseNumber(row[cols.high]) : close;
    let low = hasOhl && cols.low ? parseNumber(row[cols.low]) : close;
    const volumeRaw = cols.volume ? parseNumber(row[cols.volume]) : 0;
    const volume = Number.isFinite(volumeRaw) && volumeRaw >= 0 ? volumeRaw : 0;

    if (!Number.isFinite(time)) {
      skipped++;
      if (issues.length < MAX_REPORTED_ISSUES) issues.push(`line ${line}: unparseable date "${row[timeCol] ?? ''}"`);
      return;
    }
    if (!(Number.isFinite(close) && close > 0)) {
      skipped++;
      if (issues.length < MAX_REPORTED_ISSUES) issues.push(`line ${line}: invalid close "${row[closeCol] ?? ''}"`);
      return;
    }
    // Fall back to the close for individual missing OHL cells.
    if (!(Number.isFinite(open) && open > 0)) open = close;
    if (!(Number.isFinite(high) && high > 0)) high = Math.max(open, close);
    if (!(Number.isFinite(low) && low > 0)) low = Math.min(open, close);

    const fixedHigh = Math.max(high, open, close, low);
    const fixedLow = Math.min(low, open, close, high);
    if (fixedHigh !== high || fixedLow !== low) repaired++;

    bars.push({ time, open, high: fixedHigh, low: fixedLow, close, volume });
  });

  if (bars.length === 0) {
    throw new CsvParseError(`No valid rows found.${issues.length ? ` First issues: ${issues.join('; ')}` : ''}`);
  }

  // Sort chronologically and drop duplicate timestamps, keeping the last row.
  bars.sort((a, b) => a.time - b.time);
  const unique: Bar[] = [];
  let duplicates = 0;
  for (const bar of bars) {
    if (unique.length > 0 && unique[unique.length - 1].time === bar.time) {
      unique[unique.length - 1] = bar;
      duplicates++;
    } else {
      unique.push(bar);
    }
  }

  if (skipped > 0) warnings.push(`Skipped ${skipped} invalid row(s): ${issues.join('; ')}${skipped > issues.length ? '; ...' : ''}`);
  if (repaired > 0) warnings.push(`Repaired ${repaired} candle(s) whose high/low did not bound open/close.`);
  if (duplicates > 0) warnings.push(`Merged ${duplicates} duplicate timestamp(s), keeping the last occurrence.`);
  if (parsed.errors.length > 0) {
    warnings.push(`CSV reader reported ${parsed.errors.length} formatting issue(s), e.g. row ${(parsed.errors[0].row ?? 0) + 2}: ${parsed.errors[0].message}`);
  }

  return { bars: unique, rowsRead: rows.length, rowsSkipped: skipped, warnings };
}

/** Reads and parses a `File` selected by the user. */
export async function parseCsvFile(file: File): Promise<CsvParseResult> {
  const text = await file.text();
  return parseOhlcvCsv(text);
}

/** Serializes bars back to a canonical CSV (used for exporting fetched data). */
export function barsToCsv(bars: readonly Bar[]): string {
  const rows = bars.map((b) => ({
    Date: b.time % 86_400 === 0 ? new Date(b.time * 1000).toISOString().slice(0, 10) : new Date(b.time * 1000).toISOString(),
    Open: b.open,
    High: b.high,
    Low: b.low,
    Close: b.close,
    Volume: b.volume,
  }));
  return Papa.unparse(rows);
}
