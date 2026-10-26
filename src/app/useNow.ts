import { useEffect, useState } from 'react';

/**
 * Instante actual que se refresca mientras `active` y al volver a primer plano.
 * Solo sirve para pintar: el tiempo real sale siempre del estado del cronómetro.
 */
export function useNow(active: boolean, intervalMs = 250): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const refresh = () => setNow(Date.now());
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    window.addEventListener('pageshow', refresh);
    const timer = active ? window.setInterval(refresh, intervalMs) : undefined;
    refresh();
    return () => {
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('pageshow', refresh);
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [active, intervalMs]);
  return now;
}
