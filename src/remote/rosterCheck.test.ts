// Coincidencias de dorsal antes de vincular: solo se identifican, nunca se unen. Datos sintéticos.
import { describe, expect, it } from 'vitest';
import type { Player } from '../domain/types';
import { rosterCoincidences } from './rosterCheck';

const p = (id: string, name: string, number: number, extra: Partial<Player> = {}) =>
  ({ id, name, number, active: true, role: 'player', ...extra }) as Pick<Player, 'id' | 'name' | 'number' | 'active' | 'role'>;

describe('coincidencias de dorsal con el club', () => {
  it('mismo dorsal y distinta ficha: coincidencia, con o sin el mismo nombre', () => {
    const local = [p('l12', 'Ana López', 12), p('l15', 'Bea Ruiz', 15), p('l30', 'Carla', 30)];
    const club = [p('c12', 'ana lópez', 12), p('c15', 'Beatriz Ruiz', 15), p('c40', 'Dani', 40)];
    expect(rosterCoincidences(local, club)).toEqual([
      { number: 12, local: { id: 'l12', name: 'Ana López' }, club: { id: 'c12', name: 'ana lópez' }, sameName: true },
      { number: 15, local: { id: 'l15', name: 'Bea Ruiz' }, club: { id: 'c15', name: 'Beatriz Ruiz' }, sameName: false },
    ]);
  });

  it('la misma ficha (mismo id), inactivas y cuerpo técnico no cuentan; dos personas con el mismo nombre y distinto dorsal, tampoco', () => {
    const local = [p('same', 'Ana', 12), p('l7', 'Baja', 7, { active: false }), p('of', 'Entrenador', 0, { role: 'official' }), p('l20', 'Laura', 20)];
    const club = [p('same', 'Ana', 12), p('c7', 'Otra', 7), p('cof', 'Entrenadora', 0, { role: 'official' }), p('c21', 'Laura', 21)];
    expect(rosterCoincidences(local, club)).toEqual([]);
  });
});
