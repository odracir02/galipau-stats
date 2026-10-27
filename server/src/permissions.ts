// Matriz de permisos. Es la única fuente de verdad: el servidor la aplica en
// cada petición; la interfaz podrá usarla después solo para ocultar controles.
import type { Role } from './model';

/** Operaciones sobre un equipo. */
export type Action =
  /** Ver equipo, jugadores, partidos, estadísticas y rankings. */
  | 'team.read'
  /** Crear y registrar partidos, corregir acciones. */
  | 'match.write'
  /** Editar la plantilla. */
  | 'roster.write'
  /** Transferir el registro de un partido a otro dispositivo. */
  | 'match.transfer'
  /** Datos del equipo (nombre, temporada, categoría…). */
  | 'team.manage'
  /** Crear, rotar y revocar códigos de entrenador y de consulta. */
  | 'invites.manage'
  /** Retirar el acceso de dispositivos al equipo. */
  | 'grants.manage';

/** Operaciones sobre un club. */
export type ClubAction =
  | 'club.read'
  /** Nombre y datos del club. */
  | 'club.manage'
  /** Crear, editar y eliminar equipos del club. */
  | 'club.teams.manage'
  /** Nombrar y retirar administradores del club. */
  | 'club.admins.manage';

/** Operaciones de toda la plataforma. */
export type PlatformAction =
  /** Crear y eliminar clubes. */
  | 'platform.clubs.manage'
  /** Ver cualquier club y la auditoría. */
  | 'platform.read';

const TEAM: Record<Role, readonly Action[]> = {
  superadmin: ['team.read', 'match.write', 'roster.write', 'match.transfer', 'team.manage', 'invites.manage', 'grants.manage'],
  club_admin: ['team.read', 'match.write', 'roster.write', 'match.transfer', 'team.manage', 'invites.manage', 'grants.manage'],
  coach: ['team.read', 'match.write', 'roster.write', 'match.transfer'],
  viewer: ['team.read'],
};

const CLUB: Record<'superadmin' | 'club_admin', readonly ClubAction[]> = {
  superadmin: ['club.read', 'club.manage', 'club.teams.manage', 'club.admins.manage'],
  // El administrador de club no nombra a otros administradores (ni de su club):
  // eso lo hace el superadministrador.
  club_admin: ['club.read', 'club.manage', 'club.teams.manage'],
};

export function roleAllows(role: Role, action: Action): boolean {
  return TEAM[role].includes(action);
}

export function clubRoleAllows(role: 'superadmin' | 'club_admin', action: ClubAction): boolean {
  return CLUB[role].includes(action);
}

/** Acciones que solo leen. Cualquier otra se considera escritura. */
export function isReadOnly(action: Action): boolean {
  return action === 'team.read';
}

/**
 * Operaciones que exigen haber verificado la credencial fuerte hace poco,
 * aunque la sesión siga abierta.
 */
export const RECENT_AUTH_ACTIONS: readonly (ClubAction | PlatformAction)[] = [
  'club.admins.manage',
  'platform.clubs.manage',
];

/** Margen para considerar reciente la verificación fuerte. */
export const RECENT_AUTH_MINUTES = 15;
