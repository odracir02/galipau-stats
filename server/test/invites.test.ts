import { beforeEach, describe, expect, it } from 'vitest';
import { authenticate, authorize } from '../src/auth';
import { HttpError } from '../src/errors';
import { clientKeyFromRequest, createInvite, REDEEM_LIMIT, redeemInvite, revokeInvite, revokeTeamAccess } from '../src/invites';
import { generateInviteCode, INVITE_CODE_LENGTH, normalizeInviteCode } from '../src/secrets';
import { addAdmin, addDevice, PEPPER, twoClubs } from './seed';
import { migratedDb, type SqliteD1 } from './sqliteD1';

let db: SqliteD1;
let n = 0;
/** Cada canje desde una «IP» distinta, salvo en la prueba del límite. */
const client = () => `198.51.100.${++n}`;

async function errorCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    if (e instanceof HttpError) return `${e.status} ${e.code}`;
    throw e;
  }
}

beforeEach(() => {
  db = migratedDb();
  twoClubs(db);
});

describe('códigos', () => {
  it('son aleatorios, legibles y sin caracteres confundibles', () => {
    const codes = new Set(Array.from({ length: 2000 }, () => generateInviteCode()));
    expect(codes.size).toBe(2000);
    for (const c of [...codes].slice(0, 50)) {
      expect(c).toMatch(/^[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}$/);
      expect(normalizeInviteCode(c)).toHaveLength(INVITE_CODE_LENGTH);
    }
  });

  it('se aceptan en minúsculas, sin guiones o con espacios', () => {
    expect(normalizeInviteCode(' k7qm-4xrp tb ')).toBe('K7QM4XRPTB');
  });
});

