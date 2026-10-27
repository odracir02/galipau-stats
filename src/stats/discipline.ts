// Descalificaciones (tarjetas rojas). Se derivan de los eventos, nunca se guardan:
// - Roja directa: un evento `red`.
// - Roja por acumulación: la tercera exclusión de un jugador en el partido.
// Un jugador solo puede ser descalificado una vez por partido; la causa es la que
// ocurre primero en el tiempo de partido. Una roja registrada cuando ya estaba
// descalificado no suma otra (evita duplicar la roja automática).
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

/** Todas las tarjetas rojas del partido, en orden cronológico. */
export function redCards(events: readonly MatchEvent[]): RedCard[] {
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
    } else if (e.kind === 'exclusion' && e.playerId !== null) {
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

/** Descalificación de cada jugador (como mucho una por partido). */
export function disqualifications(events: readonly MatchEvent[]): Map<Id, RedCard> {
  const map = new Map<Id, RedCard>();
  for (const card of redCards(events)) if (card.playerId !== null) map.set(card.playerId, card);
  return map;
}

/**
 * Convocados disponibles para registrar acciones nuevas en directo: los
 * descalificados dejan de aparecer, aunque siguen en la convocatoria, la
 * cronología y las estadísticas, y pueden recibir acciones olvidadas desde
 * el editor.
 */
export function availableForNewActions(squad: readonly SquadEntry[], events: readonly MatchEvent[]): SquadEntry[] {
  const out = disqualifications(events);
  return squad.filter((s) => !out.has(s.playerId));
}
