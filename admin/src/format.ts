// Auxiliares puros del panel de administración.

export type ClubStatus = 'active' | 'suspended';
export type Gender = 'male' | 'female' | 'mixed';
export type TeamRole = 'coach' | 'viewer';

export interface Me {
  identityId: string;
  email: string;
  roles: { role: 'superadmin' | 'club_admin'; clubId: string | null }[];
  criticalOpsEnabled: boolean;
}

export interface ClubSummary {
  id: string;
  name: string;
  shortName: string | null;
  status: ClubStatus;
}

export interface TeamSummary {
  id: string;
  name: string;
  code: string;
  season: string;
  category: string | null;
  gender: Gender | null;
  codes: { coach: boolean; viewer: boolean };
}

export interface ClubDetail extends ClubSummary {
  teams: TeamSummary[];
}

export interface CodeView {
  code: string | null;
  expiresAt: string;
}

export interface TeamCodes {
  teamId: string;
  teamCode: string;
  season: string;
  role: string;
  viewer: CodeView | null;
  coach?: CodeView | null;
}

export const STATUS_LABEL: Record<ClubStatus, string> = { active: 'Activo', suspended: 'Suspendido' };
export const GENDER_LABEL: Record<Gender, string> = { male: 'Masculino', female: 'Femenino', mixed: 'Mixto' };
export const CODE_LABEL: Record<TeamRole, { title: string; detail: string }> = {
  coach: { title: 'Código de entrenador', detail: 'Registrar y corregir partidos, y consultar las estadísticas del equipo.' },
  viewer: { title: 'Código de jugador/familia', detail: 'Solo consultar estadísticas, resultados y clasificaciones.' },
};

export const isSuperadmin = (me: Me) => me.roles.some((r) => r.role === 'superadmin');

/** El usuario puede gestionar el club (datos y equipos): superadministrador o su administrador. */
export const canManageClub = (me: Me, clubId: string) =>
  isSuperadmin(me) || me.roles.some((r) => r.role === 'club_admin' && r.clubId === clubId);

/** Equipos agrupados por temporada, la más reciente primero; dentro, por nombre. */
export function groupBySeason(teams: readonly TeamSummary[]): [string, TeamSummary[]][] {
  const map = new Map<string, TeamSummary[]>();
  for (const t of teams) map.set(t.season, [...(map.get(t.season) ?? []), t]);
  return [...map.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([season, list]) => [season, [...list].sort((x, y) => x.name.localeCompare(y.name, 'es'))]);
}

/** Código oculto con el mismo formato (K7QM-4XRP-TB9H → ••••-••••-••••). */
export function maskCode(code: string): string {
  return code.replace(/[^-]/g, '•');
}

/** Normaliza el identificador del equipo como el servidor: mayúsculas y sin espacios. */
export function normalizeTeamCode(code: string): string {
  return code.trim().toUpperCase().replace(/\s+/g, '');
}

export const isValidTeamCode = (code: string) => /^[A-Z0-9]{3,12}$/.test(normalizeTeamCode(code));
export const isValidSeason = (season: string) => {
  const m = /^(\d{4})\/(\d{2})$/.exec(season.trim());
  return !!m && (Number(m[1]) + 1) % 100 === Number(m[2]);
};

/** Fecha corta en español (dd/mm/aaaa) de una fecha ISO. */
export function formatDay(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
}
