// Descalificaciones (tarjetas rojas). Se derivan de los eventos, nunca se guardan:
// - Roja directa: un evento `red`.
// - Roja por acumulación: la tercera exclusión de un jugador en el partido.
// Un jugador solo puede ser descalificado una vez por partido; la causa es la que
// ocurre primero en el tiempo de partido. Una roja registrada cuando ya estaba
// descalificado no suma otra (evita duplicar la roja automática).
// El cuerpo técnico no tiene roja por acumulación (la 3.ª exclusión es una regla
// de jugadores): sus exclusiones no cuentan para ella; su roja directa sí vale.
import { isOfficial } from '../domain/catalog';
import { compareEvents } from '../domain/events';
import type { Id, MatchEvent, Period, SquadEntry } from '../domain/types';

export const EXCLUSIONS_FOR_DISQUALIFICATION = 3;

export type RedCardType = 'direct' | 'accumulated';

export interface RedCard {
  /** null = roja directa pendiente de atribución. */
  playerId: Id | null;
  type: RedCardType;
  /** Evento que la provoca: la roja directa o la tercera exclusión. */
  triggerEventId: Id;
  period: Period;
  matchTimeMs: number;
}

const cardFrom = (e: MatchEvent, type: RedCardType): RedCard => ({
  playerId: e.playerId,
  type,
  triggerEventId: e.id,
  period: e.period,
  matchTimeMs: e.matchTimeMs,
});

const NONE: ReadonlySet<Id> = new Set();

/** Miembros del cuerpo técnico de una convocatoria. */
export function officialIds(squad: readonly SquadEntry[]): ReadonlySet<Id> {
  return new Set(squad.filter(isOfficial).map((s) => s.playerId));
}

/** Todas las tarjetas rojas del partido, en orden cronológico. `officials`: sin acumulación. */
export function redCards(events: readonly MatchEvent[], officials: ReadonlySet<Id> = NONE): RedCard[] {
  const live = events.filter((e) => e.deletedAt === null).sort(compareEvents);
  const exclusions = new Map<Id, number>();
  const disqualified = new Set<Id>();
  const cards: RedCard[] = [];

  for (const e of live) {
    if (e.kind === 'red') {
      if (e.playerId === null) cards.push(cardFrom(e, 'direct'));
      else if (!disqualified.has(e.playerId)) {
        disqualified.add(e.playerId);
        cards.push(cardFrom(e, 'direct'));
      }
    } else if (e.kind === 'exclusion' && e.playerId !== null && !officials.has(e.playerId)) {
      const n = (exclusions.get(e.playerId) ?? 0) + 1;
      exclusions.set(e.playerId, n);
      if (n === EXCLUSIONS_FOR_DISQUALIFICATION && !disqualified.has(e.playerId)) {
        disqualified.add(e.playerId);
        cards.push(cardFrom(e, 'accumulated'));
      }
    }
  }
  return cards;
}

/** Descalificación de cada jugador u oficial (como mucho una por partido). */
export function disqualifications(events: readonly MatchEvent[], officials: ReadonlySet<Id> = NONE): Map<Id, RedCard> {
  const map = new Map<Id, RedCard>();
  for (const card of redCards(events, officials)) if (card.playerId !== null) map.set(card.playerId, card);
  return map;
}

/**
 * Convocados disponibles para registrar acciones nuevas en directo: los
 * descalificados dejan de aparecer, aunque siguen en la convocatoria, la
 * cronología y las estadísticas, y pueden recibir acciones olvidadas desde
 * el editor.
 */
export function availableForNewActions(squad: readonly SquadEntry[], events: readonly MatchEvent[]): SquadEntry[] {
  const out = disqualifications(events, officialIds(squad));
  return squad.filter((s) => !out.has(s.playerId));
}

/** Compara dos momentos de partido: negativo si `a` es anterior a `b`. */
function compareTiming(a: Pick<RedCard, 'period' | 'matchTimeMs'>, b: Pick<RedCard, 'period' | 'matchTimeMs'>): number {
  return a.period - b.period || a.matchTimeMs - b.matchTimeMs;
}

/**
 * Si `candidate` (una acción nueva o corregida) se atribuye a un jugador que en
 * ese momento ya estaba descalificado, devuelve su descalificación; si no, null.
 * Se calcula con el evento ya colocado en el partido (sustituyendo su versión
 * anterior), de modo que corregir la propia 3.ª exclusión o la roja se evalúa
 * con la situación resultante. Solo informa: no bloquea ni cambia estadísticas.
 */
export function actionAfterDisqualification(
  events: readonly MatchEvent[],
  candidate: MatchEvent,
  officials: ReadonlySet<Id> = NONE,
): RedCard | null {
  if (candidate.playerId === null || candidate.deletedAt !== null) return null;
  const others = events.filter((e) => e.id !== candidate.id);
  const card = disqualifications([...others, candidate], officials).get(candidate.playerId);
  if (!card || card.triggerEventId === candidate.id) return null;
  return compareTiming(candidate, card) > 0 ? card : null;
}
