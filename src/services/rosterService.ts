// Corrección de la plantilla: fichas repetidas por error (p. ej. la misma
// jugadora dada de alta dos veces, con el mismo dorsal). Nunca se decide por
// nombre ni por dorsal: el entrenador elige qué ficha borra o qué dos une.
//
// - Borrar: solo una ficha que nunca llegó al club y que no aparece en ninguna
//   convocatoria ni acción (no hay nada que conservar).
// - Unir: la ficha que nunca llegó al club se funde en la otra; sus
//   convocatorias y acciones pasan a la que se conserva, en una sola
//   transacción. Una ficha que ya está en el club no se puede borrar (el club no
//   admite borrar fichas): se da de baja (inactiva) o se conserva al unir.
import type { Repository } from '../data/repository';
import { isOfficial } from '../domain/catalog';
import { monotonicIsoNow } from '../domain/ids';
import type { Id, Match, MatchEvent, Player, SquadEntry } from '../domain/types';
import { assertValidEvent, ValidationError } from '../domain/validation';

/** Dónde aparece una ficha: partidos (también eliminados) y acciones (también anuladas). */
export interface CardActivity {
  matches: number;
  events: number;
}

/** ¿La ficha está ya en el club? (lo responde quien conoce la sincronización). */
export type IsOnClub = (playerId: Id) => Promise<boolean>;

const label = (p: Pick<Player, 'name' | 'number' | 'role'>) => (isOfficial(p) ? p.name : `${p.number} · ${p.name}`);

/** Partidos y acciones de un equipo, incluidos los eliminados y anulados (una lectura coherente). */
async function teamRecords(repo: Repository, teamId: Id): Promise<{ players: Player[]; matches: Match[]; events: MatchEvent[] }> {
  const all = await repo.readAll();
  const matches = all.matches.filter((m) => m.teamId === teamId);
  const ids = new Set(matches.map((m) => m.id));
  return { players: all.players.filter((p) => p.teamId === teamId), matches, events: all.events.filter((e) => ids.has(e.matchId)) };
}

function activityOf(playerId: Id, matches: readonly Match[], events: readonly MatchEvent[]): CardActivity {
  return {
    matches: matches.filter((m) => m.squad.some((s) => s.playerId === playerId)).length,
    events: events.filter((e) => e.playerId === playerId).length,
  };
}

/** Actividad de cada ficha del equipo (para explicar qué se puede hacer con ella). */
export async function cardActivity(repo: Repository, teamId: Id): Promise<Map<Id, CardActivity>> {
  const { players, matches, events } = await teamRecords(repo, teamId);
  return new Map(players.map((p) => [p.id, activityOf(p.id, matches, events)]));
}

/** Dorsales repetidos entre jugadores activos (el cuerpo técnico no tiene dorsal). */
export function duplicateNumbers(players: readonly Player[]): { number: number; players: Player[] }[] {
  const byNumber = new Map<number, Player[]>();
  for (const p of players) if (p.active && !isOfficial(p)) byNumber.set(p.number, [...(byNumber.get(p.number) ?? []), p]);
  return [...byNumber.entries()]
    .filter(([, list]) => list.length > 1)
    .sort(([a], [b]) => a - b)
    .map(([number, list]) => ({ number, players: list }));
}

/**
 * Borra una ficha. Solo si nunca llegó al club y no aparece en ninguna
 * convocatoria ni acción: no se pierde nada. Si no, explica la alternativa.
 */
export async function deletePlayerCard(repo: Repository, player: Player, isOnClub: IsOnClub): Promise<void> {
  if (await isOnClub(player.id)) {
    throw new ValidationError(`${label(player)} ya está en el club y no se puede borrar: desmarca «Activo en la plantilla» para darla de baja, o únela con la otra ficha.`);
  }
  const { matches, events } = await teamRecords(repo, player.teamId);
  const used = activityOf(player.id, matches, events);
  if (used.matches > 0 || used.events > 0) {
    throw new ValidationError(`${label(player)} aparece en ${used.matches} ${used.matches === 1 ? 'partido' : 'partidos'}: no se puede borrar. Si es la misma persona que otra ficha, únelas.`);
  }
  await repo.saveTogether({ deletePlayers: [player.id] });
}

