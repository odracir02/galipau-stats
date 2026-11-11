// «Rankings» con «Mi equipo / Todo el club»: siempre se abre en «Mi equipo»; el
// selector solo aparece cuando el servidor ofrece el club (con conexión). Sin
// conexión, los rankings del equipo funcionan como siempre. Datos sintéticos.
import 'fake-indexeddb/auto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ClubGroupsState } from '../../app/useClubRankings';

const groups = vi.hoisted(() => ({ state: { status: 'loading' } as ClubGroupsState }));
vi.mock('../../app/useClubRankings', () => ({ useClubRankingGroups: () => ({ state: groups.state, recheck: () => undefined }) }));
// Nunca se pide nada al servidor en esta prueba.
vi.mock('../../app/remote', () => ({ clubRankings: null }));

const { RankingsWithClub } = await import('./ClubRankingsView');

const TEAM = 'RANKINGS-DEL-EQUIPO';
const html = (state: ClubGroupsState, clubId: string | null = 'A') => {
  groups.state = state;
  return renderToStaticMarkup(
    createElement(RankingsWithClub, { clubId, teamId: 'sma', clubName: 'Club', players: [], team: createElement('p', null, TEAM) }),
  );
};

describe('«Mi equipo / Todo el club»', () => {
  it('con el club disponible: el selector, abierto en «Mi equipo» y mostrando los rankings del equipo', () => {
    const out = html({ status: 'ready', groups: [{ season: '2026/27', group: 'Todo el club', teamIds: ['sma'] }] });
    expect(out).toContain('role="tablist"');
    expect(out).toMatch(/aria-selected="true"[^>]*>Mi equipo</);
    expect(out).toMatch(/aria-selected="false"[^>]*>Todo el club</);
    expect(out).toContain(TEAM);
    // No se ha pedido ni mostrado ninguna clasificación del club.
    expect(out).not.toContain('Rankings del club');
  });

  it('sin conexión, cargando o sin acceso: sin selector, los rankings del equipo tal cual', () => {
    for (const state of [{ status: 'unknown' }, { status: 'loading' }, { status: 'none', lost: false }] as ClubGroupsState[]) {
      const out = html(state);
      expect(out, state.status).not.toContain('tablist');
      expect(out, state.status).toContain(TEAM);
    }
  });

  it('acceso retirado: lo avisa y sigue mostrando el equipo', () => {
    const out = html({ status: 'none', lost: true });
    expect(out).toContain('ya no están disponibles');
    expect(out).toContain(TEAM);
  });

  it('equipo sin club (cuenta local): solo el equipo', () => {
    const out = html({ status: 'ready', groups: [{ season: '2026/27', group: 'Todo el club' }] }, null);
    expect(out).not.toContain('tablist');
    expect(out).toContain(TEAM);
  });
});
