import { describe, expect, it } from 'vitest';
import { reductionTag, statusBadge } from './labels';

describe('etiqueta de estado en la lista de partidos', () => {
  it('finalizado: Victoria, Derrota o Empate según nuestro marcador', () => {
    expect(statusBadge('finished', { own: 24, opponent: 22 })).toEqual({ label: 'Victoria', tone: 'win' });
    expect(statusBadge('finished', { own: 22, opponent: 28 })).toEqual({ label: 'Derrota', tone: 'loss' });
    expect(statusBadge('finished', { own: 25, opponent: 25 })).toEqual({ label: 'Empate', tone: 'draw' });
  });

  it('los no finalizados conservan su etiqueta y su estilo', () => {
    expect(statusBadge('ready', { own: 3, opponent: 0 })).toEqual({ label: 'Preparado', tone: 'ready' });
    expect(statusBadge('in_progress', { own: 3, opponent: 0 })).toEqual({ label: 'En curso', tone: 'in_progress' });
    expect(statusBadge('halftime', { own: 0, opponent: 3 })).toEqual({ label: 'Descanso', tone: 'halftime' });
  });
});

describe('etiqueta de las inferioridades', () => {
  it('exclusión normal sin etiqueta; roja y duración especial, en corto', () => {
    expect(reductionTag({ kind: 'exclusion', durationMs: 120_000 })).toBeNull();
    expect(reductionTag({ kind: 'red', durationMs: 120_000 })).toBe('Roja');
    expect(reductionTag({ kind: 'accumulated', durationMs: 120_000 })).toBe('Roja');
    expect(reductionTag({ kind: 'exclusion', durationMs: 240_000 })).toBe("4'");
    expect(reductionTag({ kind: 'red', durationMs: 240_000 })).toBe("Roja 4'");
  });
});
