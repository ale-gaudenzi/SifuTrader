/**
 * Live view of the local price-history database: re-reads the series list
 * whenever the store reports a write.
 */
import { useEffect, useState } from 'react';
import { listSeries, subscribe, type SeriesMeta } from '../data/store';

export interface SavedSeriesState {
  items: SeriesMeta[];
  /** False when IndexedDB cannot be opened in this browser. */
  available: boolean;
}

export function useSavedSeries(): SavedSeriesState {
  const [state, setState] = useState<SavedSeriesState>({ items: [], available: true });
  useEffect(() => {
    let alive = true;
    const reload = (): void => {
      listSeries()
        .then((items) => alive && setState({ items, available: true }))
        .catch(() => alive && setState({ items: [], available: false }));
    };
    reload();
    const unsubscribe = subscribe(reload);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);
  return state;
}
