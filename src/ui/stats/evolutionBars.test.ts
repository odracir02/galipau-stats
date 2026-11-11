// Barras de evolución: aciertos sobre el total de cada partido con escala común,
// cifras exactas en texto y nombre accesible; sin cálculos propios. Datos sintéticos.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Position } from '../../domain/types';
import { emptyCounters } from '../../stats/engine';
import { EvolutionBars } from './EvolutionBars';
import { evolutionBars, SERIES_LIMIT, type MyMatchPoint } from './mySeason';

/** Partido de la serie de N-B (lo que da myMatchSeries) con las cifras indicadas. */
function point(id: string, day: number, position: Position, v: { goals?: number; attempts?: number; saves?: number; onTarget?: number; actions?: number } = {}): MyMatchPoint {
  const counters = emptyCounters();
  counters.shots = { goals: v.goals ?? 0, out: (v.attempts ?? 0) - (v.goals ?? 0), saved: 0, attempts: v.attempts ?? 0 };
  counters.gk = { saves: v.saves ?? 0, goals: (v.onTarget ?? 0) - (v.saves ?? 0), out: 0, received: v.onTarget ?? 0 };
  return {
    matchId: id,
    date: `2026-10-${String(day).padStart(2, '0')}`,
    opponent: `Rival ${id}`,
    venue: 'home',
    score: { own: 20, opponent: 18 },
    result: 'win',
    position,
    counters,
    actions: v.actions ?? (v.attempts ?? 0) + (v.onTarget ?? 0),
    gkOnTarget: v.onTarget ?? 0,
  };
}

const html = (points: MyMatchPoint[], onOpen?: (id: string) => void) =>
  renderToStaticMarkup(createElement(EvolutionBars, { points, title: 'Evolución de la temporada', onOpen }));
const text = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const widths = (markup: string, cls: string) =>
  [...markup.matchAll(new RegExp(`class="${cls}[^"]*"[^>]*style="width:([0-9.]+)%`, 'g'))].map((m) => Number(m[1]));

describe('datos de las barras', () => {
  it('campo: goles sobre lanzamientos; portero: paradas sobre lanzamientos entre palos', () => {
    const { bars } = evolutionBars([point('a', 1, 'field', { goals: 2, attempts: 5 }), point('b', 2, 'goalkeeper', { saves: 7, onTarget: 12 })]);
    expect(bars.map((b) => [b.matchId, b.position, b.made, b.total])).toEqual([
      ['a', 'field', 2, 5],
      ['b', 'goalkeeper', 7, 12],
    ]);
  });

  it('posición de cada convocatoria: un portero que lanza no mezcla sus goles con la portería', () => {
    const keeperWhoScores = point('k', 1, 'goalkeeper', { goals: 1, attempts: 1, saves: 3, onTarget: 4 });
    const fieldWithKeeperData = point('f', 2, 'field', { goals: 2, attempts: 3, saves: 1, onTarget: 1 });
    const { bars, mixed } = evolutionBars([keeperWhoScores, fieldWithKeeperData]);
    expect(bars.map((b) => [b.made, b.total])).toEqual([
      [3, 4],
      [2, 3],
    ]);
    expect(mixed).toBe(true);
    expect(evolutionBars([keeperWhoScores]).mixed).toBe(false);
  });

  it('escala común: el mayor total de la serie (al menos 1 aunque todo sea cero)', () => {
    expect(evolutionBars([point('a', 1, 'field', { goals: 1, attempts: 4 }), point('b', 2, 'field', { goals: 3, attempts: 8 })]).scales.field).toBe(8);
    expect(evolutionBars([point('a', 1, 'field')]).scales.field).toBe(1);
  });

  it('posición mixta: una escala por posición (lanzamientos de campo y entre palos, cada uno con la suya)', () => {
    const { scales } = evolutionBars([
      point('a', 1, 'field', { goals: 1, attempts: 2 }),
      point('b', 2, 'goalkeeper', { saves: 9, onTarget: 15 }),
      point('c', 3, 'field', { goals: 3, attempts: 4 }),
      point('d', 4, 'goalkeeper', { saves: 2, onTarget: 5 }),
    ]);
    expect(scales).toEqual({ field: 4, goalkeeper: 15 });
    // Un portero que también lanza: su escala de campo no se ve afectada por sus paradas.
    expect(evolutionBars([point('a', 1, 'goalkeeper', { goals: 1, attempts: 1, saves: 3, onTarget: 20 })]).scales).toEqual({ field: 1, goalkeeper: 20 });
  });

  it('diez partidos como mucho: los más recientes, en el orden recibido (cronológico)', () => {
    const twelve = Array.from({ length: 12 }, (_, i) => point(`m${i + 1}`, i + 1, 'field', { goals: i, attempts: 12 }));
    const { bars } = evolutionBars(twelve);
    expect(bars).toHaveLength(SERIES_LIMIT);
    expect(bars.map((b) => b.matchId)).toEqual(twelve.slice(2).map((p) => p.matchId));
  });

  it('partido sin acciones: se conserva, con total cero', () => {
    const { bars } = evolutionBars([point('a', 1, 'field', { goals: 1, attempts: 2 }), point('b', 2, 'field', { actions: 0 })]);
    expect(bars.map((b) => [b.matchId, b.total])).toEqual([
      ['a', 2],
      ['b', 0],
    ]);
  });
});

