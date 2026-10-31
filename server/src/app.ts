// Lógica del Worker de GalipauStats: API y panel de administración, en el mismo
// origen. El punto de entrada es index.ts.
// Pendiente: descarga de cambios sobre la base editable de otros entrenadores (005E.2H2).
//
// Dispositivos (Authorization: Bearer <token de dispositivo>; CORS solo para la PWA, sin cookies):
//   GET  /api/health                         sin autenticación
//   POST /api/invites/redeem                 canjear un código (sin token: dispositivo nuevo)
//   GET  /api/session                        equipos y roles del dispositivo
//   POST /api/session/teams/:teamId/leave    dejar un equipo
//   POST /api/session/logout                 cerrar la sesión del dispositivo
//   GET  /api/teams/:teamId                  consulta (cualquier rol del equipo)
//   GET  /api/teams/:teamId/codes            códigos del equipo que el rol puede ver
//   GET  /api/teams/:teamId/changes?since=N  consulta: cambios posteriores a N
//   GET  /api/teams/:teamId/snapshot         consulta: equipo completo (jugadores, partidos, acciones)
//   POST /api/sync/players                   escritura: entrenador (plantilla)
//   POST /api/sync/matches                   escritura: entrenador (partido y convocatoria)
//   POST /api/sync/events                    escritura: entrenador
//   POST /api/sync/control                   tomar el control de un partido en curso (entrenador)
//
// Administración (Cloudflare Access + roles en D1; mismo origen, sin CORS):
//   GET    /admin, /admin/*                                 panel (archivos estáticos)
//   GET    /api/admin/me                                    identidad y roles
//   GET    /api/admin/clubs                                 clubes visibles
//   GET    /api/admin/clubs/:clubId                         ficha del club y sus equipos
//   GET    /api/admin/teams/:teamId/codes                   los dos códigos del equipo
// Escrituras: todas críticas (ADMIN_CRITICAL_OPS + aplicación crítica de Access):
//   GET    /api/admin/critical/reauth?return=/admin/…       volver al panel tras verificar
//   POST   /api/admin/critical/clubs                        crear club (superadmin)
//   PATCH  /api/admin/critical/clubs/:clubId                editar club
//   POST   /api/admin/critical/clubs/:clubId/status         suspender o reactivar (superadmin)
//   DELETE /api/admin/critical/clubs/:clubId                eliminar club (superadmin)
//   POST   /api/admin/critical/clubs/:clubId/admins         nombrar administrador (superadmin)
//   DELETE /api/admin/critical/clubs/:clubId/admins/:id     retirar administrador (superadmin)
//   POST   /api/admin/critical/clubs/:clubId/teams          crear equipo con sus dos códigos
//   PATCH  /api/admin/critical/teams/:teamId                editar equipo
//   POST   /api/admin/critical/teams/:teamId/codes/:role/regenerate   regenerar un código
//   POST   /api/admin/critical/teams/:teamId/codes/:role/revoke       revocar un código
import { accessConfig } from './access';
import {
  adminProfile,
  appointClubAdmin,
  createClub,
  createTeam,
  deleteClub,
  getClub,
  listClubs,
  revokeClubAdmin,
  setClubStatus,
  updateClub,
  updateTeam,
} from './admin';
import { authenticate, authenticateAdmin, authorize, bearerToken } from './auth';
import { codeKey } from './codecrypt';
import { takeControl, type ControlOp } from './control';
import { assertSafeAdminWrite } from './csrf';
import type { Db } from './db';
import { HttpError, notFound } from './errors';
import { clientKeyFromRequest, createInvite, readTeamCodes, redeemInvite, revokeTeamCode, type InviteSecrets } from './invites';
import { rowToTeam, type TeamRow } from './mapping';
import { TEAM_ROLES, type TeamRole } from './model';
import { getSession, leaveTeam, logout, teamSummary } from './session';
import { applyEventOp, pullChanges, type EventOp } from './sync';
import { applyMatchOp, applyPlayerOp, teamSnapshot, type MatchOp, type PlayerOp } from './teamsync';

