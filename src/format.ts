/**
 * Display formatting helpers. All functions are pure; numbers are
 * locale-stable (en-US) so that screenshots and exported logs are consistent.
 * Display dates follow the UI language through the optional `locale`.
 */

const DATE_FMTS = new Map<string, Intl.DateTimeFormat>();

export function formatDate(timeSeconds: number, locale = 'en-US'): string {
  let fmt = DATE_FMTS.get(locale);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: '2-digit', timeZone: 'UTC' });
    DATE_FMTS.set(locale, fmt);
  }
  return fmt.format(new Date(timeSeconds * 1000));
}

export function isoDate(timeSeconds: number): string {
  return new Date(timeSeconds * 1000).toISOString().slice(0, 10);
}

/** Price with precision adapted to magnitude (crypto sub-dollar prices keep more digits). */
export function formatPrice(value: number): string {
  if (!Number.isFinite(value)) return '-';
  const abs = Math.abs(value);
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6;
  return value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function formatMoney(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '-';
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function formatSignedMoney(value: number): string {
  if (!Number.isFinite(value)) return '-';
  return `${value >= 0 ? '+' : '-'}${formatMoney(Math.abs(value))}`;
}

export function formatPct(value: number, digits = 2, signed = false): string {
  if (Number.isNaN(value)) return '-';
  if (!Number.isFinite(value)) return value > 0 ? 'Inf' : '-Inf';
  const sign = signed && value > 0 ? '+' : '';
  return `${sign}${value.toFixed(digits)}%`;
}

export function formatNumber(value: number, digits = 2): string {
  if (Number.isNaN(value)) return '-';
  if (!Number.isFinite(value)) return value > 0 ? 'Inf' : '-Inf';
  return value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Compact volume notation: 1.2K, 3.4M, 5.6B. */
export function formatVolume(value: number): string {
  if (!Number.isFinite(value)) return '-';
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(value);
}

/** Tailwind text color class for a signed quantity. */
export function signClass(value: number): string {
  if (value > 0) return 'text-up';
  if (value < 0) return 'text-down';
  return 'text-terminal-muted';
}

const RELATIVE_FMTS = new Map<string, Intl.RelativeTimeFormat>();

/** "5 minutes ago", "yesterday", ... for an epoch-milliseconds timestamp. */
export function formatAgo(timeMs: number, locale = 'en-US', nowMs = Date.now()): string {
  let fmt = RELATIVE_FMTS.get(locale);
  if (!fmt) {
    fmt = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'narrow' });
    RELATIVE_FMTS.set(locale, fmt);
  }
  const seconds = Math.round((timeMs - nowMs) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return fmt.format(0, 'second');
  if (abs < 3600) return fmt.format(Math.round(seconds / 60), 'minute');
  if (abs < 86_400) return fmt.format(Math.round(seconds / 3600), 'hour');
  if (abs < 30 * 86_400) return fmt.format(Math.round(seconds / 86_400), 'day');
  if (abs < 365 * 86_400) return fmt.format(Math.round(seconds / (30 * 86_400)), 'month');
  return fmt.format(Math.round(seconds / (365 * 86_400)), 'year');
}
