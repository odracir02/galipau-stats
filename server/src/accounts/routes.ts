// Rutas de las cuentas de club. Solo existen con ACCOUNTS_ENABLED=true (app.ts no
// llega aquí en otro caso) y solo en el origen configurado (ACCOUNTS_ORIGIN): mismo
// origen que el futuro panel, sin CORS y con cookie de sesión.
//
// Biblioteca de autenticación (prefijo /api/account/auth):
//   POST /email-otp/send-verification-otp   pedir código (Turnstile; límites por IP y correo)
//   POST /sign-in/email-otp                 entrar con el código (crea la cuenta si está permitido)
//   POST /email-otp/verify-email            verificar el correo con un código
//   GET  /get-session                       sesión actual
//   GET  /list-sessions                     sesiones de la cuenta
//   POST /revoke-session | /revoke-other-sessions | /revoke-sessions | /sign-out
//
// Cuentas y clubes (sesión obligatoria):
//   GET  /api/account/me                                   cuenta, clubes, invitaciones y transferencias pendientes
//   POST /api/account/deactivate                           desactivar la propia cuenta
//   POST /api/account/clubs                                crear club propio (solo con registro libre)
//   GET  /api/account/clubs/:clubId                        ficha del club (propietario o administrador)
//   POST /api/account/clubs/:clubId/invitations            invitar administrador (propietario)
//   POST /api/account/clubs/:clubId/invitations/:id/revoke retirar invitación (propietario)
//   POST /api/account/clubs/:clubId/admins/:userId/revoke  retirar administrador (propietario)
//   POST /api/account/clubs/:clubId/leave                  dejar de administrar (administrador)
//   POST /api/account/clubs/:clubId/transfer               proponer transferencia (propietario)
//   POST /api/account/invitations/:id/accept|decline       responder a una invitación (correo invitado)
//   POST /api/account/transfers/:id/accept|decline|cancel  decidir una transferencia
//
// Administración del club (sesión obligatoria y rol en ese club):
//   GET  /api/club/:clubId/me                              rol de la cuenta en el club
//   (las futuras operaciones administrativas del club cuelgan de aquí)
//
// No hay ninguna relación con los tokens de dispositivo: un entrenador o un usuario
// de consulta con su código no obtiene nada aquí, y una sesión de cuenta no sirve
// para la API de dispositivos ni para la administración de Access.
import { assertSafeAdminWrite } from '../csrf';
import { HttpError, notFound, unauthorized } from '../errors';
import { AUTH_BASE_PATH, makeAuth, OTP_SEND_PATH, OTP_SIGN_IN_PATH, OTP_VERIFY_EMAIL_PATH, type Auth } from './auth';
import {
  acceptInvitation,
  accountSummary,
  clubDetail,
  createOwnedClub,
  deactivateAccount,
  decideTransfer,
  declineInvitation,
  inviteAdmin,
  leaveClub,
  requestTransfer,
  requireClubAccess,
  revokeAdmin,
  revokeInvitation,
  type AccountUser,
} from './clubs';
import { accountsConfig, type AccountsConfig, type AccountsEnv } from './config';
import { allowCodeRequest } from './limits';
import { emailAccountState, isUserDisabled, mayCreateAccount } from './policy';

function json(body: unknown, status = 200, headers?: Headers): Response {
  const h = new Headers(headers);
  h.set('Content-Type', 'application/json; charset=utf-8');
  h.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(body), { status, headers: h });
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = (await request.json()) as unknown;
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  } catch {
    throw new HttpError(400, 'bad_request', 'Cuerpo JSON no válido.');
  }
}

const OTP_ROUTES = new Set([OTP_SEND_PATH, OTP_SIGN_IN_PATH, OTP_VERIFY_EMAIL_PATH].map((p) => AUTH_BASE_PATH + p));

/**
 * Filtro previo de las rutas de código. No sustituye a los hooks de la biblioteca
 * (que son la garantía): evita enviar correos que no llevan a nada y aplica el
 * límite por correo. Responde igual exista o no la cuenta.
 */
async function otpPrefilter(request: Request, env: AccountsEnv, cfg: AccountsConfig, path: string): Promise<Response | null> {
  const body = (await request.clone().json().catch(() => null)) as { email?: unknown; type?: unknown } | null;
  if (typeof body?.email !== 'string') return null; // la biblioteca valida y responde
  const email = body.email.toLowerCase(); // misma normalización que la biblioteca
  const sending = path === AUTH_BASE_PATH + OTP_SEND_PATH;
  if (sending && !(await allowCodeRequest(env.DB, email, cfg.pepper))) {
    return json({ code: 'TOO_MANY_REQUESTS', message: 'Demasiadas solicitudes de código para este correo. Espera un rato.' }, 429);
  }
  const state = await emailAccountState(env.DB, email);
  const silentOk = () => json({ success: true });
  const invalid = () => json({ code: 'INVALID_OTP', message: 'Invalid OTP' }, 400);
  if (state === 'disabled') return sending ? silentOk() : invalid();
  if (sending && state === 'none' && body.type === 'sign-in' && !(await mayCreateAccount(env.DB, email, cfg.publicSignup))) {
    return silentOk();
  }
  return null;
}