/** Archivos estáticos del panel (binding ASSETS de Workers). */
export interface AssetsBinding {
  fetch(request: Request): Promise<Response>;
}

export interface Env {
  DB: Db;
  /** Clave para el HMAC de tokens y códigos. Secret de Cloudflare, nunca en el repositorio. */
  TOKEN_PEPPER?: string;
  /** Clave AES-256 (32 bytes, base64url) para guardar los códigos de forma recuperable. Secret. */
  INVITE_CODE_KEY?: string;
  /** local | preview | production */
  ENVIRONMENT: string;
  /** Orígenes de la aplicación separados por comas (CORS). No aplica a la administración. */
  ALLOWED_ORIGINS: string;
  /** https://<equipo>.cloudflareaccess.com. Vacío = administración desactivada. */
  ACCESS_TEAM_DOMAIN?: string;
  /** AUD de la aplicación de Access de administración (/admin, /api/admin/*). */
  ACCESS_AUD_ADMIN?: string;
  /** AUD de la aplicación de Access de operaciones críticas (/api/admin/critical/*). */
  ACCESS_AUD_CRITICAL?: string;
  /** «enabled» solo tras verificar a mano el segundo factor en Cloudflare; si no, 503. */
  ADMIN_CRITICAL_OPS?: string;
  /** Panel de administración. */
  ASSETS?: AssetsBinding;
}

/** Longitud mínima de TOKEN_PEPPER (32 bytes aleatorios en base64url ocupan 43). */
export const MIN_PEPPER_LENGTH = 32;

function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    // no-store: ninguna respuesta (y menos las que llevan códigos) se guarda en cachés.
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin');
  const allowed = env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
  if (!origin || !allowed.includes(origin)) return {};
  // Sin Access-Control-Allow-Credentials: la PWA se identifica con su token, no con cookies.
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

/** Versión base de una operación: null (alta) o un entero positivo. */
const validBase = (v: unknown) => v === null || (typeof v === 'number' && Number.isInteger(v) && v > 0);

async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError(400, 'bad_request', 'Cuerpo JSON no válido.');
  }
}

/**
 * Solo rutas canónicas: sin barras dobles ni finales y sin barras o puntos
 * codificados. Así el Worker enruta exactamente las rutas que Cloudflare
 * Access protege, y una variante no puede llegar a otra ruta.
 */
export function isCanonicalPath(pathname: string): boolean {
  if (pathname.includes('//') || (pathname.length > 1 && pathname.endsWith('/'))) return false;
  if (/%(2f|5c|2e)/i.test(pathname) || pathname.includes('\\')) return false;
  return pathname.split('/').every((seg) => seg !== '.' && seg !== '..');
}

function devicePepper(env: Env): string {
  // Sin la clave configurada (p. ej. justo tras el primer despliegue) las rutas
  // de dispositivos se rechazan, sin llegar a la base de datos.
  const pepper = env.TOKEN_PEPPER ?? '';
  if (pepper.length < MIN_PEPPER_LENGTH) throw new HttpError(503, 'not_configured', 'El servidor no está configurado todavía.');
  return pepper;
}

async function inviteSecrets(env: Env): Promise<InviteSecrets> {
  return { pepper: devicePepper(env), codeKey: await codeKey(env.INVITE_CODE_KEY) };
}

/**
 * Canje de un código. Sin token crea un dispositivo y devuelve su token una
 * sola vez, en el cuerpo (nunca en la URL). Con token válido añade el equipo a
 * ese dispositivo; con un token no válido responde 401 y no crea nada. El
 * límite de intentos usa la IP que pone Cloudflare.
 */
