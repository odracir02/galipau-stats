// Envío manual de un equipo vinculado y comprobación posterior.
//
// Garantías:
//   * Orden: jugadores → partidos (con convocatoria) → acciones.
//   * Idempotente: cada registro se identifica por su id; cada operación, por un
//     opId derivado del dispositivo, el registro, la versión base y su contenido.
//     Repetir un envío interrumpido no duplica nada, y lo ya confirmado con el
//     mismo contenido no se vuelve a enviar.
//   * Sin sobrescrituras: cada cambio indica la versión sobre la que se hizo. Ante
//     un conflicto, un rechazo o la falta de permiso, el envío se DETIENE y se
//     informa; nunca se fuerza ni se transforma nada.
//   * Los datos locales nunca se modifican: solo se guardan, aparte, las
//     versiones que el servidor confirma.
//   * Sin tokens ni datos personales en el historial ni en los mensajes.
import { computeMatchStats, computeSeasonStats } from '../stats/engine';
import type { Match, MatchEvent, Player } from '../domain/types';
import { isTransient, RemoteError, type Api, type OpResult, type TeamSnapshot } from './api';
import type { UploadPlan } from './plan';
import { toRemoteMatch, toRemotePlayer } from './plan';
import type { AccountStore, SyncEntity } from './store';
import { metaKey } from './store';

// --- Huellas y operaciones ---------------------------------------------------

/** JSON estable (claves ordenadas, sin undefined), para comparar y firmar contenidos. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
}

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Lo que el servidor guarda de una acción (sin campos ajenos a su tipo). */
export function eventContent(e: MatchEvent): Record<string, unknown> {
  return {
    id: e.id,
    matchId: e.matchId,
    playerId: e.playerId,
    kind: e.kind,
    shotType: e.kind === 'shot' || e.kind === 'gk_shot' ? e.shotType : undefined,
    result: e.kind === 'shot' || e.kind === 'gk_shot' ? e.result : undefined,
    turnoverType: e.kind === 'turnover' ? e.turnoverType : undefined,
    period: e.period,
    matchTimeMs: e.matchTimeMs,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    deletedAt: e.deletedAt,
    addsToPrevious: e.addsToPrevious === true ? true : undefined,
  };
}

/** Lo que el servidor guarda de un partido (cronómetro solo con sus campos conocidos). */
export function matchContent(m: Match): Record<string, unknown> {
  const { period, running, baseMs, anchorWallMs, firstHalfEndMs } = m.clock;
  return {
    ...m,
    squad: m.squad.map(({ playerId, name, number, position }) => ({ playerId, name, number, position })),
    clock: { period, running, baseMs, anchorWallMs, firstHalfEndMs },
    scoreAdjustment: { own: m.scoreAdjustment.own, opponent: m.scoreAdjustment.opponent },
  };
}

/** Lo que el servidor guarda de un jugador. */
export function playerContent(p: Player): Record<string, unknown> {
  const { id, teamId, name, number, position, active, createdAt, updatedAt } = p;
  return { id, teamId, name, number, position, active, createdAt, updatedAt };
}

// --- Pendientes ------------------------------------------------------------------

export interface PendingChanges {
  players: number;
  matches: number;
  events: number;
  /** Partidos ya enviados que se han eliminado en el dispositivo. */
  matchDeletions: number;
}

/**
 * Cuenta lo que un envío mandaría (registros nuevos o cambiados respecto a lo
 * confirmado por el servidor), sin enviar nada ni tocar ningún dato. Lo que no
 * ha cambiado, como los partidos históricos ya enviados, no cuenta.
 */
export async function pendingChanges(plan: UploadPlan, store: AccountStore): Promise<PendingChanges> {
  const remoteTeamId = plan.link.remoteTeamId;
  const known = new Map((await store.listMeta(remoteTeamId)).map((m) => [m.key, m.hash]));
  const changed = async (entity: SyncEntity, id: string, content: unknown) =>
    known.get(metaKey(entity, id)) !== (await sha256(stableJson(content)));
  const out: PendingChanges = { players: 0, matches: 0, events: 0, matchDeletions: 0 };
  for (const p of plan.players) if (await changed('player', p.id, playerContent(toRemotePlayer(p, remoteTeamId)))) out.players++;
  for (const m of plan.matches) {
    if (!(await changed('match', m.id, matchContent(toRemoteMatch(m, remoteTeamId))))) continue;
    if (m.deletedAt !== null) out.matchDeletions++;
    else out.matches++;
  }
  for (const e of plan.events) if (await changed('event', e.id, eventContent(e))) out.events++;
  return out;
}

