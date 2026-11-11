import { describe, expect, it } from 'vitest';
import { cardTeamLine, fold, groupQuery, linkProblem, rankingGroups, rankingValue, searchCards, searchPeople, teamRankingProblem, type CardView, type PersonView, type RankingsTeam } from './people';

const card = (playerId: string, teamId: string, name: string, number: number, extra: Partial<CardView> = {}): CardView => ({
  playerId,
  teamId,
  teamCode: teamId.toUpperCase() + '2627',
  teamName: `Senior ${teamId}`,
  season: '2026/27',
  number,
  name,
  position: 'field',
  active: true,
  rankingExcluded: false,
  ...extra,
});
const team = (teamId: string, extra: Partial<RankingsTeam> = {}): RankingsTeam => ({
  teamId,
  code: teamId.toUpperCase(),
  name: teamId,
  season: '2026/27',
  gender: 'male',
  participates: true,
  group: 'senior',
  ...extra,
});

const cards = [card('a7', 'sma', 'José Martínez', 7), card('b17', 'smb', 'Ana López', 17), card('b7', 'smb', 'Luis Pérez', 70)];

describe('búsqueda de fichas y personas', () => {
  it('por nombre sin tildes ni mayúsculas, por equipo, por temporada y por dorsal exacto', () => {
    expect(fold('  JOSÉ Martínez ')).toBe('jose martinez');
    expect(searchCards(cards, 'jose').map((c) => c.playerId)).toEqual(['a7']);
    expect(searchCards(cards, 'smb2627').map((c) => c.playerId)).toEqual(['b17', 'b7']);
    // Un número busca el dorsal exacto (7 no encuentra el 17 ni el 70).
    expect(searchCards(cards, '7').map((c) => c.playerId)).toEqual(['a7']);
    expect(searchCards(cards, 'smb 70').map((c) => c.playerId)).toEqual(['b7']);
    expect(searchCards(cards, '2026/27')).toHaveLength(3);
    expect(searchCards(cards, '   ')).toHaveLength(3);
    expect(searchCards(cards, 'nadie')).toEqual([]);
  });

  it('una persona coincide por su nombre visible o por cualquiera de sus fichas', () => {
    const people: PersonView[] = [{ id: 'p1', displayName: 'Ana L.', rankingExcluded: false, version: 1, cards: [cards[1]!] }];
    expect(searchPeople(people, 'ana')).toHaveLength(1);
    expect(searchPeople(people, '17')).toHaveLength(1);
    expect(searchPeople(people, 'jose')).toEqual([]);
  });

  it('describe la ficha sin identificadores internos', () => {
    expect(cardTeamLine(cards[0]!)).toBe('SMA2627 · 2026/27 · nº 7');
    expect(cardTeamLine(cards[0]!)).not.toContain('a7');
  });
});

describe('reglas antes de unir (las del servidor)', () => {
  it('no se ofrece unir una ficha consigo misma ni dos fichas del mismo equipo', () => {
    expect(linkProblem(cards[0]!, { cards: [cards[0]!] })).toBe('Es la misma ficha.');
    expect(linkProblem(cards[1]!, { cards: [cards[2]!] })).toBe('Ya tiene una ficha en este equipo.');
    expect(linkProblem(cards[0]!, { cards: [cards[1]!] })).toBeNull();
  });
});

describe('rankings del club', () => {
  it('grupos: solo equipos que participan con modalidad y grupo, sin repetir, los más recientes primero', () => {
    const teams = [
      team('sma'),
      team('smb'),
      team('sfa', { gender: 'female' }),
      team('old', { season: '2025/26' }),
      team('np', { participates: false }),
      team('sin-grupo', { group: null }),
      team('sin-modalidad', { gender: null }),
    ];
    expect(rankingGroups(teams)).toEqual([
      { season: '2026/27', gender: 'female', group: 'senior' },
      { season: '2026/27', gender: 'male', group: 'senior' },
      { season: '2025/26', gender: 'male', group: 'senior' },
    ]);
    expect(rankingGroups([])).toEqual([]);
    expect(groupQuery({ season: '2026/27', gender: 'male', group: 'sénior A' })).toBe('season=2026%2F27&gender=male&group=s%C3%A9nior%20A');
  });

  it('avisa de los equipos que no pueden clasificar', () => {
    expect(teamRankingProblem(team('x', { gender: null }))).toMatch(/modalidad/);
    expect(teamRankingProblem(team('x', { group: null }))).toMatch(/sin grupo/);
    expect(teamRankingProblem(team('x', { participates: false, group: null }))).toBeNull();
    expect(teamRankingProblem(team('x'))).toBeNull();
  });

  it('muestra las cifras tal como llegan del servidor (sin calcular nada)', () => {
    expect(rankingValue('top_scorer', { position: 1, name: 'A', teams: [], matches: 2, value: 1 })).toBe('1 gol');
    expect(rankingValue('top_scorer', { position: 1, name: 'A', teams: [], matches: 2, value: 4 })).toBe('4 goles');
    expect(rankingValue('sharpshooter', { position: 1, name: 'A', teams: [], matches: 2, value: 33.3, made: 4, of: 12 })).toMatch(/^33,3\s?% · 4\/12$/);
  });
});
