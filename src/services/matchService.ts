// Gestión del partido: creación, cronómetro, estados y registro/corrección de
// eventos. Cada operación devuelve objetos nuevos (nunca muta los recibidos) y
// se persiste antes de devolverse.
import * as clock from '../clock/clock';
import type { Repository } from '../data/repository';
import { isLegacyKind, isTeamKind } from '../domain/catalog';
import { buildEvent, lastRecorded, type EventTiming } from '../domain/events';
import { monotonicIsoNow, newId } from '../domain/ids';
import type {
  EventPayload,
  Id,
  LocalDate,
  Match,
  MatchEvent,
  Player,
  ScoreAdjustment,
  SquadEntry,
  Venue,
} from '../domain/types';
import { assertValidEvent, ValidationError } from '../domain/validation';

export const DEFAULT_HALF_MINUTES = 30;

const isoNow = () => monotonicIsoNow();

// --- Creación ----------------------------------------------------------------

export interface NewMatchInput {
  teamId: Id;
  opponent: string;
  date: LocalDate;
  venue: Venue;
  season: string;
  playerIds: readonly Id[];
  halfMinutes?: number;
}

/** Convocatoria ordenada: porteros al final, cada grupo por dorsal. */
export function buildSquad(players: readonly Player[], playerIds: readonly Id[]): SquadEntry[] {
  const selected = new Set(playerIds);
  return players
    .filter((p) => selected.has(p.id))
    .map((p) => ({ playerId: p.id, name: p.name, number: p.number, position: p.position }))
    .sort((a, b) =>
      a.position === b.position ? a.number - b.number : a.position === 'goalkeeper' ? 1 : -1,
    );
}

/**
 * Crea el partido. El identificador lo genera la pantalla al abrirse, de modo que
 * una doble pulsación o un reintento devuelven el mismo partido, sin duplicarlo.
 */
