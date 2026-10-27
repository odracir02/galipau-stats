import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { IndexedDbRepository } from '../data/indexedDbRepository';
import type { Match, Player, Team } from '../domain/types';
import { computeSeasonStats } from '../stats/engine';
import { rankingById, rankPlayers, seasonCandidates, type RankingId } from '../stats/rankings';
import { createMatch, deleteEvent, deleteMatch, recordEvent, toggleClock, updateEvent } from './matchService';
import { countsForSeason, loadSeasonItems } from './statsService';
import { createTeam, savePlayer } from './teamService';

let dbCounter = 0;
let repo: IndexedDbRepository;
let team: Team;
let p7: Player;
let p14: Player;

const t = { period: 1 as const, matchTimeMs: 0 };
const goal = { kind: 'shot', shotType: 'nine_m', result: 'goal' } as const;

beforeEach(async () => {
  repo = new IndexedDbRepository(`rankings-${++dbCounter}`);
  team = await createTeam(repo, { name: 'Senior Masculino', code: 'SM2627', season: '2026/27', maxSquad: 16 });
  p7 = await savePlayer(repo, team.id, { name: 'Jugador Siete', number: 7, position: 'field', active: true });
  p14 = await savePlayer(repo, team.id, { name: 'Jugador Catorce', number: 14, position: 'field', active: true });
});

async function playedMatch(date: string): Promise<Match> {
  const m = await createMatch(repo, {
    teamId: team.id,
    opponent: 'Rival de prueba',
    date,
    venue: 'home',
    season: '2026/27',
    playerIds: [p7.id, p14.id],
  });
  return toggleClock(repo, m);
}

/** Lo mismo que hace la pantalla de Rankings: leer del almacén y clasificar. */
async function ranking(id: RankingId) {
  const stats = computeSeasonStats(await loadSeasonItems(repo, team.id));
  return rankPlayers(rankingById(id), seasonCandidates(stats)).map((e) => [e.position, e.player.name, e.value]);
}

describe('rankings con datos guardados', () => {
  it('se actualizan al añadir, corregir y borrar acciones', async () => {
    const m = await playedMatch('2026-10-25');
    await recordEvent(repo, m, goal, p7.id, t);
    const second = await recordEvent(repo, m, goal, p7.id, t);
    const other = await recordEvent(repo, m, goal, p14.id, t);
    expect(await ranking('top_scorer')).toEqual([
      [1, 'Jugador Siete', 2],
      [2, 'Jugador Catorce', 1],
    ]);

    await deleteEvent(repo, second);
    expect(await ranking('top_scorer')).toEqual([
      [1, 'Jugador Siete', 1],
      [1, 'Jugador Catorce', 1],
    ]);

    await updateEvent(repo, m, other, { playerId: p7.id });
    expect(await ranking('top_scorer')).toEqual([[1, 'Jugador Siete', 2]]);
  });

  it('los partidos eliminados no cuentan', async () => {
    const kept = await playedMatch('2026-10-25');
    const removed = await playedMatch('2026-11-01');
    await recordEvent(repo, kept, goal, p14.id, t);
    await recordEvent(repo, removed, goal, p7.id, t);
    await recordEvent(repo, removed, goal, p7.id, t);
    expect((await ranking('top_scorer'))[0]).toEqual([1, 'Jugador Siete', 2]);

    await deleteMatch(repo, removed);
    expect(await ranking('top_scorer')).toEqual([[1, 'Jugador Catorce', 1]]);
    expect((await loadSeasonItems(repo, team.id)).map((i) => i.match.id)).toEqual([kept.id]);
  });

  it('un partido creado pero sin empezar ni acciones no cuenta', async () => {
    const m = await createMatch(repo, {
      teamId: team.id,
      opponent: 'Rival de prueba',
      date: '2026-10-25',
      venue: 'home',
      season: '2026/27',
      playerIds: [p7.id],
    });
    expect(countsForSeason(m, [])).toBe(false);
    expect(await loadSeasonItems(repo, team.id)).toEqual([]);
    expect(await ranking('top_scorer')).toEqual([]);
  });
});