describe('invitaciones', () => {
  it('solo un administrador (de club o global) crea códigos; se guardan como hash y son distintos del código del equipo', async () => {
    const admin = await addAdmin(db, 'adm', [{ role: 'club_admin', clubId: 'A' }]);
    const coach = await addDevice(db, 'coach', [{ clubId: 'A', teamId: 'a1', role: 'coach' }]);
    expect(await errorCode(createInvite(db, coach.auth, { teamId: 'a1', role: 'viewer' }, PEPPER))).toBe('403 forbidden');

    const inv = await createInvite(db, admin.auth, { teamId: 'a1', role: 'viewer' }, PEPPER);
    expect(normalizeInviteCode(inv.code)).not.toContain('SM2627');
    const dump = JSON.stringify(db.sqlite.prepare('SELECT * FROM invites').all());
    expect(dump).not.toContain(inv.code);
    expect(dump).not.toContain(normalizeInviteCode(inv.code));
  });

  it('el código de consulta da acceso de solo lectura y puede compartirse entre varios dispositivos', async () => {
    const admin = await addAdmin(db, 'adm', [{ role: 'club_admin', clubId: 'A' }]);
    const inv = await createInvite(db, admin.auth, { teamId: 'a1', role: 'viewer' }, PEPPER);
    const r1 = await redeemInvite(db, { code: inv.code, clientKey: client(), deviceLabel: 'Familia 1' }, PEPPER);
    const r2 = await redeemInvite(db, { code: inv.code.toLowerCase(), clientKey: client() }, PEPPER);
    expect(r1.deviceId).not.toBe(r2.deviceId);
    expect(r1).toMatchObject({ teamId: 'a1', role: 'viewer' });

    const auth = await authenticate(db, r1.token, PEPPER);
    expect(await errorCode(authorize(db, auth, 'a1', 'team.read'))).toBe('ok');
    expect(await errorCode(authorize(db, auth, 'a1', 'match.write'))).toBe('403 forbidden');
    expect(await errorCode(authorize(db, auth, 'a2', 'team.read'))).toBe('404 not_found');
  });

  it('el código de entrenador da permiso de edición', async () => {
    const admin = await addAdmin(db, 'adm', [{ role: 'club_admin', clubId: 'A' }]);
    const inv = await createInvite(db, admin.auth, { teamId: 'a1', role: 'coach' }, PEPPER);
    const r = await redeemInvite(db, { code: inv.code, clientKey: client() }, PEPPER);
    const auth = await authenticate(db, r.token, PEPPER);
    expect(await errorCode(authorize(db, auth, 'a1', 'match.write'))).toBe('ok');
    expect(await errorCode(authorize(db, auth, 'a1', 'grants.manage'))).toBe('403 forbidden');
  });

  it('rotar invalida el código anterior; quien ya lo canjeó conserva el acceso', async () => {
    const admin = await addAdmin(db, 'adm', [{ role: 'club_admin', clubId: 'A' }]);
    const old = await createInvite(db, admin.auth, { teamId: 'a1', role: 'viewer' }, PEPPER);
    const before = await redeemInvite(db, { code: old.code, clientKey: client() }, PEPPER);
    const fresh = await createInvite(db, admin.auth, { teamId: 'a1', role: 'viewer' }, PEPPER);
    expect(fresh.code).not.toBe(old.code);
    expect(await errorCode(redeemInvite(db, { code: old.code, clientKey: client() }, PEPPER))).toBe('404 invalid_code');
    expect(await errorCode(redeemInvite(db, { code: fresh.code, clientKey: client() }, PEPPER))).toBe('ok');
    const auth = await authenticate(db, before.token, PEPPER);
    expect(await errorCode(authorize(db, auth, 'a1', 'team.read'))).toBe('ok');
  });

  it('caducidad, revocación y número máximo de usos', async () => {
    const admin = await addAdmin(db, 'adm', [{ role: 'club_admin', clubId: 'A' }]);
    const t0 = new Date('2026-10-27T10:00:00Z');
    const inv = await createInvite(db, admin.auth, { teamId: 'a1', role: 'coach', ttlDays: 1, maxUses: 1 }, PEPPER, t0);
    const later = new Date('2026-10-29T10:00:00Z');
    expect(await errorCode(redeemInvite(db, { code: inv.code, clientKey: client() }, PEPPER, later))).toBe('404 invalid_code');
    expect(await errorCode(redeemInvite(db, { code: inv.code, clientKey: client() }, PEPPER, t0))).toBe('ok');
    expect(await errorCode(redeemInvite(db, { code: inv.code, clientKey: client() }, PEPPER, t0))).toBe('404 invalid_code');

    const viewer = await createInvite(db, admin.auth, { teamId: 'a1', role: 'viewer' }, PEPPER);
    await revokeInvite(db, admin.auth, 'a1', viewer.inviteId);
    expect(await errorCode(redeemInvite(db, { code: viewer.code, clientKey: client() }, PEPPER))).toBe('404 invalid_code');
  });

  it('limita los intentos por cliente', async () => {
    const ip = '203.0.113.7';
    for (let i = 0; i < REDEEM_LIMIT.attempts; i++) {
      expect(await errorCode(redeemInvite(db, { code: generateInviteCode(), clientKey: ip }, PEPPER))).toBe('404 invalid_code');
    }
    expect(await errorCode(redeemInvite(db, { code: generateInviteCode(), clientKey: ip }, PEPPER))).toBe('429 too_many_attempts');
    // Otro cliente no se ve afectado; la IP no se guarda en claro.
    expect(await errorCode(redeemInvite(db, { code: generateInviteCode(), clientKey: client() }, PEPPER))).toBe('404 invalid_code');
    expect(JSON.stringify(db.sqlite.prepare('SELECT * FROM auth_attempts').all())).not.toContain(ip);
  });

  it('un dispositivo acumula equipos y nunca pierde un rol mayor al canjear otro código', async () => {
    const adminA = await addAdmin(db, 'admA', [{ role: 'club_admin', clubId: 'A' }]);
    const adminB = await addAdmin(db, 'admB', [{ role: 'club_admin', clubId: 'B' }]);
    const coachA1 = await createInvite(db, adminA.auth, { teamId: 'a1', role: 'coach' }, PEPPER);
    const viewerA1 = await createInvite(db, adminA.auth, { teamId: 'a1', role: 'viewer' }, PEPPER);
    const viewerB1 = await createInvite(db, adminB.auth, { teamId: 'b1', role: 'viewer' }, PEPPER);

    const first = await redeemInvite(db, { code: coachA1.code, clientKey: client() }, PEPPER);
    let auth = await authenticate(db, first.token, PEPPER);
    const again = await redeemInvite(db, { code: viewerA1.code, clientKey: client(), auth }, PEPPER);
    expect(again).toMatchObject({ deviceId: first.deviceId, token: null, role: 'coach' });
    await redeemInvite(db, { code: viewerB1.code, clientKey: client(), auth }, PEPPER);

    auth = await authenticate(db, first.token, PEPPER);
    expect(auth.grants.map((g) => [g.teamId, g.role]).sort()).toEqual([
      ['a1', 'coach'],
      ['b1', 'viewer'],
    ]);
  });

  it('el administrador puede retirar el acceso de un dispositivo', async () => {
    const admin = await addAdmin(db, 'adm', [{ role: 'club_admin', clubId: 'A' }]);
    const lost = await addDevice(db, 'lost', [{ clubId: 'A', teamId: 'a1', role: 'coach' }]);
    expect(await errorCode(revokeTeamAccess(db, lost.auth, 'a1', 'lost'))).toBe('403 forbidden');
    expect(await revokeTeamAccess(db, admin.auth, 'a1', 'lost')).toBe(1);
    const auth = await authenticate(db, lost.token, PEPPER);
    expect(await errorCode(authorize(db, auth, 'a1', 'team.read'))).toBe('404 not_found');
  });

  it('revocar un código filtrado puede retirar también el acceso de quienes lo canjearon', async () => {
    const admin = await addAdmin(db, 'adm', [{ role: 'club_admin', clubId: 'A' }]);
    const inv = await createInvite(db, admin.auth, { teamId: 'a1', role: 'viewer' }, PEPPER);
    const a = await redeemInvite(db, { code: inv.code, clientKey: client() }, PEPPER);
    const b = await redeemInvite(db, { code: inv.code, clientKey: client() }, PEPPER);
    // Un acceso concedido por otro código no se toca.
    const other = await addDevice(db, 'otro', [{ clubId: 'A', teamId: 'a1', role: 'coach' }]);
    expect(await revokeInvite(db, admin.auth, 'a1', inv.inviteId, { revokeAccess: true })).toEqual({ revokedGrants: 2 });
    for (const t of [a.token, b.token]) {
      expect(await errorCode(authorize(db, await authenticate(db, t, PEPPER), 'a1', 'team.read'))).toBe('404 not_found');
    }
    expect(await errorCode(authorize(db, other.auth, 'a1', 'match.write'))).toBe('ok');
  });
});

