// Cuerpo técnico en las estadísticas: sus sanciones van aparte y no tiene
// estadísticas individuales.
import type { Id, SquadEntry } from '../../domain/types';
import type { Counters, OfficialSanctions, SanctionLine } from '../../stats/engine';
import type { StatRow } from './StatTables';

/** Sanciones del cuerpo técnico para mostrarlas: el total y, en un partido, de cada uno. */
export interface StaffSanctions {
  total: SanctionLine;
  people: { playerId: Id; name: string; line: SanctionLine }[];
}

/** Sanciones del cuerpo técnico de un partido, con el nombre de cada oficial convocado. */
export function staffOfMatch(squad: readonly SquadEntry[], officials: OfficialSanctions): StaffSanctions {
  const people = squad
    .filter((s) => officials.byOfficial.has(s.playerId))
    .map((s) => ({ playerId: s.playerId, name: s.name, line: officials.byOfficial.get(s.playerId)! }));
  return { total: officials, people };
}

/** Filas de jugadores: el cuerpo técnico no tiene estadísticas individuales. */
export function playerRows(squad: readonly SquadEntry[], players: ReadonlyMap<Id, Counters>): StatRow[] {
  return squad.filter((s) => players.has(s.playerId)).map((s) => ({ ...s, counters: players.get(s.playerId)! }));
}
