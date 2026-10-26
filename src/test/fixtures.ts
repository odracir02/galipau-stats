// Datos ficticios para pruebas. No representan jugadores reales.
import { buildEvent } from '../domain/events';
import { initialClock, MINUTE_MS } from '../clock/clock';
import type { EventPayload, Id, Match, MatchEvent, Period, SquadEntry } from '../domain/types';

export const SQUAD: SquadEntry[] = [
  { playerId: 'p7', name: 'Jugador Siete', number: 7, position: 'field' },
  { playerId: 'p14', name: 'Jugador Catorce', number: 14, position: 'field' },
  { playerId: 'p69', name: 'Jugador Sesenta y nueve', number: 69, position: 'field' },
  { playerId: 'g1', name: 'Portero Uno', number: 1, position: 'goalkeeper' },
  { playerId: 'g12', name: 'Portero Doce', number: 12, position: 'goalkeeper' },
];

export function makeMatch(overrides: Partial<Match> = {}): Match {
  return {
    id: 'm1',
    teamId: 't1',
    opponent: 'Rival de prueba',
    date: '2026-10-25',
    venue: 'home',
    season: '2026/27',
    status: 'in_progress',
    halfMinutes: 30,
    squad: SQUAD,
    clock: initialClock(),
    scoreAdjustment: { own: 0, opponent: 0 },
    createdAt: '2026-10-25T10:00:00.000Z',
    updatedAt: '2026-10-25T10:00:00.000Z',
    finishedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

let seq = 0;

/** Evento de prueba; `minute` es tiempo de partido (la parte se deduce si no se da). */
export function ev(
  payload: EventPayload,
  playerId: Id | null,
  minute = 1,
  opts: { period?: Period; matchId?: Id; deleted?: boolean } = {},
): MatchEvent {
  seq++;
  const created = new Date(Date.UTC(2026, 9, 25, 10, 0, 0, seq)).toISOString();
  const e = buildEvent({
    id: `e${seq}`,
    matchId: opts.matchId ?? 'm1',
    payload,
    playerId,
    timing: { period: opts.period ?? (minute >= 30 ? 2 : 1), matchTimeMs: minute * MINUTE_MS },
    nowIso: created,
  });
  return opts.deleted ? { ...e, deletedAt: created } : e;
}

export const goal = (type: 'nine_m' | 'six_m' | 'penalty' | 'fast_break' = 'nine_m') =>
  ({ kind: 'shot', shotType: type, result: 'goal' }) as const;
