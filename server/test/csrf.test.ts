// Protección CSRF de las escrituras administrativas. Las operaciones críticas
// se habilitan aquí a propósito, con un token crítico válido de superadministrador,
// para que lo único que pueda frenar la petición sea esta protección.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildBootstrapSql } from '../scripts/bootstrap-superadmin.mjs';
import { clearJwksCache } from '../src/access';
import { assertSafeAdminWrite } from '../src/csrf';
import { HttpError } from '../src/errors';
import worker, { type Env } from '../src/index';
import { ACCESS_ENV, claimsFor, CONFIG, makeIssuer, serveJwks, type Issuer } from './accessKeys';
import { PEPPER, twoClubs } from './seed';
import { migratedDb, type SqliteD1 } from './sqliteD1';

const API = 'https://api.example';
const OWNER = 'propietario@example.com';
let db: SqliteD1;
let env: Env;
let issuer: Issuer;

beforeEach(async () => {
  db = migratedDb();
  twoClubs(db);
  db.sqlite.exec(buildBootstrapSql({ identityId: 'owner', email: OWNER }));
  issuer = await makeIssuer();
  serveJwks(() => [issuer.jwk]);
  env = { DB: db, TOKEN_PEPPER: PEPPER, ENVIRONMENT: 'test', ALLOWED_ORIGINS: 'https://app.example', ...ACCESS_ENV };
});
afterEach(() => {
  vi.unstubAllGlobals();
  clearJwksCache();
});

const clubs = () => (db.sqlite.prepare('SELECT COUNT(*) AS n FROM clubs').get() as { n: number }).n;

/** Petición al Worker con un token crítico válido del superadministrador y las cabeceras indicadas. */
async function send(method: string, path: string, headers: Record<string, string>, body?: string) {
  const token = await issuer.sign(claimsFor(OWNER, { aud: CONFIG.criticalAud }));
  const res = await worker.fetch(
    new Request(`${API}${path}`, { method, headers: { 'Cf-Access-Jwt-Assertion': token, ...headers }, body }),
    env,
  );
  return { status: res.status, body: (await res.json()) as { error?: string; details?: { reason?: string } } };
}

const json = JSON.stringify({ name: 'Club nuevo' });

