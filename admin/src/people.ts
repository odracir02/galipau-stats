// Auxiliares puros de «Jugadores del club» y «Rankings del club». Los tipos son
// los de las respuestas del servidor (server/src/people.ts y clubRankings.ts):
// aquí no se calcula ninguna estadística ni clasificación.
import { formatPct } from '../../src/domain/format';
import { rankingById, type RankingId } from '../../src/stats/rankings';
import type { Gender } from './format';

export type RankingsVisibility = 'admins' | 'coaches' | 'members';

export interface CardView {
  playerId: string;
  teamId: string;
  teamCode: string;
  teamName: string;
  season: string;
  number: number;
  name: string;
  position: 'field' | 'goalkeeper';
  active: boolean;
  rankingExcluded: boolean;
}

export interface PersonView {
  id: string;
  displayName: string;
  rankingExcluded: boolean;
  version: number;
  cards: CardView[];
}

export interface RankingsTeam {
  teamId: string;
  code: string;
  name: string;
  season: string;
  gender: Gender | null;
  participates: boolean;
  group: string | null;
}

export interface ClubPeople {
  people: PersonView[];
  unlinked: CardView[];
  rankings: { visibility: RankingsVisibility; teams: RankingsTeam[] };
}

export interface GroupKey {
  season: string;
  gender: Gender;
  group: string;
}

export interface ClubRankingEntry {
  position: number;
  name: string;
  teams: string[];
  matches: number;
  value: number;
  made?: number;
  of?: number;
}

export interface ClubRankingsView {
  season: string;
  gender: Gender;
  group: string;
  computedAt: string;
  teams: { code: string; name: string }[];
  rankings: { id: RankingId; ranked: number; hiddenTies: number; entries: ClubRankingEntry[] }[];
}

export const VISIBILITY_LABEL: Record<RankingsVisibility, string> = {
  admins: 'Solo administradores del club',
  coaches: 'Entrenadores de los equipos participantes',
  members: 'Jugadores y familias',
};

/** Texto sin mayúsculas ni tildes, para buscar «José» con «jose». */
export const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();

/**
 * Fichas que coinciden con la búsqueda: por nombre, equipo (código o nombre) o
 * temporada; una palabra solo de cifras es el dorsal exacto («7» no encuentra el
 * 17 ni el 7 de «SMA2627»). Sin búsqueda, todas.
 */
export function searchCards(cards: readonly CardView[], query: string): CardView[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...cards];
  return cards.filter((c) => {
    const text = fold(`${c.name} ${c.teamCode} ${c.teamName} ${c.season}`);
    return words.every((w) => (/^\d+$/.test(w) ? String(c.number) === w : text.includes(w)));
  });
}

/** Personas cuyo nombre visible o alguna de sus fichas coincide con la búsqueda. */
export function searchPeople(people: readonly PersonView[], query: string): PersonView[] {
  if (!fold(query)) return [...people];
  return people.filter((p) => fold(p.displayName).includes(fold(query)) || searchCards(p.cards, query).length > 0);
}

/** «SMA2627 · 2026/27 · nº 7» (sin identificadores internos). */
export const cardTeamLine = (c: CardView) => `${c.teamCode} · ${c.season} · nº ${c.number}`;

/**
 * Por qué una ficha no se puede unir a otra (o a una persona), o null si se
 * puede. Las mismas reglas que el servidor, para no ofrecer lo imposible.
 */
export function linkProblem(card: CardView, target: { cards: readonly CardView[] }): string | null {
  if (target.cards.some((c) => c.playerId === card.playerId)) return 'Es la misma ficha.';
  if (target.cards.some((c) => c.teamId === card.teamId)) return 'Ya tiene una ficha en este equipo.';
  return null;
}

/** Grupos que se pueden consultar: equipos participantes con modalidad y grupo. */
export function rankingGroups(teams: readonly RankingsTeam[]): GroupKey[] {
  const seen = new Map<string, GroupKey>();
  for (const t of teams) {
    if (!t.participates || !t.group || !t.gender) continue;
    const key = `${t.season}|${t.gender}|${t.group}`;
    if (!seen.has(key)) seen.set(key, { season: t.season, gender: t.gender, group: t.group });
  }
  return [...seen.values()].sort((a, b) => b.season.localeCompare(a.season) || a.gender.localeCompare(b.gender) || a.group.localeCompare(b.group, 'es'));
}

export const groupQuery = (g: GroupKey) =>
  `season=${encodeURIComponent(g.season)}&gender=${encodeURIComponent(g.gender)}&group=${encodeURIComponent(g.group)}`;

/** Por qué un equipo todavía no clasifica con otros, o null si está listo. */
export function teamRankingProblem(t: RankingsTeam): string | null {
  if (!t.gender) return 'Indica la modalidad del equipo (en «Datos del equipo») para poder agruparlo.';
  if (t.participates && !t.group) return 'Participa, pero sin grupo: no aparece en ninguna clasificación.';
  return null;
}

/** Título y cifra de una clasificación, como en los rankings de equipo. */
export const rankingTitle = (id: RankingId) => rankingById(id).title;
export function rankingValue(id: RankingId, e: ClubRankingEntry): string {
  const def = rankingById(id);
  if (def.format === 'pct') return `${formatPct(e.value)} · ${e.made}/${e.of}`;
  const [one, many] = def.unit!;
  return `${e.value} ${e.value === 1 ? one : many}`;
}
