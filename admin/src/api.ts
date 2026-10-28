// Cliente de la API de administración. Siempre en el mismo origen que el panel:
// la cookie de Cloudflare Access va sola y el navegador envía Origin y
// Sec-Fetch-Site, que la protección CSRF del Worker exige en las escrituras.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const MESSAGES: Record<string, string> = {
  critical_disabled: 'Las operaciones de escritura no están habilitadas en este entorno.',
  codes_unavailable: 'Los códigos no están disponibles en este entorno.',
  session_expired: 'La sesión ha caducado. Recarga la página para volver a entrar.',
};

/** Ruta de vuelta tras la verificación reforzada: la pantalla actual del panel. */
export function reauthUrl(hash: string = window.location.hash): string {
  const back = `/admin/${/^#\/[A-Za-z0-9/_-]*$/.test(hash) ? hash : ''}`;
  return `/api/admin/critical/reauth?return=${encodeURIComponent(back)}`;
}

export async function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const { method = 'GET', body } = options;
  const headers: Record<string, string> = {
    // Pide a Cloudflare Access un 401 (en vez de una redirección) si la sesión caduca.
    'X-Requested-With': 'XMLHttpRequest',
    Accept: 'application/json',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as (T & { error?: string; message?: string }) | null;
  if (res.ok) return data as T;

  const code = data?.error ?? (res.status === 401 ? 'session_expired' : 'error');
  // Operación crítica sin verificación reciente: se pasa por la aplicación
  // crítica de Access (biometría) y se vuelve a esta pantalla.
  if (res.status === 401 && path.startsWith('/api/admin/critical/') && (code === 'reauth_required' || code === 'session_expired')) {
    window.location.assign(reauthUrl());
    throw new ApiError(401, 'reauth_required', 'Verificación necesaria…');
  }
  throw new ApiError(res.status, code, MESSAGES[code] ?? data?.message ?? 'No se ha podido completar la operación.');
}
