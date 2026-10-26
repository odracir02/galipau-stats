import type { EventPayload, Id, MatchEvent, Period } from './types';

/** Orden cronológico de partido; a igualdad de tiempo, orden de registro. */
export function compareEvents(a: MatchEvent, b: MatchEvent): number {
  return a.period - b.period || a.matchTimeMs - b.matchTimeMs || a.createdAt.localeCompare(b.createdAt);
}

export function liveEvents(events: readonly MatchEvent[]): MatchEvent[] {
  return events.filter((e) => e.deletedAt === null);
}

/** Último evento registrado (por momento de registro, no por tiempo de partido). */
export function lastRecorded(events: readonly MatchEvent[]): MatchEvent | undefined {
  let last: MatchEvent | undefined;
  for (const e of events) {
    if (e.deletedAt !== null) continue;
    if (!last || e.createdAt >= last.createdAt) last = e;
  }
  return last;
}

export interface EventTiming {
  period: Period;
  matchTimeMs: number;
}

/** Construye un evento a partir de su contenido. Devuelve un objeto nuevo. */
export function buildEvent(args: {
  id: Id;
  matchId: Id;
  payload: EventPayload;
  playerId: Id | null;
  timing: EventTiming;
  nowIso: string;
}): MatchEvent {
  return {
    ...args.payload,
    id: args.id,
    matchId: args.matchId,
    playerId: args.playerId,
    period: args.timing.period,
    matchTimeMs: Math.max(0, Math.round(args.timing.matchTimeMs)),
    createdAt: args.nowIso,
    updatedAt: args.nowIso,
    deletedAt: null,
  } as MatchEvent;
}
