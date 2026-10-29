// Cliente HTTP del servidor de GalipauStats (solo lo necesario para los códigos
// de acceso y la sesión del dispositivo). No depende de la configuración de
// Vite: la URL y fetch se inyectan, así que se puede probar contra el Worker real.
//
// El token del dispositivo solo viaja en la cabecera Authorization: nunca en la
// URL, en los mensajes de error ni en los registros.

export type RemoteRole = 'coach' | 'viewer';

/** Equipo al que tiene acceso este dispositivo, tal como lo devuelve /api/session. */
export interface RemoteTeam {
  teamId: string;
  role: RemoteRole;
  /** «unavailable»: el equipo o su club están eliminados, o el club está suspendido. */
  status: 'active' | 'unavailable';
  name: string;
  code: string;
  season: string;
  clubId: string;
  clubName: string;
}

export interface RedeemResult {
  deviceId: string;
  role: RemoteRole;
  team: { id: string; name: string; code: string; season: string; clubId: string; clubName: string };
  /** Solo cuando el canje crea un dispositivo nuevo. */
  token?: string;
}

export interface SessionInfo {
  deviceId: string;
  teams: RemoteTeam[];
}

export type RemoteErrorKind =
  /** Sin conexión o el servidor no responde. */
  | 'offline'
  | 'timeout'
  /** Credencial del dispositivo inexistente o revocada. */
  | 'unauthorized'
  | 'invalid_code'
  | 'rate_limited'
  /** El canje ya se estaba procesando: basta con reintentar. */
  | 'conflict'
  | 'not_found'
  | 'bad_request'
  | 'server';

/** Error del servidor con un mensaje apto para mostrar. No incluye datos sensibles. */
export class RemoteError extends Error {
  override name = 'RemoteError';
  constructor(
    readonly kind: RemoteErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** ¿Merece la pena reintentar la misma petición? */
export const isTransient = (e: unknown) =>
  e instanceof RemoteError && (e.kind === 'offline' || e.kind === 'timeout' || e.kind === 'server');

const MESSAGES: Record<RemoteErrorKind, string> = {
  offline: 'Sin conexión con el servidor. Inténtalo cuando tengas internet.',
  timeout: 'El servidor tarda demasiado en responder. Inténtalo de nuevo.',
  unauthorized: 'La sesión de este dispositivo ya no es válida.',
  invalid_code: 'Código no válido o caducado.',
  rate_limited: 'Demasiados intentos. Espera unos minutos antes de volver a probar.',
  conflict: 'No se ha podido completar. Inténtalo de nuevo.',
  not_found: 'No encontrado.',
  bad_request: 'La petición no es válida.',
  server: 'El servidor no está disponible ahora mismo. Inténtalo más tarde.',
};

function errorFor(status: number, code: string | undefined): RemoteError {
  let kind: RemoteErrorKind;
  if (status === 401) kind = 'unauthorized';
  else if (status === 404 && code === 'invalid_code') kind = 'invalid_code';
  else if (status === 404) kind = 'not_found';
  else if (status === 429) kind = 'rate_limited';
  else if (status === 409) kind = 'conflict';
  else if (status >= 400 && status < 500) kind = 'bad_request';
  else kind = 'server';
  return new RemoteError(kind, MESSAGES[kind], status);
}

export interface ApiOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface Api {
  redeem(code: string, token: string | null, deviceLabel: string | null): Promise<RedeemResult>;
  getSession(token: string): Promise<SessionInfo>;
  leaveTeam(token: string, teamId: string): Promise<void>;
  logout(token: string): Promise<void>;
}

export function createApi({ baseUrl, fetch: doFetch = globalThis.fetch.bind(globalThis), timeoutMs = 10_000 }: ApiOptions): Api {
  const base = baseUrl.replace(/\/+$/, '');

  async function call<T>(method: 'GET' | 'POST', path: string, token: string | null, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        // Sin cookies ni credenciales del navegador: el dispositivo se identifica con su token.
        credentials: 'omit',
        cache: 'no-store',
      });
    } catch {
      throw controller.signal.aborted ? new RemoteError('timeout', MESSAGES.timeout) : new RemoteError('offline', MESSAGES.offline);
    } finally {
      clearTimeout(timer);
    }
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // Respuesta sin JSON (p. ej. una página de error intermedia).
    }
    if (!res.ok) throw errorFor(res.status, (data as { error?: string } | null)?.error);
    return data as T;
  }

  return {
    redeem: (code, token, deviceLabel) =>
      call<RedeemResult>('POST', '/api/invites/redeem', token, { code, ...(deviceLabel ? { deviceLabel } : {}) }),
    getSession: (token) => call<SessionInfo>('GET', '/api/session', token),
    leaveTeam: async (token, teamId) => {
      await call('POST', `/api/session/teams/${encodeURIComponent(teamId)}/leave`, token);
    },
    logout: async (token) => {
      await call('POST', '/api/session/logout', token);
    },
  };
}

/** Normaliza un código como el servidor: mayúsculas, sin guiones ni espacios. */
export function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^0-9A-Z]/g, '');
}

/** Los códigos tienen 12 caracteres (se muestran en grupos de cuatro: XXXX-XXXX-XXXX). */
export const CODE_LENGTH = 12;