async function authRoute(request: Request, env: AccountsEnv, cfg: AccountsConfig, auth: Auth): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (request.method === 'POST' && OTP_ROUTES.has(path)) {
    const early = await otpPrefilter(request, env, cfg, path);
    if (early) return early;
  }
  const res = await auth.handler(request);
  const headers = new Headers(res.headers);
  headers.set('Cache-Control', 'no-store');
  return new Response(res.body, { status: res.status, headers });
}

export async function accountsRoute(request: Request, env: AccountsEnv, parts: string[]): Promise<Response> {
  const cfg = accountsConfig(env);
  // Las cuentas solo se sirven en su origen; en cualquier otro host no existen.
  if (new URL(request.url).origin !== cfg.origin) throw notFound();
  // Mismas defensas CSRF que la administración: origen propio y cuerpo JSON.
  assertSafeAdminWrite(request);
  const auth = makeAuth(env.DB, cfg);

  if (parts[1] === 'account' && parts[2] === 'auth') return authRoute(request, env, cfg, auth);

  const { headers: refreshed, response: session } = await auth.api.getSession({ headers: request.headers, returnHeaders: true });
  if (!session || (await isUserDisabled(env.DB, session.user.id))) throw unauthorized();
  const user: AccountUser = { id: session.user.id, email: session.user.email, emailVerified: session.user.emailVerified };
  // Si la biblioteca ha renovado la sesión, la cookie actualizada acompaña la respuesta.
  const out = (body: unknown, status = 200) => json(body, status, refreshed);
  const db = env.DB;
  const m = request.method;
  const [, , section, id, action, sub, subAction] = parts;
  const n = parts.length;

  // Espacio de las operaciones administrativas de cada club (/api/club/:clubId/*). Toda
  // ruta pasa por el mismo guardián: sesión válida, cuenta activa y rol en ESE club. La
  // cookie, por sí sola, no concede nada.
  if (parts[1] === 'club') {
    const clubId = parts[2];
    if (!clubId) throw notFound();
    const access = await requireClubAccess(db, user, clubId);
    if (parts[3] === 'me' && n === 4 && m === 'GET') return out({ clubId, role: access.role, clubStatus: access.status });
    throw notFound();
  }

  if (section === 'me' && n === 3 && m === 'GET') return out(await accountSummary(db, user));
  if (section === 'deactivate' && n === 3 && m === 'POST') return out(await deactivateAccount(db, user.id, user.id, 'self'));

  if (section === 'clubs') {
    if (n === 3 && m === 'POST') {
      if (!cfg.publicSignup) throw new HttpError(403, 'signup_closed', 'El alta de clubes todavía no está abierta.');
      const result = await createOwnedClub(db, user, await readBody(request), cfg.pepper);
      return out(result, result.created ? 201 : 200);
    }
    if (!id) throw notFound();
    if (n === 4 && m === 'GET') return out(await clubDetail(db, user, id));
    if (action === 'invitations' && n === 5 && m === 'POST') {
      const result = await inviteAdmin(db, user, id, (await readBody(request)).email);
      return out(result, result.created ? 201 : 200);
    }
    if (action === 'invitations' && sub && subAction === 'revoke' && n === 7 && m === 'POST') return out(await revokeInvitation(db, user, id, sub));
    if (action === 'admins' && sub && subAction === 'revoke' && n === 7 && m === 'POST') return out(await revokeAdmin(db, user, id, sub));
    if (action === 'leave' && n === 5 && m === 'POST') return out(await leaveClub(db, user, id));
    if (action === 'transfer' && n === 5 && m === 'POST') {
      const result = await requestTransfer(db, user, id, (await readBody(request)).toUserId);
      return out(result, result.created ? 201 : 200);
    }
    throw notFound();
  }

  if (section === 'invitations' && id && n === 5 && m === 'POST') {
    if (action === 'accept') return out(await acceptInvitation(db, user, id));
    if (action === 'decline') return out(await declineInvitation(db, user, id));
  }
  if (section === 'transfers' && id && n === 5 && m === 'POST' && (action === 'accept' || action === 'decline' || action === 'cancel')) {
    return out(await decideTransfer(db, user, id, action));
  }
  throw notFound();
}
