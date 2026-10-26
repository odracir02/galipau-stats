import type { Repository } from '../data/repository';
import { newId } from '../domain/ids';
import type { Id, Player, Position, Team } from '../domain/types';
import {
  assertUniqueNumber,
  assertValidPlayerFields,
  assertValidTeamCode,
  normalizeTeamCode,
  ValidationError,
} from '../domain/validation';

export const DEFAULT_MAX_SQUAD = 16;

export interface TeamInput {
  name: string;
  code: string;
  season: string;
  maxSquad: number;
}

function validateTeam(input: TeamInput): TeamInput {
  const name = input.name.trim();
  const season = input.season.trim();
  const code = normalizeTeamCode(input.code);
  if (!name) throw new ValidationError('El nombre del equipo es obligatorio.');
  if (!season) throw new ValidationError('La temporada es obligatoria.');
  assertValidTeamCode(code);
  if (!Number.isInteger(input.maxSquad) || input.maxSquad < 1 || input.maxSquad > 40)
    throw new ValidationError('El máximo de convocados debe estar entre 1 y 40.');
  return { name, season, code, maxSquad: input.maxSquad };
}

async function assertCodeFree(repo: Repository, code: string, ownId: Id | null): Promise<void> {
  const teams = await repo.listTeams();
  if (teams.some((t) => t.code === code && t.id !== ownId))
    throw new ValidationError(`Ya existe un equipo con el código ${code}.`);
}

export async function createTeam(repo: Repository, input: TeamInput, id: Id = newId()): Promise<Team> {
  const existing = await repo.getTeam(id);
  if (existing) return existing; // Reintento de la misma operación.
  const clean = validateTeam(input);
  await assertCodeFree(repo, clean.code, null);
  const now = new Date().toISOString();
  const team: Team = { id, ...clean, createdAt: now, updatedAt: now };
  await repo.saveTeam(team);
  return team;
}

export async function updateTeam(repo: Repository, team: Team, input: TeamInput): Promise<Team> {
  const clean = validateTeam(input);
  await assertCodeFree(repo, clean.code, team.id);
  const updated: Team = { ...team, ...clean, updatedAt: new Date().toISOString() };
  await repo.saveTeam(updated);
  return updated;
}

export interface PlayerInput {
  name: string;
  number: number;
  position: Position;
  active: boolean;
}

/**
 * Crea o actualiza un jugador. Su identificador no depende del dorsal, así que
 * cambiar nombre, dorsal o posición no altera los partidos ya jugados (que
 * guardan su propia copia en la convocatoria).
 */
export async function savePlayer(
  repo: Repository,
  teamId: Id,
  input: PlayerInput,
  existing?: Player,
  newPlayerId: Id = newId(),
): Promise<Player> {
  const fields = { ...input, name: input.name.trim() };
  assertValidPlayerFields(fields);
  const id = existing?.id ?? newPlayerId;
  assertUniqueNumber(await repo.listPlayers(teamId), { id, number: fields.number, active: fields.active });
  const now = new Date().toISOString();
  const player: Player = existing
    ? { ...existing, ...fields, updatedAt: now }
    : { id, teamId, ...fields, createdAt: now, updatedAt: now };
  await repo.savePlayer(player);
  return player;
}
