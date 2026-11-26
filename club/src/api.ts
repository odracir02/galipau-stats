// Cliente de la API de cuentas. Siempre en el mismo origen que el panel: la cookie
// de sesión (HttpOnly) va sola y nunca pasa por JavaScript; no se guarda nada en
// localStorage. El navegador envía Origin, que el Worker exige en las escrituras, y
// todas las escrituras llevan cuerpo JSON. El rol que se muestra lo decide el
// servidor en cada petición: la interfaz solo lo refleja.
import {
  errorMessage,
  type Account,
  type ClubDetail,
  type ClubInvitation,
  type ClubSummary,
  type PendingTransfer,
  type PublicConfig,
  type TeamSummary,
} from './format';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

interface Options {
  method?: string;
  body?: unknown;
  /** Token de Turnstile, solo en las rutas que lo exigen. */
  captcha?: string | null;
}

export async function api<T>(path: string, { method = 'GET', body, captcha }: Options = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (captcha) headers['x-captcha-response'] = captcha;
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network', errorMessage(0, 'network'));
  }
  const data = (await res.json().catch(() => null)) as (T & { code?: string; error?: string; message?: string }) | null;
  if (res.ok) return data as T;
  // La biblioteca de autenticación responde { code }, el resto de la API { error }.
  const code = data?.code ?? data?.error;
  throw new ApiError(res.status, code, errorMessage(res.status, code, data?.message));
}

export const getConfig = () => api<PublicConfig>('/api/account/config');

/** Cuenta actual, o null si no hay sesión. */
export async function getAccount(): Promise<Account | null> {
  try {
    return await api<Account>('/api/account/me');
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return null;
    throw e;
  }
}

export const sendCode = (email: string, captcha: string | null) =>
  api<{ success: boolean }>('/api/account/auth/email-otp/send-verification-otp', { method: 'POST', body: { email, type: 'sign-in' }, captcha });

export const signIn = (email: string, otp: string, captcha: string | null) =>
  api<{ user: { id: string; email: string } }>('/api/account/auth/sign-in/email-otp', { method: 'POST', body: { email, otp }, captcha });

export const signOut = () => api<{ success: boolean }>('/api/account/auth/sign-out', { method: 'POST', body: {} });

export const createClub = (input: { id: string; name: string; shortName: string }) =>
  api<{ club: Pick<ClubSummary, 'id' | 'name' | 'shortName'>; created: boolean }>('/api/account/clubs', { method: 'POST', body: input });

export const getClub = (clubId: string) => api<ClubDetail>(`/api/account/clubs/${encodeURIComponent(clubId)}`);
export const getTeams = (clubId: string) => api<{ teams: TeamSummary[] }>(`/api/club/${encodeURIComponent(clubId)}/teams`);

export const answerInvitation = (invitationId: string, answer: 'accept' | 'decline') =>
  api<unknown>(`/api/account/invitations/${encodeURIComponent(invitationId)}/${answer}`, { method: 'POST', body: {} });

// --- Administradores del club --------------------------------------------------------
// Todas las comprobaciones (rol, club, correo, estado) las hace el servidor; si la
// interfaz llama a una operación que no corresponde, recibe 403 o 404.

const clubPath = (clubId: string) => `/api/account/clubs/${encodeURIComponent(clubId)}`;

/** Crea la invitación (o devuelve la pendiente para ese correo: `created: false`). No envía correo. */
export const inviteAdmin = (clubId: string, email: string) =>
  api<{ invitation: ClubInvitation; created: boolean }>(`${clubPath(clubId)}/invitations`, { method: 'POST', body: { email } });

export const revokeInvitation = (clubId: string, invitationId: string) =>
  api<{ revoked: boolean }>(`${clubPath(clubId)}/invitations/${encodeURIComponent(invitationId)}/revoke`, { method: 'POST', body: {} });

export const revokeAdmin = (clubId: string, userId: string) =>
  api<{ revoked: boolean }>(`${clubPath(clubId)}/admins/${encodeURIComponent(userId)}/revoke`, { method: 'POST', body: {} });

export const leaveClub = (clubId: string) => api<{ revoked: boolean }>(`${clubPath(clubId)}/leave`, { method: 'POST', body: {} });

export const requestTransfer = (clubId: string, toUserId: string) =>
  api<{ transfer: PendingTransfer; created: boolean }>(`${clubPath(clubId)}/transfer`, { method: 'POST', body: { toUserId } });

export const decideTransfer = (transferId: string, decision: 'accept' | 'decline' | 'cancel') =>
  api<{ clubId: string; status: string; changed: boolean }>(`/api/account/transfers/${encodeURIComponent(transferId)}/${decision}`, { method: 'POST', body: {} });