export const pendingTotal = (p: PendingChanges) => p.players + p.matches + p.events + p.matchDeletions;

// --- Bloqueo -------------------------------------------------------------------

const running = new Set<string>();

export class UploadBusyError extends Error {
  override name = 'UploadBusyError';
  constructor() {
    super('Ya hay un envío en curso para este equipo.');
  }
}

/** Un solo envío a la vez por equipo del club (también entre pestañas, si el navegador lo permite). */
async function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  if (running.has(name)) throw new UploadBusyError();
  running.add(name);
  try {
    const locks = (globalThis.navigator as Navigator | undefined)?.locks;
    if (!locks?.request) return await fn();
    let entered = false;
    const result = await locks.request(`galipaustats-envio-${name}`, { ifAvailable: true }, async (lock) => {
      if (!lock) return undefined;
      entered = true;
      return fn();
    });
    if (!entered) throw new UploadBusyError();
    return result as T;
  } finally {
    running.delete(name);
  }
}

// --- Envío ---------------------------------------------------------------------

export interface UploadProgress {
  phase: 'players' | 'matches' | 'events' | 'verify';
  done: number;
  total: number;
}

export type StopReason = 'offline' | 'unauthorized' | 'forbidden' | 'conflict' | 'recorded_elsewhere' | 'rejected';

export interface UploadOutcome {
  /** «sent»: enviado sin comprobación completa (envío automático). */
  status: 'verified' | 'differences' | 'stopped' | 'sent';
  sent: { players: number; matches: number; events: number };
  /** Ya estaban en el servidor con el mismo contenido. */
  unchanged: number;
  stop?: { reason: StopReason; message: string; record: string };
  differences: string[];
}

export interface UploadDeps {
  api: Api;
  store: AccountStore;
  token: string;
  deviceId: string;
  /** Esperas entre reintentos de una misma operación ante fallos de red (ms). */
  retryDelays?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  onProgress?: (p: UploadProgress) => void;
  /**
   * Comprobar el resultado descargando el equipo (por defecto, sí). El envío
   * automático no lo hace en cada ráfaga: solo envía lo que ha cambiado.
   */
  verify?: boolean;
}

class StopUpload extends Error {
  constructor(
    readonly reason: StopReason,
    message: string,
    readonly record: string,
  ) {
    super(message);
  }
}

function stopFor(e: unknown, record: string): StopUpload {
  if (!(e instanceof RemoteError)) throw e;
  if (isTransient(e)) return new StopUpload('offline', 'Se ha perdido la conexión con el servidor.', record);
  if (e.kind === 'unauthorized') return new StopUpload('unauthorized', 'La sesión de este dispositivo ya no es válida.', record);
  if (e.kind === 'forbidden') return new StopUpload('forbidden', 'Este dispositivo no tiene permiso de entrenador en ese equipo.', record);
  if (e.code === 'match_recorded_elsewhere') return new StopUpload('recorded_elsewhere', e.message, record);
  if (e.kind === 'conflict') return new StopUpload('conflict', e.message, record);
  return new StopUpload('rejected', e.message, record);
}

/**
 * Envía un plan ya validado. Se detiene en el primer conflicto o rechazo; lo
 * confirmado hasta ese momento queda anotado, así que un nuevo envío continúa
 * donde se quedó sin repetir nada.
 */