describe('identificación del cliente para el límite de intentos', () => {
  const req = (headers: Record<string, string>) => new Request('https://api.example/x', { headers });

  it('solo usa CF-Connecting-IP (la pone Cloudflare); ignora cabeceras que controla el cliente', () => {
    expect(clientKeyFromRequest(req({ 'CF-Connecting-IP': '203.0.113.7' }))).toBe('v4:203.0.113.7');
    const spoofed = req({ 'CF-Connecting-IP': '203.0.113.7', 'X-Forwarded-For': '1.2.3.4', 'X-Real-IP': '5.6.7.8', 'True-Client-IP': '9.9.9.9' });
    expect(clientKeyFromRequest(spoofed)).toBe('v4:203.0.113.7');
  });

  it('sin la cabecera de Cloudflare, todas las peticiones comparten un contador', () => {
    expect(clientKeyFromRequest(req({}))).toBe('sin-ip');
    expect(clientKeyFromRequest(req({ 'X-Forwarded-For': '1.2.3.4' }))).toBe('sin-ip');
    expect(clientKeyFromRequest(req({ 'CF-Connecting-IP': 'basura' }))).toBe('ip-no-valida');
  });

  it('IPv6: cambiar de dirección dentro del mismo /64 no da intentos nuevos', () => {
    const k1 = clientKeyFromRequest(req({ 'CF-Connecting-IP': '2001:db8:1:2::1' }));
    const k2 = clientKeyFromRequest(req({ 'CF-Connecting-IP': '2001:0db8:0001:0002:ffff:eeee:dddd:cccc' }));
    expect(k1).toBe('v6:2001:0db8:0001:0002::/64');
    expect(k2).toBe(k1);
    expect(clientKeyFromRequest(req({ 'CF-Connecting-IP': '2001:db8:1:3::1' }))).not.toBe(k1);
  });

  it('el límite se aplica por clave: cambiar de cabecera falsa no reinicia el contador', async () => {
    const keyOf = (xff: string) => clientKeyFromRequest(req({ 'CF-Connecting-IP': '203.0.113.9', 'X-Forwarded-For': xff }));
    for (let i = 0; i < REDEEM_LIMIT.attempts; i++) {
      await errorCode(redeemInvite(db, { code: generateInviteCode(), clientKey: keyOf(`10.0.0.${i}`) }, PEPPER));
    }
    expect(await errorCode(redeemInvite(db, { code: generateInviteCode(), clientKey: keyOf('10.9.9.9') }, PEPPER))).toBe('429 too_many_attempts');
  });
});