async function redeem(request: Request, env: Env): Promise<Response> {
  const pepper = devicePepper(env);
  const presented = bearerToken(request);
  const auth = presented ? await authenticate(env.DB, presented, pepper) : undefined;
  const body = await readJson<{ code?: unknown; deviceLabel?: unknown }>(request);
  const code = typeof body?.code === 'string' ? body.code : '';
  if (!code || code.length > 40) throw new HttpError(400, 'bad_request', 'Código no válido.');
  const label = body?.deviceLabel;
  if (label !== undefined && label !== null && (typeof label !== 'string' || label.length > 60)) {
    throw new HttpError(400, 'bad_request', 'Nombre de dispositivo no válido.');
  }
  // Sin caracteres de control (saltos de línea, nulos…): es un texto que se mostrará.
  const printable = typeof label === 'string' ? [...label].filter((ch) => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127).join('') : '';
  const deviceLabel = printable.trim() || null;
  const result = await redeemInvite(env.DB, { code, clientKey: clientKeyFromRequest(request), deviceLabel, auth }, pepper);
  const response = {
    deviceId: result.deviceId,
    role: result.role,
    team: await teamSummary(env.DB, result.teamId),
    ...(result.token ? { token: result.token } : {}),
  };
  return json(response, result.token ? 201 : 200);
}

function teamRole(value: string | undefined): TeamRole {
  if (!TEAM_ROLES.includes(value as TeamRole)) throw notFound();
  return value as TeamRole;
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean);
  // Única excepción a «sin barra final»: la página de entrada del panel.
  if (!isCanonicalPath(url.pathname) && url.pathname !== '/admin/') throw notFound();
  if (parts[0] === 'admin') return adminPanel(request, env);
  if (parts[0] !== 'api') throw notFound();

  if (request.method === 'GET' && parts[1] === 'health' && parts.length === 2) {
    return json({ ok: true, environment: env.ENVIRONMENT });
  }

  if (parts[1] === 'admin') return adminRoute(request, env, parts.slice(2));

  if (request.method === 'POST' && parts[1] === 'invites' && parts[2] === 'redeem' && parts.length === 3) {
    return redeem(request, env);
  }

  const auth = await authenticate(env.DB, bearerToken(request), devicePepper(env));

  if (parts[1] === 'session') {
    if (request.method === 'GET' && parts.length === 2) return json(await getSession(env.DB, auth));
    if (request.method === 'POST' && parts.length === 3 && parts[2] === 'logout') {
      await logout(env.DB, auth);
      return json({ ok: true });
    }
    if (request.method === 'POST' && parts.length === 5 && parts[2] === 'teams' && parts[4] === 'leave') {
      await leaveTeam(env.DB, auth, parts[3]!);
      return json({ ok: true });
    }
    throw notFound();
  }

  if (request.method === 'GET' && parts[1] === 'teams' && parts[2] && parts.length === 3) {
    const team = await authorize(env.DB, auth, parts[2], 'team.read');
    const row = await env.DB.prepare('SELECT * FROM teams WHERE id = ?').bind(team.id).first<TeamRow>();
    const { team: data, remote } = rowToTeam(row!);
    return json({ team: data, ...remote, role: team.role });
  }

  if (request.method === 'GET' && parts[1] === 'teams' && parts[2] && parts[3] === 'codes' && parts.length === 4) {
    return json(await readTeamCodes(env.DB, auth, parts[2], await codeKey(env.INVITE_CODE_KEY)));
  }

  if (request.method === 'GET' && parts[1] === 'teams' && parts[2] && parts[3] === 'changes' && parts.length === 4) {
    const since = Number(url.searchParams.get('since') ?? 0);
    if (!Number.isInteger(since) || since < 0) throw new HttpError(400, 'bad_request', 'Parámetro since no válido.');
    return json(await pullChanges(env.DB, auth, parts[2], since));
  }

  if (request.method === 'GET' && parts[1] === 'teams' && parts[2] && parts[3] === 'snapshot' && parts.length === 4) {
    return json(await teamSnapshot(env.DB, auth, parts[2]));
  }

  if (request.method === 'POST' && parts[1] === 'sync' && parts[2] === 'players' && parts.length === 3) {
    const op = await readJson<PlayerOp>(request);
    if (!op || typeof op.opId !== 'string' || typeof op.teamId !== 'string' || !op.player || typeof op.player.id !== 'string' || !validBase(op.baseVersion)) {
      throw new HttpError(400, 'bad_request', 'Operación incompleta.');
    }
    return json(await applyPlayerOp(env.DB, auth, op));
  }

  if (request.method === 'POST' && parts[1] === 'sync' && parts[2] === 'matches' && parts.length === 3) {
    const op = await readJson<MatchOp>(request);
    if (!op || typeof op.opId !== 'string' || typeof op.teamId !== 'string' || !op.match || typeof op.match.id !== 'string' || !validBase(op.baseVersion)) {
      throw new HttpError(400, 'bad_request', 'Operación incompleta.');
    }
    return json(await applyMatchOp(env.DB, auth, op));
  }

  if (request.method === 'POST' && parts[1] === 'sync' && parts[2] === 'events' && parts.length === 3) {
    const op = await readJson<EventOp>(request);
    if (!op || typeof op.opId !== 'string' || typeof op.teamId !== 'string' || !op.event || typeof op.event.id !== 'string') {
      throw new HttpError(400, 'bad_request', 'Operación incompleta.');
    }
    return json(await applyEventOp(env.DB, auth, op));
  }

  if (request.method === 'POST' && parts[1] === 'sync' && parts[2] === 'control' && parts.length === 3) {
    const op = await readJson<ControlOp>(request);
    if (
      !op ||
      typeof op.opId !== 'string' ||
      !op.opId ||
      typeof op.teamId !== 'string' ||
      typeof op.matchId !== 'string' ||
      !Number.isInteger(op.expectedEpoch) ||
      op.expectedEpoch < 0
    ) {
      throw new HttpError(400, 'bad_request', 'Operación incompleta.');
    }
    return json(await takeControl(env.DB, auth, { opId: op.opId, teamId: op.teamId, matchId: op.matchId, expectedEpoch: op.expectedEpoch }));
  }

  throw notFound();
}

