// Navegación, carga de datos y escrituras del panel.
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from './api';

export const go = (hash: string) => (window.location.hash = hash);

export function useData<T>(path: string | null): { data: T | undefined; error: string | null; reload: () => void } {
  const [state, setState] = useState<{ path: string | null; data?: T; error: string | null }>({ path: null, error: null });
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    api<T>(path).then(
      (data) => !cancelled && setState({ path, data, error: null }),
      (e: unknown) => !cancelled && setState({ path, error: e instanceof ApiError ? e.message : 'Error de conexión.' }),
    );
    return () => {
      cancelled = true;
    };
  }, [path, version]);
  // Al cambiar de ruta, nunca se muestran los datos de la anterior (se ve «cargando»).
  const current = state.path === path;
  return { data: current ? state.data : undefined, error: current ? state.error : null, reload: useCallback(() => setVersion((v) => v + 1), []) };
}

/** Ejecuta una escritura y devuelve su error como texto (nunca la repite sola). */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const run = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    setConflict(false);
    try {
      return await fn();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Error de conexión.');
      // Otro administrador lo cambió mientras tanto: hay que recargar antes de seguir.
      setConflict(e instanceof ApiError && e.status === 409);
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  const clear = useCallback(() => {
    setError(null);
    setConflict(false);
  }, []);
  return { busy, error, conflict, run, clear };
}
