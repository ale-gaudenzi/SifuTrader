/**
 * Top-level view selected by the URL fragment (`#fundamentals`, `#builder`),
 * so each view has a shareable link and the browser back button switches
 * between them. The fragment works on any sub-path and needs no router.
 *
 * `#builder=<payload>` opens the builder with a shared strategy; the payload
 * is read by `takeSharedStrategy` in `components/builder/share.ts`.
 */
import { useCallback, useEffect, useState } from 'react';

export type View = 'backtest' | 'fundamentals' | 'builder';

const HASHES: Record<Exclude<View, 'backtest'>, string> = { fundamentals: '#fundamentals', builder: '#builder' };

function readView(): View {
  const hash = window.location.hash;
  if (hash === HASHES.fundamentals) return 'fundamentals';
  if (hash === HASHES.builder || hash.startsWith(`${HASHES.builder}=`)) return 'builder';
  return 'backtest';
}

export function useHashView(): readonly [View, (view: View) => void] {
  const [view, setView] = useState<View>(readView);

  useEffect(() => {
    const sync = (): void => setView(readView());
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
    return () => {
      window.removeEventListener('hashchange', sync);
      window.removeEventListener('popstate', sync);
    };
  }, []);

  const change = useCallback((next: View) => {
    if (next === readView()) return;
    const url = next === 'backtest' ? window.location.pathname + window.location.search : HASHES[next];
    window.history.pushState(null, '', url);
    setView(next);
  }, []);

  return [view, change] as const;
}
