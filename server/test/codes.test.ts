// Códigos de invitación recuperables: cifrado, dos códigos por equipo,
// permisos de lectura por rol, regeneración y revocación independientes.
import { beforeEach, describe, expect, it } from 'vitest';
import { createTeam } from '../src/admin';
import { authenticate } from '../src/auth';
import { codeKey, decryptCode, encryptCode } from '../src/codecrypt';
import { HttpError } from '../src/errors';
import { createInvite, readTeamCodes, redeemInvite, revokeTeamCode, seasonExpiry } from '../src/invites';
import type { AuthContext } from '../src/model';
import { addAdmin, addDevice, CODE_KEY, NOW, PEPPER, secrets, twoClubs } from './seed';
import { migratedDb, type SqliteD1 } from './sqliteD1';

let db: SqliteD1;
let n = 0;
const client = () => `198.51.100.${++n}`;

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    if (e instanceof HttpError) return `${e.status} ${e.code}`;
    throw e;
  }
}

const dump = () => JSON.stringify(db.sqlite.prepare('SELECT * FROM invites').all());

describe('cifrado de códigos', () => {
  const ctx = { inviteId: 'i1', teamId: 't1', role: 'viewer' };

  it('ida y vuelta; el texto cifrado no contiene el código y cambia en cada cifrado', async () => {
    const key = await codeKey(CODE_KEY);
    const a = await encryptCode(key, 'K7QM-4XRP-TB9H', ctx);
    const b = await encryptCode(key, 'K7QM-4XRP-TB9H', ctx);
    expect(a).toMatch(/^v1\./);
    expect(a).not.toContain('K7QM');
    expect(a).not.toBe(b);
    expect(await decryptCode(key, a, ctx)).toBe('K7QM-4XRP-TB9H');
    expect(await decryptCode(key, null, ctx)).toBeNull();
  });

  it('un texto cifrado copiado a otra fila, de otro rol o equipo, no se descifra', async () => {
    const key = await codeKey(CODE_KEY);
    const enc = await encryptCode(key, 'K7QM-4XRP-TB9H', { ...ctx, role: 'coach' });
    for (const other of [ctx, { ...ctx, role: 'coach', inviteId: 'i2' }, { ...ctx, role: 'coach', teamId: 't2' }]) {
      expect(await codeOf(decryptCode(key, enc, other))).toBe('500 code_corrupt');
    }
  });

  it('otra clave o un texto manipulado no se descifran', async () => {
    const key = await codeKey(CODE_KEY);
    const enc = await encryptCode(key, 'K7QM-4XRP-TB9H', ctx);
    const other = await codeKey(Buffer.alloc(32, 9).toString('base64url'));
    expect(await codeOf(decryptCode(other, enc, ctx))).toBe('500 code_corrupt');
    const tampered = enc.slice(0, -2) + (enc.endsWith('A') ? 'BB' : 'AA');
    expect(await codeOf(decryptCode(key, tampered, ctx))).toBe('500 code_corrupt');
    expect(await codeOf(decryptCode(key, 'v2.xxxx', ctx))).toBe('500 code_corrupt');
  });

  it('sin clave válida (ausente, corta o mal formada) no hay códigos: 503', async () => {
    for (const bad of [undefined, '', 'corta', Buffer.alloc(16, 1).toString('base64url'), '***no-base64***']) {
      expect(await codeOf(codeKey(bad)), String(bad)).toBe('503 codes_unavailable');
    }
  });
});

describe('vigencia por temporada', () => {
  it('los códigos de una temporada valen hasta el 1 de agosto del año siguiente', () => {
    expect(seasonExpiry('2026/27')).toBe('2027-08-01T00:00:00.000Z');
    expect(seasonExpiry('2099/00')).toBe('2100-08-01T00:00:00.000Z');
    for (const bad of ['2026/28', '2026-27', '26/27', '2026', '']) expect(() => seasonExpiry(bad), bad).toThrow(HttpError);
  });
});