describe('escrituras legítimas del panel', () => {
  it('mismo origen (Sec-Fetch-Site y Origin) con JSON: se aceptan', async () => {
    const res = await send('POST', '/api/admin/critical/clubs', { 'Sec-Fetch-Site': 'same-origin', Origin: API, 'Content-Type': 'application/json' }, json);
    expect(res.status).toBe(201);
    expect(clubs()).toBe(3);
  });

  it('variantes válidas: charset, mayúsculas, solo una de las dos cabeceras', async () => {
    const variants: Record<string, string>[] = [
      { 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json; charset=utf-8' },
      { 'Sec-Fetch-Site': 'Same-Origin', 'Content-Type': 'Application/JSON' },
      // Navegador sin Fetch Metadata pero con Origin (o un script que lo añade).
      { Origin: API, 'Content-Type': 'application/json' },
    ];
    for (const headers of variants) {
      expect((await send('POST', '/api/admin/critical/clubs', headers, json)).status, JSON.stringify(headers)).toBe(201);
    }
  });

  it('DELETE del propio origen no necesita Content-Type', async () => {
    const res = await send('DELETE', '/api/admin/critical/clubs/B', { 'Sec-Fetch-Site': 'same-origin', Origin: API });
    expect(res.status).toBe(200);
  });

  it('las lecturas no se ven afectadas', async () => {
    const res = await worker.fetch(
      new Request(`${API}/api/admin/me`, {
        headers: { 'Cf-Access-Jwt-Assertion': await issuer.sign(claimsFor(OWNER)), 'Sec-Fetch-Site': 'cross-site', Origin: 'https://otra.example' },
      }),
      env,
    );
    expect(res.status).toBe(200);
    // Sin CORS: el navegador de la otra web no puede leer la respuesta.
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

describe('peticiones falsificadas o sospechosas', () => {
  it('formulario text/plain desde otra web (el ataque típico): 403 y nada escrito', async () => {
    // <form enctype="text/plain"> con un campo cuyo nombre forma JSON válido.
    const body = '{"name":"Club pirata","x":"="}';
    const res = await send('POST', '/api/admin/critical/clubs', { 'Sec-Fetch-Site': 'cross-site', Origin: 'https://atacante.example', 'Content-Type': 'text/plain' }, body);
    expect(res).toMatchObject({ status: 403, body: { error: 'csrf_rejected' } });
    expect(clubs()).toBe(2);
  });

  it('cualquier Sec-Fetch-Site distinto de same-origin: 403', async () => {
    for (const site of ['cross-site', 'same-site', 'none', '', 'same-origin, cross-site']) {
      const res = await send('POST', '/api/admin/critical/clubs', { 'Sec-Fetch-Site': site, Origin: API, 'Content-Type': 'application/json' }, json);
      expect(res, site).toMatchObject({ status: 403, body: { error: 'csrf_rejected', details: { reason: 'fetch_site' } } });
    }
    expect(clubs()).toBe(2);
  });

  it('Origin ajeno, «null», de un subdominio hermano o con otro esquema o puerto: 403', async () => {
    for (const origin of ['https://atacante.example', 'null', 'https://otro.api.example', 'http://api.example', 'https://api.example:8443', 'https://api.example.atacante.example']) {
      const res = await send('POST', '/api/admin/critical/clubs', { 'Sec-Fetch-Site': 'same-origin', Origin: origin, 'Content-Type': 'application/json' }, json);
      expect(res, origin).toMatchObject({ status: 403, body: { error: 'csrf_rejected', details: { reason: 'origin' } } });
    }
    expect(clubs()).toBe(2);
  });

  it('sin Sec-Fetch-Site ni Origin: 403 (no hay vía por omisión)', async () => {
    const res = await send('POST', '/api/admin/critical/clubs', { 'Content-Type': 'application/json' }, json);
    expect(res).toMatchObject({ status: 403, body: { error: 'csrf_rejected', details: { reason: 'missing_headers' } } });
    const del = await send('DELETE', '/api/admin/critical/clubs/B', {});
    expect(del.status).toBe(403);
    expect(clubs()).toBe(2);
  });

  it('mismo origen pero sin JSON declarado (formularios, multipart, sin Content-Type): 415', async () => {
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/json-patch+json', '']) {
      const headers: Record<string, string> = { 'Sec-Fetch-Site': 'same-origin', Origin: API };
      if (type) headers['Content-Type'] = type;
      const res = await send('POST', '/api/admin/critical/clubs', headers, json);
      expect(res, type || '(sin Content-Type)').toMatchObject({ status: 415, body: { error: 'unsupported_media_type' } });
    }
    expect(clubs()).toBe(2);
  });

  it('se rechaza antes de autenticar: no consulta la base de datos', async () => {
    const touched: string[] = [];
    env = { ...env, DB: { prepare: (q: string) => (touched.push(q), db.prepare(q)), batch: (s) => db.batch(s) } };
    await send('POST', '/api/admin/critical/clubs/A/admins', { 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'text/plain' }, '{"email":"a@example.com"}');
    expect(touched).toEqual([]);
  });

  it('las operaciones críticas desactivadas siguen respondiendo 503, también ante peticiones de otra web', async () => {
    env = { ...env, ADMIN_CRITICAL_OPS: 'disabled' };
    const res = await send('POST', '/api/admin/critical/clubs', { 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'text/plain' }, json);
    expect(res).toMatchObject({ status: 503, body: { error: 'critical_disabled' } });
  });
});

describe('assertSafeAdminWrite', () => {
  const req = (method: string, headers: Record<string, string>) => new Request(`${API}/api/admin/x`, { method, headers });
  const code = (r: Request) => {
    try {
      assertSafeAdminWrite(r);
      return 'ok';
    } catch (e) {
      return e instanceof HttpError ? `${e.status} ${e.code}` : 'otro';
    }
  };

  it('no afecta a GET, HEAD ni OPTIONS', () => {
    for (const m of ['GET', 'HEAD', 'OPTIONS']) expect(code(req(m, { 'Sec-Fetch-Site': 'cross-site' }))).toBe('ok');
  });

  it('aplica a PUT y PATCH igual que a POST', () => {
    for (const m of ['PUT', 'PATCH']) {
      expect(code(req(m, { 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' }))).toBe('ok');
      expect(code(req(m, { 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'text/plain' }))).toBe('415 unsupported_media_type');
      expect(code(req(m, { 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'application/json' }))).toBe('403 csrf_rejected');
    }
  });
});
