import { describe, expect, it } from 'vitest';
import { reauthUrl } from './api';
import { canManageClub, formatDay, groupBySeason, isValidSeason, isValidTeamCode, maskCode, normalizeTeamCode, type Me, type TeamSummary } from './format';

const team = (name: string, season: string): TeamSummary => ({
  id: name,
  name,
  code: 'X',
  season,
  category: null,
  gender: null,
  codes: { coach: true, viewer: true },
});

describe('panel: auxiliares', () => {
  it('agrupa por temporada (la más reciente primero) y ordena por nombre', () => {
    const groups = groupBySeason([team('Senior Masculino B', '2026/27'), team('Senior Femenino A', '2025/26'), team('Senior Masculino A', '2026/27')]);
    expect(groups.map(([s, t]) => [s, t.map((x) => x.name)])).toEqual([
      ['2026/27', ['Senior Masculino A', 'Senior Masculino B']],
      ['2025/26', ['Senior Femenino A']],
    ]);
  });

  it('oculta el código conservando su formato', () => {
    expect(maskCode('K7QM-4XRP-TB9H')).toBe('••••-••••-••••');
  });

  it('valida identificador y temporada como el servidor', () => {
    expect(normalizeTeamCode(' sma 2627 ')).toBe('SMA2627');
    expect(isValidTeamCode('sma2627')).toBe(true);
    expect(isValidTeamCode('S-1')).toBe(false);
    expect(isValidSeason('2026/27')).toBe(true);
    expect(isValidSeason('2026/28')).toBe(false);
  });

  it('solo el superadministrador o el administrador de ese club gestionan el club', () => {
    const sa: Me = { identityId: 'x', email: 'a@b.c', roles: [{ role: 'superadmin', clubId: null }], criticalOpsEnabled: false };
    const ca: Me = { ...sa, roles: [{ role: 'club_admin', clubId: 'A' }] };
    expect(canManageClub(sa, 'B')).toBe(true);
    expect(canManageClub(ca, 'A')).toBe(true);
    expect(canManageClub(ca, 'B')).toBe(false);
  });

  it('formatea fechas en UTC y la vuelta tras verificar solo apunta al panel', () => {
    expect(formatDay('2027-08-01T00:00:00.000Z')).toBe('01/08/2027');
    expect(decodeURIComponent(reauthUrl('#/clubs/A/teams/t1'))).toBe('/api/admin/critical/reauth?return=/admin/#/clubs/A/teams/t1');
    expect(decodeURIComponent(reauthUrl('#javascript:alert(1)'))).toBe('/api/admin/critical/reauth?return=/admin/');
  });
});
