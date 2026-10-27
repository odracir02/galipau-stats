// Worker de GalipauStats (API). Rutas mínimas de esta fase, sin desplegar.
// Pendientes: inicio de sesión administrativo (llave de acceso), canje de
// códigos, alta de clubes y equipos, administradores, transferencia de
// partidos y sincronización completa.
//
//   GET  /api/health                         sin autenticación
//   GET  /api/teams/:teamId                  consulta (cualquier rol del equipo)
//   GET  /api/teams/:teamId/changes?since=N  consulta: cambios posteriores a N
//   POST /api/sync/events                    escritura: entrenador, administrador de club o superadministrador
import { authenticate, authorize, bearerToken } from './auth';
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
  /** Orígenes de la aplicación separados por comas (CORS). */
  ALLOWED_ORIGINS: string;
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

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] !== 'api') throw notFound();

  if (request.method === 'GET' && parts[1] === 'health' && parts.length === 2) {
    return json({ ok: true, environment: env.ENVIRONMENT });
  }

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

export async function handle(request: Request, env: Env): Promise<Response> {
  const cors = corsHeaders(request, env);
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