describe('dos códigos por equipo', () => {
  let sa: AuthContext;

  beforeEach(async () => {
    db = migratedDb();
    twoClubs(db);
    sa = (await addAdmin(db, 'sa', [{ role: 'superadmin', clubId: null }], { critical: true })).auth;
  });

  it('al crear un equipo se generan sus dos códigos, cifrados, válidos toda la temporada y canjeables', async () => {
    const created = await createTeam(db, sa, { clubId: 'A', name: 'Senior Masculino A', code: 'sma2627', season: '2026/27', category: 'Senior', gender: 'male' }, await secrets(), new Date(NOW));
    expect(created.codes.coach.code).not.toBe(created.codes.viewer.code);
    const rows = db.sqlite.prepare('SELECT role, expires_at, code_enc IS NOT NULL AS cifrado FROM invites WHERE team_id = ? AND revoked_at IS NULL ORDER BY role').all(created.teamId);
    expect(rows).toEqual([
      { role: 'coach', expires_at: '2027-08-01T00:00:00.000Z', cifrado: 1 },
      { role: 'viewer', expires_at: '2027-08-01T00:00:00.000Z', cifrado: 1 },
    ]);
    for (const c of [created.codes.coach.code, created.codes.viewer.code]) {
      expect(dump()).not.toContain(c);
      expect(dump()).not.toContain(c.replace(/-/g, ''));
    }
    const coach = await redeemInvite(db, { code: created.codes.coach.code, clientKey: client() }, PEPPER);
    const viewer = await redeemInvite(db, { code: created.codes.viewer.code, clientKey: client() }, PEPPER);
    expect([coach.role, viewer.role]).toEqual(['coach', 'viewer']);
    expect(db.sqlite.prepare("SELECT code FROM teams WHERE id = ?").get(created.teamId)).toEqual({ code: 'SMA2627' });
  });

  it('el identificador del equipo no sirve como código', async () => {
    await createTeam(db, sa, { clubId: 'A', name: 'Senior Masculino A', code: 'SMA2627', season: '2026/27' }, await secrets());
    expect(await codeOf(redeemInvite(db, { code: 'SMA2627', clientKey: client() }, PEPPER))).toBe('404 invalid_code');
  });

  it('regenerar uno no toca el otro; el código anterior deja de valer, pero quien entró con él sigue dentro', async () => {
    const created = await createTeam(db, sa, { clubId: 'A', name: 'Equipo', code: 'EQ2627', season: '2026/27' }, await secrets());
    const before = await redeemInvite(db, { code: created.codes.viewer.code, clientKey: client() }, PEPPER);
    const fresh = await createInvite(db, sa, { teamId: created.teamId, role: 'viewer' }, await secrets());
    const codes = await readTeamCodes(db, sa, created.teamId, await codeKey(CODE_KEY));
    expect(codes.viewer?.code).toBe(fresh.code);
    expect(codes.coach?.code).toBe(created.codes.coach.code);
    expect(await codeOf(redeemInvite(db, { code: created.codes.viewer.code, clientKey: client() }, PEPPER))).toBe('404 invalid_code');
    const auth = await authenticate(db, before.token, PEPPER);
    expect(auth.grants.map((g) => g.role)).toEqual(['viewer']);
  });

  it('revocar uno no toca el otro; después se puede generar de nuevo', async () => {
    const created = await createTeam(db, sa, { clubId: 'A', name: 'Equipo', code: 'EQ2627', season: '2026/27' }, await secrets());
    await revokeTeamCode(db, sa, created.teamId, 'coach');
    const key = await codeKey(CODE_KEY);
    let codes = await readTeamCodes(db, sa, created.teamId, key);
    expect(codes.coach).toBeNull();
    expect(codes.viewer?.code).toBe(created.codes.viewer.code);
    expect(await codeOf(revokeTeamCode(db, sa, created.teamId, 'coach'))).toBe('404 not_found');
    await createInvite(db, sa, { teamId: created.teamId, role: 'coach' }, await secrets());
    codes = await readTeamCodes(db, sa, created.teamId, key);
    expect(codes.coach?.code).toMatch(/^[2-9A-Z]{4}-[2-9A-Z]{4}-[2-9A-Z]{4}$/);
  });
});

