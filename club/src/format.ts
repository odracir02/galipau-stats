// Lógica pura del panel de clubes: validaciones, mensajes de error y navegación.
// Sin dependencias del navegador, para probarla de forma unitaria.

export type ClubRole = 'owner' | 'admin';

export interface PublicConfig {
  publicSignup: boolean;
  turnstileSiteKey: string | null;
  appUrl: string | null;
}

export interface ClubSummary {
  id: string;
  name: string;
  shortName: string | null;
  role: ClubRole;
}

export interface PendingInvitation {
  id: string;
  clubId: string;
  clubName: string;
  expiresAt: string;
}

export interface Account {
  user: { id: string; email: string };
  clubs: ClubSummary[];
  invitations: PendingInvitation[];
  transfers: { id: string; clubId: string; clubName: string; expiresAt: string }[];
}

export interface ClubMember {
  userId: string;
  email: string;
  since: string;
}

export interface ClubInvitation {
  id: string;
  email: string;
  expiresAt: string;
}

export interface PendingTransfer {
  id: string;
  toUserId: string;
  expiresAt: string;
}

export interface ClubDetail {
  club: { id: string; name: string; shortName: string | null; status: string };
  role: ClubRole;
  owner: ClubMember | null;
  admins: ClubMember[];
  /** Solo las ve el propietario (para un administrador llega vacío). */
  invitations: ClubInvitation[];
  /** Transferencia pendiente: la ve el propietario y quien la recibe; nadie más. */
  transfer: PendingTransfer | null;
}

export interface TeamSummary {
  id: string;
  name: string;
  code: string;
  season: string;
  category: string | null;
  gender: string | null;
}

export const ROLE_LABEL: Record<ClubRole, string> = { owner: 'Propietario', admin: 'Administrador' };
export const GENDER_LABEL: Record<string, string> = { male: 'Masculino', female: 'Femenino', mixed: 'Mixto' };

export const CLUB_NAME_MAX = 80;
export const SHORT_NAME_MAX = 24;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const normalizeEmail = (value: string) => value.trim().toLowerCase();
export const isValidEmail = (value: string) => EMAIL.test(normalizeEmail(value)) && normalizeEmail(value).length <= 254;

/** Solo cifras, como mucho seis (se admite pegar «123 456» o «123-456»). */
export const normalizeCode = (value: string) => value.replace(/\D/g, '').slice(0, 6);
export const isCompleteCode = (value: string) => /^\d{6}$/.test(value);

/** Error de la API traducido a un mensaje claro. `code` viene del servidor o de la biblioteca. */
export function errorMessage(status: number, code: string | undefined, fallback?: string): string {
  switch (code) {
    case 'network':
      return 'No hay conexión con el servidor. Comprueba tu conexión e inténtalo de nuevo.';
    case 'INVALID_OTP':
      return 'El código no es correcto. Revísalo o pide uno nuevo.';
    case 'OTP_EXPIRED':
      return 'El código ha caducado. Pide uno nuevo.';
    case 'TOO_MANY_ATTEMPTS':
      return 'Demasiados intentos con este código. Pide uno nuevo.';
    case 'MISSING_RESPONSE':
    case 'VERIFICATION_FAILED':
      return 'No se ha podido comprobar que no eres un robot. Vuelve a intentarlo.';
    case 'INVALID_EMAIL':
      return 'Ese correo no es válido.';
    case 'signup_closed':
      return 'El alta de clubes todavía no está abierta.';
    case 'accounts_not_configured':
      return 'El acceso para clubes no está disponible en este momento.';
    case 'unauthorized':
      return 'Tu sesión ha terminado. Vuelve a entrar.';
  }
  if (status === 429) return 'Demasiadas solicitudes. Espera unos minutos y vuelve a intentarlo.';
  if (status === 401) return 'Tu sesión ha terminado. Vuelve a entrar.';
  if (status === 404) return 'No encontrado o sin acceso.';
  if (status >= 500) return 'El servidor no ha podido completar la operación. Inténtalo de nuevo en unos minutos.';
  return fallback || 'No se ha podido completar la operación.';
}

/** Tras un error al entrar, ¿hace falta pedir otro código? */
export const needsNewCode = (code: string | undefined) => code === 'OTP_EXPIRED' || code === 'TOO_MANY_ATTEMPTS';

// --- Navegación por hash ------------------------------------------------------

export const SECTIONS = ['resumen', 'equipos', 'temporadas', 'codigos', 'administradores'] as const;
export type Section = (typeof SECTIONS)[number];

export const SECTION_LABEL: Record<Section, string> = {
  resumen: 'Resumen',
  equipos: 'Equipos',
  temporadas: 'Temporadas',
  codigos: 'Códigos',
  administradores: 'Administradores',
};

export type Route =
  | { name: 'home' }
  | { name: 'login'; then: 'home' | 'create' }
  | { name: 'create' }
  | { name: 'club'; clubId: string; section: Section };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map((p) => decodeURIComponent(p));
  const [a, b, c] = parts;
  if (a === 'entrar') return { name: 'login', then: b === 'crear' ? 'create' : 'home' };
  if (a === 'crear') return { name: 'create' };
  if (a === 'club' && b) return { name: 'club', clubId: b, section: (SECTIONS as readonly string[]).includes(c ?? '') ? (c as Section) : 'resumen' };
  return { name: 'home' };
}

export const clubHash = (clubId: string, section: Section = 'resumen') =>
  `#/club/${encodeURIComponent(clubId)}${section === 'resumen' ? '' : `/${section}`}`;

/** Temporadas presentes en los equipos, de la más reciente a la más antigua. */
export const seasonsOf = (teams: readonly TeamSummary[]) => [...new Set(teams.map((t) => t.season))].sort().reverse();

export function formatDay(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });
}
