/**
 * Top-level view selected by the URL fragment (`#fundamentals`), so each view
 * has a shareable link and the browser back button switches between them.
 * The fragment works on GitHub Pages sub-paths and needs no router.
 */
import { useCallback, useEffect, useState } from 'react';

export type View = 'backtest' | 'fundamentals';

const FUNDAMENTALS_HASH = '#fundamentals';

function readView(): View {
  return window.location.hash === FUNDAMENTALS_HASH ? 'fundamentals' : 'backtest';
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
    const url = next === 'fundamentals' ? FUNDAMENTALS_HASH : window.location.pathname + window.location.search;
    window.history.pushState(null, '', url);
    setView(next);
  }, []);

  return [view, change] as const;
}
