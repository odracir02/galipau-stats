import type { SquadEntry } from '../../domain/types';

export function playerLabel(squad: readonly SquadEntry[], playerId: string | null): string {
  if (playerId === null) return 'Sin asignar';
  const s = squad.find((x) => x.playerId === playerId);
  return s ? `${s.number} · ${s.name}` : 'Jugador desconocido';
}
