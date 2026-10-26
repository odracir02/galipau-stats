import { describe, expect, it } from 'vitest';
import { formatClock, formatPct, parseClock, seasonFor } from './format';

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
