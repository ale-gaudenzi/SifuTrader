/**
 * Moving custom strategies in and out of the browser without a server:
 * JSON files and links that carry the spec in the URL fragment. The fragment
 * never reaches the server, so a shared link discloses nothing to it.
 */
import { parseSpec } from '../../strategies/rules/validate';
import type { RuleStrategySpec } from '../../strategies/rules/spec';

const SHARE_PREFIX = '#builder=';

/** Short random identifier for a new spec (UI only: the engine stays deterministic). */
export function newSpecId(): string {
  try {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  } catch {
    return Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  }
}

function toBase64Url(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(data: string): string {
  const binary = atob(data.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

/** A link to this page that opens the builder with a copy of `spec`. */
export function shareUrl(spec: RuleStrategySpec): string {
  const { origin, pathname, search } = window.location;
  return `${origin}${pathname}${search}${SHARE_PREFIX}${toBase64Url(JSON.stringify(spec))}`;
}

/**
 * Reads a strategy shared through the URL fragment and removes it from the
 * address bar. Returns `undefined` when the URL carries none and `null` when
 * it carries something unreadable.
 */
export function takeSharedStrategy(): RuleStrategySpec | null | undefined {
  const hash = window.location.hash;
  if (!hash.startsWith(SHARE_PREFIX)) return undefined;
  window.history.replaceState(null, '', '#builder');
  try {
    return parseSpec(JSON.parse(fromBase64Url(hash.slice(SHARE_PREFIX.length))));
  } catch {
    return null;
  }
}

/** Specs found in an imported file: a single spec or an array of them. Invalid entries are skipped. */
export function specsFromJson(text: string): RuleStrategySpec[] {
  try {
    const data: unknown = JSON.parse(text);
    const items = Array.isArray(data) ? data : [data];
    return items.map(parseSpec).filter((s): s is RuleStrategySpec => s !== null);
  } catch {
    return [];
  }
}

export function downloadSpec(spec: RuleStrategySpec): void {
  const blob = new Blob([JSON.stringify(spec, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(spec.name || 'strategy').replace(/[^\w.-]+/g, '_')}.strategy.json`;
  a.click();
  URL.revokeObjectURL(url);
}
