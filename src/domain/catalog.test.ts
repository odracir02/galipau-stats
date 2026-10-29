import { describe, expect, it } from 'vitest';
import { DEFENSE_KINDS, isLegacyKind, isTeamKind, SIMPLE_KINDS, TEAM_KINDS } from './catalog';

describe('catálogo de acciones registrables', () => {
  it('el golpe franco vuelve como acción de equipo, fuera de «Defensa y sanciones»', () => {
    expect(TEAM_KINDS).toEqual(['free_throw']);
    expect(isTeamKind('free_throw')).toBe(true);
    expect(SIMPLE_KINDS).toContain('free_throw');
    expect(DEFENSE_KINDS).not.toContain('free_throw');
    expect(isLegacyKind('free_throw')).toBe(false);
  });

  it('el resto de acciones defensivas se mantiene, incluido el penalti cometido', () => {
    expect(DEFENSE_KINDS).toEqual(['yellow', 'exclusion', 'red', 'penalty_committed']);
    expect(isLegacyKind('penalty_committed')).toBe(false);
    expect(isTeamKind('exclusion')).toBe(false);
  });
});