describe('componente', () => {
  it('cifras exactas visibles y una frase completa por partido para lectores de pantalla', () => {
    const t = text(html([point('a', 4, 'field', { goals: 2, attempts: 3 }), point('b', 11, 'goalkeeper', { saves: 1, onTarget: 1 })]));
    expect(t).toContain('2 de 3');
    expect(t).toContain('04/10/2026, vs Rival a (campo): 2 goles de 3 lanzamientos registrados.');
    expect(t).toContain('11/10/2026, vs Rival b (portero): 1 parada de 1 lanzamiento entre palos.');
    expect(t).toContain('04/10');
  });

  it('escala común y aciertos como parte del total (la pista es el total; el relleno, los aciertos)', () => {
    const m = html([point('a', 1, 'field', { goals: 2, attempts: 4 }), point('b', 2, 'field', { goals: 6, attempts: 8 })]);
    expect(widths(m, 'evo-track')).toEqual([50, 100]);
    expect(widths(m, 'evo-fill')).toEqual([50, 75]);
    // Una sola barra por partido: la de aciertos va dentro de la del total.
    expect(m.match(/class="evo-track"/g)).toHaveLength(2);
    expect(m).toMatch(/<span class="evo-track"[^>]*><span class="evo-fill/);
  });

  it('posición mixta: cada barra con la escala de su posición; dentro de cada una, comparables', () => {
    const m = html([
      point('a', 1, 'field', { goals: 1, attempts: 2 }),
      point('b', 2, 'goalkeeper', { saves: 9, onTarget: 15 }),
      point('c', 3, 'field', { goals: 3, attempts: 4 }),
      point('d', 4, 'goalkeeper', { saves: 2, onTarget: 5 }),
      point('e', 5, 'field', { actions: 1 }),
    ]);
    // Campo: 2 y 4 sobre 4. Portería: 15 y 5 sobre 15. Sin lanzamientos: sin barra.
    expect(widths(m, 'evo-track').map((w) => Math.round(w * 10) / 10)).toEqual([50, 100, 100, 33.3]);
    expect(widths(m, 'evo-fill').map((w) => Math.round(w * 10) / 10)).toEqual([50, 60, 75, 40]);
    expect(text(m)).toContain('Sin lanzamientos registrados');
  });

  it('una sola posición: igual que antes (la escala es el mayor total de la serie)', () => {
    const m = html([point('a', 1, 'goalkeeper', { saves: 3, onTarget: 6 }), point('b', 2, 'goalkeeper', { saves: 6, onTarget: 12 })]);
    expect(widths(m, 'evo-track')).toEqual([50, 100]);
  });

  it('sin lanzamientos registrados: estado neutro, sin barra ni porcentajes', () => {
    const m = html([point('a', 1, 'field', { actions: 1 }), point('b', 2, 'goalkeeper')]);
    const t = text(m);
    expect(t).toContain('Sin lanzamientos registrados');
    expect(t).toContain('Sin lanzamientos entre palos registrados');
    expect(t).toContain('01/10/2026, vs Rival a (campo): sin lanzamientos registrados.');
    expect(m).not.toContain('evo-track');
    expect(t).not.toMatch(/%|0 de 0/);
  });

  it('serie de una sola posición: sin etiqueta de posición; mixta: con etiqueta y leyenda de ambas', () => {
    const single = text(html([point('a', 1, 'field', { goals: 1, attempts: 2 })]));
    expect(single).not.toMatch(/\bCampo\b|\(campo\)/);
    expect(single).toContain('Goles sobre lanzamientos registrados');
    const mixed = text(html([point('a', 1, 'field', { goals: 1, attempts: 2 }), point('b', 2, 'goalkeeper', { saves: 2, onTarget: 3 })]));
    expect(mixed).toContain('Goles sobre lanzamientos registrados');
    expect(mixed).toContain('Paradas sobre lanzamientos recibidos entre palos');
    expect(mixed).toMatch(/Campo.*Portero/);
  });

  it('accesible: lista con nombre; lo visual, oculto a los lectores; la frase, solo para ellos', () => {
    const m = html([point('a', 1, 'field', { goals: 1, attempts: 2 })]);
    expect(m).toContain('<ol class="evo-list" aria-label="Evolución de la temporada">');
    expect(m).toMatch(/<span class="evo-head" aria-hidden="true">/);
    expect(m).toMatch(/<span class="evo-track" aria-hidden="true"/);
    expect(m).toMatch(/<span class="sr-only">01\/10\/2026/);
  });

  it('sin acción: filas sin botón; con acción: un botón por partido, sin rutas propias', () => {
    const points = [point('a', 1, 'field', { goals: 1, attempts: 2 }), point('b', 2, 'field')];
    expect(html(points)).not.toContain('<button');
    const m = html(points, vi.fn());
    expect(m.match(/<button type="button" class="evo-row">/g)).toHaveLength(2);
    expect(m).not.toMatch(/href=/);
  });

  it('serie vacía: no se pinta nada', () => {
    expect(html([])).toBe('');
  });
});
