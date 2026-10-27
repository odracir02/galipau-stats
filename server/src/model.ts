// Modelos del servidor que no existen en la aplicación local. Los de equipo,
// jugador, partido y evento se comparten con src/domain/types.ts (ver mapping.ts).
import type { Id, IsoDateTime } from '../../src/domain/types';

/**
 * Roles, de mayor a menor alcance:
 *   superadmin  propietario de la plataforma: todos los clubes.
 *   club_admin  responsable de un club: todos los equipos de SU club.
 *   coach       entrenador: los equipos asignados, con edición.
 *   viewer      jugador o familia: los equipos asignados, solo lectura.
 */
export type Role = 'superadmin' | 'club_admin' | 'coach' | 'viewer';

/** Roles de equipo: los únicos que puede conceder un código de invitación. */
export type TeamRole = 'coach' | 'viewer';

/** Roles administrativos: solo para identidades con autenticación fuerte. */
export type AdminRole = 'superadmin' | 'club_admin';

export const TEAM_ROLES: readonly TeamRole[] = ['coach', 'viewer'];

export type Gender = 'male' | 'female' | 'mixed';

export interface Club {
  id: Id;
  name: string;
  shortName: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  deletedAt: IsoDateTime | null;
  version: number;
}

/** Datos del equipo que solo existen en el servidor. */
export interface TeamRemoteFields {
  clubId: Id;
  category: string | null;
  gender: Gender | null;
}

/** Permiso de un dispositivo sobre un equipo. */
export interface Grant {
  id: Id;
  deviceId: Id;
  clubId: Id;
  teamId: Id;
  role: TeamRole;
}

/** Rol administrativo de una identidad. club_id null solo para superadmin. */
export interface AdminRoleGrant {
  role: AdminRole;
  clubId: Id | null;
}

/**
 * Quién hace la petición y con qué permisos vigentes. Hay dos formas:
 *   * dispositivo (token propio): deviceId y sus permisos de equipo;
 *   * administración (Cloudflare Access + roles en D1): admin, sin dispositivo.
 */
export interface AuthContext {
  /** Dispositivo (navegador o PWA); null en peticiones de administración. */
  deviceId: Id | null;
  /** Permisos de equipo del dispositivo. */
  grants: Grant[];
  /** Solo en peticiones de administración. */
  admin?: {
    identityId: Id;
    email: string;
    roles: AdminRoleGrant[];
    /** El token viene de la aplicación de Access de operaciones críticas (MFA reciente). */
    critical: boolean;
  };
}