/** Cabeceras de seguridad del panel: sin incrustarse en otras webs ni cargar nada ajeno. */
const PANEL_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

/**
 * Panel de administración. Cloudflare Access lo protege en el borde; además, el
 * Worker comprueba el JWT y el rol antes de servir cualquier archivo, para que
 * no dependa solo de la configuración de Access.
 */
async function adminPanel(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') throw new HttpError(405, 'method_not_allowed', 'Método no permitido.');
  await authenticateAdmin(env.DB, request, accessConfig(env));
  if (!env.ASSETS) throw new HttpError(503, 'panel_unavailable', 'El panel no está disponible en este entorno.');
  const res = await env.ASSETS.fetch(request);
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(PANEL_HEADERS)) out.headers.set(k, v);
  return out;
}

/** Ruta interna del panel a la que volver tras la verificación crítica. */
function safeReturnPath(value: string | null): string {
  if (!value || !/^\/admin(\/[A-Za-z0-9/_-]*)?(#[A-Za-z0-9/_-]*)?$/.test(value) || value.includes('//')) return '/admin/';
  return value === '/admin' ? '/admin/' : value;
}

/**
 * Rutas de administración. Solo Cloudflare Access: el token de dispositivo no
 * cuenta aquí. Toda ruta crítica exige el token de la aplicación de operaciones
 * críticas, además del rol en la base de datos y de las comprobaciones de cada
 * operación.
 */
async function adminRoute(request: Request, env: Env, path: string[]): Promise<Response> {
  const config = accessConfig(env);
  if (path[0] === 'critical' && config && !config.criticalEnabled) {
    throw new HttpError(503, 'critical_disabled', 'Las operaciones críticas no están habilitadas en este entorno.');
  }
  // Escrituras: solo desde el propio origen y con JSON declarado (antes de
  // autenticar, sin llegar a la base de datos).
  assertSafeAdminWrite(request);
  const auth = await authenticateAdmin(env.DB, request, config);
  const m = request.method;

  if (m === 'GET' && path.length === 1 && path[0] === 'me') {
    // El panel desactiva los formularios si las escrituras no están habilitadas.
    return json({ ...adminProfile(auth), criticalOpsEnabled: config?.criticalEnabled === true });
  }
  if (m === 'GET' && path.length === 1 && path[0] === 'clubs') return json({ clubs: await listClubs(env.DB, auth) });
  if (m === 'GET' && path.length === 2 && path[0] === 'clubs') return json(await getClub(env.DB, auth, path[1]!));
  if (m === 'GET' && path.length === 3 && path[0] === 'teams' && path[2] === 'codes') {
    return json(await readTeamCodes(env.DB, auth, path[1]!, await codeKey(env.INVITE_CODE_KEY)));
  }

  if (path[0] !== 'critical') throw notFound();
  if (!auth.admin?.critical) throw new HttpError(401, 'reauth_required', 'Vuelve a verificar tu identidad para esta operación.');

  if (m === 'GET' && path.length === 2 && path[1] === 'reauth') {
    const target = safeReturnPath(new URL(request.url).searchParams.get('return'));
    return new Response(null, { status: 303, headers: { Location: target, 'Cache-Control': 'no-store' } });
  }

  if (path[1] === 'clubs') {
    const [, , clubId, sub, identityId] = path;
    if (m === 'POST' && path.length === 2) {
      const body = await readJson<{ name?: unknown; shortName?: unknown }>(request);
      return json({ clubId: await createClub(env.DB, auth, body ?? {}) }, 201);
    }
    if (m === 'PATCH' && clubId && path.length === 3) {
      await updateClub(env.DB, auth, clubId, (await readJson<{ name?: unknown; shortName?: unknown }>(request)) ?? {});
      return json({ ok: true });
    }
    if (m === 'DELETE' && clubId && path.length === 3) {
      await deleteClub(env.DB, auth, clubId);
      return json({ ok: true });
    }
    if (m === 'POST' && clubId && sub === 'status' && path.length === 4) {
      await setClubStatus(env.DB, auth, clubId, (await readJson<{ status?: unknown }>(request))?.status);
      return json({ ok: true });
    }
    if (m === 'POST' && clubId && sub === 'admins' && path.length === 4) {
      const body = await readJson<{ email?: unknown; displayName?: unknown }>(request);
      return json(await appointClubAdmin(env.DB, auth, { clubId, email: body?.email, displayName: body?.displayName }), 201);
    }
    if (m === 'DELETE' && clubId && sub === 'admins' && identityId && path.length === 5) {
      await revokeClubAdmin(env.DB, auth, { clubId, identityId });
      return json({ ok: true });
    }
    if (m === 'POST' && clubId && sub === 'teams' && path.length === 4) {
      const body = (await readJson<Record<string, unknown>>(request)) ?? {};
      const created = await createTeam(
        env.DB,
        auth,
        { clubId, name: body.name, code: body.code, season: body.season, category: body.category, gender: body.gender },
        await inviteSecrets(env),
      );
      return json(created, 201);
    }
  }

  if (path[1] === 'teams' && path[2]) {
    const teamId = path[2];
    if (m === 'PATCH' && path.length === 3) {
      await updateTeam(env.DB, auth, teamId, (await readJson<Record<string, unknown>>(request)) ?? {});
      return json({ ok: true });
    }
    if (m === 'POST' && path.length === 6 && path[3] === 'codes' && path[5] === 'regenerate') {
      const created = await createInvite(env.DB, auth, { teamId, role: teamRole(path[4]) }, await inviteSecrets(env));
      return json({ role: path[4], code: created.code, expiresAt: created.expiresAt }, 201);
    }
    if (m === 'POST' && path.length === 6 && path[3] === 'codes' && path[5] === 'revoke') {
      const body = await readJson<{ revokeAccess?: unknown }>(request);
      return json(await revokeTeamCode(env.DB, auth, teamId, teamRole(path[4]), { revokeAccess: body?.revokeAccess === true }));
    }
  }
  throw notFound();
}

export async function handle(request: Request, env: Env): Promise<Response> {
  // La administración (panel y API) solo se usa desde su propio origen: nunca CORS.
  const isAdmin = /^\/(api\/)?admin(\/|$)/.test(new URL(request.url).pathname);
  const cors = isAdmin ? {} : corsHeaders(request, env);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  try {
    const res = await route(request, env);
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  } catch (e) {
    if (e instanceof HttpError) {
      return json({ error: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) }, e.status, cors);
    }
    // Nunca se devuelven detalles internos.
    console.error(e);
    return json({ error: 'internal', message: 'Error interno.' }, 500, cors);
  }
}