export interface MergePlan {
  /** Ficha que se conserva (la que ya está en el club, si alguna lo está). */
  keep: Player;
  /** Ficha que desaparece: sus convocatorias y acciones pasan a `keep`. */
  remove: Player;
  matches: Match[];
  events: MatchEvent[];
}

/**
 * Qué pasaría al unir dos fichas, sin escribir nada. Se conserva la que ya está
 * en el club; si ninguna lo está, `preferKeep`. Comprueba que el resultado sea
 * válido: que las acciones sigan siendo de un convocado con la posición
 * adecuada en cada partido y que ninguna convocatoria repita dorsal.
 */
export async function planMerge(repo: Repository, a: Player, b: Player, isOnClub: IsOnClub, preferKeep: Player = a): Promise<MergePlan> {
  if (a.id === b.id) throw new ValidationError('Es la misma ficha.');
  if (a.teamId !== b.teamId) throw new ValidationError('Las dos fichas deben ser del mismo equipo.');
  if (isOfficial(a) || isOfficial(b)) throw new ValidationError('Solo se pueden unir fichas de jugadores.');
  const [aOnClub, bOnClub] = await Promise.all([isOnClub(a.id), isOnClub(b.id)]);
  if (aOnClub && bOnClub) {
    throw new ValidationError('Las dos fichas ya están en el club: no se pueden unir desde la aplicación. Da de baja la que sobre (desmarca «Activo en la plantilla»).');
  }
  const keep = aOnClub ? a : bOnClub ? b : preferKeep.id === b.id ? b : a;
  const remove = keep.id === a.id ? b : a;

  const { matches, events } = await teamRecords(repo, keep.teamId);
  const now = monotonicIsoNow();
  const changedMatches: Match[] = [];
  for (const m of matches) {
    const old = m.squad.find((s) => s.playerId === remove.id);
    if (!old) continue;
    const both = m.squad.some((s) => s.playerId === keep.id);
    // En el partido conserva su copia (nombre y dorsal de entonces), ya como la ficha que queda.
    const squad: SquadEntry[] = both ? m.squad.filter((s) => s.playerId !== remove.id) : m.squad.map((s) => (s.playerId === remove.id ? { ...s, playerId: keep.id } : s));
    const numbers = squad.filter((s) => !isOfficial(s)).map((s) => s.number);
    if (new Set(numbers).size !== numbers.length) {
      throw new ValidationError(`En el partido contra ${m.opponent} quedaría un dorsal repetido: corrige antes esa convocatoria.`);
    }
    changedMatches.push({ ...m, squad, updatedAt: now });
  }
  const changedEvents = events.filter((e) => e.playerId === remove.id).map((e) => ({ ...e, playerId: keep.id, updatedAt: now }));

  // Todas las acciones de los partidos tocados deben seguir siendo válidas.
  const byId = new Map(changedMatches.map((m) => [m.id, m]));
  const finalEvents = new Map(events.map((e) => [e.id, e]));
  for (const e of changedEvents) finalEvents.set(e.id, e);
  for (const e of finalEvents.values()) {
    const m = byId.get(e.matchId);
    if (!m) continue;
    try {
      assertValidEvent(m, e);
    } catch (err) {
      if (err instanceof ValidationError) {
        throw new ValidationError(`En el partido contra ${m.opponent}, una acción dejaría de ser válida (${err.message}). Revisa las posiciones antes de unir.`);
      }
      throw err;
    }
  }
  return { keep, remove, matches: changedMatches, events: changedEvents };
}

/** Une dos fichas según `planMerge`, en una sola transacción: o todo o nada. */
export async function mergePlayerCards(repo: Repository, plan: MergePlan, isOnClub: IsOnClub): Promise<Player> {
  // Se vuelve a comprobar justo antes de escribir (la ficha que se borra no puede estar en el club).
  if (await isOnClub(plan.remove.id)) throw new ValidationError('La ficha que se iba a borrar ya está en el club: vuelve a intentarlo.');
  await repo.saveTogether({ matches: plan.matches, events: plan.events, deletePlayers: [plan.remove.id] });
  return plan.keep;
}
