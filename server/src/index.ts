// Worker de GalipauStats (API). Sin desplegar todavía.
// Pendientes: canje de códigos, alta de equipos desde la app, transferencia de
// partidos, sincronización completa y paneles de administración.
//
// Dispositivos (Authorization: Bearer <token de dispositivo>):
//   GET  /api/health                         sin autenticación
//   GET  /api/teams/:teamId                  consulta (cualquier rol del equipo)
//   GET  /api/teams/:teamId/changes?since=N  consulta: cambios posteriores a N
//   POST /api/sync/events                    escritura: entrenador
//
// Administración (Cloudflare Access + roles en D1; misma URL, sin CORS):
//   GET    /api/admin/me                                    identidad y roles
//   GET    /api/admin/clubs                                 clubes visibles
//   POST   /api/admin/critical/clubs                        crear club (superadmin)
//   DELETE /api/admin/critical/clubs/:clubId                eliminar club (superadmin)
//   POST   /api/admin/critical/clubs/:clubId/admins         nombrar administrador (superadmin)
//   DELETE /api/admin/critical/clubs/:clubId/admins/:id     retirar administrador (superadmin)
import { accessConfig } from './access';
import { adminProfile, appointClubAdmin, createClub, deleteClub, listClubs, revokeClubAdmin } from './admin';
import { authenticate, authenticateAdmin, authorize, bearerToken } from './auth';
import type { Db } from './db';
import { HttpError, notFound } from './errors';
import { rowToTeam, type TeamRow } from './mapping';
import { applyEventOp, pullChanges, type EventOp } from './sync';

export interface Env {
  DB: Db;
  /** Clave para el HMAC de tokens y códigos. Secret de Cloudflare, nunca en el repositorio. */
  TOKEN_PEPPER: string;
  /** local | preview | production */
  ENVIRONMENT: string;
  /** Orígenes de la aplicación separados por comas (CORS). No aplica a /api/admin. */
  ALLOWED_ORIGINS: string;
  /** https://<equipo>.cloudflareaccess.com. Vacío = administración desactivada. */
  ACCESS_TEAM_DOMAIN?: string;
  /** AUD de la aplicación de Access de administración (/api/admin/*). */
  ACCESS_AUD_ADMIN?: string;
  /** AUD de la aplicación de Access de operaciones críticas (/api/admin/critical/*). */
  ACCESS_AUD_CRITICAL?: string;
  /** «enabled» solo tras verificar a mano el segundo factor en Cloudflare; si no, 503. */
  ADMIN_CRITICAL_OPS?: string;
}

function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin');
  const allowed = env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
  if (!origin || !allowed.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

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

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] !== 'api' || !isCanonicalPath(url.pathname)) throw notFound();

  if (request.method === 'GET' && parts[1] === 'health' && parts.length === 2) {
    return json({ ok: true, environment: env.ENVIRONMENT });
  }

  if (parts[1] === 'admin') return adminRoute(request, env, parts.slice(2));

  const auth = await authenticate(env.DB, bearerToken(request), env.TOKEN_PEPPER);

  if (request.method === 'GET' && parts[1] === 'teams' && parts[2] && parts.length === 3) {
    const team = await authorize(env.DB, auth, parts[2], 'team.read');
    const row = await env.DB.prepare('SELECT * FROM teams WHERE id = ?').bind(team.id).first<TeamRow>();
    const { team: data, remote } = rowToTeam(row!);
    return json({ team: data, ...remote, role: team.role });
  }

  if (request.method === 'GET' && parts[1] === 'teams' && parts[2] && parts[3] === 'changes' && parts.length === 4) {
    const since = Number(url.searchParams.get('since') ?? 0);
    if (!Number.isInteger(since) || since < 0) throw new HttpError(400, 'bad_request', 'Parámetro since no válido.');
    return json(await pullChanges(env.DB, auth, parts[2], since));
  }

  if (request.method === 'POST' && parts[1] === 'sync' && parts[2] === 'events' && parts.length === 3) {
    const op = await readJson<EventOp>(request);
    if (!op || typeof op.opId !== 'string' || typeof op.teamId !== 'string' || !op.event || typeof op.event.id !== 'string') {
      throw new HttpError(400, 'bad_request', 'Operación incompleta.');
    }
    return json(await applyEventOp(env.DB, auth, op));
  }

  throw notFound();
}

/**
 * Rutas de administración. Solo Cloudflare Access: el token de dispositivo no
 * cuenta aquí. Las críticas exigen el token de la aplicación de operaciones
 * críticas (segundo factor reciente), además del rol en la base de datos.
 */
async function adminRoute(request: Request, env: Env, path: string[]): Promise<Response> {
  const config = accessConfig(env);
  if (path[0] === 'critical' && config && !config.criticalEnabled) {
    throw new HttpError(503, 'critical_disabled', 'Las operaciones críticas no están habilitadas en este entorno.');
  }
  const auth = await authenticateAdmin(env.DB, request, config);
  const m = request.method;

  if (m === 'GET' && path.length === 1 && path[0] === 'me') return json(adminProfile(auth));
  if (m === 'GET' && path.length === 1 && path[0] === 'clubs') return json({ clubs: await listClubs(env.DB, auth) });

  if (path[0] === 'critical' && path[1] === 'clubs') {
    const [, , clubId, sub, identityId] = path;
    if (m === 'POST' && path.length === 2) {
      const body = await readJson<{ name?: unknown; shortName?: unknown }>(request);
      return json({ clubId: await createClub(env.DB, auth, body ?? {}) }, 201);
    }
    if (m === 'DELETE' && clubId && path.length === 3) {
      await deleteClub(env.DB, auth, clubId);
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
  }
  throw notFound();
}

export async function handle(request: Request, env: Env): Promise<Response> {
  // La administración solo se usa desde su propia URL: nunca CORS (y nunca credenciales cruzadas).
  const isAdmin = /^\/api\/admin(\/|$)/.test(new URL(request.url).pathname);
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

export default {
  fetch: handle,
};