describe('quién puede ver qué código', () => {
  let teamId: string;
  let codes: { coach: string; viewer: string };
  let key: CryptoKey;

  beforeEach(async () => {
    db = migratedDb();
    twoClubs(db);
    key = await codeKey(CODE_KEY);
    const sa = (await addAdmin(db, 'sa', [{ role: 'superadmin', clubId: null }], { critical: true })).auth;
    const created = await createTeam(db, sa, { clubId: 'A', name: 'Senior Masculino A', code: 'SMA2627', season: '2026/27' }, await secrets());
    teamId = created.teamId;
    codes = { coach: created.codes.coach.code, viewer: created.codes.viewer.code };
  });

  const device = async (role: 'coach' | 'viewer', team = teamId, club = 'A') => (await addDevice(db, `${role}-${++n}`, [{ clubId: club, teamId: team, role }])).auth;

  it('superadministrador y administrador del club: los dos', async () => {
    const sa = (await addAdmin(db, 'sa2', [{ role: 'superadmin', clubId: null }])).auth;
    const ca = (await addAdmin(db, 'ca', [{ role: 'club_admin', clubId: 'A' }])).auth;
    for (const auth of [sa, ca]) {
      const r = await readTeamCodes(db, auth, teamId, key);
      expect(r).toMatchObject({ teamCode: 'SMA2627', season: '2026/27', coach: { code: codes.coach }, viewer: { code: codes.viewer } });
    }
  });

  it('entrenador del equipo: los dos (sin poder regenerarlos)', async () => {
    const coach = await device('coach');
    const r = await readTeamCodes(db, coach, teamId, key);
    expect(r).toMatchObject({ role: 'coach', coach: { code: codes.coach }, viewer: { code: codes.viewer } });
    expect(await codeOf(createInvite(db, coach, { teamId, role: 'coach' }, await secrets()))).toBe('403 forbidden');
    expect(await codeOf(revokeTeamCode(db, coach, teamId, 'viewer'))).toBe('403 forbidden');
  });

  it('consulta: solo el código de consulta; el de entrenador ni se menciona', async () => {
    const viewer = await device('viewer');
    const r = await readTeamCodes(db, viewer, teamId, key);
    expect(r).toMatchObject({ role: 'viewer', viewer: { code: codes.viewer } });
    expect(r).not.toHaveProperty('coach');
    expect(JSON.stringify(r)).not.toContain(codes.coach);
  });

  it('aislamiento: otro equipo, otro club o el administrador de otro club no ven nada', async () => {
    const otherTeam = await device('coach', 'a2');
    const otherClub = await device('coach', 'b1', 'B');
    const caB = (await addAdmin(db, 'caB', [{ role: 'club_admin', clubId: 'B' }])).auth;
    for (const auth of [otherTeam, otherClub, caB]) expect(await codeOf(readTeamCodes(db, auth, teamId, key))).toBe('404 not_found');
  });

  it('club suspendido: dispositivos y su administrador pierden el acceso; el superadministrador los sigue viendo', async () => {
    const coach = await device('coach');
    const ca = (await addAdmin(db, 'ca', [{ role: 'club_admin', clubId: 'A' }])).auth;
    const sa = (await addAdmin(db, 'sa2', [{ role: 'superadmin', clubId: null }])).auth;
    db.run("UPDATE clubs SET status = 'suspended' WHERE id = 'A'");
    expect(await codeOf(readTeamCodes(db, coach, teamId, key))).toBe('404 not_found');
    expect(await codeOf(readTeamCodes(db, ca, teamId, key))).toBe('404 not_found');
    expect((await readTeamCodes(db, sa, teamId, key)).viewer?.code).toBe(codes.viewer);
    // Y nadie puede canjear sus códigos mientras dure la suspensión.
    expect(await codeOf(redeemInvite(db, { code: codes.viewer, clientKey: client() }, PEPPER))).toBe('404 invalid_code');
    db.run("UPDATE clubs SET status = 'active' WHERE id = 'A'");
    expect(await codeOf(readTeamCodes(db, coach, teamId, key))).toBe('ok');
  });

  it('club eliminado: nadie los ve por la vía de dispositivos', async () => {
    const coach = await device('coach');
    db.run("UPDATE clubs SET deleted_at = ? WHERE id = 'A'", NOW);
    expect(await codeOf(readTeamCodes(db, coach, teamId, key))).toBe('404 not_found');
  });

  it('códigos caducados, revocados o agotados no se muestran; los anteriores al cifrado aparecen sin código', async () => {
    db.run("UPDATE invites SET expires_at = '2020-01-01T00:00:00.000Z' WHERE role = 'coach'");
    db.run("UPDATE invites SET code_enc = NULL WHERE role = 'viewer'");
    const r = await readTeamCodes(db, (await addAdmin(db, 'sa2', [{ role: 'superadmin', clubId: null }])).auth, teamId, key);
    expect(r.coach).toBeNull();
    expect(r.viewer).toMatchObject({ code: null });
  });
});
