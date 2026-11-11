// Cliente HTTP del servidor de GalipauStats: códigos de acceso, sesión del
// dispositivo, subida de jugadores, partidos y acciones y descarga del equipo. No depende de la configuración de
// Vite: la URL y fetch se inyectan, así que se puede probar contra el Worker real.
//
// El token del dispositivo solo viaja en la cabecera Authorization: nunca en la
// URL, en los mensajes de error ni en los registros.

import type { Match, MatchEvent, Player } from '../domain/types';

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

/** Resultado de una operación de subida: aplicada o ya existente (idempotente). */
export interface OpResult {
  status: 'applied' | 'duplicate';
  entityId: string;
  version: number;
}

/** Operación de subida, con la versión del servidor sobre la que se hizo (null = alta). */
export interface SyncOp<T> {
  opId: string;
  teamId: string;
  baseVersion: number | null;
  record: T;
}

/** Equipo completo tal como lo devuelve GET /api/teams/:id/snapshot. */
export interface TeamSnapshot {
  team: { id: string; name: string; code: string; season: string };
  club: { id: string; name: string };
  seq: number;
  players: { version: number; player: Player }[];
  /**
   * `control` (servidor con control de partidos): si el partido en curso lo
   * registra este dispositivo, otro o ninguno. Opcional por compatibilidad.
   */
  matches: { version: number; match: Match; recordedHere: boolean; control?: { holder: 'here' | 'other' | null; epoch: number; seenAt: string | null } }[];
  events: { version: number; event: MatchEvent }[];
}

/** Cambios de un equipo posteriores a `since`, tal como los devuelve GET /api/teams/:id/changes. */
export interface ChangesPage {
  /** Último cambio incluido (igual a `since` si no hay ninguno). */
  nextSeq: number;
  hasMore: boolean;
  /** Estado actual de las acciones cambiadas (también las borradas). */
  events: { version: number; event: MatchEvent }[];
  /** Otros registros cambiados (partidos, jugadores…), solo identificados. */
  others: { entity: string; entityId: string; version: number }[];
}

export type RemoteErrorKind =
  /** Sin conexión o el servidor no responde. */
  | 'offline'
  /** Permiso insuficiente (p. ej. acceso de consulta intentando escribir). */
  | 'forbidden'
  /** El servidor rechaza los datos por no cumplir sus reglas. */
  | 'invalid'
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
    /** Código estable del servidor (p. ej. «match_recorded_elsewhere»), sin datos sensibles. */
    readonly code?: string,
  ) {
    super(message);
  }
}

/** ¿Merece la pena reintentar la misma petición? */
export const isTransient = (e: unknown) =>
  e instanceof RemoteError && (e.kind === 'offline' || e.kind === 'timeout' || e.kind === 'server');

const MESSAGES: Record<RemoteErrorKind, string> = {
  offline: 'Sin conexión con el servidor. Inténtalo cuando tengas internet.',
  forbidden: 'Este dispositivo no tiene permiso para esta operación.',
  invalid: 'El servidor ha rechazado los datos.',
  timeout: 'El servidor tarda demasiado en responder. Inténtalo de nuevo.',
  unauthorized: 'La sesión de este dispositivo ya no es válida.',
  invalid_code: 'Código no válido o caducado.',
  rate_limited: 'Demasiados intentos. Espera unos minutos antes de volver a probar.',
  conflict: 'No se ha podido completar. Inténtalo de nuevo.',
  not_found: 'No encontrado.',
  bad_request: 'La petición no es válida.',
  server: 'El servidor no está disponible ahora mismo. Inténtalo más tarde.',
};

/** Mensajes del servidor que se pueden mostrar tal cual (no contienen datos sensibles). */
const SERVER_MESSAGE_CODES = new Set(['conflict', 'match_recorded_elsewhere', 'number_taken', 'invalid_data', 'invalid_event', 'unknown_player', 'match_deleted', 'control_changed', 'match_not_active']);

function errorFor(status: number, code: string | undefined, serverMessage: string | undefined): RemoteError {
  let kind: RemoteErrorKind;
  if (status === 401) kind = 'unauthorized';
  else if (status === 403) kind = 'forbidden';
  else if (status === 422) kind = 'invalid';
  else if (status === 404 && code === 'invalid_code') kind = 'invalid_code';
  else if (status === 404) kind = 'not_found';
  else if (status === 429) kind = 'rate_limited';
  else if (status === 409) kind = 'conflict';
  else if (status >= 400 && status < 500) kind = 'bad_request';
  else kind = 'server';
  const message = code && serverMessage && SERVER_MESSAGE_CODES.has(code) ? serverMessage : MESSAGES[kind];
  return new RemoteError(kind, message, status, code);
}

