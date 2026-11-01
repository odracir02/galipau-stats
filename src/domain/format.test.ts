import { describe, expect, it } from 'vitest';
import { clockFromParts, formatClock, formatPct, opponentLabel, parseClock, publicTeamName, seasonFor } from './format';

describe('formato de tiempo', () => {
  it('formatea mm:ss, también por encima de 60 minutos', () => {
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(26 * 60_000 + 30_000)).toBe('26:30');
    expect(formatClock(61 * 60_000 + 5_999)).toBe('61:05');
  });

  it('interpreta mm:ss, mm y separadores de teclado numérico', () => {
    expect(parseClock('23:45')).toBe((23 * 60 + 45) * 1000);
    expect(parseClock('23.45')).toBe((23 * 60 + 45) * 1000);
    expect(parseClock('23,5')).toBe((23 * 60 + 5) * 1000);
    expect(parseClock('12')).toBe(12 * 60_000);
    expect(parseClock('12:60')).toBeNull();
    expect(parseClock('abc')).toBeNull();
    expect(parseClock('')).toBeNull();
  });

  it('minutos y segundos en campos separados: exacto, sin decimales', () => {
    expect(clockFromParts('20', '55')).toBe((20 * 60 + 55) * 1000);
    expect(clockFromParts('00', '00')).toBe(0);
    expect(clockFromParts('29', '59')).toBe((29 * 60 + 59) * 1000);
    expect(clockFromParts('05', '7')).toBe((5 * 60 + 7) * 1000);
    expect(clockFromParts('61', '05')).toBe((61 * 60 + 5) * 1000);
    // Un campo vacío cuenta como 0, pero no los dos.
    expect(clockFromParts('', '45')).toBe(45_000);
    expect(clockFromParts('12', '')).toBe(12 * 60_000);
    expect(clockFromParts('', '')).toBeNull();
    // Segundos de 00 a 59; solo cifras (sin comas, puntos ni signos).
    expect(clockFromParts('20', '60')).toBeNull();
    expect(clockFromParts('20', '99')).toBeNull();
    expect(clockFromParts('20,55', '')).toBeNull();
    expect(clockFromParts('20.5', '0')).toBeNull();
    expect(clockFromParts('-1', '00')).toBeNull();
    expect(clockFromParts('20', '5.5')).toBeNull();
    expect(clockFromParts('1000', '00')).toBeNull();
  });

  it('porcentaje sin datos se muestra como guion', () => {
    expect(formatPct(null)).toBe('—');
    expect(formatPct(50)).toMatch(/^50\s%$/);
  });

  it('propone la temporada deportiva de julio a junio', () => {
    expect(seasonFor(new Date(2026, 9, 27))).toBe('2026/27');
    expect(seasonFor(new Date(2027, 2, 1))).toBe('2026/27');
    expect(seasonFor(new Date(2027, 6, 1))).toBe('2027/28');
  });
});

describe('nombres en partidos', () => {
  it('el marcador usa el nombre público y, si falta, el nombre del equipo (nunca el código)', () => {
    expect(publicTeamName({ name: 'Senior Masculino A', publicName: 'BM Burjassot' })).toBe('BM Burjassot');
    expect(publicTeamName({ name: 'Senior Masculino A' })).toBe('Senior Masculino A');
    expect(publicTeamName({ name: 'Senior Masculino A', publicName: '   ' })).toBe('Senior Masculino A');
  });

  it('el rival se presenta igual como local y como visitante, sin «@»', () => {
    expect(opponentLabel('BM Marni')).toBe('vs BM Marni');
  });
});
