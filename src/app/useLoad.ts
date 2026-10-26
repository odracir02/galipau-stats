import { useCallback, useEffect, useEffectEvent, useState } from 'react';
import { errorMessage } from './errors';

export interface Loaded<T> {
  data: T | undefined;
  error: string | null;
  reload: () => void;
}

/** Carga asíncrona simple; vuelve a cargar cuando cambian `deps` o al llamar a `reload`. */
export function useLoad<T>(load: () => Promise<T>, deps: readonly (string | number | undefined)[]): Loaded<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const runLoad = useEffectEvent(load);
  const depKey = JSON.stringify(deps);

  useEffect(() => {
    let cancelled = false;
    runLoad().then(
      (value) => {
        if (!cancelled) {
          setData(value);
          setError(null);
        }
      },
      (e: unknown) => {
        if (!cancelled) setError(errorMessage(e));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [depKey, version]);

  return { data, error, reload: useCallback(() => setVersion((v) => v + 1), []) };
}
