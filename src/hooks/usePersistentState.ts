/**
 * `useState` mirrored to `localStorage` for per-browser preferences (API key,
 * proxy template, last-used settings). Storage may be unavailable (private
 * mode, blocked cookies); every access is guarded and the hook degrades to
 * plain in-memory state.
 */
import { useEffect, useState } from 'react';

const PREFIX = 'backtest-terminal:';

function read<T>(key: string, fallback: T, guard: (v: unknown) => v is T): T {
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    return guard(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function usePersistentState<T>(key: string, fallback: T, guard: (v: unknown) => v is T) {
  const [value, setValue] = useState<T>(() => read(key, fallback, guard));
  useEffect(() => {
    try {
      window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch {
      // Storage unavailable; keep the in-memory value only.
    }
  }, [key, value]);
  return [value, setValue] as const;
}

export const isString = (v: unknown): v is string => typeof v === 'string';
export const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean';
export const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
export function isOneOf<T extends string>(options: readonly T[]) {
  return (v: unknown): v is T => typeof v === 'string' && (options as readonly string[]).includes(v);
}
