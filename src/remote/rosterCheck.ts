// Coincidencias de dorsal entre la plantilla de este dispositivo y la del club.
// Solo identifica posibles coincidencias: un mismo dorsal (y, a veces, el mismo
// nombre) no demuestra que sea la misma persona. Nunca une ni cambia nada.
import { isOfficial } from '../domain/catalog';
import type { Id, Player } from '../domain/types';

export interface RosterCoincidence {
  number: number;
  local: { id: Id; name: string };
  club: { id: Id; name: string };
  /** Mismo nombre (sin tildes ni mayúsculas): más probable que sea la misma persona, pero no seguro. */
  sameName: boolean;
}

const fold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Fichas activas de jugadores (sin cuerpo técnico) de aquí y del club con el
 * mismo dorsal y distinto identificador. Las que comparten identificador son la
 * misma ficha, no una coincidencia.
 */
export function rosterCoincidences(local: readonly Pick<Player, 'id' | 'name' | 'number' | 'active' | 'role'>[], club: readonly Pick<Player, 'id' | 'name' | 'number' | 'active' | 'role'>[]): RosterCoincidence[] {
  const clubIds = new Set(club.map((p) => p.id));
  const clubByNumber = new Map<number, Pick<Player, 'id' | 'name'>>();
  for (const p of club) if (p.active && !isOfficial(p)) clubByNumber.set(p.number, p);
  const out: RosterCoincidence[] = [];
  for (const p of local) {
    if (!p.active || isOfficial(p) || clubIds.has(p.id)) continue;
    const other = clubByNumber.get(p.number);
    if (!other) continue;
    out.push({ number: p.number, local: { id: p.id, name: p.name }, club: { id: other.id, name: other.name }, sameName: fold(p.name) === fold(other.name) });
  }
  return out.sort((a, b) => a.number - b.number);
}
