// Turnstile en el panel de clubes. Solo se carga si el servidor anuncia una clave
// de sitio (fuera de local y pruebas siempre la hay: el Worker no arranca las
// cuentas sin ella). Cada token sirve una vez: tras usarlo se pide otro.
import { useCallback, useEffect, useRef, useState } from 'react';

interface TurnstileApi {
  render(el: HTMLElement, opts: Record<string, unknown>): string;
  reset(id: string): void;
  remove(id: string): void;
}
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let loading: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  loading ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SCRIPT;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      loading = null;
      reject(new Error('turnstile'));
    };
    document.head.appendChild(s);
  });
  return loading;
}

/**
 * Sin clave de sitio no hay widget y `ready` es true desde el principio (el
 * servidor tampoco lo exige). Con clave, `token` llega al resolver el desafío.
 */
export function useTurnstile(siteKey: string | null) {
  // Contenedor del widget como callback ref: el componente lo pasa a `ref` y el
  // efecto se vuelve a ejecutar cuando aparece.
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const widget = useRef<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!siteKey || !box) return;
    let cancelled = false;
    loadScript().then(
      () => {
        if (cancelled || !window.turnstile) return;
        widget.current = window.turnstile.render(box, {
          sitekey: siteKey,
          callback: (t: string) => setToken(t),
          'expired-callback': () => setToken(null),
          'error-callback': () => setToken(null),
          language: 'es',
        });
      },
      () => !cancelled && setFailed(true),
    );
    return () => {
      cancelled = true;
      if (widget.current && window.turnstile) window.turnstile.remove(widget.current);
      widget.current = null;
    };
  }, [siteKey, box]);

  /** Tras usar el token: se descarta y se pide otro. */
  const consume = useCallback(() => {
    setToken(null);
    if (widget.current && window.turnstile) window.turnstile.reset(widget.current);
  }, []);

  return { boxRef: setBox, token, ready: !siteKey || token !== null, failed, enabled: !!siteKey, consume };
}
