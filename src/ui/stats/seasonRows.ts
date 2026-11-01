// Filas de jugadores de «Temporada». Con la plantilla (consulta), se añaden los
// jugadores activos sin ninguna convocatoria en la temporada, sin estadísticas.
// Las cifras de los demás son las del motor, sin cambios.
import { isOfficial } from '../../domain/catalog';
import type { Player } from '../../domain/types';
import { emptyCounters, type MatchWithEvents, type SeasonStats } from '../../stats/engine';
import type { StatRow } from './StatTables';

export function seasonRows(
  stats: SeasonStats,
  /** Partidos de la temporada, sin filtrar (un convocado nunca se repite como «sin estadísticas»). */
  seasonItems: readonly MatchWithEvents[],
  roster?: readonly Player[],
): StatRow[] {
  const rows: StatRow[] = [...stats.players.values()].map((p) => ({ ...p.latest, matches: p.matches, counters: p.counters }));
  if (roster) {
    const convoked = new Set(seasonItems.flatMap((i) => i.match.squad.filter((s) => s.role !== 'official').map((s) => s.playerId)));
    for (const p of roster) {
      if (!p.active || isOfficial(p) || convoked.has(p.id)) continue;
      rows.push({ playerId: p.id, name: p.name, number: p.number, position: p.position, matches: 0, counters: emptyCounters() });
    }
  }
  return rows.sort((a, b) => a.number - b.number);
}
