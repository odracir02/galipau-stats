import { describe, expect, it } from 'vitest';
import { DEFENSE_KINDS, isLegacyKind, SIMPLE_KINDS } from './catalog';

describe('catálogo de acciones registrables', () => {
  it('el golpe franco ya no se ofrece para registrar', () => {
    expect(DEFENSE_KINDS).not.toContain('free_throw');
    expect(SIMPLE_KINDS).not.toContain('free_throw');
    expect(isLegacyKind('free_throw')).toBe(true);
  });

  it('el resto de acciones defensivas se mantiene, incluido el penalti cometido', () => {
    expect(DEFENSE_KINDS).toEqual(['yellow', 'exclusion', 'red', 'penalty_committed']);
    expect(isLegacyKind('penalty_committed')).toBe(false);
  });
});
