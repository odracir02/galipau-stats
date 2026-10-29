// Inferioridades del equipo: cuenta atrás bajo el cronómetro por cada sanción
// que deja al equipo con un jugador menos. No se guarda nada: se deriva de los
// eventos y del cronómetro, así que se pausa con el reloj, sobrevive a cerrar la
// app y se corrige sola si la sanción se edita, se deshace o se elimina.
//
// Se separa la sanción individual (el evento: exclusión o roja, que cuenta en
// las estadísticas) del periodo de inferioridad del equipo:
// - Cada exclusión abre una inferioridad de 2 minutos (también la 3.ª, que
//   además descalifica: la roja por acumulación no abre otra).
// - Una roja directa abre una inferioridad de 2 minutos. Una roja registrada a
//   un jugador ya descalificado no abre ninguna (no suma otra roja).
// - Sanción adicional antes de reanudar el juego: si el registrador la marca
//   (`addsToPrevious`), no abre otra inferioridad, sino que suma 2 minutos a la
//   inferioridad anterior del mismo jugador (p. ej. 4 minutos). No se deduce
//   nunca sola: dos exclusiones seguidas del mismo jugador no se encadenan.
//
// El tiempo cumplido es tiempo oficial de partido, no tiempo real. Si la
// inferioridad atraviesa el descanso, se suma lo cumplido al final de la 1.ª
// parte (hasta donde llegó realmente el reloj) y lo cumplido desde el inicio de
// la 2.ª.
import { elapsedMs, periodEndMs, periodStartMs } from '../clock/clock';
import { compareEvents } from '../domain/events';
import type { Id, Match, MatchEvent, Period } from '../domain/types';
import { redCards } from './discipline';

/** Inferioridad por cada sanción (y lo que suma una sanción adicional). */
export const REDUCTION_MS = 2 * 60_000;

/** Origen de la inferioridad: exclusión, 3.ª exclusión (roja por acumulación) o roja directa. */
export type ReductionKind = 'exclusion' | 'accumulated' | 'red';

export interface ActiveReduction {
  /** Sanción que la abre (identifica la tarjeta). */
  eventId: Id;
  /** null = sanción pendiente de atribuir. */
  playerId: Id | null;
  kind: ReductionKind;
  /** Duración total: 2 min, o 4 min (u otra suma de 2) con sanciones adicionales. */
  durationMs: number;
  remainingMs: number;
  /** Sanciones que la forman: la que la abre y las adicionales sumadas. */
  eventIds: Id[];
}

/** Momento de partido «actual» para las cuentas atrás. */
export interface MatchMoment {
  period: Period;
  timeMs: number;
}

/** Fin real de la 1.ª parte; en partidos anteriores a este dato, su final nominal. */
function firstHalfEnd(match: Pick<Match, 'clock' | 'halfMinutes'>): number {
  return match.clock.firstHalfEndMs ?? periodEndMs(1, match.halfMinutes);
}

/**
 * Tiempo de partido cumplido desde la sanción hasta `now`. Negativo si la
 * sanción está registrada en un momento posterior al del reloj.
 */
export function servedMs(
  start: Pick<MatchEvent, 'period' | 'matchTimeMs'>,
  now: MatchMoment,
  match: Pick<Match, 'clock' | 'halfMinutes'>,
): number {
  if (start.period === now.period) return now.timeMs - start.matchTimeMs;
  if (start.period > now.period) return -1;
  // De la 1.ª parte a la 2.ª: lo que quedaba de la 1.ª más lo jugado de la 2.ª.
  const inFirst = Math.max(0, firstHalfEnd(match) - start.matchTimeMs);
  const inSecond = Math.max(0, now.timeMs - periodStartMs(2, match.halfMinutes));
  return inFirst + inSecond;
}

interface Reduction extends Omit<ActiveReduction, 'remainingMs'> {
  start: MatchEvent;
}

/** Todas las inferioridades del partido (activas o no), en orden cronológico. */
export function teamReductions(events: readonly MatchEvent[]): Reduction[] {
  const live = events.filter((e) => e.deletedAt === null).sort(compareEvents);
  const cards = new Map(redCards(live).map((c) => [c.triggerEventId, c.type]));
  const reductions: Reduction[] = [];
  for (const e of live) {
    if (e.kind !== 'exclusion' && e.kind !== 'red') continue;
    const kind: ReductionKind =
      e.kind === 'red' ? 'red' : cards.get(e.id) === 'accumulated' ? 'accumulated' : 'exclusion';
    // Sanción adicional marcada: suma a la inferioridad anterior del mismo jugador.
    if (e.addsToPrevious && e.playerId !== null) {
      const previous = reductions.findLast((r) => r.playerId === e.playerId);
      if (previous) {
        previous.durationMs += REDUCTION_MS;
        previous.eventIds.push(e.id);
        // Si la adicional descalifica, la inferioridad pasa a identificarse como roja.
        if (previous.kind === 'exclusion') previous.kind = kind;
        continue;
      }
    }
    // Roja a un jugador ya descalificado: sin inferioridad propia.
    if (e.kind === 'red' && cards.get(e.id) !== 'direct') continue;
    reductions.push({ eventId: e.id, playerId: e.playerId, kind, durationMs: REDUCTION_MS, eventIds: [e.id], start: e });
  }
  return reductions;
}

/**
 * Inferioridades que siguen cumpliéndose en el instante `nowWall`. Solo con el
 * partido en juego o en el descanso: en un partido preparado (registro sin
 * reloj, p. ej. de un partido ya jugado) o finalizado no hay cuenta atrás.
 */
export function activeReductions(
  match: Pick<Match, 'status' | 'clock' | 'halfMinutes'>,
  events: readonly MatchEvent[],
  nowWall: number,
): ActiveReduction[] {
  if (match.status !== 'in_progress' && match.status !== 'halftime') return [];
  const now: MatchMoment = { period: match.clock.period, timeMs: elapsedMs(match.clock, nowWall) };
  const active: ActiveReduction[] = [];
  for (const { start, ...r } of teamReductions(events)) {
    const served = servedMs(start, now, match);
    if (served < 0 || served >= r.durationMs) continue;
    active.push({ ...r, remainingMs: r.durationMs - served });
  }
  // La que antes termina, primero.
  return active.sort((a, b) => a.remainingMs - b.remainingMs);
}

/**
 * Sanciones de un jugador que pueden marcarse como «adicional antes de
 * reanudar» para sumarse a su inferioridad activa: las posteriores a la que la
 * abre. Se ofrecen en la tarjeta de la inferioridad, nunca al registrar.
 */
export function additionalCandidates(
  events: readonly MatchEvent[],
  reduction: Pick<ActiveReduction, 'eventId' | 'playerId'>,
): MatchEvent[] {
  if (reduction.playerId === null) return [];
  const live = events.filter((e) => e.deletedAt === null).sort(compareEvents);
  const first = live.findIndex((e) => e.id === reduction.eventId);
  if (first < 0) return [];
  return live
    .slice(first + 1)
    .filter((e) => (e.kind === 'exclusion' || e.kind === 'red') && e.playerId === reduction.playerId);
}