/**
 * Grupo de los rankings del club: temporada y grupo de clasificación (ni el
 * género ni la categoría separan; un grupo puede reunir a todo el club).
 */
export interface ClubRankingGroup {
  season: string;
  group: string;
  /**
   * Equipos del club que participan en el grupo y en los que este dispositivo
   * tiene un permiso que la visibilidad del club abre. Opcional: un servidor
   * anterior no lo envía.
   */
  teamIds?: string[];
}

export interface ClubRankingEntry {
  position: number;
  /** Nombre visible: el de la persona del club o el de la ficha. */
  name: string;
  /** Códigos de los equipos del grupo en los que suma. */
  teams: string[];
  matches: number;
  value: number;
  made?: number;
  of?: number;
}

/** Clasificaciones del club tal como las calcula el servidor (Top 10 y puestos propios). */
export interface ClubRankings {
  season: string;
  group: string;
  computedAt: string;
  teams: { code: string; name: string }[];
  rankings: { id: 'top_scorer' | 'sharpshooter' | 'wall' | 'thief' | 'shots'; ranked: number; hiddenTies: number; entries: ClubRankingEntry[] }[];
  mine: {
    playerId: string;
    excluded?: true;
    rankings: { id: ClubRankings['rankings'][number]['id']; position: number; ranked: number; value: number; made?: number; of?: number }[];
  }[];
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
  syncPlayer(token: string, op: SyncOp<Player>): Promise<OpResult>;
  syncMatch(token: string, op: SyncOp<Match>): Promise<OpResult>;
  syncEvent(token: string, op: SyncOp<MatchEvent>): Promise<OpResult>;
  snapshot(token: string, teamId: string): Promise<TeamSnapshot>;
  changes(token: string, teamId: string, since: number): Promise<ChangesPage>;
  /** Toma el control de un partido en curso (entrenador), con el contador de control visto. */
  takeControl(token: string, op: { opId: string; teamId: string; matchId: string; expectedEpoch: number }): Promise<{ status: 'applied' | 'duplicate'; entityId: string; epoch: number }>;
  /** Grupos de los rankings del club que este dispositivo puede consultar (los decide el servidor). */
  clubRankingGroups(token: string, clubId: string): Promise<{ groups: ClubRankingGroup[] }>;
  /** Clasificaciones de un grupo y, de las fichas pedidas (como mucho 5), su puesto si el servidor lo permite. */
  clubRankings(token: string, clubId: string, group: ClubRankingGroup, playerIds: readonly string[]): Promise<ClubRankings>;
}

export function createApi({ baseUrl, fetch: doFetch = globalThis.fetch.bind(globalThis), timeoutMs = 10_000 }: ApiOptions): Api {
  const base = baseUrl.replace(/\/+$/, '');

  async function call<T>(method: 'GET' | 'POST', path: string, token: string | null, body?: unknown): Promise<T> {
    // Esta versión conoce el cuerpo técnico: el servidor le deja usar los equipos
    // que lo tienen (no autoriza nada; los permisos son los del token).
    const headers: Record<string, string> = { 'X-GalipauStats-Features': 'officials' };
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
    if (!res.ok) {
      const err = data as { error?: string; message?: string } | null;
      throw errorFor(res.status, err?.error, err?.message);
    }
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
    syncPlayer: (token, { record, ...op }) => call<OpResult>('POST', '/api/sync/players', token, { ...op, player: record }),
    syncMatch: (token, { record, ...op }) => call<OpResult>('POST', '/api/sync/matches', token, { ...op, match: record }),
    syncEvent: (token, { record, ...op }) => call<OpResult>('POST', '/api/sync/events', token, { ...op, event: record }),
    snapshot: (token, teamId) => call<TeamSnapshot>('GET', `/api/teams/${encodeURIComponent(teamId)}/snapshot`, token),
    takeControl: (token, op) => call('POST', '/api/sync/control', token, op),
    changes: (token, teamId, since) =>
      call<ChangesPage>('GET', `/api/teams/${encodeURIComponent(teamId)}/changes?since=${since}`, token),
    clubRankingGroups: (token, clubId) => call('GET', `/api/clubs/${encodeURIComponent(clubId)}/rankings`, token),
    clubRankings: (token, clubId, g, playerIds) => {
      const q = new URLSearchParams({ season: g.season, group: g.group });
      if (playerIds.length) q.set('players', playerIds.slice(0, 5).join(','));
      return call('GET', `/api/clubs/${encodeURIComponent(clubId)}/rankings?${q.toString()}`, token);
    },
  };
}

/** Normaliza un código como el servidor: mayúsculas, sin guiones ni espacios. */
export function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^0-9A-Z]/g, '');
}

/** Los códigos tienen 12 caracteres (se muestran en grupos de cuatro: XXXX-XXXX-XXXX). */
export const CODE_LENGTH = 12;