export async function runUpload(plan: UploadPlan, deps: UploadDeps): Promise<UploadOutcome> {
  if (plan.problems.length > 0) throw new Error('El plan tiene problemas: no se puede enviar.');
  const remoteTeamId = plan.link.remoteTeamId;
  return withLock(remoteTeamId, async () => {
    const now = deps.now ?? (() => new Date());
    const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const delays = deps.retryDelays ?? [800, 2500];
    const sent = { players: 0, matches: 0, events: 0 };
    let unchanged = 0;

    async function send<T>(entity: SyncEntity, id: string, label: string, record: T, content: unknown, call: (op: { opId: string; teamId: string; baseVersion: number | null; record: T }) => Promise<OpResult>): Promise<void> {
      const hash = await sha256(stableJson(content));
      const meta = await deps.store.getMeta(entity, id);
      const known = meta && meta.remoteTeamId === remoteTeamId ? meta : null;
      if (known && known.hash === hash) {
        unchanged++;
        return;
      }
      const baseVersion = known?.version ?? null;
      const opId = (await sha256(`${deps.deviceId}|${entity}|${id}|${baseVersion ?? 'alta'}|${hash}`)).slice(0, 32);
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await call({ opId, teamId: remoteTeamId, baseVersion, record });
          await deps.store.saveMeta({ key: metaKey(entity, id), entity, entityId: id, remoteTeamId, version: res.version, hash, syncedAt: now().toISOString() });
          if (res.status === 'applied') sent[entity === 'player' ? 'players' : entity === 'match' ? 'matches' : 'events']++;
          else unchanged++;
          return;
        } catch (e) {
          const delay = delays[attempt];
          if (isTransient(e) && delay !== undefined) {
            await sleep(delay);
            continue;
          }
          throw stopFor(e, label);
        }
      }
    }

    try {
      const total = (phase: UploadProgress['phase'], n: number) => (done: number) => deps.onProgress?.({ phase, done, total: n });
      const pPlayers = total('players', plan.players.length);
      for (const [i, p] of plan.players.entries()) {
        const record = toRemotePlayer(p, remoteTeamId);
        await send('player', p.id, `Jugador ${p.number} · ${p.name}`, record, playerContent(record), (op) => deps.api.syncPlayer(deps.token, op));
        pPlayers(i + 1);
      }
      const pMatches = total('matches', plan.matches.length);
      for (const [i, m] of plan.matches.entries()) {
        const record = toRemoteMatch(m, remoteTeamId);
        await send('match', m.id, `Partido vs ${m.opponent} (${m.date})`, record, matchContent(record), (op) => deps.api.syncMatch(deps.token, op));
        pMatches(i + 1);
      }
      const pEvents = total('events', plan.events.length);
      for (const [i, e] of plan.events.entries()) {
        await send('event', e.id, `Acción del partido ${e.matchId.slice(0, 8)}`, e, eventContent(e), (op) => deps.api.syncEvent(deps.token, op));
        pEvents(i + 1);
      }
    } catch (e) {
      if (!(e instanceof StopUpload)) throw e;
      return { status: 'stopped', sent, unchanged, stop: { reason: e.reason, message: e.message, record: e.record }, differences: [] };
    }

    if (deps.verify === false) return { status: 'sent', sent, unchanged, differences: [] };
    deps.onProgress?.({ phase: 'verify', done: 0, total: 1 });
    let snapshot: TeamSnapshot;
    try {
      snapshot = await deps.api.snapshot(deps.token, remoteTeamId);
    } catch (e) {
      const stop = stopFor(e, 'Comprobación');
      return { status: 'stopped', sent, unchanged, stop: { reason: stop.reason, message: stop.message, record: stop.record }, differences: [] };
    }
    const metas = new Map((await deps.store.listMeta(remoteTeamId)).map((m) => [m.key, m.version]));
    const differences = compareWithServer(plan, snapshot, metas);
    deps.onProgress?.({ phase: 'verify', done: 1, total: 1 });
    return { status: differences.length === 0 ? 'verified' : 'differences', sent, unchanged, differences };
  });
}

// --- Comprobación ----------------------------------------------------------------

/** Mapa de estadísticas convertido en algo comparable. */
const statsJson = (s: ReturnType<typeof computeSeasonStats>) =>
  stableJson({ ...s, players: [...s.players.entries()].sort(([a], [b]) => a.localeCompare(b)) });

/**
 * Compara lo que hay en el servidor con lo que se ha enviado. Devuelve las
 * diferencias en lenguaje claro (vacío = todo coincide).
 */