export async function createMatch(repo: Repository, input: NewMatchInput, id: Id = newId()): Promise<Match> {
  const existing = await repo.getMatch(id);
  if (existing) return existing;

  const team = await repo.getTeam(input.teamId);
  if (!team) throw new ValidationError('El equipo no existe.');
  const opponent = input.opponent.trim();
  if (!opponent) throw new ValidationError('Indica el equipo contrario.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new ValidationError('Fecha no válida.');
  if (!input.season.trim()) throw new ValidationError('Indica la temporada.');

  const players = await repo.listPlayers(input.teamId);
  const squad = buildSquad(players, input.playerIds);
  if (squad.length === 0) throw new ValidationError('Selecciona al menos un convocado.');
  if (squad.length > team.maxSquad)
    throw new ValidationError(`Máximo ${team.maxSquad} convocados (hay ${squad.length}).`);
  if (new Set(squad.map((s) => s.number)).size !== squad.length)
    throw new ValidationError('Hay dorsales repetidos en la convocatoria.');

  const halfMinutes = input.halfMinutes ?? DEFAULT_HALF_MINUTES;
  if (!Number.isInteger(halfMinutes) || halfMinutes < 5 || halfMinutes > 60)
    throw new ValidationError('Duración de parte no válida.');

  const now = isoNow();
  const match: Match = {
    id,
    teamId: input.teamId,
    opponent,
    date: input.date,
    venue: input.venue,
    season: input.season.trim(),
    status: 'ready',
    halfMinutes,
    squad,
    clock: clock.initialClock(),
    scoreAdjustment: { own: 0, opponent: 0 },
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
    deletedAt: null,
  };
  await repo.saveMatch(match);
  return match;
}

/** Convocatoria del último partido del equipo, para proponerla de nuevo. */
export async function previousSquadIds(repo: Repository, teamId: Id): Promise<Id[]> {
  const [last] = await repo.listMatches(teamId);
  return last ? last.squad.map((s) => s.playerId) : [];
}

async function persist(repo: Repository, match: Match): Promise<Match> {
  await repo.saveMatch(match);
  return match;
}

function withChanges(match: Match, changes: Partial<Match>): Match {
  return { ...match, ...changes, updatedAt: isoNow() };
}

// --- Cronómetro y estados ----------------------------------------------------

/**
 * Botón principal del cronómetro (una pulsación, sin confirmación):
 * - preparado → en curso y en marcha;
 * - descanso → empieza la 2.ª parte en 30:00 y en marcha;
 * - en curso → pausa / reanuda.
 */
export async function toggleClock(repo: Repository, match: Match, now = Date.now()): Promise<Match> {
  if (match.status === 'finished') throw new ValidationError('El partido está finalizado.');
  if (match.status === 'halftime') {
    const firstHalfEnd = clock.elapsedMs(match.clock, now);
    const second = clock.start(clock.startSecondHalf(match.halfMinutes, firstHalfEnd), now);
    return persist(repo, withChanges(match, { status: 'in_progress', clock: second }));
  }
  return persist(
    repo,
    withChanges(match, { status: 'in_progress', clock: clock.toggle(match.clock, now) }),
  );
}

export async function adjustClock(repo: Repository, match: Match, timeMs: number, now = Date.now()): Promise<Match> {
  return persist(repo, withChanges(match, { clock: clock.setTime(match.clock, timeMs, now) }));
}

export async function shiftClock(repo: Repository, match: Match, deltaMs: number, now = Date.now()): Promise<Match> {
  return persist(repo, withChanges(match, { clock: clock.shift(match.clock, deltaMs, now) }));
}

/** Descanso: detiene el reloj al final de la 1.ª parte. */
export async function startHalftime(repo: Repository, match: Match, now = Date.now()): Promise<Match> {
  if (match.clock.period !== 1 || match.status === 'finished')
    throw new ValidationError('El descanso solo puede iniciarse durante la primera parte.');
  return persist(repo, withChanges(match, { status: 'halftime', clock: clock.pause(match.clock, now) }));
}

export async function finishMatch(repo: Repository, match: Match, now = Date.now()): Promise<Match> {
  if (match.status === 'finished') return match;
  return persist(
    repo,
    withChanges(match, {
      status: 'finished',
      clock: clock.pause(match.clock, now),
      finishedAt: new Date(now).toISOString(),
    }),
  );
}

/** Reabre un partido finalizado; el reloj queda parado donde estaba. */
export async function reopenMatch(repo: Repository, match: Match): Promise<Match> {
  if (match.status !== 'finished') return match;
  return persist(repo, withChanges(match, { status: 'in_progress', finishedAt: null }));
}

/**
 * Elimina un partido (borrado lógico). Deja de aparecer en el historial, en
 * «partido en curso» y en la temporada; sus eventos se conservan intactos pero
 * no cuentan porque su partido ya no se lista. El reloj queda parado. Repetir la
 * operación no cambia nada. La marca `deletedAt` permitirá restaurarlo y viajará
 * como «lápida» en la sincronización para que no reaparezca.
 */
export async function deleteMatch(repo: Repository, match: Match, now = Date.now()): Promise<Match> {
  const current = (await repo.getMatch(match.id)) ?? match;
  if (current.deletedAt !== null) return current;
  return persist(repo, withChanges(current, { deletedAt: isoNow(), clock: clock.pause(current.clock, now) }));
}

/**
 * Corrección manual del marcador. Se guarda aparte de los eventos: no crea
 * lanzamientos ni atribuye goles, y por tanto no altera ninguna eficacia.
 */
export async function setScoreAdjustment(repo: Repository, match: Match, adjustment: ScoreAdjustment): Promise<Match> {
  if (!Number.isInteger(adjustment.own) || !Number.isInteger(adjustment.opponent))
    throw new ValidationError('Ajuste de marcador no válido.');
  return persist(repo, withChanges(match, { scoreAdjustment: { ...adjustment } }));
}

/** Momento de partido actual, para sellar un evento. */
export function currentTiming(match: Match, now = Date.now()): EventTiming {
  return { period: match.clock.period, matchTimeMs: Math.floor(clock.elapsedMs(match.clock, now)) };
}

// --- Eventos -----------------------------------------------------------------

/**
 * Registra una acción. Se guarda en el dispositivo antes de devolverse. Con el
 * mismo `id`, repetir la llamada no duplica el evento.
 */
export async function recordEvent(
  repo: Repository,
  match: Match,
  payload: EventPayload,
  playerId: Id | null,
  timing: EventTiming,
  id: Id = newId(),
): Promise<MatchEvent> {
  const existing = await repo.getEvent(id);
  if (existing) return existing;
  if (isLegacyKind(payload.kind)) throw new ValidationError('Esta acción ya no se registra.');
  if (isTeamKind(payload.kind) && playerId !== null)
    throw new ValidationError('El golpe franco es del equipo: no se asigna a ningún jugador.');
  const event = buildEvent({ id, matchId: match.id, payload, playerId, timing, nowIso: isoNow() });
  assertValidEvent(match, event);
  await repo.saveEvent(event);
  return event;
}

export interface EventChanges {
  payload?: EventPayload;
  playerId?: Id | null;
  period?: EventTiming['period'];
  matchTimeMs?: number;
}

/**
 * Corrige una acción. Se sustituye el evento completo por una versión nueva con
 * el mismo identificador; las estadísticas se recalculan solas desde los eventos.
 */
export async function updateEvent(
  repo: Repository,
  match: Match,
  event: MatchEvent,
  changes: EventChanges,
): Promise<MatchEvent> {
  // Un evento histórico puede conservar su categoría; ninguno puede pasar a ella.
  if (changes.payload && isLegacyKind(changes.payload.kind) && changes.payload.kind !== event.kind)
    throw new ValidationError('Esta acción ya no se registra.');
  const base = buildEvent({
    id: event.id,
    matchId: event.matchId,
    payload: changes.payload ?? event,
    playerId: changes.playerId === undefined ? event.playerId : changes.playerId,
    timing: {
      period: changes.period ?? event.period,
      matchTimeMs: changes.matchTimeMs ?? event.matchTimeMs,
    },
    nowIso: isoNow(),
  });
  // Las acciones de equipo no se asignan a jugadores. Solo un golpe franco antiguo,
  // de cuando sí se asignaban, puede conservar su jugador.
  if (isTeamKind(base.kind) && base.playerId !== null && !(event.kind === base.kind && event.playerId === base.playerId))
    throw new ValidationError('El golpe franco es del equipo: no se asigna a ningún jugador.');
  // Solo se conservan los campos del nuevo contenido (al cambiar de tipo de acción
  // no deben sobrevivir subtipos o resultados del anterior).
  const updated = stripForeignFields({ ...base, createdAt: event.createdAt, deletedAt: event.deletedAt });
  // La marca de sanción adicional sigue mientras siga siendo una sanción del mismo jugador.
  delete updated.addsToPrevious;
  if (event.addsToPrevious && isSanction(updated.kind) && updated.playerId === event.playerId)
    updated.addsToPrevious = true;
  assertValidEvent(match, updated);
  await repo.saveEvent(updated);
  return updated;
}

function stripForeignFields(e: MatchEvent): MatchEvent {
  const copy = { ...e } as Record<string, unknown>;
  if (e.kind !== 'shot' && e.kind !== 'gk_shot') {
    delete copy.shotType;
    delete copy.result;
  }
  if (e.kind !== 'turnover') delete copy.turnoverType;
  return copy as unknown as MatchEvent;
}

const isSanction = (kind: MatchEvent['kind']) => kind === 'exclusion' || kind === 'red';

/**
 * Marca (o desmarca) una exclusión o roja como sanción adicional antes de
 * reanudar: su inferioridad se suma a la anterior del mismo jugador (4 minutos)
 * en lugar de contarse aparte. No cambia ninguna estadística.
 */
export async function setAddsToPrevious(repo: Repository, event: MatchEvent, value: boolean): Promise<MatchEvent> {
  if (!isSanction(event.kind) || event.playerId === null)
    throw new ValidationError('Solo una exclusión o roja de un jugador puede sumarse a una inferioridad anterior.');
  if (Boolean(event.addsToPrevious) === value) return event;
  const updated: MatchEvent = { ...event, updatedAt: isoNow() };
  if (value) updated.addsToPrevious = true;
  else delete updated.addsToPrevious;
  await repo.saveEvent(updated);
  return updated;
}

/** Borrado lógico: el evento deja de contar pero queda constancia de él. */
export async function deleteEvent(repo: Repository, event: MatchEvent): Promise<MatchEvent> {
  if (event.deletedAt !== null) return event;
  const now = isoNow();
  const deleted: MatchEvent = { ...event, deletedAt: now, updatedAt: now };
  await repo.saveEvent(deleted);
  return deleted;
}

/** Deshacer: anula la última acción registrada. Devuelve la acción anulada. */
export async function undoLast(repo: Repository, events: readonly MatchEvent[]): Promise<MatchEvent | null> {
  const last = lastRecorded(events);
  return last ? deleteEvent(repo, last) : null;
}
