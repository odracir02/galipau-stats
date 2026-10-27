import type { Repository } from '../data/repository';
import type { Id, Match, MatchEvent } from '../domain/types';
import type { MatchWithEvents } from '../stats/engine';

/** Partidos que cuentan para la temporada: los que se han empezado o tienen acciones. */
export function countsForSeason(match: Match, events: readonly MatchEvent[]): boolean {
  return match.status !== 'ready' || events.some((e) => e.deletedAt === null);
}

/**
 * Partidos del equipo con sus eventos, listos para el acumulado de temporada y
 * los rankings. Los partidos eliminados no se listan, así que no cuentan.
 */
export async function loadSeasonItems(repo: Repository, teamId: Id): Promise<MatchWithEvents[]> {
  const matches = await repo.listMatches(teamId);
  const withEvents = await Promise.all(matches.map(async (m) => ({ match: m, events: await repo.listEvents(m.id) })));
  return withEvents.filter(({ match, events }) => countsForSeason(match, events));
}