export function compareWithServer(plan: UploadPlan, snapshot: TeamSnapshot, versions: ReadonlyMap<string, number>): string[] {
  const out: string[] = [];
  const remoteTeamId = plan.link.remoteTeamId;
  const version = (entity: SyncEntity, id: string, server: number, label: string) => {
    if (versions.get(metaKey(entity, id)) !== server) out.push(`${label}: la versión del servidor no coincide con la confirmada.`);
  };

  // Jugadores.
  const rPlayers = new Map(snapshot.players.map((p) => [p.player.id, p]));
  for (const p of plan.players) {
    const r = rPlayers.get(p.id);
    const label = `Jugador ${p.number} · ${p.name}`;
    if (!r) out.push(`${label}: no está en el servidor.`);
    else {
      if (stableJson(playerContent(r.player)) !== stableJson(playerContent(toRemotePlayer(p, remoteTeamId)))) out.push(`${label}: datos distintos en el servidor.`);
      version('player', p.id, r.version, label);
    }
    rPlayers.delete(p.id);
  }
  for (const r of rPlayers.values()) out.push(`En el servidor hay un jugador que no está en este equipo: ${r.player.number} · ${r.player.name}.`);

  // Partidos, resultados y acciones (también las borradas).
  const rMatches = new Map(snapshot.matches.map((m) => [m.match.id, m]));
  const rEvents = new Map<string, TeamSnapshot['events']>();
  for (const e of snapshot.events) rEvents.set(e.event.matchId, [...(rEvents.get(e.event.matchId) ?? []), e]);
  for (const m of plan.matches) {
    const label = `Partido vs ${m.opponent} (${m.date})`;
    const r = rMatches.get(m.id);
    rMatches.delete(m.id);
    if (!r) {
      out.push(`${label}: no está en el servidor.`);
      continue;
    }
    if (stableJson(matchContent(r.match)) !== stableJson(matchContent(toRemoteMatch(m, remoteTeamId)))) out.push(`${label}: datos del partido distintos en el servidor.`);
    version('match', m.id, r.version, label);
    // Partido eliminado: basta con que el servidor también lo tenga eliminado.
    if (m.deletedAt !== null) continue;
    const local = plan.events.filter((e) => e.matchId === m.id);
    const remote = rEvents.get(m.id) ?? [];
    const rById = new Map(remote.map((e) => [e.event.id, e]));
    let missing = 0;
    let different = 0;
    for (const e of local) {
      const re = rById.get(e.id);
      rById.delete(e.id);
      if (!re) missing++;
      else {
        if (stableJson(eventContent(re.event)) !== stableJson(eventContent(e))) different++;
        version('event', e.id, re.version, `${label}, acción`);
      }
    }
    if (missing) out.push(`${label}: faltan ${missing} acciones en el servidor.`);
    if (different) out.push(`${label}: ${different} acciones distintas en el servidor.`);
    if (rById.size) out.push(`${label}: el servidor tiene ${rById.size} acciones que no están en este dispositivo.`);
    const ls = computeMatchStats(m, local).score;
    const rs = computeMatchStats(r.match, remote.map((e) => e.event)).score;
    if (ls.own !== rs.own || ls.opponent !== rs.opponent) {
      out.push(`${label}: resultado distinto (${ls.own}–${ls.opponent} aquí, ${rs.own}–${rs.opponent} en el servidor).`);
    }
  }
  for (const r of rMatches.values()) {
    if (r.match.deletedAt === null) out.push(`En el servidor hay un partido que no está en este equipo: vs ${r.match.opponent} (${r.match.date}).`);
  }

  // Estadísticas acumuladas de la temporada.
  const localItems = plan.matches
    .filter((m) => m.deletedAt === null)
    .map((m) => ({ match: toRemoteMatch(m, remoteTeamId), events: plan.events.filter((e) => e.matchId === m.id) }));
  const remoteItems = snapshot.matches
    .filter((m) => m.match.deletedAt === null)
    .map(({ match }) => ({ match, events: (rEvents.get(match.id) ?? []).map((e) => e.event) }));
  if (statsJson(computeSeasonStats(localItems)) !== statsJson(computeSeasonStats(remoteItems))) {
    out.push('Las estadísticas acumuladas de la temporada no coinciden.');
  }
  return out;
}
